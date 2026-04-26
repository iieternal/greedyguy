/**
 * GG Decompressor — Platform-adaptive GGW1 decompression.
 *
 * - Web: loads WASM via standard WebAssembly API
 * - Android/iOS (Hermes): loads WASM binary from bundled asset
 * - Fallback: errors with clear message if WASM unavailable
 *
 * The decompressor is initialized once and reused across all requests.
 */

const GGW1_MAGIC = new Uint8Array([0x47, 0x47, 0x57, 0x31]); // "GGW1"

// Safety limits — prevent OOM from malicious payloads
const MAX_DECOMPRESS_SIZE = 256 * 1024 * 1024;  // 256MB absolute max
const MAX_INPUT_SIZE = 50 * 1024 * 1024;         // 50MB max compressed input

let _mod = null;
let _loading = null;
let _maxDecompressSize = MAX_DECOMPRESS_SIZE;

/**
 * Detect the current platform.
 */
function getPlatform() {
  if (typeof document !== 'undefined') return 'web';
  if (typeof navigator !== 'undefined' && navigator.product === 'ReactNative') return 'native';
  if (typeof process !== 'undefined' && process.versions?.node) return 'node';
  return 'unknown';
}

/**
 * Check if WebAssembly is available on this platform.
 */
export function isWasmSupported() {
  return typeof WebAssembly !== 'undefined' &&
         typeof WebAssembly.instantiate === 'function';
}

/**
 * Initialize the GG decompressor.
 *
 * @param {object} [opts]
 * @param {string}     [opts.wasmUrl]    - URL/path to greedyguy.wasm
 * @param {string}     [opts.glueUrl]    - URL/path to greedyguy.js (Emscripten glue)
 * @param {ArrayBuffer} [opts.wasmBinary] - Pre-loaded WASM binary (skip fetch)
 * @param {Function}   [opts.glueModule] - Pre-imported Emscripten factory function
 * @param {number}     [opts.maxDecompressSize] - Max output size in bytes (default 256MB)
 */
export async function initDecompressor(opts = {}) {
  if (_mod) return;
  if (_loading) return _loading;

  if (opts.maxDecompressSize) {
    _maxDecompressSize = Math.min(opts.maxDecompressSize, MAX_DECOMPRESS_SIZE);
  }

  _loading = _doInit(opts);
  await _loading;
}

async function _doInit(opts) {
  if (!isWasmSupported()) {
    throw new Error(
      'WebAssembly not available. On React Native, ensure Hermes is enabled ' +
      'with wasm support, or use the JSC engine with polyfill.'
    );
  }

  const platform = getPlatform();
  let createGreedyGuy;
  let wasmBinary = opts.wasmBinary || null;

  // --- Load the Emscripten glue ---
  if (opts.glueModule) {
    createGreedyGuy = opts.glueModule;
  } else if (platform === 'web') {
    const glueUrl = opts.glueUrl || resolveAssetUrl('greedyguy.js');
    const mod = await import(/* webpackIgnore: true */ glueUrl);
    createGreedyGuy = mod.default || mod;
  } else if (platform === 'native') {
    // React Native: glue must be bundled or pre-loaded
    if (!opts.glueModule) {
      throw new Error(
        'On React Native, pass the Emscripten glue via opts.glueModule. ' +
        'Example: import createGG from "./assets/greedyguy.js"; initDecompressor({ glueModule: createGG })'
      );
    }
  } else {
    // Node.js fallback
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const wasmDir = join(thisDir, '..', 'assets');

    wasmBinary = readFileSync(join(wasmDir, 'greedyguy.wasm'));
    const { default: factory } = await import(
      `file://${join(wasmDir, 'greedyguy.js').replace(/\\/g, '/')}`
    );
    createGreedyGuy = factory;
  }

  // --- Load the WASM binary if not provided ---
  if (!wasmBinary && platform === 'web') {
    const wasmUrl = opts.wasmUrl || resolveAssetUrl('greedyguy.wasm');
    const resp = await fetch(wasmUrl);
    wasmBinary = await resp.arrayBuffer();
  }

  // --- Instantiate the module ---
  const initOpts = {};
  if (wasmBinary) initOpts.wasmBinary = wasmBinary;
  if (platform === 'web' && !wasmBinary) {
    const wasmUrl = opts.wasmUrl || resolveAssetUrl('greedyguy.wasm');
    initOpts.locateFile = (path) => {
      if (path.endsWith('.wasm')) return wasmUrl;
      return path;
    };
  }

  _mod = await createGreedyGuy(initOpts);
}

function resolveAssetUrl(filename) {
  // Try common asset locations for bundlers
  if (typeof __webpack_public_path__ !== 'undefined') {
    return __webpack_public_path__ + filename;
  }
  return './assets/' + filename;
}

/**
 * Check if data starts with GGW1 magic bytes.
 */
export function isGGCompressed(data) {
  if (!data || data.byteLength < 4) return false;
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  return view[0] === 0x47 && view[1] === 0x47 &&
         view[2] === 0x57 && view[3] === 0x31;
}

/**
 * Decompress GGW1-compressed data.
 *
 * @param {Uint8Array|ArrayBuffer} input - Compressed data
 * @returns {Uint8Array} Decompressed data
 */
export function decompress(input) {
  if (!_mod) throw new Error('Decompressor not initialized. Call initDecompressor() first.');

  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (data.length === 0) return new Uint8Array(0);

  // Input size guard
  if (data.length > MAX_INPUT_SIZE) {
    throw new Error(`Input too large (${data.length} bytes, max ${MAX_INPUT_SIZE})`);
  }

  const inputPtr = _mod._malloc(data.length);
  const outPtrPtr = _mod._malloc(4);
  const outLenPtr = _mod._malloc(4);

  if (!inputPtr || !outPtrPtr || !outLenPtr) {
    if (inputPtr) _mod._free(inputPtr);
    if (outPtrPtr) _mod._free(outPtrPtr);
    if (outLenPtr) _mod._free(outLenPtr);
    throw new Error('WASM malloc failed — heap exhausted');
  }

  try {
    _mod.HEAPU8.set(data, inputPtr);
    _mod.setValue(outPtrPtr, 0, 'i32');
    _mod.setValue(outLenPtr, 0, 'i32');

    const rc = _mod._gg_web_decompress(inputPtr, data.length, outPtrPtr, outLenPtr);
    if (rc !== 0) throw new Error(`GG decompression failed (code ${rc})`);

    const outPtr = _mod.getValue(outPtrPtr, 'i32');
    const outLen = _mod.getValue(outLenPtr, 'i32');

    // Output size guard — prevent OOM from malicious payloads
    if (outLen > _maxDecompressSize) {
      _mod._gg_web_free(outPtr);
      throw new Error(
        `Decompressed size ${outLen} exceeds limit ${_maxDecompressSize} (possible zip bomb)`
      );
    }

    // Inner try to ensure outPtr is freed even if Uint8Array alloc fails
    let result;
    try {
      result = new Uint8Array(outLen);
      result.set(_mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    } finally {
      _mod._gg_web_free(outPtr);
    }
    return result;
  } finally {
    _mod._free(inputPtr);
    _mod._free(outPtrPtr);
    _mod._free(outLenPtr);
  }
}

/**
 * Decompress and decode as UTF-8 string.
 */
export function decompressText(input) {
  const bytes = decompress(input);
  return new TextDecoder().decode(bytes);
}

/**
 * Get decompressor status.
 */
export function getStatus() {
  return {
    initialized: _mod !== null,
    wasmSupported: isWasmSupported(),
    platform: getPlatform(),
  };
}

/**
 * Reset the decompressor (for testing).
 */
export function resetDecompressor() {
  _mod = null;
  _loading = null;
}
