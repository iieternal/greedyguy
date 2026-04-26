/**
 * Express middleware — transparent compressed caching for HTTP responses.
 *
 * Usage:
 *   import { GGCache } from 'gg-cache';
 *   import { ggCacheMiddleware } from 'gg-cache/middleware/express';
 *
 *   const cache = new GGCache({ ttl: 600 });
 *   await cache.init();
 *   app.use(ggCacheMiddleware(cache));
 */

/**
 * Headers that indicate a response should NOT be cached by default.
 */
const NO_CACHE_RESPONSE_HEADERS = ['set-cookie'];
const NO_CACHE_CC_DIRECTIVES = ['private', 'no-store', 'no-cache'];

/**
 * Check if a response should be skipped for caching based on security headers.
 */
function isResponseCacheable(res) {
  // Never cache responses with Set-Cookie
  if (res.getHeader('set-cookie')) return false;

  const cc = (res.getHeader('cache-control') || '').toLowerCase();
  for (const dir of NO_CACHE_CC_DIRECTIVES) {
    if (cc.includes(dir)) return false;
  }
  return true;
}

/**
 * Check if a request has auth credentials (should not use shared cache by default).
 */
function hasAuthCredentials(req) {
  return !!(req.headers['authorization'] || req.headers['cookie']);
}

/**
 * Create Express middleware that caches responses.
 *
 * @param {import('../cache.js').GGCache} cache
 * @param {object} [opts]
 * @param {string[]}  [opts.methods=['GET']]     - HTTP methods to cache
 * @param {number[]}  [opts.statuses=[200]]      - Status codes to cache
 * @param {Function}  [opts.keyFn]               - Custom cache key function (req) => string
 * @param {Function}  [opts.shouldCache]          - (req, res) => boolean
 * @param {number}    [opts.ttl]                 - Override default TTL
 * @param {boolean}   [opts.cacheAuthenticated=false] - Cache responses for authenticated requests
 * @param {boolean}   [opts.honorCacheControl=true]   - Honor Cache-Control/Set-Cookie headers
 */
export function ggCacheMiddleware(cache, opts = {}) {
  const methods = new Set(opts.methods || ['GET']);
  const statuses = new Set(opts.statuses || [200]);
  const keyFn = opts.keyFn || ((req) => `${req.method}:${req.originalUrl || req.url}`);
  const shouldCache = opts.shouldCache || null;
  const cacheAuthenticated = opts.cacheAuthenticated ?? false;
  const honorCacheControl = opts.honorCacheControl ?? true;

  return async (req, res, next) => {
    if (!methods.has(req.method)) return next();

    // Security: skip caching for authenticated requests by default
    if (!cacheAuthenticated && hasAuthCredentials(req)) return next();

    const key = keyFn(req);

    // Try cache hit
    const cached = await cache.get(key);
    if (cached) {
      res.set('X-GG-Cache', 'HIT');
      res.set('Content-Type', cached.meta?.contentType || 'application/octet-stream');
      if (cached.meta?.originalSize) {
        res.set('X-GG-Original-Size', String(cached.meta.originalSize));
      }
      return res.send(Buffer.from(cached.data));
    }

    // Cache miss — intercept the response
    res.set('X-GG-Cache', 'MISS');
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);

    const cacheResponse = async (body) => {
      if (!statuses.has(res.statusCode)) return;
      if (shouldCache && !shouldCache(req, res)) return;
      // Security: honor Cache-Control and Set-Cookie headers
      if (honorCacheControl && !isResponseCacheable(res)) return;

      const contentType = res.getHeader('content-type') || 'application/octet-stream';
      let data;
      if (typeof body === 'string') {
        data = new TextEncoder().encode(body);
      } else if (Buffer.isBuffer(body)) {
        data = new Uint8Array(body);
      } else if (body instanceof Uint8Array) {
        data = body;
      } else {
        data = new TextEncoder().encode(JSON.stringify(body));
      }

      await cache.set(key, data, {
        ttl: opts.ttl,
        contentType: String(contentType).split(';')[0].trim(),
        meta: { url: req.originalUrl || req.url, method: req.method },
      }).catch(() => {}); // Don't fail the response if caching fails
    };

    res.send = function(body) {
      cacheResponse(body).catch(() => {});
      return originalSend(body);
    };

    res.json = function(obj) {
      cacheResponse(obj).catch(() => {});
      return originalJson(obj);
    };

    next();
  };
}
