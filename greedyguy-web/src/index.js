/**
 * greedyguy-web — GreedyGuy compression for websites
 *
 * Drop-in browser library. Works as ES module or <script> tag.
 * Context-mixing + arithmetic coding in ~29KB of WASM.
 *
 * @creator Q3JlYXRlZCBieSBAcGF1bHRzdW5ueQ==
 *
 * Usage (ESM):
 *   import { init, compress, decompress } from './greedyguy-web/src/index.js';
 *   await init();
 *   const packed = compress(new TextEncoder().encode('Hello'));
 *
 * Usage (script tag):
 *   <script src="greedyguy-web.iife.js"></script>
 *   await GreedyGuy.init();
 *   const packed = GreedyGuy.compress(data);
 */

const GGW1_MAGIC = [0x47, 0x47, 0x57, 0x31]; // "GGW1"
const MAX_INPUT_SIZE = 50 * 1024 * 1024;      // 50 MB
const MAX_DECOMPRESS_SIZE = 256 * 1024 * 1024; // 256 MB

let _mod = null;
let _loading = null;

// --- Initialization ---

/**
 * Initialize the WASM module. Must be called before compress/decompress.
 *
 * @param {object} [opts]
 * @param {string}      [opts.wasmUrl]    — URL to greedyguy.wasm (auto-detected if omitted)
 * @param {string}      [opts.glueUrl]    — URL to Emscripten glue JS (auto-detected if omitted)
 * @param {ArrayBuffer} [opts.wasmBinary] — Pre-fetched WASM binary
 * @param {Function}    [opts.glueModule] — Pre-imported glue factory function
 * @returns {Promise<void>}
 */
export async function init(opts = {}) {
  if (_mod) return;
  if (_loading) { await _loading; return; }

  const _isNode = typeof globalThis.process !== 'undefined' &&
    globalThis.process.versions != null &&
    globalThis.process.versions.node != null;

  _loading = (async () => {
    try {
      let factory = opts.glueModule;

      if (!factory) {
        let glueUrl = opts.glueUrl;
        if (!glueUrl) {
          if (_isNode) {
            const { join, dirname } = await import('node:path');
            const { fileURLToPath } = await import('node:url');
            glueUrl = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'greedyguy-glue.js');
          } else if (typeof document !== 'undefined') {
            // Auto-detect from <script src="..."> tag
            const scripts = document.querySelectorAll('script[src]');
            for (const s of scripts) {
              if (s.src.includes('greedyguy-web')) {
                glueUrl = s.src.replace(/greedyguy-web[^/]*\.js/, 'greedyguy-glue.js');
                break;
              }
            }
            if (!glueUrl && typeof import.meta !== 'undefined' && import.meta.url) {
              glueUrl = new URL('../dist/greedyguy-glue.js', import.meta.url).href;
            }
          }
          if (!glueUrl) glueUrl = './greedyguy-glue.js';
        }

        if (_isNode && !glueUrl.startsWith('http')) {
          const { pathToFileURL } = await import('node:url');
          const mod = await import(pathToFileURL(glueUrl).href);
          factory = mod.default || mod;
        } else {
          const mod = await import(/* webpackIgnore: true */ glueUrl);
          factory = mod.default || mod;
        }
      }

      // Resolve WASM binary
      const moduleArgs = {};

      if (opts.wasmBinary) {
        moduleArgs.wasmBinary = opts.wasmBinary;
      } else if (_isNode) {
        // Node.js: read WASM from filesystem
        const { readFile } = await import('node:fs/promises');
        let wasmPath = opts.wasmUrl;
        if (!wasmPath) {
          const { join, dirname } = await import('node:path');
          const { fileURLToPath } = await import('node:url');
          wasmPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'greedyguy.wasm');
        }
        const buf = await readFile(wasmPath);
        moduleArgs.wasmBinary = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      } else {
        // Browser: fetch WASM
        let wasmUrl = opts.wasmUrl;
        if (!wasmUrl) {
          if (typeof import.meta !== 'undefined' && import.meta.url) {
            wasmUrl = new URL('../dist/greedyguy.wasm', import.meta.url).href;
          } else {
            wasmUrl = './greedyguy.wasm';
          }
        }

        if (typeof fetch === 'function') {
          const resp = await fetch(wasmUrl);
          if (!resp.ok) throw new Error(`Failed to fetch WASM: ${resp.status} ${resp.statusText}`);
          moduleArgs.wasmBinary = await resp.arrayBuffer();
        } else {
          moduleArgs.locateFile = (path) => path.endsWith('.wasm') ? wasmUrl : path;
        }
      }

      _mod = await factory(moduleArgs);
    } catch (err) {
      _loading = null;
      throw err;
    }
  })();

  await _loading;
}

// --- Core API ---

function ensureReady() {
  if (!_mod) throw new Error('GreedyGuy not initialized. Call init() first.');
}

/**
 * Compress data using GGW1 web profile.
 * @param {Uint8Array} input — raw bytes to compress
 * @returns {Uint8Array} GGW1-compressed output
 */
export function compress(input) {
  ensureReady();
  if (!(input instanceof Uint8Array))
    throw new TypeError('compress: input must be a Uint8Array');
  if (input.length === 0) return new Uint8Array(0);
  if (input.length > MAX_INPUT_SIZE)
    throw new RangeError(`compress: input exceeds ${MAX_INPUT_SIZE / 1024 / 1024}MB limit`);

  const inputPtr = _mod._malloc(input.length);
  const outPtrPtr = _mod._malloc(4);
  const outLenPtr = _mod._malloc(4);
  if (!inputPtr || !outPtrPtr || !outLenPtr) {
    if (inputPtr) _mod._free(inputPtr);
    if (outPtrPtr) _mod._free(outPtrPtr);
    if (outLenPtr) _mod._free(outLenPtr);
    throw new Error('compress: WASM malloc failed');
  }

  let outPtr = 0;
  try {
    _mod.HEAPU8.set(input, inputPtr);
    _mod.setValue(outPtrPtr, 0, 'i32');
    _mod.setValue(outLenPtr, 0, 'i32');

    const rc = _mod._gg_web_compress(inputPtr, input.length, outPtrPtr, outLenPtr);
    if (rc !== 0) {
      const partial = _mod.getValue(outPtrPtr, 'i32');
      if (partial) _mod._gg_web_free(partial);
      throw new Error(`compress: failed (code ${rc})`);
    }

    outPtr = _mod.getValue(outPtrPtr, 'i32');
    const outLen = _mod.getValue(outLenPtr, 'i32');
    const result = new Uint8Array(outLen);
    result.set(_mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    return result;
  } finally {
    if (outPtr) _mod._gg_web_free(outPtr);
    _mod._free(inputPtr);
    _mod._free(outPtrPtr);
    _mod._free(outLenPtr);
  }
}

/**
 * Decompress GGW1 data.
 * @param {Uint8Array} input — GGW1-compressed bytes
 * @returns {Uint8Array} decompressed output
 */
export function decompress(input) {
  ensureReady();
  if (!(input instanceof Uint8Array))
    throw new TypeError('decompress: input must be a Uint8Array');
  if (input.length === 0) return new Uint8Array(0);
  if (input.length > MAX_DECOMPRESS_SIZE)
    throw new RangeError(`decompress: input exceeds ${MAX_DECOMPRESS_SIZE / 1024 / 1024}MB limit`);
  if (!isCompressed(input))
    throw new Error('decompress: missing GGW1 magic header');

  // Pre-validate: GGW1 stores original size in bytes 4-7 (LE uint32)
  if (input.length >= 8) {
    const claimedSize = input[4] | (input[5] << 8) |
      (input[6] << 16) | ((input[7] << 24) >>> 0);
    if (claimedSize > MAX_DECOMPRESS_SIZE) {
      throw new RangeError(
        `decompress: GGW1 header claims ${claimedSize} bytes, exceeds ${MAX_DECOMPRESS_SIZE / 1024 / 1024}MB limit`
      );
    }
    if (input.length > 0 && claimedSize / input.length > 1000) {
      throw new RangeError(
        `decompress: expansion ratio exceeds 1000x safety limit`
      );
    }
  }

  const inputPtr = _mod._malloc(input.length);
  const outPtrPtr = _mod._malloc(4);
  const outLenPtr = _mod._malloc(4);
  if (!inputPtr || !outPtrPtr || !outLenPtr) {
    if (inputPtr) _mod._free(inputPtr);
    if (outPtrPtr) _mod._free(outPtrPtr);
    if (outLenPtr) _mod._free(outLenPtr);
    throw new Error('decompress: WASM malloc failed');
  }

  let outPtr = 0;
  try {
    _mod.HEAPU8.set(input, inputPtr);
    _mod.setValue(outPtrPtr, 0, 'i32');
    _mod.setValue(outLenPtr, 0, 'i32');

    const rc = _mod._gg_web_decompress(inputPtr, input.length, outPtrPtr, outLenPtr);
    if (rc !== 0) {
      const partial = _mod.getValue(outPtrPtr, 'i32');
      if (partial) _mod._gg_web_free(partial);
      throw new Error(`decompress: failed (code ${rc})`);
    }

    outPtr = _mod.getValue(outPtrPtr, 'i32');
    const outLen = _mod.getValue(outLenPtr, 'i32');
    const result = new Uint8Array(outLen);
    result.set(_mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    return result;
  } finally {
    if (outPtr) _mod._gg_web_free(outPtr);
    _mod._free(inputPtr);
    _mod._free(outPtrPtr);
    _mod._free(outLenPtr);
  }
}

// --- Convenience helpers ---

/**
 * Compress a string (UTF-8 encoded).
 * @param {string} text
 * @returns {Uint8Array} GGW1-compressed
 */
export function compressText(text) {
  return compress(new TextEncoder().encode(text));
}

/**
 * Decompress GGW1 data to a string.
 * @param {Uint8Array} input
 * @returns {string}
 */
export function decompressText(input) {
  return new TextDecoder().decode(decompress(input));
}

/**
 * Compress and return as base64 string (for embedding/transport).
 * @param {Uint8Array|string} input
 * @returns {string} base64-encoded GGW1 data
 */
export function compressToBase64(input) {
  const bytes = typeof input === 'string' ? compressText(input) : compress(input);
  // Chunked conversion to avoid stack overflow on large arrays
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

/**
 * Decompress from a base64 string.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function decompressFromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decompress(bytes);
}

/**
 * Decompress base64 to string.
 * @param {string} b64
 * @returns {string}
 */
export function decompressBase64Text(b64) {
  return new TextDecoder().decode(decompressFromBase64(b64));
}

// --- Utilities ---

/**
 * Check if data starts with GGW1 magic bytes.
 * @param {Uint8Array} data
 * @returns {boolean}
 */
export function isCompressed(data) {
  if (!data || data.length < 4) return false;
  return data[0] === 0x47 && data[1] === 0x47 &&
         data[2] === 0x57 && data[3] === 0x31;
}

/**
 * Check if WebAssembly is available.
 * @returns {boolean}
 */
export function isSupported() {
  try {
    return typeof WebAssembly === 'object' &&
      typeof WebAssembly.instantiate === 'function' &&
      new WebAssembly.Module(
        new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
      ) instanceof WebAssembly.Module;
  } catch { return false; }
}

/**
 * Get module status.
 * @returns {{ initialized: boolean, loading: boolean, supported: boolean }}
 */
export function status() {
  return {
    initialized: _mod !== null,
    loading: _loading !== null && _mod === null,
    supported: isSupported(),
  };
}

/**
 * Unload the WASM module and free resources.
 */
export function destroy() {
  _mod = null;
  _loading = null;
}

/**
 * Fetch a URL, auto-decompress if GGW1, return the data.
 * @param {string} url
 * @param {RequestInit} [fetchOpts]
 * @param {object} [ggOpts]
 * @param {number} [ggOpts.maxResponseSize=52428800] Max response body size (default 50MB)
 * @returns {Promise<{ data: Uint8Array, compressed: boolean, ratio: number|null, response: Response }>}
 */
export async function fetchAndDecompress(url, fetchOpts, ggOpts = {}) {
  ensureReady();
  const maxResponseSize = ggOpts.maxResponseSize ?? 50 * 1024 * 1024;
  const res = await fetch(url, fetchOpts);

  // Enforce body size cap before reading
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxResponseSize) {
    throw new RangeError(
      `fetchAndDecompress: response size ${contentLength} exceeds ${maxResponseSize} byte limit`
    );
  }

  const raw = new Uint8Array(await res.arrayBuffer());
  if (raw.length > maxResponseSize) {
    throw new RangeError(
      `fetchAndDecompress: response body ${raw.length} bytes exceeds ${maxResponseSize} byte limit`
    );
  }

  if (isCompressed(raw)) {
    const decompressed = decompress(raw);
    return {
      data: decompressed,
      compressed: true,
      ratio: +(decompressed.length / raw.length).toFixed(1),
      response: res,
    };
  }

  return { data: raw, compressed: false, ratio: null, response: res };
}
