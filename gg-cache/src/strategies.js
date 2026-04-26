/**
 * Cache Strategies — configurable fetch-and-cache behaviors.
 *
 * Each strategy is a function that takes (request, cache, fetcher) and returns
 * a Response-like object { data, meta, fromCache }.
 */

/**
 * Cache-first: return cached version if available, otherwise fetch and cache.
 * Best for static assets that rarely change.
 */
export function cacheFirst(cache, fetcher, opts = {}) {
  return async (key, fetchOpts = {}) => {
    const cached = await cache.get(key);
    if (cached) return { ...cached, fromCache: true };

    const response = await fetcher(key, fetchOpts);
    await cache.set(key, response.data, {
      ttl: opts.ttl,
      contentType: response.contentType,
      meta: response.meta,
    });
    return { ...response, fromCache: false };
  };
}

/**
 * Network-first: always fetch, fall back to cache on failure.
 * Best for API responses where freshness matters.
 */
export function networkFirst(cache, fetcher, opts = {}) {
  const timeout = opts.timeout ?? 5000;

  return async (key, fetchOpts = {}) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetcher(key, { ...fetchOpts, signal: controller.signal });
      clearTimeout(timer);

      await cache.set(key, response.data, {
        ttl: opts.ttl,
        contentType: response.contentType,
        meta: response.meta,
      });
      return { ...response, fromCache: false };
    } catch {
      const cached = await cache.get(key);
      if (cached) return { ...cached, fromCache: true, stale: true };
      throw new Error(`Network failed and no cache for: ${key}`);
    }
  };
}

/**
 * Stale-while-revalidate: return cache immediately, refresh in background.
 * Best for content that should load fast but stay eventually-consistent.
 */
export function staleWhileRevalidate(cache, fetcher, opts = {}) {
  return async (key, fetchOpts = {}) => {
    const cached = await cache.get(key);

    // Fire-and-forget background refresh
    const refresh = async () => {
      try {
        const response = await fetcher(key, fetchOpts);
        await cache.set(key, response.data, {
          ttl: opts.ttl,
          contentType: response.contentType,
          meta: response.meta,
        });
      } catch {}
    };

    if (cached) {
      // Don't await — refresh happens in background
      refresh();
      return { ...cached, fromCache: true, revalidating: true };
    }

    // Nothing cached — must wait for network
    const response = await fetcher(key, fetchOpts);
    await cache.set(key, response.data, {
      ttl: opts.ttl,
      contentType: response.contentType,
      meta: response.meta,
    });
    return { ...response, fromCache: false };
  };
}

/**
 * Cache-only: only return from cache, never fetch.
 * Useful for offline-only or pre-warmed caches.
 */
export function cacheOnly(cache) {
  return async (key) => {
    const cached = await cache.get(key);
    if (!cached) throw new Error(`Not in cache: ${key}`);
    return { ...cached, fromCache: true };
  };
}

/**
 * Network-only: always fetch, never cache.
 * Useful for sensitive or one-time data.
 */
export function networkOnly(fetcher) {
  return async (key, fetchOpts = {}) => {
    const response = await fetcher(key, fetchOpts);
    return { ...response, fromCache: false };
  };
}
