/**
 * GGCache — Compressed cache manager with LRU + TTL.
 *
 * Transparently compresses cacheable content using GreedyGuy WASM,
 * storing compressed data in a pluggable backend (memory, filesystem, etc.).
 */

import { GGCompressor, NoopCompressor } from './compressor.js';
import { MemoryStore } from './stores/memory.js';

// Content types worth compressing (text-based, not already compressed)
const COMPRESSIBLE_TYPES = new Set([
  'text/html', 'text/css', 'text/javascript', 'text/plain', 'text/xml',
  'text/csv', 'text/markdown',
  'application/json', 'application/xml', 'application/javascript',
  'application/xhtml+xml', 'application/rss+xml', 'application/atom+xml',
  'application/ld+json', 'application/graphql+json',
  'application/manifest+json', 'application/vnd.api+json',
  'image/svg+xml',
]);

// Content types that are already compressed — never compress these
const INCOMPRESSIBLE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/ogg',
  'audio/mpeg', 'audio/ogg', 'audio/webm',
  'font/woff', 'font/woff2',
  'application/gzip', 'application/zip', 'application/zstd',
  'application/br', 'application/x-bzip2',
]);

export class GGCache {
  #store;
  #compressor;
  #defaultTTL;
  #minCompressSize;
  #compressible;
  #stats;
  #sweepTimer;

  /**
   * @param {object} [opts]
   * @param {object}  [opts.store]          - Storage backend (default: MemoryStore)
   * @param {object}  [opts.compressor]     - Compressor (default: GGCompressor)
   * @param {number}  [opts.ttl=3600]       - Default TTL in seconds (0 = no expiry)
   * @param {number}  [opts.minCompressSize=512] - Min bytes to compress
   * @param {number}  [opts.maxSize]        - Max cache size in bytes (passed to default store)
   * @param {Set}     [opts.compressible]   - Content types to compress
   * @param {number}  [opts.sweepInterval=60000] - TTL sweep interval in ms (0 = disabled)
   * @param {string}  [opts.wasmPath]       - Path/URL to WASM files
   */
  constructor(opts = {}) {
    this.#store = opts.store || new MemoryStore({ maxSize: opts.maxSize });
    this.#defaultTTL = opts.ttl ?? 3600;
    this.#minCompressSize = opts.minCompressSize ?? 512;
    this.#compressible = opts.compressible || COMPRESSIBLE_TYPES;

    if (opts.compressor) {
      this.#compressor = opts.compressor;
    } else if (opts.compress === false) {
      this.#compressor = new NoopCompressor();
    } else {
      this.#compressor = new GGCompressor({ wasmPath: opts.wasmPath });
    }

    this.#stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0,
      bytesIn: 0,
      bytesStored: 0,
      compressTimeMs: 0,
      decompressTimeMs: 0,
    };

    const sweepMs = opts.sweepInterval ?? 60000;
    if (sweepMs > 0) {
      this.#sweepTimer = setInterval(() => this.#store.sweep?.(), sweepMs);
      if (this.#sweepTimer.unref) this.#sweepTimer.unref();
    }
  }

  /**
   * Initialize the compressor (loads WASM). Must call before get/set.
   */
  async init() {
    await this.#compressor.init();
  }

  /**
   * Cache a value.
   *
   * @param {string} key - Cache key (usually the URL)
   * @param {Uint8Array|Buffer|string} value - Data to cache
   * @param {object} [opts]
   * @param {number}  [opts.ttl]         - TTL in seconds (overrides default)
   * @param {string}  [opts.contentType] - MIME type (for compression decisions)
   * @param {object}  [opts.meta]        - Arbitrary metadata to store
   */
  async set(key, value, opts = {}) {
    const ttl = opts.ttl ?? this.#defaultTTL;
    let data = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    const originalSize = data.length;

    let compressed = false;
    const shouldCompress = this.#shouldCompress(data, opts.contentType);

    if (shouldCompress) {
      const t0 = performance.now();
      try {
        const cdata = this.#compressor.compress(data);
        // Only use compressed version if it's actually smaller
        if (cdata.length < data.length) {
          data = cdata;
          compressed = true;
        }
      } catch {
        // Compression failed — store uncompressed
      }
      this.#stats.compressTimeMs += performance.now() - t0;
    }

    const entry = {
      data,
      size: data.length,
      expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : null,
      meta: {
        ...opts.meta,
        contentType: opts.contentType || 'application/octet-stream',
        originalSize,
        compressed,
        createdAt: Date.now(),
      },
    };

    await this.#store.set(key, entry);

    this.#stats.sets++;
    this.#stats.bytesIn += originalSize;
    this.#stats.bytesStored += data.length;
  }

  /**
   * Retrieve a cached value.
   * @param {string} key
   * @returns {Promise<{ data: Uint8Array, meta: object } | null>}
   */
  async get(key) {
    const entry = await this.#store.get(key);
    if (!entry) {
      this.#stats.misses++;
      return null;
    }

    this.#stats.hits++;

    let data = entry.data;
    if (entry.meta?.compressed) {
      const t0 = performance.now();
      try {
        data = this.#compressor.decompress(data);
      } catch (err) {
        // Decompression failed — evict corrupt entry
        await this.#store.delete(key);
        this.#stats.misses++;
        this.#stats.hits--;
        return null;
      }
      this.#stats.decompressTimeMs += performance.now() - t0;
    }

    return { data, meta: entry.meta };
  }

  /**
   * Get cached value as UTF-8 string.
   */
  async getText(key) {
    const result = await this.get(key);
    if (!result) return null;
    return {
      data: new TextDecoder().decode(result.data),
      meta: result.meta,
    };
  }

  /**
   * Check if key exists (without refreshing or decompressing).
   */
  async has(key) {
    return this.#store.has(key);
  }

  /** Delete a specific key. */
  async delete(key) {
    return this.#store.delete(key);
  }

  /** Clear all entries. */
  async clear() {
    return this.#store.clear();
  }

  /** List all live keys. */
  async keys() {
    return this.#store.keys();
  }

  /**
   * Get cache statistics.
   */
  stats() {
    const store = this.#store.stats?.() || {};
    return {
      ...this.#stats,
      hitRate: this.#stats.hits + this.#stats.misses > 0
        ? this.#stats.hits / (this.#stats.hits + this.#stats.misses)
        : 0,
      compressionRatio: this.#stats.bytesIn > 0
        ? this.#stats.bytesIn / this.#stats.bytesStored
        : 1,
      store,
    };
  }

  /**
   * Destroy the cache — stop timers and clear storage.
   */
  async destroy() {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    await this.#store.clear();
  }

  #shouldCompress(data, contentType) {
    if (data.length < this.#minCompressSize) return false;

    if (contentType) {
      const base = contentType.split(';')[0].trim().toLowerCase();
      if (INCOMPRESSIBLE_TYPES.has(base)) return false;
      if (this.#compressible.has(base)) return true;
    }

    // Heuristic: check if data looks like text (high ASCII density)
    const sample = data.subarray(0, Math.min(512, data.length));
    let textChars = 0;
    for (let i = 0; i < sample.length; i++) {
      const b = sample[i];
      if ((b >= 0x20 && b <= 0x7E) || b === 0x09 || b === 0x0A || b === 0x0D) {
        textChars++;
      }
    }
    return textChars / sample.length > 0.85;
  }
}
