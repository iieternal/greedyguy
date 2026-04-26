/**
 * greedyguy-web — TypeScript declarations
 */

export interface InitOptions {
  /** URL to greedyguy.wasm (auto-detected if omitted) */
  wasmUrl?: string;
  /** URL to Emscripten glue JS (auto-detected if omitted) */
  glueUrl?: string;
  /** Pre-fetched WASM binary */
  wasmBinary?: ArrayBuffer;
  /** Pre-imported glue factory function */
  glueModule?: (...args: any[]) => Promise<any>;
}

export interface FetchResult {
  data: Uint8Array;
  compressed: boolean;
  ratio: number | null;
  response: Response;
}

export interface Status {
  initialized: boolean;
  loading: boolean;
  supported: boolean;
}

/** Initialize the WASM module. Must be called before compress/decompress. */
export function init(opts?: InitOptions): Promise<void>;

/** Compress raw bytes using GGW1 web profile. */
export function compress(input: Uint8Array): Uint8Array;

/** Decompress GGW1 data. */
export function decompress(input: Uint8Array): Uint8Array;

/** Compress a UTF-8 string. */
export function compressText(text: string): Uint8Array;

/** Decompress GGW1 data to a UTF-8 string. */
export function decompressText(input: Uint8Array): string;

/** Compress and encode as base64 (for embedding/transport). */
export function compressToBase64(input: Uint8Array | string): string;

/** Decompress from a base64-encoded GGW1 string. */
export function decompressFromBase64(b64: string): Uint8Array;

/** Decompress base64 GGW1 to a string. */
export function decompressBase64Text(b64: string): string;

/** Check if data starts with GGW1 magic header. */
export function isCompressed(data: Uint8Array): boolean;

/** Check if WebAssembly is supported. */
export function isSupported(): boolean;

/** Get module status. */
export function status(): Status;

/** Unload the WASM module and free resources. */
export function destroy(): void;

/** Fetch a URL, auto-decompress if GGW1. */
export function fetchAndDecompress(url: string, fetchOpts?: RequestInit): Promise<FetchResult>;

/** Global interface for script-tag usage (window.GreedyGuy). */
export as namespace GreedyGuy;
