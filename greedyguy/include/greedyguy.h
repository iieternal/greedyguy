/*
 * greedyguy.h — GreedyGuy Compression Library API
 *
 * Byte-prediction compressor using context mixing + arithmetic coding.
 * Achieves better-than-xz compression on web content (HTML, CSS, JS, JSON, XML).
 *
 * Usage:
 *   #include "greedyguy.h"
 *
 *   void *out; size_t out_len;
 *   int rc = gg_compress(input, input_len, &out, &out_len);
 *   if (rc == 0) { use out... }
 *   gg_free(out);
 */

#ifndef GREEDYGUY_H
#define GREEDYGUY_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GG_VERSION_MAJOR 1
#define GG_VERSION_MINOR 0
#define GG_VERSION_PATCH 0
#define GG_VERSION_STRING "1.0.0"

/* Error codes */
#define GG_OK           0
#define GG_ERR_NOMEM   -1
#define GG_ERR_INPUT   -2
#define GG_ERR_CORRUPT -3

/**
 * Compress data in memory.
 *
 * @param input      Input data to compress
 * @param input_len  Length of input in bytes (max ~4 GiB)
 * @param output     Receives pointer to compressed data (caller must gg_free)
 * @param output_len Receives compressed length
 * @return GG_OK on success, negative error code on failure
 */
int gg_compress(const void *input, size_t input_len,
                void **output, size_t *output_len);

/**
 * Decompress data in memory.
 *
 * @param input      Compressed data (GG01 format)
 * @param input_len  Length of compressed data
 * @param output     Receives pointer to decompressed data (caller must gg_free)
 * @param output_len Receives decompressed length
 * @return GG_OK on success, negative error code on failure
 */
int gg_decompress(const void *input, size_t input_len,
                  void **output, size_t *output_len);

/**
 * Free memory allocated by gg_compress or gg_decompress.
 */
void gg_free(void *ptr);

/**
 * Get version string.
 */
const char *gg_version(void);

#ifdef __cplusplus
}
#endif

#endif /* GREEDYGUY_H */
