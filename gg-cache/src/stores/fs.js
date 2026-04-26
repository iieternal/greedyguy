/**
 * FileStore — Filesystem-backed persistent cache store.
 *
 * Each entry is stored as two files:
 *   <hash>.dat  — compressed data
 *   <hash>.meta — JSON metadata (key, contentType, ttl, size, etc.)
 *
 * Suitable for Electron apps and Node.js servers where cache
 * should survive process restarts.
 */

import { createHash } from 'crypto';
import { resolve as pathResolve, join as pathJoin } from 'path';

export class FileStore {
  #dir;
  #index = new Map();  // key → { hash, size, expiresAt }
  #currentSize = 0;
  #maxSize;
  #loaded = false;
  #mutex = Promise.resolve(); // Simple serialization mutex

  /**
   * @param {object} opts
   * @param {string} opts.dir      - Directory to store cache files
   * @param {number} [opts.maxSize] - Max bytes on disk (default 500MB)
   */
  constructor(opts) {
    if (!opts?.dir) throw new Error('FileStore requires a dir option');
    // Resolve to absolute path to prevent path traversal via relative dir
    this.#dir = pathResolve(opts.dir);
    this.#maxSize = opts.maxSize ?? 500 * 1024 * 1024;
  }

  #hash(key) {
    // Safe hash — output is always hex chars, no path traversal possible
    return createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
  }

  // Serialize mutating operations to prevent concurrent size accounting corruption
  #withLock(fn) {
    const prev = this.#mutex;
    let release;
    this.#mutex = new Promise(r => { release = r; });
    return prev.then(fn).finally(release);
  }

  #safePath(filename) {
    // Ensure generated filename stays within cache dir
    const resolved = pathResolve(this.#dir, filename);
    if (!resolved.startsWith(this.#dir)) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  async #ensureLoaded() {
    if (this.#loaded) return;
    const fs = await import('fs/promises');
    
    try {
      await fs.mkdir(this.#dir, { recursive: true });
    } catch {}

    // Scan existing files to rebuild index
    try {
      const files = await fs.readdir(this.#dir);
      for (const f of files) {
        if (!f.endsWith('.meta')) continue;
        try {
          const raw = await fs.readFile(pathJoin(this.#dir, f), 'utf-8');
          const meta = JSON.parse(raw);
          const hash = f.replace('.meta', '');
          // Validate hash is hex-only (prevent index poisoning)
          if (!/^[0-9a-f]+$/.test(hash)) continue;
          // Validate meta fields to prevent accounting corruption
          if (typeof meta.size !== 'number' || meta.size < 0 || !Number.isFinite(meta.size)) continue;
          if (typeof meta.key !== 'string') continue;
          this.#index.set(meta.key, {
            hash,
            size: meta.size,
            expiresAt: meta.expiresAt || null,
            lastAccess: meta.lastAccess || Date.now(),
          });
          this.#currentSize += meta.size;
        } catch {}
      }
    } catch {}

    this.#loaded = true;
  }

  async get(key) {
    await this.#ensureLoaded();
    const fs = await import('fs/promises');
    
    const idx = this.#index.get(key);
    if (!idx) return null;

    // TTL check
    if (idx.expiresAt && Date.now() > idx.expiresAt) {
      await this.delete(key);
      return null;
    }

    try {
      const data = await fs.readFile(pathJoin(this.#dir, idx.hash + '.dat'));
      const metaRaw = await fs.readFile(pathJoin(this.#dir, idx.hash + '.meta'), 'utf-8');
      const meta = JSON.parse(metaRaw);

      // Update last access
      idx.lastAccess = Date.now();
      meta.lastAccess = idx.lastAccess;
      await fs.writeFile(pathJoin(this.#dir, idx.hash + '.meta'), JSON.stringify(meta));

      return {
        data: new Uint8Array(data),
        meta: meta.meta || {},
        size: idx.size,
        expiresAt: idx.expiresAt,
        lastAccess: idx.lastAccess,
      };
    } catch {
      // File missing — remove from index
      this.#index.delete(key);
      return null;
    }
  }

  async set(key, entry) {
    return this.#withLock(async () => {
    await this.#ensureLoaded();
    const fs = await import('fs/promises');
    
    // Remove old entry
    if (this.#index.has(key)) {
      await this._deleteInner(key, fs);
    }

    // Evict LRU until we have space
    while (this.#currentSize + entry.size > this.#maxSize && this.#index.size > 0) {
      let oldestKey = null, oldestAccess = Infinity;
      for (const [k, v] of this.#index) {
        if (v.lastAccess < oldestAccess) {
          oldestAccess = v.lastAccess;
          oldestKey = k;
        }
      }
      if (oldestKey) await this._deleteInner(oldestKey, fs);
      else break;
    }

    const hash = this.#hash(key);
    const metaObj = {
      key,
      meta: entry.meta || {},
      size: entry.size,
      expiresAt: entry.expiresAt || null,
      lastAccess: Date.now(),
      createdAt: Date.now(),
    };

    await fs.writeFile(pathJoin(this.#dir, hash + '.dat'), entry.data);
    await fs.writeFile(pathJoin(this.#dir, hash + '.meta'), JSON.stringify(metaObj));

    this.#index.set(key, {
      hash,
      size: entry.size,
      expiresAt: entry.expiresAt || null,
      lastAccess: Date.now(),
    });
    this.#currentSize += entry.size;
    });
  }

  async has(key) {
    await this.#ensureLoaded();
    const idx = this.#index.get(key);
    if (!idx) return false;
    if (idx.expiresAt && Date.now() > idx.expiresAt) {
      await this.delete(key);
      return false;
    }
    return true;
  }

  async delete(key) {
    return this.#withLock(async () => {
      await this.#ensureLoaded();
      const fs = await import('fs/promises');
      return this._deleteInner(key, fs);
    });
  }

  async _deleteInner(key, fs) {
    const idx = this.#index.get(key);
    if (!idx) return false;

    try { await fs.unlink(pathJoin(this.#dir, idx.hash + '.dat')); } catch {}
    try { await fs.unlink(pathJoin(this.#dir, idx.hash + '.meta')); } catch {}

    this.#currentSize -= idx.size;
    this.#index.delete(key);
    return true;
  }

  async clear() {
    await this.#ensureLoaded();
    const fs = await import('fs/promises');
    
    for (const [key, idx] of this.#index) {
      try { await fs.unlink(pathJoin(this.#dir, idx.hash + '.dat')); } catch {}
      try { await fs.unlink(pathJoin(this.#dir, idx.hash + '.meta')); } catch {}
    }
    this.#index.clear();
    this.#currentSize = 0;
  }

  async keys() {
    await this.#ensureLoaded();
    const now = Date.now();
    const live = [];
    for (const [key, idx] of this.#index) {
      if (idx.expiresAt && now > idx.expiresAt) {
        await this.delete(key);
      } else {
        live.push(key);
      }
    }
    return live;
  }

  get size() { return this.#index.size; }
  get bytes() { return this.#currentSize; }

  stats() {
    return {
      entries: this.#index.size,
      bytes: this.#currentSize,
      maxSize: this.#maxSize,
      utilization: this.#maxSize > 0 ? this.#currentSize / this.#maxSize : 0,
      dir: this.#dir,
    };
  }

  async sweep() {
    await this.#ensureLoaded();
    const now = Date.now();
    let swept = 0;
    for (const [key, idx] of this.#index) {
      if (idx.expiresAt && now > idx.expiresAt) {
        await this.delete(key);
        swept++;
      }
    }
    return swept;
  }
}
