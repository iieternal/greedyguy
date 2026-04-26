/**
 * GG Compressor — WASM-based compression engine.
 *
 * Loads the GreedyGuy WASM module once, then provides synchronous
 * compress/decompress via the _gg_web_compress/_gg_web_decompress exports.
 * Works in both Node.js and browser environments.
 */

const GGW1_MAGIC = new Uint8Array([0x47, 0x47, 0x57, 0x31]); // "GGW1"

export class GGCompressor {
  #mod = null;
  #ready = null;
  #wasmPath;

  /**
   * @param {object} [opts]
   * @param {string} [opts.wasmPath] - Path to greedyguy.wasm (Node.js only)
   * @param {string} [opts.wasmUrl]  - URL to greedyguy.wasm (browser only)
   */
  constructor(opts = {}) {
    this.#wasmPath = opts.wasmPath || opts.wasmUrl || null;
  }

  async init() {
    if (this.#mod) return;
    if (this.#ready) return this.#ready;

    this.#ready = this.#load();
    await this.#ready;
  }

  async #load() {
    const isNode = typeof process !== 'undefined' && process.versions?.node;

    if (isNode) {
      await this.#loadNode();
    } else {
      await this.#loadBrowser();
    }
  }

  async #loadNode() {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');

    // Find WASM files — check multiple locations
    let wasmDir;
    if (this.#wasmPath) {
      const p = await import('path');
      wasmDir = p.dirname(this.#wasmPath);
    } else {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const candidates = [
        join(thisDir, '..', 'wasm'),
        join(thisDir, '..', 'node_modules', 'greedyguy', 'wasm', 'dist'),
        join(thisDir, '..', '..', 'greedyguy', 'wasm', 'dist'),
      ];
      wasmDir = candidates.find(d => {
        try { readFileSync(join(d, 'greedyguy.wasm')); return true; }
        catch { return false; }
      });
      if (!wasmDir) {
        throw new Error(
          'Could not find greedyguy.wasm. Pass wasmPath option or install greedyguy package.'
        );
      }
    }

    const wasmBinary = readFileSync(join(wasmDir, 'greedyguy.wasm'));
    const glueUrl = join(wasmDir, 'greedyguy.js');

    // Dynamic import of the Emscripten ESM glue
    const { default: createGreedyGuy } = await import(`file://${glueUrl.replace(/\\/g, '/')}`);
    this.#mod = await createGreedyGuy({ wasmBinary });
  }

  async #loadBrowser() {
    const base = this.#wasmPath || './wasm/';
    const glueUrl = base.endsWith('/') ? base + 'greedyguy.js' : base;
    const wasmBase = glueUrl.replace(/greedyguy\.js$/, '');

    const { default: createGreedyGuy } = await import(glueUrl);
    this.#mod = await createGreedyGuy({
      locateFile: (path) => wasmBase + path,
    });
  }

  get loaded() {
    return this.#mod !== null;
  }

  /**
   * Compress a buffer using GG web profile.
   * @param {Uint8Array|Buffer} input
   * @returns {Uint8Array} compressed data (GGW1 format)
   */
  compress(input) {
    if (!this.#mod) throw new Error('Compressor not initialized. Call init() first.');
    if (input.length === 0) return new Uint8Array(0);

    const mod = this.#mod;
    const inputPtr = mod._malloc(input.length);
    const outPtrPtr = mod._malloc(4);
    const outLenPtr = mod._malloc(4);

    if (!inputPtr || !outPtrPtr || !outLenPtr) {
      if (inputPtr) mod._free(inputPtr);
      if (outPtrPtr) mod._free(outPtrPtr);
      if (outLenPtr) mod._free(outLenPtr);
      throw new Error('WASM malloc failed — heap exhausted');
    }

    try {
      mod.HEAPU8.set(input, inputPtr);
      mod.setValue(outPtrPtr, 0, 'i32');
      mod.setValue(outLenPtr, 0, 'i32');

      const rc = mod._gg_web_compress(inputPtr, input.length, outPtrPtr, outLenPtr);
      if (rc !== 0) {
        // Free any partial output allocation before throwing
        const partial = mod.getValue(outPtrPtr, 'i32');
        if (partial) mod._gg_web_free(partial);
        throw new Error(`GG compression failed (code ${rc})`);
      }

      const outPtr = mod.getValue(outPtrPtr, 'i32');
      const outLen = mod.getValue(outLenPtr, 'i32');
      let result;
      try {
        result = new Uint8Array(outLen);
        result.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
      } finally {
        mod._gg_web_free(outPtr);
      }
      return result;
    } finally {
      mod._free(inputPtr);
      mod._free(outPtrPtr);
      mod._free(outLenPtr);
    }
  }

  /**
   * Decompress GGW1-compressed data.
   * @param {Uint8Array|Buffer} input
   * @returns {Uint8Array} decompressed data
   */
  decompress(input) {
    if (!this.#mod) throw new Error('Compressor not initialized. Call init() first.');
    if (input.length === 0) return new Uint8Array(0);

    const mod = this.#mod;
    const inputPtr = mod._malloc(input.length);
    const outPtrPtr = mod._malloc(4);
    const outLenPtr = mod._malloc(4);

    if (!inputPtr || !outPtrPtr || !outLenPtr) {
      if (inputPtr) mod._free(inputPtr);
      if (outPtrPtr) mod._free(outPtrPtr);
      if (outLenPtr) mod._free(outLenPtr);
      throw new Error('WASM malloc failed — heap exhausted');
    }

    try {
      mod.HEAPU8.set(input, inputPtr);
      mod.setValue(outPtrPtr, 0, 'i32');
      mod.setValue(outLenPtr, 0, 'i32');

      const rc = mod._gg_web_decompress(inputPtr, input.length, outPtrPtr, outLenPtr);
      if (rc !== 0) {
        const partial = mod.getValue(outPtrPtr, 'i32');
        if (partial) mod._gg_web_free(partial);
        throw new Error(`GG decompression failed (code ${rc})`);
      }

      const outPtr = mod.getValue(outPtrPtr, 'i32');
      const outLen = mod.getValue(outLenPtr, 'i32');
      let result;
      try {
        result = new Uint8Array(outLen);
        result.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
      } finally {
        mod._gg_web_free(outPtr);
      }
      return result;
    } finally {
      mod._free(inputPtr);
      mod._free(outPtrPtr);
      mod._free(outLenPtr);
    }
  }

  /**
   * Check if data has the GGW1 magic header.
   */
  static isCompressed(data) {
    if (!data || data.length < 4) return false;
    return data[0] === 0x47 && data[1] === 0x47 &&
           data[2] === 0x57 && data[3] === 0x31;
  }
}

/**
 * No-op compressor for when compression is disabled or for pass-through.
 */
export class NoopCompressor {
  async init() {}
  get loaded() { return true; }
  compress(input) { return input; }
  decompress(input) { return input; }
  static isCompressed() { return false; }
}
