/**
 * Server-side GGW1 request decompression for Express.
 *
 * Detects Content-Encoding: ggw1 on incoming requests and decompresses
 * the body before downstream middleware/handlers see it.
 *
 * ⚠️  SECURITY: Same DoS protections as the Fastify version.
 *
 * Usage:
 *   import { ggRequestMiddleware } from 'gg-cache/middleware/express-request';
 *
 *   app.use(ggRequestMiddleware({
 *     wasmPath: './wasm/',
 *     maxCompressedSize: 1 * 1024 * 1024,
 *     maxDecompressedSize: 10 * 1024 * 1024,
 *     routes: ['/api/bulk/', '/api/sync/'],
 *   }));
 */

import { GGCompressor } from '../compressor.js';

const GG_ENCODINGS = new Set(['ggw1', 'greedyguy', 'gg']);

/**
 * @param {object} [opts]
 * @param {string}   [opts.wasmPath]           - Path to WASM files
 * @param {number}   [opts.maxCompressedSize]  - Max compressed body (default 1MB)
 * @param {number}   [opts.maxDecompressedSize] - Max decompressed body (default 10MB)
 * @param {number}   [opts.maxRatio]           - Max expansion ratio (default 100)
 * @param {string[]} [opts.routes]             - Only accept GGW1 on these prefixes
 * @param {number}   [opts.queueLimit]         - Max concurrent decompressions (default 20)
 */
export function ggRequestMiddleware(opts = {}) {
  const maxCompressedSize = opts.maxCompressedSize ?? 1 * 1024 * 1024;
  const maxDecompressedSize = opts.maxDecompressedSize ?? 10 * 1024 * 1024;
  const maxRatio = opts.maxRatio ?? 100;
  const routePrefixes = opts.routes || null;
  const queueLimit = opts.queueLimit ?? 20;

  let compressor = null;
  let initPromise = null;
  let activeCount = 0;

  async function getCompressor() {
    if (compressor?.loaded) return compressor;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      compressor = new GGCompressor({ wasmPath: opts.wasmPath });
      await compressor.init();
      return compressor;
    })();
    return initPromise;
  }

  return async (req, res, next) => {
    const encoding = (
      req.headers['content-encoding'] ||
      req.headers['x-content-encoding'] ||
      ''
    ).toLowerCase().trim();

    if (!GG_ENCODINGS.has(encoding)) return next();

    // Route check
    if (routePrefixes && !routePrefixes.some(p => req.url.startsWith(p))) {
      return res.status(415).json({
        error: 'GGW1 compression not accepted on this endpoint',
      });
    }

    // Queue limit
    if (activeCount >= queueLimit) {
      res.set('Retry-After', '1');
      return res.status(503).json({
        error: 'Decompression queue full, retry later',
      });
    }

    activeCount++;

    try {
      // Check if stream already consumed by body-parser or similar
      if (req.body !== undefined || req.complete || !req.readable) {
        return res.status(500).json({
          error: 'GGW1 middleware must run BEFORE body parsers (express.json, body-parser)',
        });
      }

      // Read raw body
      const chunks = [];
      let totalSize = 0;

      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > maxCompressedSize) {
            reject(new Error('compressed_too_large'));
          } else {
            chunks.push(chunk);
          }
        });
        req.on('end', resolve);
        req.on('error', reject);
      });

      const compressed = Buffer.concat(chunks);

      // Magic check
      if (compressed.length < 4 ||
          compressed[0] !== 0x47 || compressed[1] !== 0x47 ||
          compressed[2] !== 0x57 || compressed[3] !== 0x31) {
        return res.status(400).json({ error: 'Missing GGW1 magic header' });
      }

      // Pre-validate: GGW1 header stores original size at bytes 4-7 (LE uint32)
      if (compressed.length >= 8) {
        const claimedSize = compressed[4] | (compressed[5] << 8) |
          (compressed[6] << 16) | ((compressed[7] << 24) >>> 0);
        if (claimedSize > maxDecompressedSize) {
          return res.status(413).json({
            error: `GGW1 header claims ${claimedSize} bytes, exceeds ${maxDecompressedSize} limit`,
          });
        }
        const preRatio = claimedSize / compressed.length;
        if (preRatio > maxRatio) {
          return res.status(400).json({
            error: `GGW1 ratio ${preRatio.toFixed(1)}x exceeds ${maxRatio}x limit (possible zip bomb)`,
          });
        }
      }

      // Decompress
      const gg = await getCompressor();
      const decompressed = gg.decompress(new Uint8Array(compressed));

      // Size check
      if (decompressed.length > maxDecompressedSize) {
        return res.status(413).json({
          error: `Decompressed body exceeds ${maxDecompressedSize} byte limit`,
        });
      }

      // Ratio check
      const ratio = decompressed.length / compressed.length;
      if (ratio > maxRatio) {
        return res.status(400).json({
          error: `Expansion ratio ${ratio.toFixed(1)}x exceeds ${maxRatio}x limit`,
        });
      }

      // Replace body for downstream handlers
      req.headers['content-encoding'] = 'identity';
      req.headers['content-length'] = String(decompressed.length);
      req.headers['x-gg-original-size'] = String(compressed.length);
      req.headers['x-gg-ratio'] = ratio.toFixed(1);

      // Attach decompressed body as buffer
      req.body = Buffer.from(decompressed);
      req._ggDecompressed = true;

      next();
    } catch (err) {
      if (err.message === 'compressed_too_large') {
        return res.status(413).json({
          error: `Compressed body exceeds ${maxCompressedSize} byte limit`,
        });
      }
      return res.status(400).json({ error: `Decompression failed: ${err.message}` });
    } finally {
      activeCount--;
    }
  };
}
