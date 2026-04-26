# GG-Cache

Compressed cache manager powered by [GreedyGuy](../greedyguy/) WASM — LRU + TTL cache with transparent compression for Electron, Express, and browser apps.

## Why?

Modern apps cache lots of data — API responses, HTML, JSON, images. GG-Cache compresses text-based content **3–20x** using GreedyGuy's context-mixing engine, so your cache holds more with less memory/disk.

| Content | Typical Ratio |
|---------|--------------|
| HTML    | 5–22x        |
| CSS     | 5–15x        |
| JSON    | 8–15x        |
| JS      | 4–18x        |
| SVG     | 5–10x        |

Binary formats (PNG, JPEG, MP4, WOFF2) are stored uncompressed — they're already compressed.

## Install

```bash
npm install gg-cache greedyguy
```

## Quick Start

```js
import { GGCache } from 'gg-cache';

const cache = new GGCache({
  maxSize: 50 * 1024 * 1024,  // 50MB cache
  ttl: 3600,                   // 1 hour default TTL
  wasmPath: './node_modules/greedyguy/wasm/dist/',
});

await cache.init();  // loads WASM (~20MB RAM)

// Cache API response
await cache.set('api:/users', jsonString, {
  contentType: 'application/json',
  ttl: 300,  // 5 minutes
});

// Retrieve (auto-decompressed)
const result = await cache.getText('api:/users');
console.log(result.data);       // original JSON string
console.log(result.meta);       // { contentType, originalSize, compressed, ... }

// Stats
console.log(cache.stats());
// { hits: 42, misses: 3, hitRate: 0.93, compressionRatio: 8.2, ... }
```

## Storage Backends

### MemoryStore (default)

In-memory LRU cache. Fast, volatile.

```js
import { GGCache, MemoryStore } from 'gg-cache';

const cache = new GGCache({
  store: new MemoryStore({ maxSize: 100 * 1024 * 1024 }),
});
```

### FileStore

Persistent filesystem cache — survives restarts. Great for Electron.

```js
import { GGCache, FileStore } from 'gg-cache';

const cache = new GGCache({
  store: new FileStore({
    dir: './cache',
    maxSize: 500 * 1024 * 1024,
  }),
});
```

## Middleware

### Express

```js
import express from 'express';
import { GGCache } from 'gg-cache';
import { ggCacheMiddleware } from 'gg-cache/middleware/express';

const app = express();
const cache = new GGCache({ ttl: 600 });
await cache.init();

app.use(ggCacheMiddleware(cache, {
  methods: ['GET'],
  statuses: [200],
  ttl: 300,
}));

// Responses are automatically cached.
// Cache hits return instantly with X-GG-Cache: HIT header.
```

### Fastify

```js
import Fastify from 'fastify';
import { GGCache } from 'gg-cache';
import { ggCachePlugin } from 'gg-cache/middleware/fastify';

const app = Fastify();
const cache = new GGCache({ ttl: 600 });
await cache.init();

await app.register(ggCachePlugin, {
  cache,
  methods: ['GET'],
  statuses: [200],
  ttl: 300,
  statsRoute: '/cache-stats',  // optional monitoring endpoint
});

app.get('/api/data', async () => ({ hello: 'world' }));
// Responses cached with X-GG-Cache header. Stats at GET /cache-stats.
```

### Electron

```js
import { app, BrowserWindow } from 'electron';
import { GGCache, FileStore } from 'gg-cache';
import { registerGGProtocol } from 'gg-cache/middleware/electron';

const cache = new GGCache({
  store: new FileStore({ dir: app.getPath('userData') + '/gg-cache' }),
  ttl: 86400,
});

app.whenReady().then(async () => {
  await cache.init();
  registerGGProtocol(cache);

  const win = new BrowserWindow();
  // Loads through the cache — compressed on disk, transparent to your app:
  win.loadURL('gg-cache://api.example.com/data');
});
```

### Fetch Interceptor

Works everywhere: browser, Service Worker, Node.js 18+, Deno.

```js
import { GGCache } from 'gg-cache';
import { interceptFetch, restoreFetch } from 'gg-cache/middleware/fetch';

const cache = new GGCache({ ttl: 300 });
await cache.init();

interceptFetch(cache, {
  include: [/\/api\//],     // only cache API calls
  exclude: [/\/auth\//],    // skip auth endpoints
  staleOnError: true,       // serve stale on network failure
});

// All matching fetch() calls are now cached:
const res = await fetch('/api/users');  // MISS → caches
const res2 = await fetch('/api/users'); // HIT → instant

// Restore original when done:
restoreFetch();
```

## Cache Strategies

```js
import { GGCache, cacheFirst, networkFirst, staleWhileRevalidate } from 'gg-cache';

const cache = new GGCache();
await cache.init();

const fetcher = async (url) => {
  const res = await fetch(url);
  return {
    data: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type'),
  };
};

// Static assets: always prefer cache
const getStatic = cacheFirst(cache, fetcher, { ttl: 86400 });

// API data: prefer fresh, fall back to cache
const getAPI = networkFirst(cache, fetcher, { ttl: 300, timeout: 5000 });

// Dashboard: show cached immediately, refresh in background
const getDashboard = staleWhileRevalidate(cache, fetcher, { ttl: 60 });

const data = await getStatic('https://cdn.example.com/styles.css');
console.log(data.fromCache); // true on second call
```

## Request Compression (Client → Server)

Decompress GGW1-compressed request bodies from clients using [`gg-cache-expo`](https://npmjs.com/package/gg-cache-expo).

### Fastify Server

```js
import { ggRequestDecompressor } from 'gg-cache/middleware/fastify-request';

await app.register(ggRequestDecompressor, {
  allowedRoutes: [/^\/api\/upload/, /^\/api\/batch/],
  maxCompressedSize: 5 * 1024 * 1024,   // 5MB max compressed
  maxDecompressedSize: 50 * 1024 * 1024, // 50MB max decompressed
  maxRatio: 100,                          // reject >100x expansion (zip bomb)
  poolSize: 4,                            // WASM worker pool size
});
```

### Express Server

```js
import { ggRequestMiddleware } from 'gg-cache/middleware/express-request';

// Must be placed BEFORE body-parser / express.json()
app.use(ggRequestMiddleware({
  allowedRoutes: [/^\/api\/upload/],
  maxCompressedSize: 5 * 1024 * 1024,
  maxDecompressedSize: 50 * 1024 * 1024,
}));
app.use(express.json());
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `store` | `MemoryStore(100MB)` | Storage backend |
| `compressor` | `GGCompressor` | Compression engine |
| `compress` | `true` | Set `false` to disable compression |
| `ttl` | `3600` | Default TTL in seconds (0 = no expiry) |
| `minCompressSize` | `512` | Skip compression below this size |
| `maxSize` | `100MB` | Max cache size (for default MemoryStore) |
| `sweepInterval` | `60000` | TTL cleanup interval in ms (0 = disabled) |
| `wasmPath` | auto-detect | Path to WASM files |

## Custom Compressor

Don't want GG? Plug in any compressor:

```js
const cache = new GGCache({
  compressor: {
    async init() {},
    get loaded() { return true; },
    compress(buf) { return myCompress(buf); },
    decompress(buf) { return myDecompress(buf); },
  },
});
```

## Security

GG-Cache includes comprehensive DoS protections:

- **Decompression bomb detection**: GGW1 header size pre-validation before WASM allocation
- **Size limits**: configurable max compressed/decompressed sizes
- **Ratio limits**: rejects suspiciously high compression ratios (default 100x)
- **Queue limits**: worker pool with bounded queue to prevent overload
- **Path traversal prevention**: FileStore uses SHA-256 hashed filenames + resolved paths
- **Stream size limits**: 10MB max for streaming response caching
- **Memory safety**: WASM malloc checks + proper free on all error paths

## Related Packages

| Package | Description |
|---------|------------|
| [`greedyguy`](https://npmjs.com/package/greedyguy) | Core compressor (CLI + C library + Node.js API) |
| [`greedyguy-wasm`](https://npmjs.com/package/greedyguy-wasm) | Standalone WASM for browsers (29KB) |
| [`gg-cache-expo`](https://npmjs.com/package/gg-cache-expo) | Client-side decompression for Expo/React Native |

## License

MIT

---

<sub>`echo 8J+mjiBDcmFmdGVkIHdpdGggb2JzZXNzaW9uIGJ5IEBwYXVsdHN1bm55 | base64 -d`</sub>
