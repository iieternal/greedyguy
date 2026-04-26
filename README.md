# 🦖 GreedyGuy

A byte-prediction compressor ecosystem. Context-mixing + arithmetic coding in a ~29 KB WASM binary — everywhere JavaScript runs.

[![CI](https://github.com/paultsunny/greedyguy/actions/workflows/ci.yml/badge.svg)](https://github.com/paultsunny/greedyguy/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is GreedyGuy?

GreedyGuy is a lossless compressor that uses **context mixing** and **arithmetic coding** to beat gzip-9 and xz-9 on web content (HTML, JSON, JS, CSS). It ships as a native C binary for max throughput and a portable WASM build for browsers and Node.js.

This monorepo contains 5 npm packages that cover the full stack — from raw compression to transparent middleware for every major framework.

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| [`greedyguy`](./greedyguy) | Node.js wrapper around the native C binary | `npm i greedyguy` |
| [`greedyguy-wasm`](./greedyguy-wasm) | Standalone WASM compressor for Node.js & bundlers | `npm i greedyguy-wasm` |
| [`greedyguy-web`](./greedyguy-web) | Browser drop-in — `<script>` tag or ES module | `npm i greedyguy-web` |
| [`gg-cache`](./gg-cache) | Compressed cache + middleware for Express, Fastify & Electron | `npm i gg-cache` |
| [`gg-cache-expo`](./gg-cache-expo) | Transparent response decompression for Expo / React Native | `npm i gg-cache-expo` |

## Quick Start

### Compress & decompress (Node.js)

```js
const gg = require('greedyguy-wasm');

await gg.init();

const original = Buffer.from('Hello GreedyGuy!');
const compressed = gg.compress(original);
const restored = gg.decompress(compressed);
// restored.toString() === 'Hello GreedyGuy!'
```

### Express middleware (cache responses automatically)

```js
const express = require('express');
const { expressCache } = require('gg-cache');

const app = express();
app.use(expressCache({ ttl: 60_000, maxEntries: 500 }));

app.get('/api/data', (req, res) => {
  res.json({ big: 'payload' }); // cached + compressed on second hit
});
```

### Fastify plugin

```js
const fastify = require('fastify')();
const { fastifyCache } = require('gg-cache');

fastify.register(fastifyCache, { ttl: 60_000 });
```

### Browser (`<script>` tag)

```html
<script src="https://unpkg.com/greedyguy-web/dist/greedyguy-web.iife.js"></script>
<script>
  GreedyGuy.init().then(() => {
    const data = new TextEncoder().encode('Hello from the browser!');
    const compressed = GreedyGuy.compress(data);
    const restored = GreedyGuy.decompress(compressed);
    console.log(new TextDecoder().decode(restored));
  });
</script>
```

### Expo / React Native

```js
import { enableInterceptor } from 'gg-cache-expo';

// Transparently decompress GGW1 responses from your API
await enableInterceptor({ wasmUrl: 'https://yourcdn.com/greedyguy.wasm' });

// All fetch() calls now auto-decompress GGW1 content
const res = await fetch('https://api.example.com/data');
```

### Electron (compressed protocol cache)

```js
const { electronCache } = require('gg-cache');

// In main process — registers gg-cache:// protocol
electronCache({ maxSize: 100 * 1024 * 1024 });
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Your Application                   │
├──────────┬──────────┬───────────┬──────────┬────────┤
│  Express │ Fastify  │ Electron  │  Expo/RN │ Browser│
│  middle  │  plugin  │ protocol  │ intercept│ script │
├──────────┴──────────┴───────────┴──────────┴────────┤
│                    gg-cache layer                     │
│          LRU + TTL + transparent compression         │
├─────────────────────────────────────────────────────┤
│          greedyguy-wasm  /  greedyguy-web            │
│          ~29 KB WASM binary (GGW1 format)            │
├─────────────────────────────────────────────────────┤
│                  greedyguy (C core)                   │
│       Context mixing + arithmetic coding engine      │
└─────────────────────────────────────────────────────┘
```

## GGW1 Format

All packages use the **GGW1** binary format:

| Offset | Size | Description |
|--------|------|-------------|
| 0–3 | 4 B | Magic: `GGW1` (0x47 0x47 0x57 0x31) |
| 4–7 | 4 B | Original size (little-endian uint32) |
| 8+ | var | Compressed data |

## Security

All packages include hardened defaults:

- **Decompression bomb protection** — pre-validates GGW1 header size and expansion ratio before allocating memory
- **Cache poisoning prevention** — skips authenticated requests, honors `Cache-Control` directives
- **SSRF protection** (Electron) — blocks private network targets, strips sensitive headers
- **Output size caps** — configurable limits on decompressed output and response body buffering
- **WASM memory safety** — proper `outPtr` lifecycle with try/finally to prevent leaks

See each package's README for configuration details.

## Development

For detailed instructions on setting up the project and contributing, please see [contributions.md](./contributions.md).

```bash
# Clone
git clone https://github.com/paultsunny/greedyguy.git
cd greedyguy

# Test all packages
cd greedyguy-wasm && npm test && cd ..
cd greedyguy-web  && npm test && cd ..
cd gg-cache       && npm test && cd ..
cd gg-cache-expo  && npm test && cd ..
```

## License

MIT — see [LICENSE](LICENSE) in each package.

---

<sub>`echo 8J+mjiBDcmFmdGVkIHdpdGggb2JzZXNzaW9uIGJ5IEBwYXVsdHN1bm55 | base64 -d`</sub>
