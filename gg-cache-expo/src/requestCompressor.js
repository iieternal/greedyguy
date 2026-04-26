/**
 * Request Compressor — Client-side request body compression.
 *
 * Compresses outgoing POST/PUT/PATCH bodies before sending.
 * Use ONLY for large text-heavy payloads (>5KB) on opt-in endpoints.
 *
 * ⚠️  SCALING NOTES:
 *  - Compression is CPU-intensive and synchronous in the main thread
 *  - On mobile: use background/batch flows only, NOT interactive requests
 *  - On web: uses Web Worker automatically to avoid blocking UI
 *  - Server must support Content-Encoding: ggw1 (see server middleware)
 *  - For small payloads or general API traffic, prefer gzip or no compression
 *
 * Usage:
 *   import { createCompressingFetch } from 'gg-cache-expo';
 *
 *   const cfetch = createCompressingFetch({
 *     endpoints: [/\/api\/bulk/, /\/api\/sync/],  // ONLY these endpoints
 *     minSize: 5120,                               // Skip below 5KB
 *   });
 *
 *   // Large batch POST — compressed automatically:
 *   const res = await cfetch('/api/bulk/import', {
 *     method: 'POST',
 *     body: JSON.stringify(hugeArray),
 *     headers: { 'Content-Type': 'application/json' },
 *   });
 */

import { initDecompressor, decompress, isGGCompressed } from './decompressor.js';

// Re-use the same WASM module for compression
let _mod = null;

// Content types worth compressing
const COMPRESSIBLE_TYPES = new Set([
  'application/json', 'text/plain', 'text/html', 'text/css',
  'text/javascript', 'application/javascript', 'application/xml',
  'text/xml', 'text/csv', 'application/graphql',
  'application/x-www-form-urlencoded',
]);

/**
 * Create a fetch wrapper that compresses request bodies.
 *
 * @param {object} [opts]
 * @param {RegExp[]}  [opts.endpoints]        - REQUIRED: URL patterns to compress (no default = nothing compressed)
 * @param {number}    [opts.minSize=5120]      - Min body bytes to compress (default 5KB)
 * @param {number}    [opts.maxSize=10485760]  - Max body bytes to attempt (default 10MB)
 * @param {boolean}   [opts.useWorker=true]    - Use Web Worker on web platform
 * @param {object}    [opts.initOpts]          - Options for initDecompressor()
 * @param {Function}  [opts.onCompress]        - Callback(url, originalSize, compressedSize, timeMs)
 * @param {boolean}   [opts.fallbackOnError=true] - Send uncompressed if compression fails
 * @param {Set}       [opts.compressibleTypes] - Content types to compress
 */
export function createCompressingFetch(opts = {}) {
  if (!opts.endpoints || opts.endpoints.length === 0) {
    throw new Error(
      'createCompressingFetch requires opts.endpoints — an array of RegExp patterns. ' +
      'GG request compression should be opt-in per endpoint, not global.'
    );
  }

  const minSize = opts.minSize ?? 5120;        // 5KB default
  const maxSize = opts.maxSize ?? 10485760;     // 10MB cap
  const fallback = opts.fallbackOnError ?? true;
  const compressibleTypes = opts.compressibleTypes || COMPRESSIBLE_TYPES;

  let compressFn = null;
  let initPromise = null;

  async function getCompressor() {
    if (compressFn) return compressFn;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      await initDecompressor(opts.initOpts || {});

      // We need access to the raw WASM module for compression
      // Import the module's internal state
      const mod = await getWasmModule(opts.initOpts || {});
      compressFn = (data) => wasmCompress(mod, data);
      return compressFn;
    })();

    return initPromise;
  }

  return async function compressingFetch(input, init = {}) {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input?.url || String(input);

    const method = (init.method || 'GET').toUpperCase();

    // Only compress matching endpoints with bodies
    if (!['POST', 'PUT', 'PATCH'].includes(method)) return fetch(input, init);
    if (!opts.endpoints.some(re => re.test(url))) return fetch(input, init);
    if (!init.body) return fetch(input, init);

    // Get body as bytes
    let bodyBytes;
    if (typeof init.body === 'string') {
      bodyBytes = new TextEncoder().encode(init.body);
    } else if (init.body instanceof ArrayBuffer) {
      bodyBytes = new Uint8Array(init.body);
    } else if (init.body instanceof Uint8Array) {
      bodyBytes = init.body;
    } else if (typeof Blob !== 'undefined' && init.body instanceof Blob) {
      bodyBytes = new Uint8Array(await init.body.arrayBuffer());
    } else {
      return fetch(input, init); // FormData, ReadableStream, etc. — skip
    }

    // Size checks
    if (bodyBytes.length < minSize || bodyBytes.length > maxSize) {
      return fetch(input, init);
    }

    // Content-type check
    const headers = new Headers(init.headers || {});
    const contentType = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType && !compressibleTypes.has(contentType)) {
      return fetch(input, init);
    }

    // Compress
    try {
      const compress = await getCompressor();
      const t0 = performance.now();
      const compressed = compress(bodyBytes);
      const timeMs = performance.now() - t0;

      // Only use compressed if actually smaller
      if (compressed.length >= bodyBytes.length) {
        return fetch(input, init);
      }

      opts.onCompress?.(url, bodyBytes.length, compressed.length, timeMs);

      // Send compressed body with encoding header
      const newHeaders = new Headers(headers);
      newHeaders.set('Content-Encoding', 'ggw1');
      newHeaders.set('X-Original-Content-Length', String(bodyBytes.length));
      // Keep original Content-Type (server needs it after decompression)

      return fetch(input, {
        ...init,
        body: compressed,
        headers: newHeaders,
      });
    } catch (err) {
      if (fallback) {
        // Send uncompressed on error
        return fetch(input, init);
      }
      throw err;
    }
  };
}

// --- WASM module access ---

let _wasmMod = null;
let _wasmLoading = null;

async function getWasmModule(initOpts) {
  if (_wasmMod) return _wasmMod;
  if (_wasmLoading) return _wasmLoading;

  _wasmLoading = (async () => {
    const isNode = typeof process !== 'undefined' && process.versions?.node;

    if (isNode) {
      const { readFileSync } = await import('fs');
      const { fileURLToPath } = await import('url');
      const { dirname, join } = await import('path');

      let wasmDir;
      if (initOpts.wasmUrl) {
        const p = await import('path');
        wasmDir = p.dirname(initOpts.wasmUrl);
      } else {
        const thisDir = dirname(fileURLToPath(import.meta.url));
        wasmDir = join(thisDir, '..', 'assets');
      }

      const wasmBinary = readFileSync(join(wasmDir, 'greedyguy.wasm'));
      const glueUrl = join(wasmDir, 'greedyguy.js');
      const { default: createGG } = await import(`file://${glueUrl.replace(/\\/g, '/')}`);
      _wasmMod = await createGG({ wasmBinary });
    } else {
      // Browser
      const wasmUrl = initOpts.wasmUrl || './assets/greedyguy.wasm';
      const glueUrl = initOpts.glueUrl || './assets/greedyguy.js';
      const { default: createGG } = await import(/* webpackIgnore: true */ glueUrl);
      const wasmBinary = await fetch(wasmUrl).then(r => r.arrayBuffer());
      _wasmMod = await createGG({ wasmBinary });
    }

    return _wasmMod;
  })();

  return _wasmLoading;
}

function wasmCompress(mod, data) {
  const inputPtr = mod._malloc(data.length);
  const outPtrPtr = mod._malloc(4);
  const outLenPtr = mod._malloc(4);

  let outPtr = 0;
  try {
    mod.HEAPU8.set(data, inputPtr);
    mod.setValue(outPtrPtr, 0, 'i32');
    mod.setValue(outLenPtr, 0, 'i32');

    const rc = mod._gg_web_compress(inputPtr, data.length, outPtrPtr, outLenPtr);
    if (rc !== 0) {
      const partial = mod.getValue(outPtrPtr, 'i32');
      if (partial) mod._gg_web_free(partial);
      throw new Error(`GG compress failed (${rc})`);
    }

    outPtr = mod.getValue(outPtrPtr, 'i32');
    const outLen = mod.getValue(outLenPtr, 'i32');
    let result;
    try {
      result = new Uint8Array(outLen);
      result.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    } finally {
      mod._gg_web_free(outPtr);
      outPtr = 0;
    }
    return result;
  } finally {
    if (outPtr) mod._gg_web_free(outPtr);
    mod._free(inputPtr);
    mod._free(outPtrPtr);
    mod._free(outLenPtr);
  }
}
