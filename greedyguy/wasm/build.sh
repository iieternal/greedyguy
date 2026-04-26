#!/bin/bash
# Build GreedyGuy WASM (web profile)
# Requires: Emscripten SDK (emsdk)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$SCRIPT_DIR/dist"

# Source emsdk if available
if [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
    source "$HOME/emsdk/emsdk_env.sh" 2>/dev/null
fi

if ! command -v emcc &>/dev/null; then
    echo "Error: emcc not found. Install Emscripten SDK first:"
    echo "  git clone https://github.com/emscripten-core/emsdk.git"
    echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest"
    exit 1
fi

mkdir -p "$OUT_DIR"

echo "=== Building GreedyGuy WASM (web profile) ==="
echo "  Tables: ~20MB (vs 764MB full profile)"
echo "  Format: GGW1"

emcc -O3 -flto \
    -I"$ROOT_DIR" -I"$ROOT_DIR/include" \
    "$SCRIPT_DIR/gg_web.c" \
    -o "$OUT_DIR/greedyguy.js" \
    -s EXPORTED_FUNCTIONS="['_gg_web_compress','_gg_web_decompress','_gg_web_free','_malloc','_free']" \
    -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','HEAPU8']" \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createGreedyGuy" \
    -s EXPORT_ES6=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=33554432 \
    -s MAXIMUM_MEMORY=268435456 \
    -s ENVIRONMENT='web,worker' \
    -s FILESYSTEM=0 \
    -s NO_EXIT_RUNTIME=1 \
    -s MALLOC=emmalloc \
    --no-entry \
    -lm

WASM_SIZE=$(stat -c%s "$OUT_DIR/greedyguy.wasm" 2>/dev/null || stat -f%z "$OUT_DIR/greedyguy.wasm")
JS_SIZE=$(stat -c%s "$OUT_DIR/greedyguy.js" 2>/dev/null || stat -f%z "$OUT_DIR/greedyguy.js")

echo ""
echo "=== Build complete ==="
echo "  WASM: $OUT_DIR/greedyguy.wasm ($(( WASM_SIZE / 1024 )) KB)"
echo "  JS:   $OUT_DIR/greedyguy.js ($(( JS_SIZE / 1024 )) KB)"

# Also build the CLI compressor with web profile for creating .ggw files
echo ""
echo "=== Building CLI web-profile compressor ==="
gcc -O3 -flto -Wall \
    -DGG_MAGIC='"GGW1"' \
    -DSIZE_ORDER4=524288 \
    -DSIZE_ORDER6=1048576 \
    -DSIZE_ORDER8=4194304 \
    -DSIZE_ORDER12=2097152 \
    -DSIZE_WORD=262144 \
    -DSIZE_ORDER23=65536 \
    -DSIZE_HTML=32768 \
    -DMATCH_CHAINS=2 \
    -DMATCH_HASH_SIZE=1048576 \
    -DMATCH_BUF_INIT=262144 \
    -o "$OUT_DIR/greedyguy-web" \
    "$ROOT_DIR/greedyguy.c" \
    -lm

echo "  CLI:  $OUT_DIR/greedyguy-web"
echo ""
echo "Usage:"
echo "  # Compress for web (GGW1 format, ~20MB decompressor)"
echo "  $OUT_DIR/greedyguy-web c input.js output.js.ggw"
echo ""
echo "  # In browser: WASM decompresses transparently via Service Worker"
