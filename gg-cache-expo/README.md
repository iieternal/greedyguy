# gg-cache-expo

GreedyGuy (GGW1) decompression for **Expo / React Native** — transparent response decompression on Android, iOS, and Web.

Your server compresses API responses with GreedyGuy. This package decompresses them transparently on all three platforms.

## Install

```bash
npx expo install gg-cache-expo
```

Copy `greedyguy.wasm` and `greedyguy.js` to your `assets/` folder.

## Quick Start

### Option 1: Global Interceptor (Simplest)

Patch `fetch` once at startup — all API calls auto-decompress:

```js
// App.js
import { installGlobalInterceptor } from 'gg-cache-expo';

// Call before any fetch:
await installGlobalInterceptor({
  wasmUrl: require('./assets/greedyguy.wasm'),
  include: [/\/api\//],  // only decompress API calls
  onDecompress: (url, compressed, original) => {
    console.log(`${url}: ${compressed}→${original} (${(original/compressed).toFixed(1)}x)`);
  },
});

// Now all fetch() calls auto-decompress GGW1 responses:
const res = await fetch('https://api.example.com/data');
const json = await res.json(); // auto-decompressed!
```

### Option 2: React Provider + Hooks

```jsx
import { GGProvider, useGGFetch } from 'gg-cache-expo';

function App() {
  return (
    <GGProvider
      wasmUrl={require('./assets/greedyguy.wasm')}
      fallback={<Text>Loading decompressor...</Text>}
    >
      <UserList />
    </GGProvider>
  );
}

function UserList() {
  const { data, loading, error, compressed, ratio } = useGGFetch(
    'https://api.example.com/users',
    { json: true }
  );

  if (loading) return <Text>Loading...</Text>;
  if (error) return <Text>Error: {error.message}</Text>;

  return (
    <View>
      {compressed && <Text>Decompressed {ratio}x</Text>}
      {data.map(user => <Text key={user.id}>{user.name}</Text>)}
    </View>
  );
}
```

### Option 3: Direct ggFetch

```js
import { createGGFetch } from 'gg-cache-expo/fetch';

const ggFetch = createGGFetch({
  initOpts: { wasmUrl: './assets/greedyguy.wasm' },
});

const res = await ggFetch('https://api.example.com/data');
const json = await res.json();
```

## Platform Notes

### Web
WASM loads natively via `WebAssembly.instantiate`. Just serve the `.wasm` file from your public assets.

### Android / iOS (Hermes)
Hermes supports WebAssembly experimentally. Enable it in your Expo config:

```json
// app.json
{
  "expo": {
    "jsEngine": "hermes",
    "experiments": {
      "wasm": true
    }
  }
}
```

For native, you must pre-import the Emscripten glue:

```js
import createGG from './assets/greedyguy.js';

await installGlobalInterceptor({
  glueModule: createGG,
  wasmUrl: require('./assets/greedyguy.wasm'),
});
```

## Server Side

Your server should compress responses with GreedyGuy web profile and set:

```
Content-Encoding: ggw1
```

Or just send raw GGW1 bytes — the client auto-detects the magic header.

Example with the gg-cache Express middleware:
```js
import { GGCache } from 'gg-cache';
import { ggCacheMiddleware } from 'gg-cache/middleware/express';

app.use(ggCacheMiddleware(cache));
```

Or with Fastify:
```js
import { ggCachePlugin } from 'gg-cache/middleware/fastify';
app.register(ggCachePlugin, { cache });
```

## API

### Core
| Export | Description |
|--------|------------|
| `initDecompressor(opts)` | Initialize WASM module |
| `decompress(data)` | Decompress Uint8Array |
| `decompressText(data)` | Decompress to string |
| `isGGCompressed(data)` | Check GGW1 magic |
| `isWasmSupported()` | Check WebAssembly available |

### Fetch
| Export | Description |
|--------|------------|
| `ggFetch(url, init)` | Default auto-decompressing fetch |
| `createGGFetch(opts)` | Create configured fetch |
| `installGlobalInterceptor(opts)` | Patch global fetch |
| `removeGlobalInterceptor()` | Restore original fetch |

### React
| Export | Description |
|--------|------------|
| `<GGProvider>` | Context provider (init WASM) |
| `useGG()` | Access decompressor |
| `useGGFetch(url, opts)` | Fetch + decompress hook |

## Request Compression (Client → Server)

Compress outgoing request bodies before sending to save bandwidth:

```js
import { createCompressingFetch } from 'gg-cache-expo/request';

const compressingFetch = createCompressingFetch({
  endpoints: [/^https:\/\/api\.example\.com\/upload/],  // REQUIRED: opt-in per endpoint
  minSize: 5120,   // only compress bodies > 5KB
  maxSize: 10 * 1024 * 1024,  // max 10MB
});

// POST body auto-compressed with GGW1 + Content-Encoding: ggw1 header
const res = await compressingFetch('https://api.example.com/upload', {
  method: 'POST',
  body: JSON.stringify(largePayload),
});
```

Pair with `gg-cache/middleware/fastify-request` or `gg-cache/middleware/express-request` on the server.

## Security

- **Max decompress size**: 256MB hard limit (prevents memory exhaustion)
- **Max input size**: 50MB hard limit
- **WASM malloc checks**: throws on allocation failure
- **Memory leak prevention**: inner try-finally around all WASM buffers
- **Proxy GC**: nulls out original response buffer after decompression
- **Content-Length validation**: pre-checks before body allocation
- **Init failure caching**: prevents retry storms on repeated failures
- **Request compression opt-in**: requires explicit endpoint patterns (no accidental compression)

## Related Packages

| Package | Description |
|---------|------------|
| [`greedyguy`](https://npmjs.com/package/greedyguy) | Core compressor (CLI + C library + Node.js API) |
| [`greedyguy-wasm`](https://npmjs.com/package/greedyguy-wasm) | Standalone WASM for browsers (29KB) |
| [`gg-cache`](https://npmjs.com/package/gg-cache) | Server-side cache with Express/Fastify middleware |

## License

MIT

---

<sub>`echo 8J+mjiBDcmFmdGVkIHdpdGggb2JzZXNzaW9uIGJ5IEBwYXVsdHN1bm55 | base64 -d`</sub>
