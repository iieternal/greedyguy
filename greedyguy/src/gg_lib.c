/*
 * gg_lib.c — GreedyGuy library wrapper
 *
 * Provides the public C API (gg_compress, gg_decompress, etc.)
 * by wrapping the internal functions from greedyguy.c.
 *
 * Build: gcc -O3 -c gg_lib.c -I include -o gg_lib.o
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* Include the core engine (compiled as library, no main) */
#define GG_LIBRARY 1
#include "greedyguy.c"

#include "include/greedyguy.h"

/* Auto-init: ensure lookup tables are ready */
static int gg_initialized = 0;
static void gg_ensure_init(void) {
    if (!gg_initialized) {
        init_tables();
        gg_initialized = 1;
    }
}

int gg_compress(const void *input, size_t input_len,
                void **output, size_t *output_len) {
    if (!input && input_len > 0) return GG_ERR_INPUT;
    if (!output || !output_len) return GG_ERR_INPUT;
    if (input_len > (size_t)0xFFFFFFFF) return GG_ERR_INPUT;

    gg_ensure_init();

    uint8_t *out = NULL;
    size_t out_len = 0;
    int rc = compress_best((const uint8_t *)input, input_len, &out, &out_len);
    if (rc != 0) return GG_ERR_NOMEM;

    *output = out;
    *output_len = out_len;
    return GG_OK;
}

int gg_decompress(const void *input, size_t input_len,
                  void **output, size_t *output_len) {
    if (!input || input_len < 8) return GG_ERR_INPUT;
    if (!output || !output_len) return GG_ERR_INPUT;

    gg_ensure_init();

    uint8_t *out = NULL;
    size_t out_len = 0;
    int rc = decompress_data((const uint8_t *)input, input_len, &out, &out_len);
    if (rc != 0) return GG_ERR_CORRUPT;

    *output = out;
    *output_len = out_len;
    return GG_OK;
}

void gg_free(void *ptr) {
    free(ptr);
}

const char *gg_version(void) {
    return GG_VERSION_STRING;
}
