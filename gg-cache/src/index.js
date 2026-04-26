/**
 * GG-Cache — Compressed cache manager powered by GreedyGuy WASM.
 *
 * @module gg-cache
 * @creator Q3JlYXRlZCBieSBAcGF1bHRzdW5ueQ==
 */

export { GGCache } from './cache.js';
export { GGCompressor, NoopCompressor } from './compressor.js';
export { MemoryStore } from './stores/memory.js';
export { FileStore } from './stores/fs.js';
export { cacheFirst, networkFirst, staleWhileRevalidate, cacheOnly, networkOnly } from './strategies.js';
