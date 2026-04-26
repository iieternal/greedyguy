# GreedyGuy

**Byte-prediction compressor using context mixing + arithmetic coding.**

GreedyGuy beats `xz -9` on web content (HTML, JS, CSS, XML, JSON, SVG, plaintext) while remaining a single-file C implementation with zero dependencies.

## Benchmark (134 real-world web files)

| Format | Files | Beat xz-9 | Beat gzip-9 |
|--------|-------|-----------|-------------|
| JavaScript | 19 | **84%** | 100% |
| Plaintext | 11 | **91%** | 100% |
| XML | 6 | **100%** | 100% |
| CSS | 13 | **77%** | 100% |
| SVG | 4 | **75%** | 100% |
| HTML | 66 | 15% | 92% |
| JSON | 9 | 44% | 100% |
| **Overall** | **134** | **49%** | **96%** |

## How It Works

GreedyGuy predicts each bit of the input using a mix of context models:
- **10 byte-hash context models** (order 0 through 8 + word)
- **LZ77 match finder** with 4-deep hash chains (128MB hash table)
- **4-stage Adaptive Probability Map (APM)** cascade for prediction refinement
- **Ghost-match LZMA-style literal coding** for post-match residuals
- **Logistic mixer** combining all models with learned weights
- **Arithmetic coder** using the mixed probability for each bit

The model adapts online — it learns the statistics of the data as it compresses.

## Installation

### From source (C compiler required)

```bash
make
```

### As npm package

```bash
npm install greedyguy
```

## CLI Usage

```bash
# Compress / decompress files
greedyguy c input.html output.gg
greedyguy d output.gg restored.html

# Pipe mode (stdin/stdout)
cat input.html | greedyguy pc > output.gg
cat output.gg  | greedyguy pd > restored.html

# Test roundtrip
greedyguy t input.html

# Benchmark against gzip/xz
greedyguy b input.html

# Version
greedyguy -V
```

## Node.js API

```javascript
const gg = require('greedyguy');

// Compress a string or Buffer
const compressed = await gg.compress('Hello World');
const original = await gg.decompress(compressed);
console.log(original.toString()); // 'Hello World'

// Compress files
const result = await gg.compressFile('input.html', 'output.gg');
console.log(`${result.ratio.toFixed(1)}:1 compression`);

await gg.decompressFile('output.gg', 'restored.html');
```

## C Library API

```c
#include "greedyguy.h"

void *compressed;
size_t compressed_len;

int rc = gg_compress(input, input_len, &compressed, &compressed_len);
if (rc == GG_OK) {
    // Use compressed data...
    gg_free(compressed);
}

// Decompress
void *output;
size_t output_len;
rc = gg_decompress(compressed, compressed_len, &output, &output_len);
```

### Error Codes

| Code | Value | Meaning |
|------|-------|---------|
| `GG_OK` | 0 | Success |
| `GG_ERR_NOMEM` | -1 | Out of memory (~764MB required) |
| `GG_ERR_INPUT` | -2 | Invalid input (null, too large) |
| `GG_ERR_CORRUPT` | -3 | Corrupt or invalid compressed data |

## Architecture

```
Input bytes
    │
    ├─► Order 0-8 context models (byte-hash tables)
    ├─► Word context model (alpha-only hash)
    ├─► LZ77 match finder (4-deep hash chains)
    │
    ▼
Logistic Mixer (stretch → weighted sum → squash)
    │
    ├─► APM1 (order-1 context)
    ├─► APM2 (prediction-binned)
    ├─► APM3 (match-length buckets)
    ├─► APM4 (ghost-match LZMA literal)
    │
    ▼
Arithmetic Coder → compressed bits
```

## Memory Usage

~764MB during compression/decompression:
- Order-4/6/8/12 hash tables: 608MB
- LZ77 match hash table: 128MB
- Other models: ~28MB

## Limitations

- **Memory**: Requires ~764MB RAM
- **Speed**: ~2-5 MB/s (prediction is compute-intensive)
- **Max input**: ~4 GiB (32-bit size header)
- **Single-threaded**: No parallel compression yet

## Related Packages

| Package | Description |
|---------|------------|
| [`greedyguy-wasm`](https://npmjs.com/package/greedyguy-wasm) | Standalone browser WASM (29KB, ~20MB RAM) |
| [`gg-cache`](https://npmjs.com/package/gg-cache) | Compressed cache manager for Express/Fastify/Electron |
| [`gg-cache-expo`](https://npmjs.com/package/gg-cache-expo) | Client decompression for Expo/React Native |

## License

MIT

---

<sub>`echo 8J+mjiBDcmFmdGVkIHdpdGggb2JzZXNzaW9uIGJ5IEBwYXVsdHN1bm55 | base64 -d`</sub>
