/**
 * Electron protocol handler — compressed cache for Electron apps.
 *
 * Integrates with Electron's protocol.handle() API (Electron >= 25)
 * to transparently cache and compress web content loaded in BrowserWindow.
 *
 * Usage:
 *   import { GGCache } from 'gg-cache';
 *   import { registerGGProtocol } from 'gg-cache/middleware/electron';
 *
 *   const cache = new GGCache({
 *     store: new FileStore({ dir: app.getPath('userData') + '/gg-cache' }),
 *     ttl: 86400,
 *   });
 *   await cache.init();
 *
 *   // In app.whenReady():
 *   registerGGProtocol(cache);
 *
 *   // Load content through the cached protocol:
 *   win.loadURL('gg-cache://example.com/api/data');
 */

/**
 * Register a custom protocol that caches and compresses responses.
 *
 * @param {import('../cache.js').GGCache} cache
 * @param {object} [opts]
 * @param {string} [opts.scheme='gg-cache'] - Protocol scheme name
 * @param {number} [opts.ttl]              - Override default TTL
 * @param {Function} [opts.shouldCache]    - (url) => boolean
 */
export function registerGGProtocol(cache, opts = {}) {
  const scheme = opts.scheme || 'gg-cache';
  const shouldCache = opts.shouldCache || (() => true);

  // Require electron — will throw if not in Electron context
  let protocol;
  try {
    const electron = require('electron');
    protocol = electron.protocol;
  } catch {
    throw new Error('registerGGProtocol requires Electron. Use fetchInterceptor for browser environments.');
  }

  protocol.handle(scheme, async (request) => {
    // Convert gg-cache://host/path → https://host/path
    const realUrl = request.url.replace(`${scheme}://`, 'https://');

    // Security: validate URL to prevent SSRF
    let parsed;
    try {
      parsed = new URL(realUrl);
    } catch {
      return new Response('Invalid URL', { status: 400 });
    }
    // Block internal/private network targets
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
        host.endsWith('.local') || host.startsWith('10.') ||
        host.startsWith('192.168.') || host.startsWith('172.')) {
      return new Response('Blocked: internal host not allowed', { status: 403 });
    }

    const key = `electron:${realUrl}`;

    // Try cache
    const cached = await cache.get(key);
    if (cached) {
      return new Response(cached.data, {
        headers: {
          'Content-Type': cached.meta?.contentType || 'application/octet-stream',
          'X-GG-Cache': 'HIT',
          'X-GG-Ratio': cached.meta?.originalSize
            ? String((cached.meta.originalSize / cached.data.length).toFixed(1))
            : '1',
        },
      });
    }

    // Fetch from network
    try {
      // Security: strip sensitive headers before forwarding
      const safeHeaders = new Headers(request.headers);
      safeHeaders.delete('authorization');
      safeHeaders.delete('cookie');
      safeHeaders.delete('x-forwarded-for');
      safeHeaders.delete('x-real-ip');

      const response = await fetch(realUrl, {
        headers: safeHeaders,
        method: request.method,
      });

      if (!response.ok) return response;
      if (!shouldCache(realUrl)) return response;

      const data = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'application/octet-stream';

      // Cache in background (don't block the response)
      cache.set(key, data, {
        ttl: opts.ttl,
        contentType: contentType.split(';')[0].trim(),
        meta: { url: realUrl, status: response.status },
      }).catch(() => {});

      return new Response(data, {
        status: response.status,
        headers: {
          'Content-Type': contentType,
          'X-GG-Cache': 'MISS',
        },
      });
    } catch (err) {
      // Network error — try stale cache
      const stale = await cache.get(key);
      if (stale) {
        return new Response(stale.data, {
          headers: {
            'Content-Type': stale.meta?.contentType || 'application/octet-stream',
            'X-GG-Cache': 'STALE',
          },
        });
      }
      return new Response(`Network error: ${err.message}`, { status: 502 });
    }
  });

  return { scheme };
}

/**
 * Create an Electron session interceptor for an existing session.
 * Caches all HTTP responses transparently.
 *
 * Usage:
 *   const { session } = require('electron');
 *   interceptSession(session.defaultSession, cache);
 */
export function interceptSession(electronSession, cache, opts = {}) {
  const shouldCache = opts.shouldCache || (() => true);

  electronSession.webRequest.onCompleted({ urls: ['<all_urls>'] }, async (details) => {
    if (details.method !== 'GET') return;
    if (details.statusCode !== 200) return;
    if (!shouldCache(details.url)) return;

    const key = `session:${details.url}`;
    if (await cache.has(key)) return;

    try {
      const response = await fetch(details.url);
      const data = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'application/octet-stream';

      await cache.set(key, data, {
        ttl: opts.ttl,
        contentType: contentType.split(';')[0].trim(),
        meta: { url: details.url },
      });
    } catch {}
  });
}
