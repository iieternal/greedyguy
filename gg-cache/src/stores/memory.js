/**
 * MemoryStore — In-memory LRU storage backend.
 *
 * Uses a Map (insertion-ordered) for O(1) get/set/delete,
 * with LRU eviction by re-inserting on access.
 */

export class MemoryStore {
  #map = new Map();
  #currentSize = 0;  // total bytes stored
  #maxSize;

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSize=104857600] - Max bytes (default 100MB)
   */
  constructor(opts = {}) {
    this.#maxSize = opts.maxSize ?? 100 * 1024 * 1024;
  }

  /**
   * Get an entry. Returns null if not found or expired.
   * Refreshes LRU position on access.
   */
  async get(key) {
    const entry = this.#map.get(key);
    if (!entry) return null;

    // Check TTL
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.#evict(key, entry);
      return null;
    }

    // LRU refresh: delete and re-insert to move to end
    this.#map.delete(key);
    entry.lastAccess = Date.now();
    this.#map.set(key, entry);

    return entry;
  }

  /**
   * Store an entry.
   * @param {string} key
   * @param {object} entry - { data: Uint8Array|Buffer, meta: object, size: number, expiresAt: number|null }
   */
  async set(key, entry) {
    // Remove old entry if exists
    const old = this.#map.get(key);
    if (old) {
      this.#currentSize -= old.size;
      this.#map.delete(key);
    }

    // Evict LRU entries until we have space
    while (this.#currentSize + entry.size > this.#maxSize && this.#map.size > 0) {
      const [oldestKey] = this.#map.keys();
      const oldest = this.#map.get(oldestKey);
      this.#evict(oldestKey, oldest);
    }

    entry.lastAccess = Date.now();
    this.#map.set(key, entry);
    this.#currentSize += entry.size;
  }

  async has(key) {
    const entry = this.#map.get(key);
    if (!entry) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.#evict(key, entry);
      return false;
    }
    return true;
  }

  async delete(key) {
    const entry = this.#map.get(key);
    if (entry) {
      this.#evict(key, entry);
      return true;
    }
    return false;
  }

  async clear() {
    this.#map.clear();
    this.#currentSize = 0;
  }

  async keys() {
    // Purge expired entries during iteration
    const now = Date.now();
    const live = [];
    for (const [key, entry] of this.#map) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.#evict(key, entry);
      } else {
        live.push(key);
      }
    }
    return live;
  }

  get size() { return this.#map.size; }
  get bytes() { return this.#currentSize; }
  get maxSize() { return this.#maxSize; }

  stats() {
    return {
      entries: this.#map.size,
      bytes: this.#currentSize,
      maxSize: this.#maxSize,
      utilization: this.#maxSize > 0 ? this.#currentSize / this.#maxSize : 0,
    };
  }

  #evict(key, entry) {
    this.#currentSize -= entry.size;
    this.#map.delete(key);
  }

  /**
   * Run a passive TTL sweep — remove all expired entries.
   * Call periodically if you want proactive cleanup.
   */
  async sweep() {
    const now = Date.now();
    let swept = 0;
    for (const [key, entry] of this.#map) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.#evict(key, entry);
        swept++;
      }
    }
    return swept;
  }
}
