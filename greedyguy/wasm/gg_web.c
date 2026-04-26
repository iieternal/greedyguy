/*
 * gg_web.c — GreedyGuy Web Profile (WASM build)
 *
 * Compiles greedyguy.c with reduced table sizes (~20MB RAM instead of 764MB)
 * for browser WASM decompression. Uses "GGW1" magic for format distinction.
 *
 * Build with Emscripten:
 *   emcc -O3 -flto gg_web.c -o greedyguy.js \
 *     -s EXPORTED_FUNCTIONS="['_gg_web_decompress','_gg_web_compress','_gg_web_free','_malloc','_free']" \
 *     -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap']" \
 *     -s MODULARIZE=1 -s EXPORT_ES6=1 \
 *     -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=33554432 \
 *     -s ENVIRONMENT='web,worker' -s FILESYSTEM=0 --no-entry
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* =========================================================================
 * Web Profile: Smaller tables for browser WASM (~20MB total)
 * ========================================================================= */
#define GG_WEB_PROFILE 1

/* Web format magic — incompatible with GG01/GG02 */
#define GG_MAGIC "GGW1"

/* Reduced table sizes: ~20MB total instead of 764MB */
#define SIZE_ORDER0   4096       /* 8KB — same */
#define SIZE_ORDER1   4096       /* 8KB — same */
#define SIZE_ORDER23  65536      /* 128KB — 4x smaller */
#define SIZE_ORDER4   524288     /* 1MB — 16x smaller */
#define SIZE_ORDER6   1048576    /* 2MB — 16x smaller */
#define SIZE_ORDER8   4194304    /* 8MB — 16x smaller */
#define SIZE_ORDER12  2097152    /* 4MB — 32x smaller */
#define SIZE_HTML     32768      /* 64KB — 4x smaller */
#define SIZE_WORD     262144     /* 512KB — 16x smaller */
#define MATCH_CHAINS  2          /* 2 candidates — 2x smaller */
#define MATCH_HASH_SIZE (1 << 20) /* 1M entries — 8x smaller */
#define MATCH_BUF_INIT  (1 << 18) /* 256KB initial */

/* Include the full engine (library mode, no CLI) */
#define GG_LIBRARY 1
#include "greedyguy.c"

#include "include/greedyguy.h"

/* Auto-init */
static int gg_web_initialized = 0;
static void gg_web_ensure_init(void) {
    if (!gg_web_initialized) {
        init_tables();
        gg_web_initialized = 1;
    }
}

/* =========================================================================
 * WASM-exported API
 *
 * These functions use a simple protocol for WASM interop:
 *   - Input: pointer + length (caller allocates via malloc)
 *   - Output: writes to caller-provided pointers
 *   - Returns: 0 on success, negative on error
 * ========================================================================= */

/* Compress data (web profile — smaller tables, "GGW1" format) */
int gg_web_compress(const uint8_t *input, uint32_t input_len,
                    uint8_t **output, uint32_t *output_len) {
    if (!input && input_len > 0) return -2;
    if (!output || !output_len) return -2;

    gg_web_ensure_init();

    uint8_t *out = NULL;
    size_t out_len = 0;
    int rc = compress_best(input, (size_t)input_len, &out, &out_len);
    if (rc != 0) return -1;

    *output = out;
    *output_len = (uint32_t)out_len;
    return 0;
}

/* Decompress data (web profile — reads "GGW1" format) */
int gg_web_decompress(const uint8_t *input, uint32_t input_len,
                      uint8_t **output, uint32_t *output_len) {
    if (!input || input_len < 8) return -2;
    if (!output || !output_len) return -2;

    gg_web_ensure_init();

    uint8_t *out = NULL;
    size_t out_len = 0;
    int rc = decompress_data(input, (size_t)input_len, &out, &out_len);
    if (rc != 0) return -3;

    *output = out;
    *output_len = (uint32_t)out_len;
    return 0;
}

/* Free WASM-allocated memory */
void gg_web_free(void *ptr) {
    free(ptr);
}
