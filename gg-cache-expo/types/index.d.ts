/**
 * gg-cache-expo — TypeScript definitions
 *
 * GreedyGuy decompression for Expo / React Native.
 * Transparent GGW1 response decompression on Android, iOS, and Web.
 */

// --- Decompressor ---

export interface InitOptions {
  /** URL or path to greedyguy.wasm */
  wasmUrl?: string;
  /** URL or path to greedyguy.js Emscripten glue */
  glueUrl?: string;
  /** Pre-loaded WASM binary */
  wasmBinary?: ArrayBuffer;
  /** Pre-imported Emscripten glue factory function */
  glueModule?: () => Promise<any>;
}

export interface DecompressorStatus {
  initialized: boolean;
  wasmSupported: boolean;
  platform: 'web' | 'native' | 'node' | 'unknown';
}

/**
 * Initialize the WASM decompressor module.
 * Must be called before compress/decompress.
 */
export function initDecompressor(opts?: InitOptions): Promise<void>;

/**
 * Decompress GGW1-compressed data.
 * @throws if module not initialized or data is corrupt
 */
export function decompress(data: Uint8Array | ArrayBuffer): Uint8Array;

/**
 * Decompress GGW1 data and decode as UTF-8 string.
 */
export function decompressText(data: Uint8Array | ArrayBuffer): string;

/**
 * Check if data starts with GGW1 magic header.
 */
export function isGGCompressed(data: Uint8Array | ArrayBuffer): boolean;

/**
 * Check if WebAssembly is supported in this environment.
 */
export function isWasmSupported(): boolean;

/**
 * Get current decompressor status.
 */
export function getStatus(): DecompressorStatus;

/**
 * Reset (unload) the decompressor module.
 */
export function resetDecompressor(): void;

// --- Fetch ---

export interface GGFetchOptions {
  /** Options passed to initDecompressor */
  initOpts?: InitOptions;
  /** Auto-decompress GGW1 responses (default: true) */
  autoDecompress?: boolean;
  /** Request headers to add */
  headers?: Record<string, string>;
}

/**
 * Create a configured auto-decompressing fetch wrapper.
 */
export function createGGFetch(opts?: GGFetchOptions): typeof globalThis.fetch;

/**
 * Default auto-decompressing fetch instance.
 */
export const ggFetch: typeof globalThis.fetch;

// --- Global Interceptor ---

export interface InterceptorOptions extends InitOptions {
  /** URL patterns to include (regex). If set, only matching URLs are intercepted. */
  include?: RegExp[];
  /** URL patterns to exclude (regex). Checked after include. */
  exclude?: RegExp[];
  /** Callback on successful decompression */
  onDecompress?: (url: string, compressedSize: number, originalSize: number) => void;
}

/**
 * Patch globalThis.fetch to auto-decompress GGW1 responses.
 */
export function installGlobalInterceptor(opts?: InterceptorOptions): Promise<void>;

/**
 * Restore the original fetch function.
 */
export function removeGlobalInterceptor(): void;

// --- Request Compression ---

export interface CompressingFetchOptions {
  /** REQUIRED: regex patterns for endpoints that accept GGW1 */
  endpoints: RegExp[];
  /** Minimum body size to compress (default: 5120 = 5KB) */
  minSize?: number;
  /** Maximum body size to compress (default: 10485760 = 10MB) */
  maxSize?: number;
  /** Fall back to uncompressed on error (default: true) */
  fallbackOnError?: boolean;
  /** Custom base fetch function */
  baseFetch?: typeof globalThis.fetch;
}

/**
 * Create a fetch wrapper that compresses request bodies for matching endpoints.
 * Requires explicit endpoint opt-in — throws if endpoints not provided.
 */
export function createCompressingFetch(opts: CompressingFetchOptions): typeof globalThis.fetch;

// --- React Components & Hooks ---

import { ComponentType, ReactNode } from 'react';

export interface GGProviderProps {
  children: ReactNode;
  /** URL to greedyguy.wasm */
  wasmUrl?: string;
  /** URL to greedyguy.js glue */
  glueUrl?: string;
  /** Pre-loaded WASM binary */
  wasmBinary?: ArrayBuffer;
  /** Pre-imported Emscripten glue factory */
  glueModule?: () => Promise<any>;
  /** Content to show while WASM loads */
  fallback?: ReactNode;
}

export interface GGContextValue {
  ready: boolean;
  error: Error | null;
  decompress: typeof decompress;
  decompressText: typeof decompressText;
  isGGCompressed: typeof isGGCompressed;
}

export interface UseGGFetchOptions {
  /** Parse response as JSON */
  json?: boolean;
  /** Parse response as text */
  text?: boolean;
  /** Auto-fetch on mount (default: true) */
  auto?: boolean;
}

export interface UseGGFetchResult<T = any> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Whether the response was GGW1-compressed */
  compressed: boolean;
  /** Decompression ratio (e.g., 8.2) */
  ratio: number | null;
  /** Re-fetch the URL */
  refetch: () => Promise<T>;
}

/**
 * React context provider — initializes WASM decompressor.
 */
export const GGProvider: ComponentType<GGProviderProps>;

/**
 * React context for GreedyGuy decompressor.
 */
export const GGContext: React.Context<GGContextValue>;

/**
 * Hook to access the GG decompressor from context.
 */
export function useGG(): GGContextValue;

/**
 * Hook that fetches a URL with auto-decompression.
 */
export function useGGFetch<T = any>(url: string, opts?: UseGGFetchOptions): UseGGFetchResult<T>;
