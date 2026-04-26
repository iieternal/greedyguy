# greedyguy-wasm

**GreedyGuy compression/decompression via WebAssembly** — context-mixing + arithmetic coding in a ~29 KB WASM module.

GreedyGuy uses the **GGW1 web profile**, a memory-efficient variant that runs in ~20 MB of RAM (compared to 764 MB for the full desktop profile), making it practical for browsers and serverless environments.

## Install

```bash
npm install greedyguy-wasm
```

## Quick Start

```js
import { init, compress, decompress } from 'greedyguy-wasm';

// Initialize the WASM module (once)
await init();

// Compress
const input = new TextEncoder().encode('Hello, world!');
const compressed = compress(input);

// Decompress
const output = decompress(compressed);
console.log(new TextDecoder().decode(output)); // "Hello, world!"
```

## Browser Usage

### With a Bundler (Vite, Webpack, etc.)

```js
import { init, compress, decompress } from 'greedyguy-wasm';

await init();

const data = new TextEncoder().encode('Compress me!');
const compressed = compress(data);
const restored = decompress(compressed);
```

Most bundlers will handle the WASM file automatically via `import.meta.url`.

### Without a Bundler (CDN / Script Tag)

```html
<script type="module">
  import { init, compress, decompress } from './node_modules/greedyguy-wasm/src/index.js';

  await init({
    wasmUrl: './node_modules/greedyguy-wasm/dist/greedyguy.wasm',
    glueUrl: './node_modules/greedyguy-wasm/dist/greedyguy.js',
  });

  const data = new TextEncoder().encode('Hello from the browser!');
  const compressed = compress(data);
  console.log('Compressed size:', compressed.length);
</script>
```

## Node.js Usage

```js
import { init, compress, decompress, decompressText } from 'greedyguy-wasm';
import { readFile, writeFile } from 'node:fs/promises';

await init();

// Compress a file
const input = await readFile('input.txt');
const compressed = compress(new Uint8Array(input));
await writeFile('output.ggw1', compressed);

// Decompress a file
const data = await readFile('output.ggw1');
const text = decompressText(new Uint8Array(data));
console.log(text);
```

## React Usage

```jsx
import { useEffect, useState } from 'react';
import { init, compress, decompress } from 'greedyguy-wasm';

function useGreedyGuy() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    init().then(() => setReady(true));
  }, []);

  return { ready, compress, decompress };
}

function App() {
  const { ready, compress, decompress } = useGreedyGuy();

  if (!ready) return <p>Loading WASM…</p>;

  const handleCompress = () => {
    const data = new TextEncoder().encode('Hello React!');
    const compressed = compress(data);
    console.log('Compressed:', compressed.length, 'bytes');
  };

  return <button onClick={handleCompress}>Compress</button>;
}
```

## Service Worker Usage

```js
// sw.js
import { init, compress, decompress, isGGCompressed } from 'greedyguy-wasm';

self.addEventListener('install', (event) => {
  event.waitUntil(init());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    (async () => {
      const response = await fetch(event.request);
      const buffer = new Uint8Array(await response.arrayBuffer());

      if (isGGCompressed(buffer)) {
        const decompressed = decompress(buffer);
        return new Response(decompressed, {
          headers: response.headers,
        });
      }

      return response;
    })(),
  );
});
```

## API Reference

| Function | Description |
|---|---|
| `init(opts?)` | Initialize the WASM module. Returns a `Promise<void>`. Idempotent. |
| `compress(input)` | Compress a `Uint8Array` using GGW1. Returns `Uint8Array`. |
| `decompress(input)` | Decompress GGW1 data. Returns `Uint8Array`. |
| `decompressText(input)` | Decompress GGW1 data and decode as UTF-8 string. |
| `isGGCompressed(data)` | Check if data starts with GGW1 magic bytes (`0x47 0x47 0x57 0x31`). |
| `isWasmSupported()` | Check if WebAssembly is available. |
| `getStatus()` | Returns `{ initialized: boolean, loading: boolean }`. |
| `reset()` | Unload the WASM module. Call `init()` again to re-use. |

### `init(opts?)`

| Option | Type | Description |
|---|---|---|
| `wasmUrl` | `string` | URL or path to `greedyguy.wasm` |
| `glueUrl` | `string` | URL or path to `greedyguy.js` glue |
| `wasmBinary` | `ArrayBuffer` | Pre-loaded WASM binary |
| `glueModule` | `Function` | Pre-imported Emscripten glue factory |

If no options are provided, the module auto-detects file locations using `import.meta.url`.

### Limits

| Limit | Value |
|---|---|
| Max input size (compress) | 50 MB |
| Max input size (decompress) | 256 MB |

## Memory

The GGW1 web profile uses approximately **20 MB of RAM** at peak. The WASM heap is capped at 256 MB. This is dramatically smaller than the full GreedyGuy desktop profile (764 MB), making it suitable for:

- Browser tabs
- Service Workers
- Serverless functions (AWS Lambda, Cloudflare Workers)
- Mobile web

## GGW1 Format

GGW1 is GreedyGuy's web-optimized format. It uses the same context-mixing + arithmetic coding core but with reduced model sizes for lower memory usage.

- **Magic bytes:** `0x47 0x47 0x57 0x31` ("GGW1")
- **Compression:** Context-mixing with arithmetic coding
- **Profile:** Web (~20 MB RAM)
- **Lossless:** Yes — decompressed output is byte-identical to input

GGW1 files are **not** compatible with the full GreedyGuy desktop format. Use this package for both compression and decompression.

## Related

- [`greedyguy`](https://github.com/niceguydave/greedyguy) — Full GreedyGuy compressor (CLI + native)

## License

MIT © Paul
