/**
 * Fastify plugin — transparent compressed caching for Fastify HTTP servers.
 *
 * Usage:
 *   import Fastify from 'fastify';
 *   import { GGCache } from 'gg-cache';
 *   import { ggCachePlugin } from 'gg-cache/middleware/fastify';
 *
 *   const cache = new GGCache({ ttl: 600 });
 *   await cache.init();
 *
 *   const app = Fastify();
 *   app.register(ggCachePlugin, { cache, ttl: 300 });
 */

/**
 * Fastify plugin that caches responses with GG compression.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} opts
 * @param {import('../cache.js').GGCache} opts.cache       - GGCache instance (must be init'd)
 * @param {string[]}  [opts.methods=['GET']]               - HTTP methods to cache
 * @param {number[]}  [opts.statuses=[200]]                - Status codes to cache
 * @param {Function}  [opts.keyFn]                         - (request) => string
 * @param {Function}  [opts.shouldCache]                   - (request, reply) => boolean
 * @param {number}    [opts.ttl]                           - Override default TTL
 * @param {string[]}  [opts.routes]                        - Restrict to specific route prefixes
 * @param {boolean}   [opts.cacheAuthenticated=false]      - Cache authenticated requests
 * @param {boolean}   [opts.honorCacheControl=true]        - Honor Cache-Control/Set-Cookie
 */
async function ggCachePlugin(fastify, opts) {
  const cache = opts.cache;
  if (!cache) throw new Error('ggCachePlugin requires a cache option');

  const methods = new Set((opts.methods || ['GET']).map(m => m.toUpperCase()));
  const statuses = new Set(opts.statuses || [200]);
  const keyFn = opts.keyFn || ((req) => `${req.method}:${req.url}`);
  const shouldCache = opts.shouldCache || null;
  const routePrefixes = opts.routes || null;
  const cacheAuthenticated = opts.cacheAuthenticated ?? false;
  const honorCacheControl = opts.honorCacheControl ?? true;

  // onRequest hook — serve from cache if HIT
  fastify.addHook('onRequest', async (request, reply) => {
    if (!methods.has(request.method)) return;
    if (routePrefixes && !routePrefixes.some(p => request.url.startsWith(p))) return;
    // Security: skip cache for authenticated requests by default
    if (!cacheAuthenticated && (request.headers?.['authorization'] || request.headers?.['cookie'])) return;

    const key = keyFn(request);
    const cached = await cache.get(key);
    if (!cached) {
      reply.header('X-GG-Cache', 'MISS');
      return; // continue to handler
    }

    reply.header('X-GG-Cache', 'HIT');
    reply.header('Content-Type', cached.meta?.contentType || 'application/octet-stream');
    if (cached.meta?.originalSize) {
      reply.header('X-GG-Original-Size', String(cached.meta.originalSize));
      reply.header('X-GG-Ratio', (cached.meta.originalSize / cached.data.length).toFixed(1));
    }
    reply.send(Buffer.from(cached.data));
  });

  // onSend hook — intercept outgoing response and cache it
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (!methods.has(request.method)) return payload;
    if (!statuses.has(reply.statusCode)) return payload;
    if (reply.getHeader('X-GG-Cache') === 'HIT') return payload; // already served from cache
    if (shouldCache && !shouldCache(request, reply)) return payload;
    // Security: skip authenticated requests
    if (!cacheAuthenticated && (request.headers?.['authorization'] || request.headers?.['cookie'])) return payload;
    // Security: honor Cache-Control and Set-Cookie
    if (honorCacheControl) {
      if (reply.getHeader('set-cookie')) return payload;
      const cc = (reply.getHeader('cache-control') || '').toLowerCase();
      if (cc.includes('private') || cc.includes('no-store') || cc.includes('no-cache')) return payload;
    }

    const key = keyFn(request);
    const contentType = reply.getHeader('content-type') || 'application/octet-stream';

    let data;
    if (typeof payload === 'string') {
      data = new TextEncoder().encode(payload);
    } else if (Buffer.isBuffer(payload)) {
      data = new Uint8Array(payload);
    } else if (payload instanceof Uint8Array) {
      data = payload;
    } else if (payload && typeof payload.pipe === 'function') {
      // Stream — collect chunks then cache (with size limit)
      const MAX_STREAM_CACHE = 10 * 1024 * 1024; // 10MB max for stream caching
      const chunks = [];
      let streamSize = 0;
      let overLimit = false;
      for await (const chunk of payload) {
        streamSize += chunk.length;
        if (streamSize > MAX_STREAM_CACHE) {
          overLimit = true;
          // Over limit — return what we have as-is, skip caching entirely
          chunks.push(chunk);
          break;
        }
        chunks.push(chunk);
      }
      if (overLimit) {
        // Reconstruct a stream from collected chunks + remainder of original
        const { Readable } = await import('stream');
        const collected = Buffer.concat(chunks);
        // Create a passthrough that yields collected data then pipes the rest
        async function* generate() {
          yield collected;
          for await (const c of payload) yield c;
        }
        return Readable.from(generate());
      }
      data = new Uint8Array(Buffer.concat(chunks));
      // We consumed the stream, so return the buffer as the new payload
      const buf = Buffer.from(data);
      cache.set(key, data, {
        ttl: opts.ttl,
        contentType: String(contentType).split(';')[0].trim(),
        meta: { url: request.url, method: request.method },
      }).catch(() => {});
      return buf;
    } else {
      return payload; // unknown type, skip caching
    }

    // Cache in background — don't block the response
    cache.set(key, data, {
      ttl: opts.ttl,
      contentType: String(contentType).split(';')[0].trim(),
      meta: { url: request.url, method: request.method },
    }).catch(() => {});

    return payload;
  });

  // Decorate Fastify instance with cache reference and helpers
  fastify.decorate('ggCache', cache);

  fastify.decorate('ggCacheInvalidate', async (key) => {
    return cache.delete(key);
  });

  fastify.decorate('ggCacheInvalidatePrefix', async (prefix) => {
    const keys = await cache.keys();
    let removed = 0;
    for (const k of keys) {
      if (k.startsWith(prefix) || k.includes(`:${prefix}`)) {
        await cache.delete(k);
        removed++;
      }
    }
    return removed;
  });

  // Add a stats route if requested
  if (opts.statsRoute) {
    const route = typeof opts.statsRoute === 'string' ? opts.statsRoute : '/_gg/stats';
    fastify.get(route, async () => cache.stats());
  }
}

// Fastify expects the plugin to have Symbol.for('skip-override') and a name
ggCachePlugin[Symbol.for('skip-override')] = true;
ggCachePlugin[Symbol.for('fastify.display-name')] = 'gg-cache';

export { ggCachePlugin };
export default ggCachePlugin;
