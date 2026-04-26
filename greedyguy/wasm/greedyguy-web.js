/**
 * GreedyGuy WASM — Browser API
 *
 * Loads the WASM module and provides compress/decompress as async functions.
 * Uses the web profile (GGW1 format, ~20MB RAM).
 *
 * Usage:
 *   import { compress, decompress } from './greedyguy-web.js';
 *   const compressed = await compress(new Uint8Array([...]));
 *   const original = await decompress(compressed);
 */

let wasmModule = null;
let wasmReady = null;

// Resolve the WASM URL relative to this module
const WASM_BASE = new URL('./', import.meta.url).href;

async function ensureLoaded() {
    if (wasmModule) return wasmModule;
    if (wasmReady) return wasmReady;

    wasmReady = (async () => {
        // Dynamic import of the Emscripten glue
        const { default: createGreedyGuy } = await import(WASM_BASE + 'dist/greedyguy.js');
        wasmModule = await createGreedyGuy({
            locateFile: (path) => WASM_BASE + 'dist/' + path
        });
        return wasmModule;
    })();

    wasmModule = await wasmReady;
    return wasmModule;
}

/**
 * Compress data using GreedyGuy web profile (GGW1 format).
 * @param {Uint8Array} input - Data to compress
 * @returns {Promise<Uint8Array>} Compressed data
 */
export async function compress(input) {
    const mod = await ensureLoaded();

    if (!(input instanceof Uint8Array)) {
        if (typeof input === 'string') {
            input = new TextEncoder().encode(input);
        } else {
            throw new TypeError('Input must be Uint8Array or string');
        }
    }

    const inputLen = input.length;
    const inputPtr = mod._malloc(inputLen);
    if (!inputPtr && inputLen > 0) throw new Error('WASM malloc failed');

    // Allocate output pointer + length (each 4 bytes)
    const outPtrPtr = mod._malloc(4);
    const outLenPtr = mod._malloc(4);

    try {
        mod.HEAPU8.set(input, inputPtr);
        mod.setValue(outPtrPtr, 0, 'i32');
        mod.setValue(outLenPtr, 0, 'i32');

        const rc = mod._gg_web_compress(inputPtr, inputLen, outPtrPtr, outLenPtr);
        if (rc !== 0) throw new Error(`Compression failed (code ${rc})`);

        const outPtr = mod.getValue(outPtrPtr, 'i32');
        const outLen = mod.getValue(outLenPtr, 'i32');

        const result = new Uint8Array(outLen);
        result.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
        mod._gg_web_free(outPtr);

        return result;
    } finally {
        mod._free(inputPtr);
        mod._free(outPtrPtr);
        mod._free(outLenPtr);
    }
}

/**
 * Decompress GGW1-compressed data.
 * @param {Uint8Array} input - Compressed data (GGW1 format)
 * @returns {Promise<Uint8Array>} Decompressed data
 */
export async function decompress(input) {
    const mod = await ensureLoaded();

    if (!(input instanceof Uint8Array)) {
        throw new TypeError('Input must be Uint8Array');
    }

    const inputLen = input.length;
    const inputPtr = mod._malloc(inputLen);
    if (!inputPtr && inputLen > 0) throw new Error('WASM malloc failed');

    const outPtrPtr = mod._malloc(4);
    const outLenPtr = mod._malloc(4);

    try {
        mod.HEAPU8.set(input, inputPtr);
        mod.setValue(outPtrPtr, 0, 'i32');
        mod.setValue(outLenPtr, 0, 'i32');

        const rc = mod._gg_web_decompress(inputPtr, inputLen, outPtrPtr, outLenPtr);
        if (rc !== 0) throw new Error(`Decompression failed (code ${rc})`);

        const outPtr = mod.getValue(outPtrPtr, 'i32');
        const outLen = mod.getValue(outLenPtr, 'i32');

        const result = new Uint8Array(outLen);
        result.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
        mod._gg_web_free(outPtr);

        return result;
    } finally {
        mod._free(inputPtr);
        mod._free(outPtrPtr);
        mod._free(outLenPtr);
    }
}

/**
 * Decompress and decode as UTF-8 string.
 * @param {Uint8Array} input - Compressed data
 * @returns {Promise<string>} Decompressed text
 */
export async function decompressText(input) {
    const bytes = await decompress(input);
    return new TextDecoder().decode(bytes);
}

/**
 * Check if data looks like GGW1-compressed.
 * @param {Uint8Array} data
 * @returns {boolean}
 */
export function isCompressed(data) {
    if (!data || data.length < 8) return false;
    return data[0] === 0x47 && data[1] === 0x47 &&
           data[2] === 0x57 && data[3] === 0x31;  // "GGW1"
}

export default { compress, decompress, decompressText, isCompressed };
