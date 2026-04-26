/**
 * greedyguy-wasm — GreedyGuy compression via WebAssembly
 */

export interface InitOptions {
  /** URL or file path to greedyguy.wasm */
  wasmUrl?: string;
  /** URL or file path to the Emscripten glue JS */
  glueUrl?: string;
  /** Pre-loaded WASM binary */
  wasmBinary?: ArrayBuffer;
  /** Pre-imported Emscripten glue factory function */
  glueModule?: (moduleArg?: object) => Promise<object>;
}

export interface ModuleStatus {
  /** Whether the WASM module is initialized and ready */
  initialized: boolean;
  /** Whether the WASM module is currently loading */
  loading: boolean;
}

/**
 * Initialize the WASM module. Must be called before compress/decompress.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function init(opts?: InitOptions): Promise<void>;

/**
 * Compress data using the GGW1 web profile.
 * @param input - Raw data to compress (max 50 MB)
 * @returns GGW1-compressed output
 * @throws If module is not initialized or compression fails
 */
export function compress(input: Uint8Array | Buffer): Uint8Array;

/**
 * Decompress GGW1-compressed data.
 * @param input - GGW1-compressed data (max 256 MB)
 * @returns Decompressed output
 * @throws If module is not initialized, input is not GGW1, or decompression fails
 */
export function decompress(input: Uint8Array | Buffer): Uint8Array;

/**
 * Decompress GGW1-compressed data and decode as a UTF-8 string.
 * @param input - GGW1-compressed data
 * @returns Decompressed UTF-8 text
 */
export function decompressText(input: Uint8Array | Buffer): string;

/**
 * Check if data has a valid GGW1 magic header (0x47 0x47 0x57 0x31).
 * @param data - Data to check
 * @returns true if first 4 bytes match "GGW1"
 */
export function isGGCompressed(data: Uint8Array | Buffer): boolean;

/**
 * Check if WebAssembly is supported in the current environment.
 */
export function isWasmSupported(): boolean;

/**
 * Get the current status of the WASM module.
 */
export function getStatus(): ModuleStatus;

/**
 * Reset (unload) the WASM module, freeing resources.
 * After calling reset(), init() must be called again before compress/decompress.
 */
export function reset(): void;
