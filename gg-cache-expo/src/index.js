/**
 * gg-cache-expo — GreedyGuy decompression for Expo/React Native.
 *
 * Transparent GGW1 response decompression on Android, iOS, and Web.
 *
 * @module gg-cache-expo
 * @creator Q3JlYXRlZCBieSBAcGF1bHRzdW5ueQ==
 */

// Core decompressor
export {
  initDecompressor,
  decompress,
  decompressText,
  isGGCompressed,
  isWasmSupported,
  getStatus,
  resetDecompressor,
} from './decompressor.js';

// Fetch wrappers
export { createGGFetch, ggFetch } from './ggFetch.js';

// Global interceptor
export { installGlobalInterceptor, removeGlobalInterceptor } from './interceptor.js';

// Request compression (client → server)
export { createCompressingFetch } from './requestCompressor.js';

// React components and hooks
export { GGProvider, useGG, useGGFetch, GGContext } from './GGProvider.js';
