# greedyguy-web

**GreedyGuy compression for websites** — drop in a `<script>` tag or ES module import. Context-mixing + arithmetic coding in 29KB of WASM.

No bundler. No framework. No dependencies.

## Quick Start

### Script Tag (simplest)

```html
<script src="https://unpkg.com/greedyguy-web/dist/greedyguy-web.iife.js"></script>
<script>
  (async () => {
    await GreedyGuy.init({
      wasmUrl: 'https://unpkg.com/greedyguy-web/dist/greedyguy.wasm',
      glueUrl: 'https://unpkg.com/greedyguy-web/dist/greedyguy-glue.js',
    });

    // Compress text
    const compressed = GreedyGuy.compressText('Hello World!');
    console.log('Compressed:', compressed.length, 'bytes');

    // Decompress
    const original = GreedyGuy.decompressText(compressed);
    console.log(original); // "Hello World!"
  })();
</script>
```

### ES Module

```html
<script type="module">
  import { init, compressText, decompressText } from 'https://unpkg.com/greedyguy-web/src/index.js';

  await init();
  const packed = compressText('Hello World!');
  console.log(decompressText(packed));
</script>
```

### npm Install

```bash
npm install greedyguy-web
```

```js
import { init, compress, decompress } from 'greedyguy-web';

await init();
const data = new TextEncoder().encode('Hello World!');
const compressed = compress(data);
const original = decompress(compressed);
```

## API

| Function | Description |
|----------|------------|
| `init(opts?)` | Initialize WASM module (must call first) |
| `compress(input)` | Compress `Uint8Array` → GGW1 bytes |
| `decompress(input)` | Decompress GGW1 → `Uint8Array` |
| `compressText(str)` | Compress string → GGW1 bytes |
| `decompressText(input)` | Decompress GGW1 → string |
| `compressToBase64(input)` | Compress → base64 string |
| `decompressFromBase64(b64)` | Decompress base64 → bytes |
| `decompressBase64Text(b64)` | Decompress base64 → string |
| `fetchAndDecompress(url)` | Fetch URL, auto-decompress if GGW1 |
| `isCompressed(data)` | Check GGW1 magic header |
| `isSupported()` | Check WebAssembly available |
| `status()` | Get module status |
| `destroy()` | Unload WASM, free memory |

### `init(opts?)`

| Option | Type | Description |
|--------|------|------------|
| `wasmUrl` | `string` | URL to `greedyguy.wasm` (auto-detected if omitted) |
| `glueUrl` | `string` | URL to Emscripten glue JS (auto-detected if omitted) |
| `wasmBinary` | `ArrayBuffer` | Pre-fetched WASM binary |
| `glueModule` | `Function` | Pre-imported glue factory |

## Examples

See the `examples/` directory:

- **[script-tag.html](examples/script-tag.html)** — Interactive demo with text compression, file drop, base64 encode/decode
- **[esm.html](examples/esm.html)** — ES module import with multiple content types
- **[cdn.html](examples/cdn.html)** — CDN loading pattern

### Compress API Responses

```js
// Server sends GGW1-compressed JSON
const { data, compressed, ratio } = await GreedyGuy.fetchAndDecompress('/api/users');
const users = JSON.parse(new TextDecoder().decode(data));
console.log(`Loaded ${users.length} users (${compressed ? ratio + 'x compressed' : 'uncompressed'})`);
```

### Offline Cache with Base64

```js
// Compress for localStorage (text-safe)
const b64 = GreedyGuy.compressToBase64(largeJSON);
localStorage.setItem('cache:users', b64);

// Restore
const json = GreedyGuy.decompressBase64Text(localStorage.getItem('cache:users'));
```

### Service Worker

```js
// sw.js
importScripts('./greedyguy-web.iife.js');

self.addEventListener('fetch', (event) => {
  event.respondWith((async () => {
    const response = await fetch(event.request);
    const buffer = new Uint8Array(await response.clone().arrayBuffer());

    if (GreedyGuy.isCompressed(buffer)) {
      const decompressed = GreedyGuy.decompress(buffer);
      return new Response(decompressed, {
        headers: { ...Object.fromEntries(response.headers), 'content-length': decompressed.length },
      });
    }
    return response;
  })());
});
```

## Specs

| Metric | Value |
|--------|-------|
| WASM binary | 29 KB |
| Glue JS | 13 KB |
| IIFE bundle | 11 KB |
| **Total** | **~53 KB** |
| RAM usage | ~20 MB |
| Max input | 50 MB |
| Max decompress | 256 MB |
| Format | GGW1 (web profile) |

## Compression Ratios (typical)

| Content | Ratio |
|---------|-------|
| HTML | 5–22x |
| CSS | 5–15x |
| JavaScript | 4–18x |
| JSON | 8–15x |
| SVG | 5–10x |

## Browser Support

Works in all modern browsers with WebAssembly:
- Chrome 57+
- Firefox 52+
- Safari 11+
- Edge 16+

## Related Packages

| Package | Description |
|---------|------------|
| [`greedyguy`](https://npmjs.com/package/greedyguy) | Core compressor (CLI + C library + Node.js API) |
| [`greedyguy-wasm`](https://npmjs.com/package/greedyguy-wasm) | Standalone WASM for Node.js + browser (ESM only) |
| [`gg-cache`](https://npmjs.com/package/gg-cache) | Server-side compressed cache (Express/Fastify/Electron) |
| [`gg-cache-expo`](https://npmjs.com/package/gg-cache-expo) | Client decompression for Expo/React Native |

## Development

```bash
# Build IIFE bundle from source
node build.js

# Run tests
node test/test.js

# Serve examples locally
npx serve -p 8080 .
# Open http://localhost:8080/examples/script-tag.html
```

## License

MIT

---

<sub>`echo 8J+mjiBDcmFmdGVkIHdpdGggb2JzZXNzaW9uIGJ5IEBwYXVsdHN1bm55 | base64 -d`</sub>
