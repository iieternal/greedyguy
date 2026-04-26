/**
 * Fetch interceptor — monkey-patches globalThis.fetch to add transparent caching.
 *
 * Works in browsers, Service Workers, Deno, and Node.js 18+.
 *
 * Usage:
 *   import { GGCache } from 'gg-cache';
 *   import { interceptFetch, restoreFetch } from 'gg-cache/middleware/fetch';
 *
 *   const cache = new GGCache({ ttl: 300 });
 *   await cache.init();
 *   interceptFetch(cache, { include: [/\/api\//] });
 *
 *   // All matching fetch() calls are now cached:
 *   const res = await fetch('/api/data');  // first call fetches, second hits cache
 *
 *   // Restore original fetch:
 *   restoreFetch();
 */

let _originalFetch = null;

/**
 * Intercept globalThis.fetch with compressed caching.
 *
 * @param {import('../cache.js').GGCache} cache
 * @param {object} [opts]
 * @param {RegExp[]}  [opts.include]   - URL patterns to cache (default: cache all GET)
 * @param {RegExp[]}  [opts.exclude]   - URL patterns to skip
 * @param {string[]}  [opts.methods]   - Methods to cache (default: ['GET'])
 * @param {number}    [opts.ttl]       - TTL override
 * @param {boolean}   [opts.staleOnError=true] - Serve stale on network error
 */
export function interceptFetch(cache, opts = {}) {
  if (_originalFetch) {
    throw new Error('Fetch already intercepted. Call restoreFetch() first.');
  }

  _originalFetch = globalThis.fetch;
  const methods = new Set(opts.methods || ['GET']);
  const staleOnError = opts.staleOnError ?? true;

  globalThis.fetch = async function ggCachedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input.url;
    const method = (init.method || 'GET').toUpperCase();

    // Check if this request should be cached
    if (!methods.has(method) || !shouldIntercept(url, opts)) {
      return _originalFetch(input, init);
    }

    const key = `fetch:${method}:${url}`;

    // Try cache
    const cached = await cache.get(key);
    if (cached) {
      return new Response(cached.data, {
        status: 200,
        headers: {
          'Content-Type': cached.meta?.contentType || 'application/octet-stream',
          'X-GG-Cache': 'HIT',
        },
      });
    }

    // Fetch from network
    try {
      const response = await _originalFetch(input, init);

      if (response.ok) {
        // Clone response before consuming body
        const cloned = response.clone();
        const data = new Uint8Array(await cloned.arrayBuffer());
        const contentType = response.headers.get('content-type') || 'application/octet-stream';

        // Cache in background
        cache.set(key, data, {
          ttl: opts.ttl,
          contentType: contentType.split(';')[0].trim(),
          meta: { url, method, status: response.status },
        }).catch(() => {});
      }

      return response;
    } catch (err) {
      // Network error — serve stale if available
      if (staleOnError) {
        const stale = await cache.get(key);
        if (stale) {
          return new Response(stale.data, {
            status: 200,
            headers: {
              'Content-Type': stale.meta?.contentType || 'application/octet-stream',
              'X-GG-Cache': 'STALE',
            },
          });
        }
      }
      throw err;
    }
  };
}

/**
 * Restore the original fetch function.
 */
export function restoreFetch() {
  if (_originalFetch) {
    globalThis.fetch = _originalFetch;
    _originalFetch = null;
  }
}

function shouldIntercept(url, opts) {
  if (opts.exclude) {
    for (const re of opts.exclude) {
      if (re.test(url)) return false;
    }
  }
  if (opts.include) {
    for (const re of opts.include) {
      if (re.test(url)) return true;
    }
    return false; // include specified but no match
  }
  return true; // no include filter = cache everything
}
