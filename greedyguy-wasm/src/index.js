/**
 * greedyguy-wasm — GreedyGuy compression via WebAssembly
 *
 * Context-mixing + arithmetic coding in ~29KB of WASM.
 * Uses GGW1 web profile (~20MB RAM instead of 764MB).
 *
 * @creator Q3JlYXRlZCBieSBAcGF1bHRzdW5ueQ==
 */

const GGW1_MAGIC = [0x47, 0x47, 0x57, 0x31]; // "GGW1"
const MAX_INPUT_SIZE = 50 * 1024 * 1024;       // 50 MB
const MAX_DECOMPRESS_SIZE = 256 * 1024 * 1024;  // 256 MB

let _mod = null;
let _loading = null;

/**
 * Detect whether we are running in Node.js.
 */
function isNode() {
  return (
    typeof globalThis.process !== 'undefined' &&
    globalThis.process.versions != null &&
    globalThis.process.versions.node != null
  );
}

/**
 * Initialize the WASM module.
 *
 * @param {object} [opts]
 * @param {string} [opts.wasmUrl]       - URL/path to greedyguy.wasm
 * @param {string} [opts.glueUrl]       - URL/path to greedyguy.js glue
 * @param {ArrayBuffer} [opts.wasmBinary] - Pre-loaded WASM binary
 * @param {Function} [opts.glueModule]    - Pre-imported glue factory
 * @returns {Promise<void>}
 */
export async function init(opts = {}) {
  if (_mod) return;

  if (_loading) {
    await _loading;
    return;
  }

  _loading = (async () => {
    try {
      // --- Resolve the glue factory ---
      let factory = opts.glueModule;

      if (!factory) {
        if (isNode()) {
          const { pathToFileURL } = await import('node:url');
          const { join, dirname } = await import('node:path');
          const { fileURLToPath } = await import('node:url');

          const glueUrl =
            opts.glueUrl ||
            join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'greedyguy.js');

          const mod = await import(pathToFileURL(glueUrl).href);
          factory = mod.default;
        } else {
          // Browser / Worker
          const glueUrl =
            opts.glueUrl ||
            new URL('../dist/greedyguy.js', import.meta.url).href;
          const mod = await import(/* webpackIgnore: true */ glueUrl);
          factory = mod.default;
        }
      }

      // --- Resolve WASM binary ---
      const moduleArgs = {};

      if (opts.wasmBinary) {
        moduleArgs.wasmBinary = opts.wasmBinary;
      } else if (opts.wasmUrl) {
        if (isNode()) {
          const { readFile } = await import('node:fs/promises');
          const buf = await readFile(opts.wasmUrl);
          moduleArgs.wasmBinary = buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength,
          );
        } else {
          const resp = await fetch(opts.wasmUrl);
          moduleArgs.wasmBinary = await resp.arrayBuffer();
        }
      } else if (isNode()) {
        const { readFile } = await import('node:fs/promises');
        const { join, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');

        const wasmPath = join(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          'dist',
          'greedyguy.wasm',
        );
        const buf = await readFile(wasmPath);
        moduleArgs.wasmBinary = buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        );
      } else {
        // Browser — let Emscripten locate it relative to glue
        const wasmUrl = new URL('../dist/greedyguy.wasm', import.meta.url).href;
        moduleArgs.locateFile = (path) => {
          if (path.endsWith('.wasm')) return wasmUrl;
          return path;
        };
      }

      _mod = await factory(moduleArgs);
    } catch (err) {
      _loading = null;
      throw err;
    }
  })();

  await _loading;
}

/**
 * Ensure the module is initialized. Throws if not.
 */
function ensureReady() {
  if (!_mod) {
    throw new Error(
      'greedyguy-wasm: Module not initialized. Call init() first.',
    );
  }
}

/**
 * Compress data using the GGW1 web profile.
 *
 * @param {Uint8Array|Buffer} input - Raw data to compress
 * @returns {Uint8Array} GGW1-compressed output
 */
export function compress(input) {
  ensureReady();

  if (!(input instanceof Uint8Array)) {
    throw new TypeError('compress: input must be a Uint8Array or Buffer');
  }
  if (input.length === 0) {
    throw new RangeError('compress: input must not be empty');
  }
  if (input.length > MAX_INPUT_SIZE) {
    throw new RangeError(
      `compress: input exceeds maximum size of ${MAX_INPUT_SIZE} bytes (${(MAX_INPUT_SIZE / 1024 / 1024) | 0} MB)`,
    );
  }

  // Allocate input buffer
  const inputPtr = _mod._malloc(input.length);
  if (!inputPtr) {
    throw new Error('compress: failed to allocate input buffer');
  }

  // Allocate out-params: uint8_t** output, uint32_t* output_len
  const outPtrPtr = _mod._malloc(4);
  const outLenPtr = _mod._malloc(4);
  if (!outPtrPtr || !outLenPtr) {
    if (outPtrPtr) _mod._free(outPtrPtr);
    if (outLenPtr) _mod._free(outLenPtr);
    _mod._free(inputPtr);
    throw new Error('compress: failed to allocate output-param buffers');
  }

  let outPtr = 0;
  try {
    _mod.HEAPU8.set(input, inputPtr);
    _mod.setValue(outPtrPtr, 0, 'i32');
    _mod.setValue(outLenPtr, 0, 'i32');

    const rc = _mod._gg_web_compress(inputPtr, input.length, outPtrPtr, outLenPtr);

    if (rc !== 0) {
      throw new Error(`compress: WASM compression failed (rc=${rc})`);
    }

    outPtr = _mod.getValue(outPtrPtr, 'i32');
    const outLen = _mod.getValue(outLenPtr, 'i32');

    if (!outPtr || outLen === 0) {
      throw new Error('compress: WASM returned empty output');
    }

    const result = new Uint8Array(outLen);
    result.set(_mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    return result;
  } finally {
    if (outPtr) _mod._gg_web_free(outPtr);
    _mod._free(outLenPtr);
    _mod._free(outPtrPtr);
    _mod._free(inputPtr);
  }
}

/**
 * Decompress GGW1 data.
 *
 * @param {Uint8Array|Buffer} input - GGW1-compressed data
 * @returns {Uint8Array} Decompressed output
 */
export function decompress(input) {
  ensureReady();

  if (!(input instanceof Uint8Array)) {
    throw new TypeError('decompress: input must be a Uint8Array or Buffer');
  }
  if (input.length === 0) {
    throw new RangeError('decompress: input must not be empty');
  }
  if (input.length > MAX_DECOMPRESS_SIZE) {
    throw new RangeError(
      `decompress: input exceeds maximum size of ${MAX_DECOMPRESS_SIZE} bytes (${(MAX_DECOMPRESS_SIZE / 1024 / 1024) | 0} MB)`,
    );
  }

  if (!isGGCompressed(input)) {
    throw new Error('decompress: input does not have valid GGW1 header');
  }

  // Pre-validate: GGW1 stores original size in bytes 4-7 (LE uint32)
  if (input.length >= 8) {
    const claimedSize = input[4] | (input[5] << 8) |
      (input[6] << 16) | ((input[7] << 24) >>> 0);
    if (claimedSize > MAX_DECOMPRESS_SIZE) {
      throw new RangeError(
        `decompress: GGW1 header claims ${claimedSize} bytes, exceeds ${MAX_DECOMPRESS_SIZE} limit`
      );
    }
    const ratio = claimedSize / input.length;
    if (ratio > 1000) {
      throw new RangeError(
        `decompress: expansion ratio ${ratio.toFixed(0)}x exceeds 1000x safety limit`
      );
    }
  }

  // Allocate input buffer
  const inputPtr = _mod._malloc(input.length);
  if (!inputPtr) {
    throw new Error('decompress: failed to allocate input buffer');
  }

  // Allocate out-params: uint8_t** output, uint32_t* output_len
  const outPtrPtr = _mod._malloc(4);
  const outLenPtr = _mod._malloc(4);
  if (!outPtrPtr || !outLenPtr) {
    if (outPtrPtr) _mod._free(outPtrPtr);
    if (outLenPtr) _mod._free(outLenPtr);
    _mod._free(inputPtr);
    throw new Error('decompress: failed to allocate output-param buffers');
  }

  let outPtr = 0;
  try {
    _mod.HEAPU8.set(input, inputPtr);
    _mod.setValue(outPtrPtr, 0, 'i32');
    _mod.setValue(outLenPtr, 0, 'i32');

    const rc = _mod._gg_web_decompress(inputPtr, input.length, outPtrPtr, outLenPtr);

    if (rc !== 0) {
      throw new Error(`decompress: WASM decompression failed (rc=${rc})`);
    }

    outPtr = _mod.getValue(outPtrPtr, 'i32');
    const outLen = _mod.getValue(outLenPtr, 'i32');

    if (!outPtr || outLen === 0) {
      throw new Error('decompress: WASM returned empty output');
    }

    const result = new Uint8Array(outLen);
    result.set(_mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    return result;
  } finally {
    if (outPtr) _mod._gg_web_free(outPtr);
    _mod._free(outLenPtr);
    _mod._free(outPtrPtr);
    _mod._free(inputPtr);
  }
}

/**
 * Decompress GGW1 data and decode as UTF-8 string.
 *
 * @param {Uint8Array|Buffer} input - GGW1-compressed data
 * @returns {string} Decompressed text
 */
export function decompressText(input) {
  const bytes = decompress(input);
  return new TextDecoder().decode(bytes);
}

/**
 * Check if data has a valid GGW1 magic header.
 *
 * @param {Uint8Array|Buffer} data
 * @returns {boolean}
 */
export function isGGCompressed(data) {
  if (!data || data.length < 4) return false;
  return (
    data[0] === GGW1_MAGIC[0] &&
    data[1] === GGW1_MAGIC[1] &&
    data[2] === GGW1_MAGIC[2] &&
    data[3] === GGW1_MAGIC[3]
  );
}

/**
 * Check if WebAssembly is supported in the current environment.
 *
 * @returns {boolean}
 */
export function isWasmSupported() {
  try {
    if (
      typeof WebAssembly === 'object' &&
      typeof WebAssembly.instantiate === 'function'
    ) {
      const mod = new WebAssembly.Module(
        new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      );
      return mod instanceof WebAssembly.Module;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Get the current module status.
 *
 * @returns {{ initialized: boolean, loading: boolean }}
 */
export function getStatus() {
  return {
    initialized: _mod !== null,
    loading: _loading !== null && _mod === null,
  };
}

/**
 * Reset (unload) the WASM module, freeing resources.
 */
export function reset() {
  _mod = null;
  _loading = null;
}
