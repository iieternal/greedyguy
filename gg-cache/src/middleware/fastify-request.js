/**
 * Server-side GGW1 request decompression for Fastify.
 *
 * Detects Content-Encoding: ggw1 on incoming requests and decompresses
 * the body before your route handler sees it.
 *
 * ⚠️  SECURITY: Compressed request bodies are a DoS vector.
 *  This middleware enforces strict limits:
 *  - Max compressed size (default 1MB)
 *  - Max decompressed size (default 10MB)
 *  - Max expansion ratio (default 100x)
 *  - Bounded worker pool with queue limit
 *  - Reject on queue overflow (503)
 *
 * ⚠️  NOTE: Decompression runs synchronously on the event loop per WASM instance.
 * The timeout is a best-effort guard — it cannot preempt a blocking WASM call.
 * For production at scale, consider offloading to worker_threads.
 *
 * Usage:
 *   import { ggRequestDecompressor } from 'gg-cache/middleware/fastify-request';
 *
 *   // Register BEFORE your routes:
 *   app.register(ggRequestDecompressor, {
 *     wasmPath: './wasm/',
 *     maxCompressedSize: 1 * 1024 * 1024,   // 1MB max compressed
 *     maxDecompressedSize: 10 * 1024 * 1024, // 10MB max decompressed
 *     maxRatio: 100,                          // max 100x expansion
 *     poolSize: 4,                            // 4 workers (~80MB RAM)
 *     queueLimit: 50,                         // reject if >50 waiting
 *     routes: ['/api/bulk/', '/api/sync/'],   // ONLY these prefixes
 *   });
 */

const GG_ENCODINGS = new Set(['ggw1', 'greedyguy', 'gg']);

async function ggRequestDecompressor(fastify, opts) {
  // --- Config with safe defaults ---
  const maxCompressedSize = opts.maxCompressedSize ?? 1 * 1024 * 1024;     // 1MB
  const maxDecompressedSize = opts.maxDecompressedSize ?? 10 * 1024 * 1024; // 10MB
  const maxRatio = opts.maxRatio ?? 100;
  const poolSize = opts.poolSize ?? Math.min(4, (await getCpuCount()));
  const queueLimit = opts.queueLimit ?? 50;
  const routePrefixes = opts.routes || null;
  const timeout = opts.timeout ?? 5000; // 5s max per decompression

  // --- Metrics ---
  const metrics = {
    totalRequests: 0,
    decompressed: 0,
    rejected: 0,
    rateLimited: 0,
    errors: 0,
    totalDecompressMs: 0,
    totalBytesIn: 0,
    totalBytesOut: 0,
    queueHighWater: 0,
  };

  // --- WASM Worker Pool ---
  const pool = await createDecompressorPool(poolSize, opts);
  let queueDepth = 0;

  fastify.decorate('ggRequestMetrics', () => ({
    ...metrics,
    avgDecompressMs: metrics.decompressed > 0
      ? metrics.totalDecompressMs / metrics.decompressed : 0,
    avgRatio: metrics.totalBytesIn > 0
      ? metrics.totalBytesOut / metrics.totalBytesIn : 0,
    poolSize,
    queueDepth,
    queueLimit,
  }));

  // --- Add custom content type parser for ggw1-encoded bodies ---
  fastify.addHook('onRequest', async (request, reply) => {
    const encoding = (
      request.headers['content-encoding'] ||
      request.headers['x-content-encoding'] ||
      ''
    ).toLowerCase().trim();

    if (!GG_ENCODINGS.has(encoding)) return;

    metrics.totalRequests++;

    // Route check
    if (routePrefixes && !routePrefixes.some(p => request.url.startsWith(p))) {
      metrics.rejected++;
      reply.code(415).send({
        error: 'Unsupported Media Type',
        message: 'GGW1 compression not accepted on this endpoint',
      });
      return;
    }

    // Queue limit check
    if (queueDepth >= queueLimit) {
      metrics.rateLimited++;
      reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Decompression queue full, retry later',
        retryAfter: 1,
      });
      reply.header('Retry-After', '1');
      return;
    }

    // Read raw body
    const chunks = [];
    let totalSize = 0;

    try {
      for await (const chunk of request.raw) {
        totalSize += chunk.length;
        if (totalSize > maxCompressedSize) {
          metrics.rejected++;
          reply.code(413).send({
            error: 'Payload Too Large',
            message: `Compressed body exceeds ${maxCompressedSize} byte limit`,
          });
          return;
        }
        chunks.push(chunk);
      }
    } catch (err) {
      metrics.errors++;
      reply.code(400).send({ error: 'Bad Request', message: 'Failed to read request body' });
      return;
    }

    const compressed = Buffer.concat(chunks);

    // Verify GGW1 magic
    if (compressed.length < 4 ||
        compressed[0] !== 0x47 || compressed[1] !== 0x47 ||
        compressed[2] !== 0x57 || compressed[3] !== 0x31) {
      metrics.rejected++;
      reply.code(400).send({
        error: 'Bad Request',
        message: 'Body claims GGW1 encoding but missing magic header',
      });
      return;
    }

    // Pre-validate: GGW1 format stores original size in header bytes 4-7 (LE uint32)
    if (compressed.length >= 8) {
      const headerOrigSize = compressed[4] | (compressed[5] << 8) |
        (compressed[6] << 16) | ((compressed[7] << 24) >>> 0);
      if (headerOrigSize > maxDecompressedSize) {
        metrics.rejected++;
        reply.code(413).send({
          error: 'Payload Too Large',
          message: `GGW1 header claims ${headerOrigSize} bytes, exceeds ${maxDecompressedSize} limit`,
        });
        return;
      }
      const preRatio = headerOrigSize / compressed.length;
      if (preRatio > maxRatio) {
        metrics.rejected++;
        reply.code(400).send({
          error: 'Bad Request',
          message: `GGW1 header ratio ${preRatio.toFixed(1)}x exceeds ${maxRatio}x limit (possible zip bomb)`,
        });
        return;
      }
    }

    // Decompress via worker pool
    queueDepth++;
    metrics.queueHighWater = Math.max(metrics.queueHighWater, queueDepth);

    try {
      const t0 = performance.now();
      const decompressed = await pool.decompress(compressed, timeout);
      const timeMs = performance.now() - t0;

      // Size check
      if (decompressed.length > maxDecompressedSize) {
        metrics.rejected++;
        reply.code(413).send({
          error: 'Payload Too Large',
          message: `Decompressed body exceeds ${maxDecompressedSize} byte limit`,
        });
        return;
      }

      // Ratio check
      const ratio = decompressed.length / compressed.length;
      if (ratio > maxRatio) {
        metrics.rejected++;
        reply.code(400).send({
          error: 'Bad Request',
          message: `Decompression ratio ${ratio.toFixed(1)}x exceeds ${maxRatio}x limit (possible zip bomb)`,
        });
        return;
      }

      // Success — replace request body
      metrics.decompressed++;
      metrics.totalDecompressMs += timeMs;
      metrics.totalBytesIn += compressed.length;
      metrics.totalBytesOut += decompressed.length;

      // Inject decompressed body so Fastify's parser sees raw content
      request.headers['content-encoding'] = 'identity';
      delete request.headers['x-content-encoding'];
      request.headers['content-length'] = String(decompressed.length);
      request.headers['x-gg-original-size'] = String(compressed.length);
      request.headers['x-gg-ratio'] = ratio.toFixed(1);
      request.headers['x-gg-decompress-ms'] = timeMs.toFixed(1);

      // Replace the raw stream with the decompressed buffer
      try { request.raw.destroy(); } catch {}
      const { Readable } = await import('stream');
      const newStream = Readable.from([decompressed]);
      // Copy over properties Fastify expects on the raw request
      Object.defineProperties(newStream, {
        headers: { value: request.headers, writable: true },
        method: { value: request.method, writable: true },
        url: { value: request.url, writable: true },
      });
      request.raw = newStream;

    } catch (err) {
      metrics.errors++;
      if (err.message?.includes('timeout')) {
        reply.code(408).send({
          error: 'Request Timeout',
          message: `Decompression exceeded ${timeout}ms limit`,
        });
      } else {
        reply.code(400).send({
          error: 'Bad Request',
          message: `Decompression failed: ${err.message}`,
        });
      }
    } finally {
      queueDepth--;
    }
  });

  // Cleanup on close
  fastify.addHook('onClose', async () => {
    await pool.destroy();
  });
}

// --- Decompressor Pool ---
// Uses a round-robin pool of WASM instances.
// Each instance is ~20MB. Operations are serialized per instance.

async function createDecompressorPool(size, opts) {
  const instances = [];
  const queues = []; // per-instance task queue
  let robin = 0;

  // Load WASM module factory once
  const isNode = typeof process !== 'undefined' && process.versions?.node;
  let createGG, wasmBinary;

  if (isNode) {
    const fs = await import('fs');
    const path = await import('path');
    const url = await import('url');

    let wasmDir;
    if (opts.wasmPath) {
      wasmDir = opts.wasmPath;
    } else {
      const thisDir = path.dirname(url.fileURLToPath(import.meta.url));
      wasmDir = path.join(thisDir, '..', 'wasm');
    }

    wasmBinary = fs.readFileSync(path.join(wasmDir, 'greedyguy.wasm'));
    const glue = path.join(wasmDir, 'greedyguy.js');
    const mod = await import(`file://${glue.replace(/\\/g, '/')}`);
    createGG = mod.default;
  }

  // Create pool instances
  for (let i = 0; i < size; i++) {
    const mod = await createGG({ wasmBinary: Buffer.from(wasmBinary) });
    instances.push(mod);
    queues.push(Promise.resolve());
  }

  return {
    async decompress(compressed, timeoutMs = 5000) {
      // Round-robin instance selection
      const idx = robin;
      robin = (robin + 1) % size;
      const mod = instances[idx];

      // Queue behind any pending work on this instance
      const task = queues[idx].then(() => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Decompression timeout')),
            timeoutMs
          );

          try {
            const data = new Uint8Array(compressed);
            const inputPtr = mod._malloc(data.length);
            const outPtrPtr = mod._malloc(4);
            const outLenPtr = mod._malloc(4);

            try {
              mod.HEAPU8.set(data, inputPtr);
              mod.setValue(outPtrPtr, 0, 'i32');
              mod.setValue(outLenPtr, 0, 'i32');

              const rc = mod._gg_web_decompress(inputPtr, data.length, outPtrPtr, outLenPtr);
              if (rc !== 0) {
                const partial = mod.getValue(outPtrPtr, 'i32');
                if (partial) mod._gg_web_free(partial);
                throw new Error(`GG decompress failed (code ${rc})`);
              }

              const outPtr = mod.getValue(outPtrPtr, 'i32');
              const outLen = mod.getValue(outLenPtr, 'i32');
              let result;
              try {
                result = Buffer.alloc(outLen);
                result.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
              } finally {
                mod._gg_web_free(outPtr);
              }

              clearTimeout(timer);
              resolve(result);
            } finally {
              mod._free(inputPtr);
              mod._free(outPtrPtr);
              mod._free(outLenPtr);
            }
          } catch (err) {
            clearTimeout(timer);
            reject(err);
          }
        });
      });

      // Replace queue head for this instance
      queues[idx] = task.catch(() => {});
      return task;
    },

    async destroy() {
      instances.length = 0;
      queues.length = 0;
    },

    get poolSize() { return size; },
    get memoryMB() { return size * 20; },
  };
}

async function getCpuCount() {
  try {
    const os = await import('os');
    return os.cpus().length;
  } catch {
    return 4;
  }
}

ggRequestDecompressor[Symbol.for('skip-override')] = true;
ggRequestDecompressor[Symbol.for('fastify.display-name')] = 'gg-request-decompressor';

export { ggRequestDecompressor };
export default ggRequestDecompressor;
