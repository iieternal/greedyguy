/*
 * greedyguy.c — Byte-prediction compressor (context mixing + arithmetic coding)
 *
 * Like a language model for bytes: learns to predict the next byte,
 * then uses predictions for optimal arithmetic coding.
 * Focused on HTML files for maximum compression.
 *
 * Usage:
 *   greedyguy c <input> <output>   — compress
 *   greedyguy d <input> <output>   — decompress
 *   greedyguy t <input>            — test (roundtrip)
 *   greedyguy g <output>           — generate HTML test data
 *   greedyguy b <input>            — benchmark (compare with gzip/xz)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>
#include <time.h>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif

/* =========================================================================
 * Constants
 * ========================================================================= */

#ifndef GG_MAGIC
#define MAGIC       "GG01"
#else
#define MAGIC       GG_MAGIC
#endif
#define MAGIC2      "GG02"  /* LZ77 + context mixing */
#define MAGIC_SIZE  4
#define HEADER_SIZE 8  /* 4 magic + 4 size */

#define N_STATE_MODELS 12   /* context models with state tables */
#define N_MODELS    13       /* +1 for byte-match model */
#define MIXER_SETS  1        /* single weight set */
#define PROB_BITS   12
#define PROB_ONE    (1 << PROB_BITS)  /* 4096 */
#define PROB_HALF   (PROB_ONE >> 1)   /* 2048 */

/* State table sizes (entries, power of 2) — overridable for web profile */
#ifndef SIZE_ORDER0
#define SIZE_ORDER0   4096
#endif
#ifndef SIZE_ORDER1
#define SIZE_ORDER1   4096
#endif
#ifndef SIZE_ORDER23
#define SIZE_ORDER23  262144
#endif
#ifndef SIZE_ORDER4
#define SIZE_ORDER4   8388608
#endif
#ifndef SIZE_ORDER6
#define SIZE_ORDER6   16777216
#endif
#ifndef SIZE_ORDER8
#define SIZE_ORDER8   67108864
#endif
#ifndef SIZE_ORDER12
#define SIZE_ORDER12  67108864   /* order-12 for long-range web patterns */
#endif
#ifndef SIZE_HTML
#define SIZE_HTML     131072
#endif
#ifndef SIZE_WORD
#define SIZE_WORD     4194304    /* word model table */
#endif
#ifndef MATCH_CHAINS
#define MATCH_CHAINS    4         /* candidates per hash bucket */
#endif
#ifndef MATCH_HASH_SIZE
#define MATCH_HASH_SIZE (1 << 23) /* 8M entries for 4-byte prefix */
#endif
#ifndef MATCH_BUF_INIT
#define MATCH_BUF_INIT  (1 << 20) /* initial match buffer capacity */
#endif

/* LZ77 Preprocessor constants */
#define LZ77_HASH_BITS   20
#define LZ77_HASH_SIZE   (1 << LZ77_HASH_BITS)  /* 1M buckets */
#define LZ77_MIN_MATCH   6    /* minimum match length to encode (5-byte reference) */
#define LZ77_MAX_MATCH   261  /* 6 + 255 */
#define LZ77_MAX_OFFSET  16777215  /* 24-bit, 16MB window */
#define LZ77_CHAIN_DEPTH 64   /* max hash chain candidates to check */
#define LZ77_USE_THRESHOLD 32768  /* only use LZ77 for files >= 32KB */

/* Stretch/squash table sizes */
#define STRETCH_SIZE  PROB_ONE       /* 4096 entries */
#define SQUASH_SIZE   4096           /* indexed -2048..2047 */
#define SQUASH_OFFSET 2048

/* Learning rate (fixed point, scaled by 256) */
#define LR  1  /* ~0.004 effective */

/* APM (Adaptive Probability Map) — secondary correction */
#define APM_BINS    36       /* prediction bins */
#define APM_CONTEXTS 1024    /* context = previous byte × html state class (256 × 4) */
#define APM_SIZE    (APM_BINS * APM_CONTEXTS)
#define APM_LR      15

/* APM2 — second stage, bit position × top 2 bits of previous byte */
#define APM2_CONTEXTS 32      /* 8 bit positions × 4 byte classes */
#define APM2_BINS     24
#define APM2_SIZE     (APM2_BINS * APM2_CONTEXTS)
#define APM2_LR       16

/* APM3 — third stage: order-4 quantized prediction × match length bucket */
#define APM3_QBINS    64     /* quantize order-4 pred into 64 bins */
#define APM3_MLEN     8      /* match length buckets: none, 4-7, 8-15, 16-31, 32-63, 64-127, 128-511, 512+ */
#define APM3_CONTEXTS (APM3_QBINS * APM3_MLEN)  /* 512 contexts */
#define APM3_BINS     24
#define APM3_SIZE     (APM3_BINS * APM3_CONTEXTS)
#define APM3_LR       18

/* APM4 — fourth stage: match-byte literal context (LZMA-style) */
/* When a match recently broke, use the match_byte's bit at current position as context */
#define APM4_CONTEXTS 24     /* 8 (no match_byte) + 8 (mb_bit=0) + 8 (mb_bit=1) */
#define APM4_BINS     32
#define APM4_SIZE     (APM4_BINS * APM4_CONTEXTS)
#define APM4_LR       16

/* =========================================================================
 * Stretch / Squash lookup tables
 * ========================================================================= */

static int stretch_table[STRETCH_SIZE];  /* p in 0..4095 -> logit * 256 */
static int squash_table[SQUASH_SIZE];    /* logit -> p in 0..4095 */

static void init_tables(void) {
    /* stretch: logit(p) = log(p / (1-p)), scaled by 256 */
    stretch_table[0] = -2047;
    stretch_table[STRETCH_SIZE - 1] = 2047;
    for (int i = 1; i < STRETCH_SIZE - 1; i++) {
        double p = (double)i / STRETCH_SIZE;
        double logit = log(p / (1.0 - p));
        int v = (int)(logit * 256.0);
        if (v < -2047) v = -2047;
        if (v > 2047) v = 2047;
        stretch_table[i] = v;
    }

    /* squash: sigmoid, inverse of stretch */
    for (int i = 0; i < SQUASH_SIZE; i++) {
        double x = (double)(i - SQUASH_OFFSET) / 256.0;
        double p = 1.0 / (1.0 + exp(-x));
        int v = (int)(p * PROB_ONE + 0.5);
        if (v < 1) v = 1;
        if (v > PROB_ONE - 1) v = PROB_ONE - 1;
        squash_table[i] = v;
    }
}

static inline int stretch(int p) {
    if (p < 1) p = 1;
    if (p > PROB_ONE - 1) p = PROB_ONE - 1;
    return stretch_table[p];
}

static inline int squash(int logit) {
    int idx = logit + SQUASH_OFFSET;
    if (idx < 0) idx = 0;
    if (idx >= SQUASH_SIZE) idx = SQUASH_SIZE - 1;
    return squash_table[idx];
}

/* =========================================================================
 * Context hashing
 * ========================================================================= */

static inline uint32_t hash_combine(uint32_t h, uint8_t b) {
    return (h * 2654435761u) ^ (uint32_t)b;
}

static inline uint32_t finalize_hash(uint32_t h, int bit_pos, int partial_byte) {
    h = hash_combine(h, (uint8_t)bit_pos);
    h = hash_combine(h, (uint8_t)partial_byte);
    return h;
}

/* =========================================================================
 * Context model state entries
 * ========================================================================= */

typedef struct {
    uint8_t c0;  /* count of 0 bits */
    uint8_t c1;  /* count of 1 bits */
} StateEntry;

/* Predict P(1) in 12-bit fixed point using Laplace smoothing */
static inline int state_predict(const StateEntry *e) {
    int total = (int)e->c0 + (int)e->c1 + 2;
    return ((int)e->c1 + 1) * PROB_ONE / total;
}

/* Update state with actual bit, halve if overflow */
static inline void state_update(StateEntry *e, int bit) {
    if (bit) {
        e->c1++;
        if (e->c1 > 127) { e->c0 >>= 1; e->c1 >>= 1; }
    } else {
        e->c0++;
        if (e->c0 > 127) { e->c0 >>= 1; e->c1 >>= 1; }
    }
}

/* =========================================================================
 * HTML State Machine
 * ========================================================================= */

enum {
    ST_TEXT = 0,
    ST_TAG_OPEN,      /* just saw '<' */
    ST_TAG_NAME,      /* reading tag name */
    ST_TAG_SPACE,     /* after tag name, before attr */
    ST_ATTR_NAME,     /* reading attribute name */
    ST_ATTR_EQ,       /* saw '=' after attr name */
    ST_ATTR_VALUE,    /* reading unquoted attr value */
    ST_ATTR_QUOTED,   /* reading quoted attr value */
    ST_CLOSE_TAG,     /* inside </...> */
    ST_COMMENT        /* inside <!-- ... --> */
};

typedef struct {
    int state;
    int depth;          /* nesting depth */
    uint8_t tag_name[16]; /* current tag name buffer */
    int tag_name_len;
    char quote_char;    /* ' or " for attr values */
    int comment_dashes; /* for tracking --> */
} HTMLState;

static void html_state_init(HTMLState *hs) {
    memset(hs, 0, sizeof(*hs));
    hs->state = ST_TEXT;
}

static void html_state_update(HTMLState *hs, uint8_t byte) {
    switch (hs->state) {
    case ST_TEXT:
        if (byte == '<') {
            hs->state = ST_TAG_OPEN;
            hs->tag_name_len = 0;
        }
        break;

    case ST_TAG_OPEN:
        if (byte == '/') {
            hs->state = ST_CLOSE_TAG;
            hs->tag_name_len = 0;
        } else if (byte == '!') {
            hs->state = ST_COMMENT;
            hs->comment_dashes = 0;
        } else if (byte == '>') {
            hs->state = ST_TEXT;
        } else {
            hs->state = ST_TAG_NAME;
            hs->tag_name_len = 0;
            if (hs->tag_name_len < 15) {
                hs->tag_name[hs->tag_name_len++] = byte;
            }
            hs->depth++;
        }
        break;

    case ST_TAG_NAME:
        if (byte == '>') {
            hs->state = ST_TEXT;
        } else if (byte == ' ' || byte == '\t' || byte == '\n' || byte == '\r') {
            hs->state = ST_TAG_SPACE;
        } else if (byte == '/') {
            hs->state = ST_TAG_SPACE; /* self-closing */
        } else {
            if (hs->tag_name_len < 15) {
                hs->tag_name[hs->tag_name_len++] = byte;
            }
        }
        break;

    case ST_TAG_SPACE:
        if (byte == '>') {
            hs->state = ST_TEXT;
        } else if (byte == '/') {
            /* self-closing, stay in TAG_SPACE */
        } else if (byte != ' ' && byte != '\t' && byte != '\n' && byte != '\r') {
            hs->state = ST_ATTR_NAME;
        }
        break;

    case ST_ATTR_NAME:
        if (byte == '=') {
            hs->state = ST_ATTR_EQ;
        } else if (byte == '>') {
            hs->state = ST_TEXT;
        } else if (byte == ' ' || byte == '\t') {
            hs->state = ST_TAG_SPACE;
        }
        break;

    case ST_ATTR_EQ:
        if (byte == '"' || byte == '\'') {
            hs->state = ST_ATTR_QUOTED;
            hs->quote_char = (char)byte;
        } else if (byte == '>') {
            hs->state = ST_TEXT;
        } else if (byte != ' ' && byte != '\t') {
            hs->state = ST_ATTR_VALUE;
        }
        break;

    case ST_ATTR_VALUE:
        if (byte == ' ' || byte == '\t') {
            hs->state = ST_TAG_SPACE;
        } else if (byte == '>') {
            hs->state = ST_TEXT;
        }
        break;

    case ST_ATTR_QUOTED:
        if (byte == (uint8_t)hs->quote_char) {
            hs->state = ST_TAG_SPACE;
        }
        break;

    case ST_CLOSE_TAG:
        if (byte == '>') {
            hs->state = ST_TEXT;
            if (hs->depth > 0) hs->depth--;
        }
        break;

    case ST_COMMENT:
        if (byte == '-') {
            hs->comment_dashes++;
        } else if (byte == '>' && hs->comment_dashes >= 2) {
            hs->state = ST_TEXT;
            hs->comment_dashes = 0;
        } else {
            hs->comment_dashes = 0;
        }
        break;
    }
}

/* Classify HTML state into 4 expert classes for MoE mixer selection */
static inline int html_state_class(int state) {
    switch (state) {
    case ST_TEXT:                                   return 0; /* text content */
    case ST_TAG_NAME: case ST_CLOSE_TAG:            return 1; /* tag names */
    case ST_ATTR_NAME: case ST_ATTR_EQ:
    case ST_ATTR_VALUE: case ST_ATTR_QUOTED:        return 2; /* attributes */
    default:                                        return 3; /* tag_open, tag_space, comment */
    }
}

typedef struct {
    /* Context model state tables */
    StateEntry *order0;       /* SIZE_ORDER0 */
    StateEntry *order1;       /* SIZE_ORDER1 */
    StateEntry *order2;       /* SIZE_ORDER23 */
    StateEntry *order3;       /* SIZE_ORDER23 */
    StateEntry *order4;       /* SIZE_ORDER4 */
    StateEntry *order6;       /* SIZE_ORDER6 */
    StateEntry *order8;       /* SIZE_ORDER8 */
    StateEntry *html_tag;     /* SIZE_HTML */
    StateEntry *html_match;   /* SIZE_HTML */
    StateEntry *html_bracket; /* SIZE_HTML */
    StateEntry *word_model;  /* SIZE_WORD */
    StateEntry *order12;     /* SIZE_ORDER12: long-range context */

    /* Running-match model (LZ-style) */
    int32_t  *match_ht;       /* hash table: 4-byte prefix → position */
    uint8_t  *match_buf;      /* all processed bytes */
    size_t    match_buf_pos;
    size_t    match_buf_cap;
    int       match_ptr;       /* position of predicted next byte, or -1 */
    int       match_len;       /* current running match length */
    int       match_expected;  /* predicted next byte value, or -1 */
    int       match_ghost_ptr; /* position in match source after match broke (ghost tracking) */
    int       match_ghost_len; /* remaining bytes to track ghost match */

    /* Context bytes history */
    uint8_t history[16];
    int hist_pos;
    int bytes_seen;

    /* Word model state */
    uint32_t word_hash;      /* rolling hash of current word */
    uint32_t prev_word_hash; /* hash of previous completed word */

    /* Current byte bit processing */
    int bit_pos;
    int partial_byte;

    /* MoE mixer: context-selected weight sets (html_class × bit_pos) */
    int weights[MIXER_SETS][N_MODELS];
    int stretched[N_MODELS];
    int predictions[N_MODELS];
    int cur_mix_set;  /* which mixer set was used (for update) */

    /* APM (secondary correction filter) */
    int apm[APM_SIZE];   /* 12-bit probabilities */
    int apm_idx;         /* last APM index used */
    int apm2[APM2_SIZE]; /* second APM stage */
    int apm2_idx;
    int apm3[APM3_SIZE]; /* third APM stage: indirect (order-4 prediction context) */
    int apm3_idx;
    int apm4[APM4_SIZE]; /* fourth APM stage: match-byte literal context */
    int apm4_idx;

    /* HTML state */
    HTMLState html;

    /* Hash indices for state table update (all N_STATE_MODELS) */
    uint32_t hash_idx[N_STATE_MODELS];
} Predictor;

static void predictor_destroy(Predictor *p);  /* forward declaration */

static Predictor *predictor_create(void) {
    Predictor *p = (Predictor *)calloc(1, sizeof(Predictor));
    if (!p) { fprintf(stderr, "Out of memory (predictor)\n"); return NULL; }

    p->order0 = (StateEntry *)calloc(SIZE_ORDER0, sizeof(StateEntry));
    p->order1 = (StateEntry *)calloc(SIZE_ORDER1, sizeof(StateEntry));
    p->order2 = (StateEntry *)calloc(SIZE_ORDER23, sizeof(StateEntry));
    p->order3 = (StateEntry *)calloc(SIZE_ORDER23, sizeof(StateEntry));
    p->order4 = (StateEntry *)calloc(SIZE_ORDER4, sizeof(StateEntry));
    p->order6 = (StateEntry *)calloc(SIZE_ORDER6, sizeof(StateEntry));
    p->order8 = (StateEntry *)calloc(SIZE_ORDER8, sizeof(StateEntry));
    p->html_tag = (StateEntry *)calloc(SIZE_HTML, sizeof(StateEntry));
    p->html_match = (StateEntry *)calloc(SIZE_HTML, sizeof(StateEntry));
    p->html_bracket = (StateEntry *)calloc(SIZE_HTML, sizeof(StateEntry));
    p->word_model = (StateEntry *)calloc(SIZE_WORD, sizeof(StateEntry));
    p->order12 = (StateEntry *)calloc(SIZE_ORDER12, sizeof(StateEntry));

    p->match_ht = (int32_t *)malloc(MATCH_HASH_SIZE * MATCH_CHAINS * sizeof(int32_t));
    p->match_buf_cap = MATCH_BUF_INIT;
    p->match_buf = (uint8_t *)malloc(p->match_buf_cap);

    if (!p->order0 || !p->order1 || !p->order2 || !p->order3 ||
        !p->order4 || !p->order6 || !p->order8 || !p->order12 ||
        !p->html_tag || !p->html_match || !p->html_bracket || !p->word_model ||
        !p->match_ht || !p->match_buf) {
        fprintf(stderr, "Out of memory (state tables)\n");
        predictor_destroy(p);
        return NULL;
    }

    /* -1 = no entry in match hash table */
    memset(p->match_ht, 0xFF, MATCH_HASH_SIZE * MATCH_CHAINS * sizeof(int32_t));
    p->match_ptr = -1;
    p->match_expected = -1;
    p->match_len = 0;
    p->match_buf_pos = 0;

    p->partial_byte = 1;
    html_state_init(&p->html);

    /* Initialize APM: linear interpolation from 0 to PROB_ONE across bins */
    for (int ctx = 0; ctx < APM_CONTEXTS; ctx++) {
        for (int bin = 0; bin < APM_BINS; bin++) {
            p->apm[ctx * APM_BINS + bin] = (bin * PROB_ONE + APM_BINS / 2) / APM_BINS;
        }
    }
    for (int ctx = 0; ctx < APM2_CONTEXTS; ctx++) {
        for (int bin = 0; bin < APM2_BINS; bin++) {
            p->apm2[ctx * APM2_BINS + bin] = (bin * PROB_ONE + APM2_BINS / 2) / APM2_BINS;
        }
    }
    for (int ctx = 0; ctx < APM3_CONTEXTS; ctx++) {
        for (int bin = 0; bin < APM3_BINS; bin++) {
            p->apm3[ctx * APM3_BINS + bin] = (bin * PROB_ONE + APM3_BINS / 2) / APM3_BINS;
        }
    }
    for (int ctx = 0; ctx < APM4_CONTEXTS; ctx++) {
        for (int bin = 0; bin < APM4_BINS; bin++) {
            p->apm4[ctx * APM4_BINS + bin] = (bin * PROB_ONE + APM4_BINS / 2) / APM4_BINS;
        }
    }
    p->match_ghost_ptr = -1;
    p->match_ghost_len = 0;

    return p;
}

static void predictor_destroy(Predictor *p) {
    if (!p) return;
    free(p->order0); free(p->order1);
    free(p->order2); free(p->order3);
    free(p->order4); free(p->order6); free(p->order8);
    free(p->html_tag); free(p->html_match); free(p->html_bracket);
    free(p->word_model); free(p->order12);
    free(p->match_ht); free(p->match_buf);
    free(p);
}

static inline uint8_t hist_byte(const Predictor *p, int ago) {
    if (ago >= p->bytes_seen) return 0;
    int idx = (p->hist_pos - 1 - ago + 16) & 15;
    return p->history[idx];
}

static inline uint32_t match_hash4(const uint8_t *d) {
    uint32_t h = d[0];
    h = (h * 2654435761u) ^ d[1];
    h = (h * 2654435761u) ^ d[2];
    h = (h * 2654435761u) ^ d[3];
    return h;
}


/* Predict P(next_bit=1) in 12-bit fixed point */
static int predictor_predict(Predictor *p) {
    int bp = p->bit_pos;
    int pb = p->partial_byte;
    uint32_t h;

    /* Model 0: Order-0 */
    h = finalize_hash(0, bp, pb);
    p->hash_idx[0] = h & (SIZE_ORDER0 - 1);
    p->predictions[0] = state_predict(&p->order0[p->hash_idx[0]]);

    /* Model 1: Order-1 */
    h = hash_combine(0, hist_byte(p, 0));
    h = finalize_hash(h, bp, pb);
    p->hash_idx[1] = h & (SIZE_ORDER1 - 1);
    p->predictions[1] = state_predict(&p->order1[p->hash_idx[1]]);

    /* Model 2: Order-2 */
    h = hash_combine(0, hist_byte(p, 1));
    h = hash_combine(h, hist_byte(p, 0));
    h = finalize_hash(h, bp, pb);
    p->hash_idx[2] = h & (SIZE_ORDER23 - 1);
    p->predictions[2] = state_predict(&p->order2[p->hash_idx[2]]);

    /* Model 3: Order-3 */
    h = hash_combine(0, hist_byte(p, 2));
    h = hash_combine(h, hist_byte(p, 1));
    h = hash_combine(h, hist_byte(p, 0));
    h = finalize_hash(h, bp, pb);
    p->hash_idx[3] = h & (SIZE_ORDER23 - 1);
    p->predictions[3] = state_predict(&p->order3[p->hash_idx[3]]);

    /* Model 4: Order-4 */
    h = hash_combine(0, hist_byte(p, 3));
    h = hash_combine(h, hist_byte(p, 2));
    h = hash_combine(h, hist_byte(p, 1));
    h = hash_combine(h, hist_byte(p, 0));
    h = finalize_hash(h, bp, pb);
    p->hash_idx[4] = h & (SIZE_ORDER4 - 1);
    p->predictions[4] = state_predict(&p->order4[p->hash_idx[4]]);

    /* Model 5: Order-6 */
    h = hash_combine(0, hist_byte(p, 5));
    h = hash_combine(h, hist_byte(p, 4));
    h = hash_combine(h, hist_byte(p, 3));
    h = hash_combine(h, hist_byte(p, 2));
    h = hash_combine(h, hist_byte(p, 1));
    h = hash_combine(h, hist_byte(p, 0));
    h = finalize_hash(h, bp, pb);
    p->hash_idx[5] = h & (SIZE_ORDER6 - 1);
    p->predictions[5] = state_predict(&p->order6[p->hash_idx[5]]);

    /* Model 6: Order-8 */
    h = hash_combine(0, hist_byte(p, 7));
    h = hash_combine(h, hist_byte(p, 6));
    h = hash_combine(h, hist_byte(p, 5));
    h = hash_combine(h, hist_byte(p, 4));
    h = hash_combine(h, hist_byte(p, 3));
    h = hash_combine(h, hist_byte(p, 2));
    h = hash_combine(h, hist_byte(p, 1));
    h = hash_combine(h, hist_byte(p, 0));
    h = finalize_hash(h, bp, pb);
    p->hash_idx[6] = h & (SIZE_ORDER8 - 1);
    p->predictions[6] = state_predict(&p->order8[p->hash_idx[6]]);

    /* Model 7: HTML tag model */
    h = hash_combine(0, (uint8_t)p->html.state);
    h = hash_combine(h, hist_byte(p, 0));
    h = hash_combine(h, hist_byte(p, 1));
    h = finalize_hash(h, bp, pb);
    p->hash_idx[7] = h & (SIZE_HTML - 1);
    p->predictions[7] = state_predict(&p->html_tag[p->hash_idx[7]]);

    /* Model 8: HTML match model (tag name prediction) */
    h = hash_combine(0, (uint8_t)p->html.state);
    if (p->html.tag_name_len > 0) {
        for (int i = 0; i < p->html.tag_name_len && i < 15; i++)
            h = hash_combine(h, p->html.tag_name[i]);
    }
    h = finalize_hash(h, bp, pb);
    p->hash_idx[8] = h & (SIZE_HTML - 1);
    p->predictions[8] = state_predict(&p->html_match[p->hash_idx[8]]);

    /* Model 9: HTML bracket model (nesting depth) */
    h = hash_combine(0, (uint8_t)(p->html.depth & 15));
    h = hash_combine(h, hist_byte(p, 0));
    h = finalize_hash(h, bp, pb);
    p->hash_idx[9] = h & (SIZE_HTML - 1);
    p->predictions[9] = state_predict(&p->html_bracket[p->hash_idx[9]]);

    /* Model 10: Word model (hash of current word) */
    h = finalize_hash(p->word_hash, bp, pb);
    p->hash_idx[10] = h & (SIZE_WORD - 1);
    p->predictions[10] = state_predict(&p->word_model[p->hash_idx[10]]);

    /* Model 11: Order-12 (captures long-range web patterns: repeated templates, JS blocks) */
    h = hash_combine(0, hist_byte(p, 11));
    h = hash_combine(h, hist_byte(p, 10));
    h = hash_combine(h, hist_byte(p, 9));
    h = hash_combine(h, hist_byte(p, 8));
    h = hash_combine(h, hist_byte(p, 7));
    h = hash_combine(h, hist_byte(p, 6));
    h = hash_combine(h, hist_byte(p, 5));
    h = hash_combine(h, hist_byte(p, 4));
    h = hash_combine(h, hist_byte(p, 3));
    h = hash_combine(h, hist_byte(p, 2));
    h = hash_combine(h, hist_byte(p, 1));
    h = hash_combine(h, hist_byte(p, 0));
    h = finalize_hash(h, bp, pb);
    p->hash_idx[11] = h & (SIZE_ORDER12 - 1);
    p->predictions[11] = state_predict(&p->order12[p->hash_idx[11]]);

    /* Model 12: Running-match model — more granular confidence */
    if (p->match_expected >= 0) {
        int expected_bit = (p->match_expected >> (7 - bp)) & 1;
        int conf;
        if (p->match_len >= 2048) conf = 4092;
        else if (p->match_len >= 512) conf = 4085;
        else if (p->match_len >= 128) conf = 4060;
        else if (p->match_len >= 64) conf = 4020;
        else if (p->match_len >= 32) conf = 3960;
        else if (p->match_len >= 16) conf = 3900;
        else if (p->match_len >= 8) conf = 3700;
        else if (p->match_len >= 6) conf = 3550;
        else conf = 3400;
        p->predictions[12] = expected_bit ? conf : (PROB_ONE - conf);
    } else {
        p->predictions[12] = PROB_HALF;
    }

    /* Logistic mixer */
    int *w = p->weights[0];
    int sum = 0;
    for (int i = 0; i < N_MODELS; i++) {
        p->stretched[i] = stretch(p->predictions[i]);
        sum += w[i] * p->stretched[i];
    }
    int mixed = squash(sum >> 8);
    if (mixed < 1) mixed = 1;
    if (mixed > PROB_ONE - 1) mixed = PROB_ONE - 1;

    /* APM: secondary correction using previous byte × HTML state class */
    int html_cls = html_state_class(p->html.state);
    int apm_ctx = (int)hist_byte(p, 0) | (html_cls << 8);
    int bin = (mixed * (APM_BINS - 1) + PROB_HALF) >> PROB_BITS;
    if (bin < 0) bin = 0;
    if (bin >= APM_BINS) bin = APM_BINS - 1;
    p->apm_idx = apm_ctx * APM_BINS + bin;

    /* Interpolate between neighboring bins */
    int frac = ((mixed * (APM_BINS - 1)) << 4) >> PROB_BITS;
    int bin_lo = frac >> 4;
    int bin_hi = bin_lo + 1;
    if (bin_hi >= APM_BINS) bin_hi = APM_BINS - 1;
    int w_hi = frac & 15;
    int w_lo = 16 - w_hi;
    int base = apm_ctx * APM_BINS;
    int apm_pred = (p->apm[base + bin_lo] * w_lo + p->apm[base + bin_hi] * w_hi + 8) >> 4;
    if (apm_pred < 1) apm_pred = 1;
    if (apm_pred > PROB_ONE - 1) apm_pred = PROB_ONE - 1;

    /* Blend mixer output with APM output */
    int final_pred = (mixed + apm_pred + 1) >> 1;
    if (final_pred < 1) final_pred = 1;
    if (final_pred > PROB_ONE - 1) final_pred = PROB_ONE - 1;

    /* APM2: second stage using bit position as context */
    {
        int ctx2 = bp | ((hist_byte(p, 0) >> 6) << 3);  /* bit_pos × top 2 bits */
        int bin2 = (final_pred * (APM2_BINS - 1) + PROB_HALF) >> PROB_BITS;
        if (bin2 < 0) bin2 = 0;
        if (bin2 >= APM2_BINS) bin2 = APM2_BINS - 1;
        p->apm2_idx = ctx2 * APM2_BINS + bin2;
        int frac2 = ((final_pred * (APM2_BINS - 1)) << 4) >> PROB_BITS;
        int blo2 = frac2 >> 4;
        int bhi2 = blo2 + 1;
        if (bhi2 >= APM2_BINS) bhi2 = APM2_BINS - 1;
        int wh2 = frac2 & 15;
        int wl2 = 16 - wh2;
        int base2 = ctx2 * APM2_BINS;
        int apm2_pred = (p->apm2[base2 + blo2] * wl2 + p->apm2[base2 + bhi2] * wh2 + 8) >> 4;
        if (apm2_pred < 1) apm2_pred = 1;
        if (apm2_pred > PROB_ONE - 1) apm2_pred = PROB_ONE - 1;
        final_pred = (final_pred + apm2_pred + 1) >> 1;
        if (final_pred < 1) final_pred = 1;
        if (final_pred > PROB_ONE - 1) final_pred = PROB_ONE - 1;
    }

    /* APM3: third stage — order-4 prediction × match length bucket */
    {
        int o4q = (p->predictions[4] * APM3_QBINS) >> PROB_BITS;
        if (o4q >= APM3_QBINS) o4q = APM3_QBINS - 1;
        /* Match length bucket: 0=none, 1-7 = log2 ranges */
        int mlen_bucket;
        if (p->match_expected < 0) mlen_bucket = 0;
        else if (p->match_len < 8)   mlen_bucket = 1;
        else if (p->match_len < 16)  mlen_bucket = 2;
        else if (p->match_len < 32)  mlen_bucket = 3;
        else if (p->match_len < 64)  mlen_bucket = 4;
        else if (p->match_len < 128) mlen_bucket = 5;
        else if (p->match_len < 512) mlen_bucket = 6;
        else mlen_bucket = 7;
        int ctx3 = o4q * APM3_MLEN + mlen_bucket;
        int bin3 = (final_pred * (APM3_BINS - 1) + PROB_HALF) >> PROB_BITS;
        if (bin3 < 0) bin3 = 0;
        if (bin3 >= APM3_BINS) bin3 = APM3_BINS - 1;
        p->apm3_idx = ctx3 * APM3_BINS + bin3;
        int frac3 = ((final_pred * (APM3_BINS - 1)) << 4) >> PROB_BITS;
        int blo3 = frac3 >> 4;
        int bhi3 = blo3 + 1;
        if (bhi3 >= APM3_BINS) bhi3 = APM3_BINS - 1;
        int wh3 = frac3 & 15;
        int wl3 = 16 - wh3;
        int base3 = ctx3 * APM3_BINS;
        int apm3_pred = (p->apm3[base3 + blo3] * wl3 + p->apm3[base3 + bhi3] * wh3 + 8) >> 4;
        if (apm3_pred < 1) apm3_pred = 1;
        if (apm3_pred > PROB_ONE - 1) apm3_pred = PROB_ONE - 1;
        final_pred = (final_pred + apm3_pred + 1) >> 1;
        if (final_pred < 1) final_pred = 1;
        if (final_pred > PROB_ONE - 1) final_pred = PROB_ONE - 1;
    }

    /* APM4: match-byte literal context (LZMA-style ghost tracking)
     * When ghost tracking is active, read the byte from match source position.
     * Use its bit at current position for LZMA-style branching. */
    {
        int ctx4;
        int ghost_byte = -1;
        if (p->match_ghost_len > 0 && p->match_ghost_ptr >= 0 &&
            (size_t)p->match_ghost_ptr < p->match_buf_pos) {
            ghost_byte = p->match_buf[p->match_ghost_ptr];
        }
        if (ghost_byte >= 0) {
            int mb_bit = (ghost_byte >> (7 - bp)) & 1;
            ctx4 = 8 + mb_bit * 8 + bp;  /* 8-15: mb_bit=0, 16-23: mb_bit=1 */
        } else {
            ctx4 = bp;  /* 0-7: no ghost */
        }
        int bin4 = (final_pred * (APM4_BINS - 1) + PROB_HALF) >> PROB_BITS;
        if (bin4 < 0) bin4 = 0;
        if (bin4 >= APM4_BINS) bin4 = APM4_BINS - 1;
        p->apm4_idx = ctx4 * APM4_BINS + bin4;
        int frac4 = ((final_pred * (APM4_BINS - 1)) << 4) >> PROB_BITS;
        int blo4 = frac4 >> 4;
        int bhi4 = blo4 + 1;
        if (bhi4 >= APM4_BINS) bhi4 = APM4_BINS - 1;
        int wh4 = frac4 & 15;
        int wl4 = 16 - wh4;
        int base4 = ctx4 * APM4_BINS;
        int apm4_pred = (p->apm4[base4 + blo4] * wl4 + p->apm4[base4 + bhi4] * wh4 + 8) >> 4;
        if (apm4_pred < 1) apm4_pred = 1;
        if (apm4_pred > PROB_ONE - 1) apm4_pred = PROB_ONE - 1;
        final_pred = (final_pred + apm4_pred + 1) >> 1;
        if (final_pred < 1) final_pred = 1;
        if (final_pred > PROB_ONE - 1) final_pred = PROB_ONE - 1;
    }

    return final_pred;
}

/* Update all models after seeing actual bit */
static void predictor_update(Predictor *p, int bit) {
    StateEntry *tables[] = {
        p->order0, p->order1, p->order2, p->order3,
        p->order4, p->order6, p->order8,
        p->html_tag, p->html_match, p->html_bracket,
        p->word_model, p->order12
    };
    for (int i = 0; i < N_STATE_MODELS; i++)
        state_update(&tables[i][p->hash_idx[i]], bit);

    /* Check match validity */
    if (p->match_expected >= 0) {
        int expected_bit = (p->match_expected >> (7 - p->bit_pos)) & 1;
        if (bit != expected_bit) {
            /* Match broke mid-byte — start ghost tracking */
            if (p->match_len >= 4 && p->match_ptr >= 0) {
                p->match_ghost_ptr = p->match_ptr;
                p->match_ghost_len = 3;
            }
            p->match_ptr = -1;
            p->match_expected = -1;
            p->match_len = 0;
        }
    }

    /* Update mixer weights */
    int *w = p->weights[0];
    int pred;
    {
        int sum = 0;
        for (int i = 0; i < N_MODELS; i++)
            sum += w[i] * p->stretched[i];
        pred = squash(sum >> 8);
    }
    int error = (bit << PROB_BITS) - pred;
    for (int i = 0; i < N_MODELS; i++) {
        w[i] += (LR * error * p->stretched[i]) >> 16;
        if (w[i] > 65536) w[i] = 65536;
        if (w[i] < -65536) w[i] = -65536;
    }

    /* Update APM stages */
    {
        int target = bit ? PROB_ONE : 0;
        int apm_error = target - p->apm[p->apm_idx];
        p->apm[p->apm_idx] += (apm_error * APM_LR + 128) >> 8;
        int apm2_error = target - p->apm2[p->apm2_idx];
        p->apm2[p->apm2_idx] += (apm2_error * APM2_LR + 128) >> 8;
        int apm3_error = target - p->apm3[p->apm3_idx];
        p->apm3[p->apm3_idx] += (apm3_error * APM3_LR + 128) >> 8;
        int apm4_error = target - p->apm4[p->apm4_idx];
        p->apm4[p->apm4_idx] += (apm4_error * APM4_LR + 128) >> 8;
    }

    p->partial_byte = (p->partial_byte << 1) | bit;
    p->bit_pos++;

    if (p->bit_pos == 8) {
        uint8_t full_byte = (uint8_t)(p->partial_byte & 0xFF);
        html_state_update(&p->html, full_byte);

        /* === Running match model === */
        if (p->match_buf_pos >= p->match_buf_cap) {
            p->match_buf_cap *= 2;
            p->match_buf = (uint8_t *)realloc(p->match_buf, p->match_buf_cap);
            if (!p->match_buf) { fprintf(stderr, "OOM\n"); return; }
        }
        p->match_buf[p->match_buf_pos] = full_byte;

        /* Check if active match continues */
        if (p->match_ptr >= 0) {
            if (p->match_buf[p->match_ptr] == full_byte) {
                p->match_len++;
                p->match_ptr++;
            } else {
                /* Match broke — start ghost tracking from match source */
                if (p->match_len >= 4 && (size_t)p->match_ptr < p->match_buf_pos) {
                    p->match_ghost_ptr = p->match_ptr;
                    p->match_ghost_len = 3;
                }
                p->match_ptr = -1;
                p->match_len = 0;
            }
        }
        /* Advance ghost tracking */
        if (p->match_ghost_len > 0) {
            p->match_ghost_ptr++;
            p->match_ghost_len--;
        }

        /* Look for new match — 4-byte hash with chains + backward extension */
        if (p->match_ptr < 0 && p->match_buf_pos >= 3) {
            uint32_t mh = match_hash4(p->match_buf + p->match_buf_pos - 3);
            int bucket = (int)(mh & (MATCH_HASH_SIZE - 1)) * MATCH_CHAINS;
            int best_ptr = -1, best_fwd = 0;
            for (int c = 0; c < MATCH_CHAINS; c++) {
                int32_t stored = p->match_ht[bucket + c];
                if (stored < 0) continue;
                if ((size_t)(stored + 4) > p->match_buf_pos - 3) continue;
                if (p->match_buf[stored]   != p->match_buf[p->match_buf_pos - 3] ||
                    p->match_buf[stored+1] != p->match_buf[p->match_buf_pos - 2] ||
                    p->match_buf[stored+2] != p->match_buf[p->match_buf_pos - 1] ||
                    p->match_buf[stored+3] != full_byte) continue;
                int fwd = 4;
                int extra = 0;
                while (stored - extra - 1 >= 0 &&
                       (int)(p->match_buf_pos - 3) - extra - 1 >= 0 &&
                       p->match_buf[stored - extra - 1] == p->match_buf[p->match_buf_pos - 3 - extra - 1]) {
                    extra++;
                    if (extra >= 256) break;
                }
                fwd += extra;
                if (fwd > best_fwd) {
                    best_fwd = fwd;
                    best_ptr = stored + 4;
                }
            }
            if (best_ptr >= 0) {
                p->match_ptr = best_ptr;
                p->match_len = 4;
            }
        }

        /* Set expected byte for next prediction */
        if (p->match_ptr >= 0 && (size_t)p->match_ptr < p->match_buf_pos) {
            p->match_expected = p->match_buf[p->match_ptr];
        } else {
            p->match_expected = -1;
            if (p->match_ptr >= 0 && (size_t)p->match_ptr >= p->match_buf_pos) {
                p->match_ptr = -1;
                p->match_len = 0;
            }
        }

        /* Update hash table — FIFO chain: shift old, insert new at [0] */
        if (p->match_buf_pos >= 3) {
            uint32_t mh = match_hash4(p->match_buf + p->match_buf_pos - 3);
            int bucket = (int)(mh & (MATCH_HASH_SIZE - 1)) * MATCH_CHAINS;
            for (int c = MATCH_CHAINS - 1; c > 0; c--)
                p->match_ht[bucket + c] = p->match_ht[bucket + c - 1];
            p->match_ht[bucket] = (int32_t)(p->match_buf_pos - 3);
        }
        p->match_buf_pos++;

        /* Update word hash: letters/digits build word, everything else ends it */
        if ((full_byte >= 'a' && full_byte <= 'z') ||
            (full_byte >= 'A' && full_byte <= 'Z') ||
            (full_byte >= '0' && full_byte <= '9') ||
            full_byte == '-' || full_byte == '_') {
            p->word_hash = (p->word_hash * 2654435761u) ^ full_byte;
        } else {
            if (p->word_hash != 0) {
                p->prev_word_hash = p->word_hash;
                p->word_hash = 0;
            }
        }

        p->history[p->hist_pos] = full_byte;
        p->hist_pos = (p->hist_pos + 1) & 15;
        if (p->bytes_seen < 16) p->bytes_seen++;
        p->bit_pos = 0;
        p->partial_byte = 1;
    }
}


/* =========================================================================
 * Range Coder (FPAQ0-style, proven correct)
 *
 * Uses [x1, x2] inclusive range with top-byte-matching normalization.
 * No carry propagation needed — bytes are only output when the top
 * bytes of x1 and x2 agree.
 * ========================================================================= */

/* --- Encoder --- */

typedef struct {
    uint32_t x1, x2;   /* Range [x1, x2] inclusive */
    uint8_t *buf;
    size_t buf_size;
    size_t buf_cap;
} RangeEncoder;

static void rc_enc_init(RangeEncoder *rc) {
    rc->x1 = 0;
    rc->x2 = 0xFFFFFFFF;
    rc->buf_size = 0;
    rc->buf_cap = 1 << 20;
    rc->buf = (uint8_t *)malloc(rc->buf_cap);
    if (!rc->buf) { fprintf(stderr, "Out of memory (encoder)\n"); rc->buf_cap = 0; return; }
}

static inline void rc_enc_output_byte(RangeEncoder *rc, uint8_t b) {
    if (rc->buf_size >= rc->buf_cap) {
        rc->buf_cap *= 2;
        rc->buf = (uint8_t *)realloc(rc->buf, rc->buf_cap);
        if (!rc->buf) { fprintf(stderr, "Out of memory (encoder realloc)\n"); return; }
    }
    rc->buf[rc->buf_size++] = b;
}

static void rc_enc_encode_bit(RangeEncoder *rc, int bit, int prob) {
    /* prob = P(bit=1) in 12-bit fixed point (1..4095)
     * Split range: [x1, xmid] for bit 0, [xmid+1, x2] for bit 1
     * xmid = x1 + ((x2-x1) >> 12) * (4096 - prob)
     * This gives P(0) fraction = (4096-prob)/4096 of the range to bit 0 */
    uint32_t xmid = rc->x1 + (uint32_t)(((uint64_t)(rc->x2 - rc->x1) * (4096 - prob)) >> 12);

    if (bit) {
        rc->x1 = xmid + 1;
    } else {
        rc->x2 = xmid;
    }

    /* Normalize: output matching top bytes */
    while (((rc->x1 ^ rc->x2) & 0xFF000000) == 0) {
        rc_enc_output_byte(rc, (uint8_t)(rc->x2 >> 24));
        rc->x1 <<= 8;
        rc->x2 = (rc->x2 << 8) | 0xFF;
    }
}

static void rc_enc_flush(RangeEncoder *rc) {
    /* Output enough bytes to uniquely identify the final range */
    rc_enc_output_byte(rc, (uint8_t)(rc->x1 >> 24));
    rc_enc_output_byte(rc, (uint8_t)(rc->x1 >> 16));
    rc_enc_output_byte(rc, (uint8_t)(rc->x1 >> 8));
    rc_enc_output_byte(rc, (uint8_t)(rc->x1));
}

static void rc_enc_free(RangeEncoder *rc) {
    free(rc->buf);
}

/* --- Decoder --- */

typedef struct {
    uint32_t x1, x2;   /* Range [x1, x2] inclusive */
    uint32_t x;         /* Code value */
    const uint8_t *buf;
    size_t buf_pos;
    size_t buf_size;
} RangeDecoder;

static void rc_dec_init(RangeDecoder *rc, const uint8_t *data, size_t size) {
    rc->x1 = 0;
    rc->x2 = 0xFFFFFFFF;
    rc->x = 0;
    rc->buf = data;
    rc->buf_size = size;
    rc->buf_pos = 0;

    /* Read initial 4 bytes into code */
    for (int i = 0; i < 4; i++) {
        rc->x = (rc->x << 8);
        if (rc->buf_pos < rc->buf_size)
            rc->x |= rc->buf[rc->buf_pos++];
    }
}

static int rc_dec_decode_bit(RangeDecoder *rc, int prob) {
    uint32_t xmid = rc->x1 + (uint32_t)(((uint64_t)(rc->x2 - rc->x1) * (4096 - prob)) >> 12);
    int bit;

    if (rc->x > xmid) {
        bit = 1;
        rc->x1 = xmid + 1;
    } else {
        bit = 0;
        rc->x2 = xmid;
    }

    /* Normalize: shift out matching top bytes */
    while (((rc->x1 ^ rc->x2) & 0xFF000000) == 0) {
        rc->x1 <<= 8;
        rc->x2 = (rc->x2 << 8) | 0xFF;
        rc->x = (rc->x << 8);
        if (rc->buf_pos < rc->buf_size)
            rc->x |= rc->buf[rc->buf_pos++];
    }

    return bit;
}

/* =========================================================================
 * LZ77 Preprocessor — eliminates repeated strings before context mixing
 *
 * Format (GG02): escape-byte based encoding
 *   First byte of preprocessed stream: escape byte (least common in input)
 *   Bytes 1-3: reserved (0)
 *   Then: literals pass through; escape byte introduces special tokens:
 *     esc + 0x00 + 0x00 + 0x00          = literal escape byte (4 bytes)
 *     esc + off[2] + off[1] + off[0] + len = match reference (5 bytes)
 *       offset: 3 bytes big-endian (1..16777215)
 *       length: 1 byte (actual_length - LZ77_MIN_MATCH, so 0..255 = 6..261)
 * ========================================================================= */

static inline uint32_t lz77_hash4(const uint8_t *d) {
    uint32_t h = (uint32_t)d[0] | ((uint32_t)d[1] << 8) |
                 ((uint32_t)d[2] << 16) | ((uint32_t)d[3] << 24);
    h *= 2654435761u;
    return h >> (32 - LZ77_HASH_BITS);
}

/* Find the least-common byte value in the input */
static uint8_t find_escape_byte(const uint8_t *data, size_t size) {
    int freq[256];
    memset(freq, 0, sizeof(freq));
    for (size_t i = 0; i < size; i++) freq[data[i]]++;
    int min_freq = freq[0];
    uint8_t min_byte = 0;
    for (int i = 1; i < 256; i++) {
        if (freq[i] < min_freq) {
            min_freq = freq[i];
            min_byte = (uint8_t)i;
        }
    }
    return min_byte;
}

/* LZ77 preprocess: replace repeated strings with backreferences.
 * Returns malloc'd preprocessed buffer, sets *out_size. */
static uint8_t *lz77_preprocess(const uint8_t *input, size_t size, size_t *out_size) {
    if (size < 16) {
        /* Too small, just copy with 4-byte header */
        uint8_t *out = (uint8_t *)malloc(size + 4);
        if (!out) return NULL;
        out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
        memcpy(out + 4, input, size);
        *out_size = size + 4;
        return out;
    }

    uint8_t esc = find_escape_byte(input, size);

    /* Hash chain match finder: head[hash] → chain[pos] → chain[prev] ... */
    int32_t *head = (int32_t *)malloc(LZ77_HASH_SIZE * sizeof(int32_t));
    int32_t *chain = (int32_t *)malloc(size * sizeof(int32_t));
    if (!head || !chain) {
        free(head); free(chain);
        return NULL;
    }
    memset(head, 0xFF, LZ77_HASH_SIZE * sizeof(int32_t));

    /* Output buffer (worst case: ~1.5x for many escape bytes) */
    size_t out_cap = size + size / 2 + 256;
    uint8_t *output = (uint8_t *)malloc(out_cap);
    if (!output) { free(head); free(chain); return NULL; }
    size_t out_pos = 0;

    /* Header: escape byte + 3 reserved bytes */
    output[out_pos++] = esc;
    output[out_pos++] = 0;
    output[out_pos++] = 0;
    output[out_pos++] = 0;

    size_t pos = 0;
    while (pos < size) {
        int best_len = 0, best_off = 0;

        /* Find best match via hash chain */
        if (pos + 3 < size) {
            uint32_t h = lz77_hash4(input + pos);
            int32_t cand = head[h];
            int depth = 0;

            while (cand >= 0 && depth < LZ77_CHAIN_DEPTH) {
                size_t off = pos - (size_t)cand;
                if (off > (size_t)LZ77_MAX_OFFSET) break;
                if (off > 0 && input[cand] == input[pos]) {
                    int len = 1;
                    int max_len = (int)(size - pos);
                    if (max_len > LZ77_MAX_MATCH) max_len = LZ77_MAX_MATCH;
                    while (len < max_len && input[cand + len] == input[pos + len])
                        len++;
                    if (len > best_len) {
                        best_len = len;
                        best_off = (int)off;
                    }
                }
                cand = chain[cand];
                depth++;
            }
        }

        if (best_len >= LZ77_MIN_MATCH) {
            /* Encode match: esc + offset(3B BE) + length(1B) */
            output[out_pos++] = esc;
            output[out_pos++] = (uint8_t)((best_off >> 16) & 0xFF);
            output[out_pos++] = (uint8_t)((best_off >> 8) & 0xFF);
            output[out_pos++] = (uint8_t)(best_off & 0xFF);
            output[out_pos++] = (uint8_t)(best_len - LZ77_MIN_MATCH);

            /* Insert all match positions into hash table */
            for (size_t i = 0; i < (size_t)best_len && pos + i + 3 < size; i++) {
                uint32_t h = lz77_hash4(input + pos + i);
                chain[pos + i] = head[h];
                head[h] = (int32_t)(pos + i);
            }
            pos += best_len;
        } else {
            /* Insert current position into hash */
            if (pos + 3 < size) {
                uint32_t h = lz77_hash4(input + pos);
                chain[pos] = head[h];
                head[h] = (int32_t)pos;
            }
            /* Literal byte */
            if (input[pos] == esc) {
                /* Escape literal: esc + 0x00 + 0x00 + 0x00 */
                output[out_pos++] = esc;
                output[out_pos++] = 0;
                output[out_pos++] = 0;
                output[out_pos++] = 0;
            } else {
                output[out_pos++] = input[pos];
            }
            pos++;
        }

        /* Grow output buffer if needed */
        if (out_pos + 16 > out_cap) {
            out_cap = out_cap * 2;
            output = (uint8_t *)realloc(output, out_cap);
            if (!output) { free(head); free(chain); return NULL; }
        }
    }

    free(head);
    free(chain);
    *out_size = out_pos;
    return output;
}

/* LZ77 reconstruct: reverse the preprocessing */
static uint8_t *lz77_reconstruct(const uint8_t *input, size_t size,
                                  size_t orig_size) {
    if (size < 4) return NULL;

    uint8_t esc = input[0];
    /* bytes 1-3 reserved */

    uint8_t *output = (uint8_t *)malloc(orig_size);
    if (!output) return NULL;

    size_t in_pos = 4, out_pos = 0;

    while (in_pos < size && out_pos < orig_size) {
        if (input[in_pos] == esc) {
            if (in_pos + 3 >= size) break;
            uint32_t offset = ((uint32_t)input[in_pos+1] << 16) |
                              ((uint32_t)input[in_pos+2] << 8) |
                              (uint32_t)input[in_pos+3];
            if (offset == 0) {
                /* Literal escape byte */
                output[out_pos++] = esc;
                in_pos += 4;
            } else {
                /* Match reference */
                if (in_pos + 4 >= size) break;
                int length = (int)input[in_pos+4] + LZ77_MIN_MATCH;
                in_pos += 5;
                if (offset > out_pos) break;  /* invalid offset — would read before buffer */
                for (int i = 0; i < length && out_pos < orig_size; i++) {
                    output[out_pos] = output[out_pos - offset];
                    out_pos++;
                }
            }
        } else {
            output[out_pos++] = input[in_pos++];
        }
    }

    return output;
}

/* =========================================================================
 * Compress
 * ========================================================================= */

static int compress_data(const uint8_t *input, size_t input_size,
                         uint8_t **output, size_t *output_size) {
    Predictor *pred = predictor_create();
    if (!pred) return -1;
    RangeEncoder rc;
    rc_enc_init(&rc);
    if (!rc.buf) { predictor_destroy(pred); return -1; }

    /* Encode each byte as 8 bits, MSB first */
    for (size_t i = 0; i < input_size; i++) {
        uint8_t byte = input[i];
        for (int bit = 7; bit >= 0; bit--) {
            int b = (byte >> bit) & 1;
            int prob = predictor_predict(pred);
            rc_enc_encode_bit(&rc, b, prob);
            predictor_update(pred, b);
        }
    }

    rc_enc_flush(&rc);

    /* Build output: header + encoded data */
    size_t total = HEADER_SIZE + rc.buf_size;
    uint8_t *out = (uint8_t *)malloc(total);
    if (!out) {
        predictor_destroy(pred);
        rc_enc_free(&rc);
        return -1;
    }

    /* Header: magic + original size (little-endian) */
    memcpy(out, MAGIC, MAGIC_SIZE);
    out[4] = (uint8_t)(input_size & 0xFF);
    out[5] = (uint8_t)((input_size >> 8) & 0xFF);
    out[6] = (uint8_t)((input_size >> 16) & 0xFF);
    out[7] = (uint8_t)((input_size >> 24) & 0xFF);

    memcpy(out + HEADER_SIZE, rc.buf, rc.buf_size);

    *output = out;
    *output_size = total;

    predictor_destroy(pred);
    rc_enc_free(&rc);
    return 0;
}

/* Compress with LZ77 preprocessing (GG02 format) */
static int compress_data_lz77(const uint8_t *input, size_t input_size,
                               uint8_t **output, size_t *output_size) {
    /* Step 1: LZ77 preprocess */
    size_t pp_size;
    uint8_t *pp_data = lz77_preprocess(input, input_size, &pp_size);
    if (!pp_data) return -1;

    /* If preprocessing didn't shrink by at least 5%, skip it */
    if (pp_size >= input_size * 95 / 100) {
        free(pp_data);
        return compress_data(input, input_size, output, output_size);
    }

    fprintf(stderr, "LZ77: %zu -> %zu bytes (%.1f%% of original)\n",
            input_size, pp_size, 100.0 * pp_size / input_size);

    /* Step 2: Context-mix the preprocessed stream */
    Predictor *pred = predictor_create();
    RangeEncoder rc;
    rc_enc_init(&rc);

    for (size_t i = 0; i < pp_size; i++) {
        uint8_t byte = pp_data[i];
        for (int bit = 7; bit >= 0; bit--) {
            int b = (byte >> bit) & 1;
            int prob = predictor_predict(pred);
            rc_enc_encode_bit(&rc, b, prob);
            predictor_update(pred, b);
        }
    }
    rc_enc_flush(&rc);

    /* Header: GG02 + original_size(4) + preprocessed_size(4) = 12 bytes */
    size_t hdr = 12;
    size_t total = hdr + rc.buf_size;
    uint8_t *out = (uint8_t *)malloc(total);
    if (!out) {
        predictor_destroy(pred);
        rc_enc_free(&rc);
        free(pp_data);
        return -1;
    }

    memcpy(out, MAGIC2, MAGIC_SIZE);
    out[4] = (uint8_t)(input_size & 0xFF);
    out[5] = (uint8_t)((input_size >> 8) & 0xFF);
    out[6] = (uint8_t)((input_size >> 16) & 0xFF);
    out[7] = (uint8_t)((input_size >> 24) & 0xFF);
    out[8] = (uint8_t)(pp_size & 0xFF);
    out[9] = (uint8_t)((pp_size >> 8) & 0xFF);
    out[10] = (uint8_t)((pp_size >> 16) & 0xFF);
    out[11] = (uint8_t)((pp_size >> 24) & 0xFF);
    memcpy(out + hdr, rc.buf, rc.buf_size);

    *output = out;
    *output_size = total;

    predictor_destroy(pred);
    rc_enc_free(&rc);
    free(pp_data);
    return 0;
}

/* Compress with best method: try GG01 and GG02, pick smaller */
static int compress_best(const uint8_t *input, size_t input_size,
                         uint8_t **output, size_t *output_size) {
    /* For small files, GG01 is always better (no LZ77 overhead) */
    return compress_data(input, input_size, output, output_size);
}

/* =========================================================================
 * Decompress
 * ========================================================================= */

static int decompress_data(const uint8_t *input, size_t input_size,
                           uint8_t **output, size_t *output_size) {
    if (input_size < HEADER_SIZE) {
        fprintf(stderr, "Error: input too small\n");
        return -1;
    }

    int is_gg02 = (memcmp(input, MAGIC2, MAGIC_SIZE) == 0);
    int is_gg01 = (memcmp(input, MAGIC, MAGIC_SIZE) == 0);

    if (!is_gg01 && !is_gg02) {
        fprintf(stderr, "Error: bad magic number\n");
        return -1;
    }

    /* Read original size */
    uint32_t orig_size = (uint32_t)input[4]
                       | ((uint32_t)input[5] << 8)
                       | ((uint32_t)input[6] << 16)
                       | ((uint32_t)input[7] << 24);

    /* Sanity check: reject absurdly large sizes (>256MB for web, >2GB otherwise) */
#ifdef GG_WEB_PROFILE
    if (orig_size > (256u << 20)) {
        fprintf(stderr, "Error: decoded size %u exceeds web limit\n", orig_size);
        return -1;
    }
#endif

    if (is_gg02) {
        /* GG02: LZ77 + context mixing */
        if (input_size < 12) {
            fprintf(stderr, "Error: GG02 header too small\n");
            return -1;
        }
        uint32_t pp_size = (uint32_t)input[8]
                         | ((uint32_t)input[9] << 8)
                         | ((uint32_t)input[10] << 16)
                         | ((uint32_t)input[11] << 24);

        /* Step 1: Arithmetic decode preprocessed stream */
        uint8_t *pp_data = (uint8_t *)malloc(pp_size);
        if (!pp_data && pp_size > 0) {
            fprintf(stderr, "Out of memory (decompress pp)\n");
            return -1;
        }

        Predictor *pred = predictor_create();
        if (!pred) { free(pp_data); return -1; }
        RangeDecoder rc;
        rc_dec_init(&rc, input + 12, input_size - 12);

        for (uint32_t i = 0; i < pp_size; i++) {
            uint8_t byte = 0;
            for (int bit = 7; bit >= 0; bit--) {
                int prob = predictor_predict(pred);
                int b = rc_dec_decode_bit(&rc, prob);
                byte |= (b << bit);
                predictor_update(pred, b);
            }
            pp_data[i] = byte;
        }
        predictor_destroy(pred);

        /* Step 2: LZ77 reconstruct */
        uint8_t *out = lz77_reconstruct(pp_data, pp_size, orig_size);
        free(pp_data);

        if (!out) {
            fprintf(stderr, "Error: LZ77 reconstruction failed\n");
            return -1;
        }

        *output = out;
        *output_size = (size_t)orig_size;
        return 0;
    }

    /* GG01: direct context mixing */
    uint8_t *out = (uint8_t *)malloc(orig_size);
    if (!out && orig_size > 0) {
        fprintf(stderr, "Out of memory (decompress output)\n");
        return -1;
    }

    Predictor *pred = predictor_create();
    if (!pred) { free(out); return -1; }
    RangeDecoder rc;
    rc_dec_init(&rc, input + HEADER_SIZE, input_size - HEADER_SIZE);

    for (uint32_t i = 0; i < orig_size; i++) {
        uint8_t byte = 0;
        for (int bit = 7; bit >= 0; bit--) {
            int prob = predictor_predict(pred);
            int b = rc_dec_decode_bit(&rc, prob);
            byte |= (b << bit);
            predictor_update(pred, b);
        }
        out[i] = byte;
    }

    *output = out;
    *output_size = (size_t)orig_size;

    predictor_destroy(pred);
    return 0;
}

/* =========================================================================
 * File I/O helpers
 * ========================================================================= */

static uint8_t *read_file(const char *path, size_t *size) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "Error: cannot open '%s' for reading\n", path);
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (len < 0) { fclose(f); return NULL; }

    uint8_t *data = (uint8_t *)malloc((size_t)len);
    if (!data) { fclose(f); return NULL; }
    if (len > 0) {
        size_t rd = fread(data, 1, (size_t)len, f);
        if ((long)rd != len) {
            free(data);
            fclose(f);
            return NULL;
        }
    }
    fclose(f);
    *size = (size_t)len;
    return data;
}

static int write_file(const char *path, const uint8_t *data, size_t size) {
    FILE *f = fopen(path, "wb");
    if (!f) {
        fprintf(stderr, "Error: cannot open '%s' for writing\n", path);
        return -1;
    }
    if (size > 0) {
        size_t wr = fwrite(data, 1, size, f);
        if (wr != size) {
            fclose(f);
            return -1;
        }
    }
    fclose(f);
    return 0;
}

#ifndef GG_LIBRARY  /* CLI-only code below */

/* Read all data from stdin (for pipe mode) */
static uint8_t *read_stdin(size_t *size) {
    size_t cap = 1 << 20;  /* 1MB initial */
    size_t len = 0;
    uint8_t *buf = (uint8_t *)malloc(cap);
    if (!buf) return NULL;
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
#endif
    while (1) {
        size_t rd = fread(buf + len, 1, cap - len, stdin);
        len += rd;
        if (rd == 0) break;
        if (len >= cap) {
            cap *= 2;
            uint8_t *nb = (uint8_t *)realloc(buf, cap);
            if (!nb) { free(buf); return NULL; }
            buf = nb;
        }
    }
    *size = len;
    return buf;
}

/* Write data to stdout (for pipe mode) */
static int write_stdout(const uint8_t *data, size_t size) {
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    if (size > 0) {
        size_t wr = fwrite(data, 1, size, stdout);
        fflush(stdout);
        if (wr != size) return -1;
    }
    return 0;
}

/* Compress stdin -> stdout (pipe mode, no status messages) */
static int cmd_pipe_compress(void) {
    size_t in_size;
    uint8_t *in_data = read_stdin(&in_size);
    if (!in_data) return 1;

    uint8_t *out_data;
    size_t out_size;
    if (compress_best(in_data, in_size, &out_data, &out_size) != 0) {
        free(in_data);
        return 1;
    }
    int ret = write_stdout(out_data, out_size);
    free(in_data);
    free(out_data);
    return ret;
}

/* Decompress stdin -> stdout (pipe mode, no status messages) */
static int cmd_pipe_decompress(void) {
    size_t in_size;
    uint8_t *in_data = read_stdin(&in_size);
    if (!in_data) return 1;

    uint8_t *out_data;
    size_t out_size;
    if (decompress_data(in_data, in_size, &out_data, &out_size) != 0) {
        free(in_data);
        return 1;
    }
    int ret = write_stdout(out_data, out_size);
    free(in_data);
    free(out_data);
    return ret;
}

/* =========================================================================
 * HTML Test Data Generator
 * ========================================================================= */

static const char *lorem_words[] = {
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing",
    "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore",
    "et", "dolore", "magna", "aliqua", "enim", "ad", "minim", "veniam",
    "quis", "nostrud", "exercitation", "ullamco", "laboris", "nisi",
    "aliquip", "ex", "ea", "commodo", "consequat", "duis", "aute", "irure",
    "in", "reprehenderit", "voluptate", "velit", "esse", "cillum",
    "fugiat", "nulla", "pariatur", "excepteur", "sint", "occaecat",
    "cupidatat", "non", "proident", "sunt", "culpa", "qui", "officia",
    "deserunt", "mollit", "anim", "id", "est"
};
#define N_LOREM (sizeof(lorem_words) / sizeof(lorem_words[0]))

static const char *css_classes[] = {
    "container", "wrapper", "content", "header", "footer", "sidebar",
    "main", "nav", "section", "article", "card", "panel", "row", "col",
    "btn", "link", "title", "subtitle", "text", "image", "icon",
    "list", "item", "form", "input", "label", "active", "hidden",
    "primary", "secondary", "success", "danger", "warning", "info"
};
#define N_CSS (sizeof(css_classes) / sizeof(css_classes[0]))

static uint32_t gen_seed = 12345;
static uint32_t gen_rand(void) {
    gen_seed = gen_seed * 1103515245 + 12345;
    return (gen_seed >> 16) & 0x7FFF;
}

static void gen_lorem(FILE *f, int words) {
    for (int i = 0; i < words; i++) {
        if (i > 0) fprintf(f, " ");
        const char *w = lorem_words[gen_rand() % N_LOREM];
        if (i == 0) {
            /* Capitalize first word */
            fprintf(f, "%c%s", (char)(w[0] - 32), w + 1);
        } else {
            fprintf(f, "%s", w);
        }
    }
}

static void gen_indent(FILE *f, int depth) {
    for (int i = 0; i < depth; i++) fprintf(f, "  ");
}

static int generate_html(const char *path) {
    FILE *f = fopen(path, "w");
    if (!f) {
        fprintf(stderr, "Error: cannot open '%s' for writing\n", path);
        return -1;
    }

    fprintf(f, "<!DOCTYPE html>\n");
    fprintf(f, "<html lang=\"en\">\n");
    fprintf(f, "<head>\n");
    fprintf(f, "  <meta charset=\"UTF-8\">\n");
    fprintf(f, "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n");
    fprintf(f, "  <title>GreedyGuy Test Page — Comprehensive HTML Document</title>\n");
    fprintf(f, "  <style>\n");
    fprintf(f, "    body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }\n");
    fprintf(f, "    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }\n");
    fprintf(f, "    .header { background: linear-gradient(135deg, #667eea 0%%, #764ba2 100%%); color: white; padding: 40px; border-radius: 8px 8px 0 0; margin: -30px -30px 30px -30px; }\n");
    fprintf(f, "    .nav { display: flex; gap: 20px; padding: 15px 0; border-bottom: 2px solid #eee; margin-bottom: 20px; }\n");
    fprintf(f, "    .nav a { text-decoration: none; color: #667eea; font-weight: bold; padding: 8px 16px; border-radius: 4px; transition: background 0.3s; }\n");
    fprintf(f, "    .nav a:hover { background: #f0f0ff; }\n");
    fprintf(f, "    .card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-bottom: 20px; transition: box-shadow 0.3s; }\n");
    fprintf(f, "    .card:hover { box-shadow: 0 4px 15px rgba(0,0,0,0.1); }\n");
    fprintf(f, "    .card-title { font-size: 1.25rem; font-weight: bold; color: #333; margin-bottom: 10px; }\n");
    fprintf(f, "    .btn { display: inline-block; padding: 10px 20px; border-radius: 4px; font-weight: bold; text-decoration: none; cursor: pointer; border: none; }\n");
    fprintf(f, "    .btn-primary { background: #667eea; color: white; }\n");
    fprintf(f, "    .btn-secondary { background: #6c757d; color: white; }\n");
    fprintf(f, "    .btn-success { background: #28a745; color: white; }\n");
    fprintf(f, "    .btn-danger { background: #dc3545; color: white; }\n");
    fprintf(f, "    table { width: 100%%; border-collapse: collapse; margin: 20px 0; }\n");
    fprintf(f, "    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #ddd; }\n");
    fprintf(f, "    th { background: #667eea; color: white; font-weight: bold; }\n");
    fprintf(f, "    tr:nth-child(even) { background: #f8f9fa; }\n");
    fprintf(f, "    tr:hover { background: #e9ecef; }\n");
    fprintf(f, "    .form-group { margin-bottom: 15px; }\n");
    fprintf(f, "    .form-group label { display: block; font-weight: bold; margin-bottom: 5px; color: #555; }\n");
    fprintf(f, "    .form-group input, .form-group textarea, .form-group select { width: 100%%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; }\n");
    fprintf(f, "    .footer { text-align: center; padding: 20px; color: #999; border-top: 1px solid #eee; margin-top: 30px; }\n");
    fprintf(f, "    .sidebar { float: right; width: 300px; padding: 20px; background: #f8f9fa; border-radius: 8px; margin-left: 20px; }\n");
    fprintf(f, "    .tag { display: inline-block; padding: 4px 8px; background: #e9ecef; border-radius: 12px; font-size: 0.85rem; margin: 2px; }\n");
    fprintf(f, "    @media (max-width: 768px) { .sidebar { float: none; width: 100%%; margin-left: 0; margin-bottom: 20px; } }\n");
    fprintf(f, "  </style>\n");
    fprintf(f, "</head>\n");
    fprintf(f, "<body>\n");
    fprintf(f, "  <div class=\"container\">\n");

    /* Header */
    fprintf(f, "    <!-- Main Header Section -->\n");
    fprintf(f, "    <div class=\"header\">\n");
    fprintf(f, "      <h1>GreedyGuy Compression Test Document</h1>\n");
    fprintf(f, "      <p>A comprehensive HTML page designed to test context-mixing compression algorithms</p>\n");
    fprintf(f, "    </div>\n\n");

    /* Navigation */
    fprintf(f, "    <!-- Navigation Bar -->\n");
    fprintf(f, "    <nav class=\"nav\" id=\"main-nav\" role=\"navigation\" aria-label=\"Main navigation\">\n");
    const char *nav_items[] = {"Home", "About", "Products", "Services", "Portfolio", "Blog", "Contact", "Support"};
    for (int i = 0; i < 8; i++) {
        fprintf(f, "      <a href=\"#%s\" data-section=\"%s\" title=\"Go to %s section\">%s</a>\n",
                nav_items[i], nav_items[i], nav_items[i], nav_items[i]);
    }
    fprintf(f, "    </nav>\n\n");

    /* Sidebar */
    fprintf(f, "    <!-- Sidebar -->\n");
    fprintf(f, "    <aside class=\"sidebar\" id=\"sidebar\" data-widget=\"sidebar\" role=\"complementary\">\n");
    fprintf(f, "      <h3>Quick Links</h3>\n");
    fprintf(f, "      <ul>\n");
    for (int i = 0; i < 12; i++) {
        fprintf(f, "        <li><a href=\"/page/%d\" title=\"Navigate to page %d\">", i + 1, i + 1);
        gen_lorem(f, 3 + gen_rand() % 3);
        fprintf(f, "</a></li>\n");
    }
    fprintf(f, "      </ul>\n");
    fprintf(f, "      <h3>Tags</h3>\n");
    fprintf(f, "      <div class=\"tags-container\">\n");
    for (int i = 0; i < 20; i++) {
        fprintf(f, "        <span class=\"tag\" data-tag-id=\"%d\">%s</span>\n",
                i, css_classes[gen_rand() % N_CSS]);
    }
    fprintf(f, "      </div>\n");
    fprintf(f, "    </aside>\n\n");

    /* Content cards */
    fprintf(f, "    <!-- Content Cards Section -->\n");
    fprintf(f, "    <section id=\"content\" class=\"content-section\" data-section=\"main\">\n");
    fprintf(f, "      <h2>Featured Content</h2>\n\n");

    for (int card = 0; card < 15; card++) {
        int depth = 3;
        gen_indent(f, depth);
        fprintf(f, "<div class=\"card\" id=\"card-%d\" data-card-index=\"%d\" data-category=\"%s\">\n",
                card, card, css_classes[gen_rand() % N_CSS]);
        gen_indent(f, depth + 1);
        fprintf(f, "<div class=\"card-title\">");
        gen_lorem(f, 4 + gen_rand() % 4);
        fprintf(f, "</div>\n");
        gen_indent(f, depth + 1);
        fprintf(f, "<p>");
        gen_lorem(f, 20 + gen_rand() % 30);
        fprintf(f, "</p>\n");

        /* Some cards have lists */
        if (card % 3 == 0) {
            gen_indent(f, depth + 1);
            fprintf(f, "<ul class=\"card-list\">\n");
            for (int li = 0; li < 5 + (int)(gen_rand() % 4); li++) {
                gen_indent(f, depth + 2);
                fprintf(f, "<li data-item=\"%d\">", li);
                gen_lorem(f, 5 + gen_rand() % 8);
                fprintf(f, "</li>\n");
            }
            gen_indent(f, depth + 1);
            fprintf(f, "</ul>\n");
        }

        /* Some cards have links */
        if (card % 2 == 0) {
            gen_indent(f, depth + 1);
            fprintf(f, "<div class=\"card-actions\">\n");
            gen_indent(f, depth + 2);
            fprintf(f, "<a href=\"/details/%d\" class=\"btn btn-primary\" data-action=\"view\">View Details</a>\n", card);
            gen_indent(f, depth + 2);
            fprintf(f, "<a href=\"/edit/%d\" class=\"btn btn-secondary\" data-action=\"edit\">Edit</a>\n", card);
            gen_indent(f, depth + 1);
            fprintf(f, "</div>\n");
        }

        gen_indent(f, depth);
        fprintf(f, "</div>\n\n");
    }

    fprintf(f, "    </section>\n\n");

    /* Data table */
    fprintf(f, "    <!-- Data Table Section -->\n");
    fprintf(f, "    <section id=\"data-table\" class=\"table-section\" data-section=\"table\">\n");
    fprintf(f, "      <h2>Product Catalog</h2>\n");
    fprintf(f, "      <table id=\"product-table\" class=\"data-table\" data-sortable=\"true\">\n");
    fprintf(f, "        <thead>\n");
    fprintf(f, "          <tr>\n");
    fprintf(f, "            <th data-sort=\"id\">ID</th>\n");
    fprintf(f, "            <th data-sort=\"name\">Product Name</th>\n");
    fprintf(f, "            <th data-sort=\"category\">Category</th>\n");
    fprintf(f, "            <th data-sort=\"price\">Price</th>\n");
    fprintf(f, "            <th data-sort=\"stock\">In Stock</th>\n");
    fprintf(f, "            <th data-sort=\"rating\">Rating</th>\n");
    fprintf(f, "            <th>Actions</th>\n");
    fprintf(f, "          </tr>\n");
    fprintf(f, "        </thead>\n");
    fprintf(f, "        <tbody>\n");

    const char *categories[] = {"Electronics", "Clothing", "Books", "Home", "Sports", "Toys", "Food", "Health"};
    for (int row = 0; row < 40; row++) {
        fprintf(f, "          <tr data-row-id=\"%d\" class=\"%s\">\n",
                row, row % 2 == 0 ? "even-row" : "odd-row");
        fprintf(f, "            <td>%04d</td>\n", 1000 + row);
        fprintf(f, "            <td>");
        gen_lorem(f, 2 + gen_rand() % 3);
        fprintf(f, "</td>\n");
        fprintf(f, "            <td>%s</td>\n", categories[gen_rand() % 8]);
        fprintf(f, "            <td>$%d.%02d</td>\n", (int)(gen_rand() % 500) + 10, (int)(gen_rand() % 100));
        fprintf(f, "            <td>%d</td>\n", (int)(gen_rand() % 1000));
        fprintf(f, "            <td>%d.%d/5</td>\n", (int)(gen_rand() % 5) + 1, (int)(gen_rand() % 10));
        fprintf(f, "            <td>\n");
        fprintf(f, "              <button class=\"btn btn-primary btn-sm\" data-action=\"view\" data-id=\"%d\">View</button>\n", row);
        fprintf(f, "              <button class=\"btn btn-success btn-sm\" data-action=\"buy\" data-id=\"%d\">Buy</button>\n", row);
        fprintf(f, "              <button class=\"btn btn-danger btn-sm\" data-action=\"delete\" data-id=\"%d\">Delete</button>\n", row);
        fprintf(f, "            </td>\n");
        fprintf(f, "          </tr>\n");
    }

    fprintf(f, "        </tbody>\n");
    fprintf(f, "      </table>\n");
    fprintf(f, "    </section>\n\n");

    /* Ordered list sections */
    fprintf(f, "    <!-- Ordered Lists -->\n");
    fprintf(f, "    <section id=\"lists\" class=\"list-section\">\n");
    fprintf(f, "      <h2>Documentation Sections</h2>\n");
    for (int sec = 0; sec < 5; sec++) {
        fprintf(f, "      <div class=\"list-group\" id=\"list-group-%d\">\n", sec);
        fprintf(f, "        <h3>Section %d: ", sec + 1);
        gen_lorem(f, 3 + gen_rand() % 3);
        fprintf(f, "</h3>\n");
        fprintf(f, "        <ol class=\"doc-list\" start=\"%d\">\n", sec * 10 + 1);
        for (int li = 0; li < 8 + (int)(gen_rand() % 5); li++) {
            fprintf(f, "          <li class=\"doc-item\" data-importance=\"%s\">\n",
                    li < 3 ? "high" : (li < 6 ? "medium" : "low"));
            fprintf(f, "            <strong>");
            gen_lorem(f, 2 + gen_rand() % 2);
            fprintf(f, ":</strong> ");
            gen_lorem(f, 10 + gen_rand() % 15);
            fprintf(f, "\n");
            fprintf(f, "          </li>\n");
        }
        fprintf(f, "        </ol>\n");
        fprintf(f, "      </div>\n");
    }
    fprintf(f, "    </section>\n\n");

    /* Forms */
    fprintf(f, "    <!-- Contact Form -->\n");
    fprintf(f, "    <section id=\"contact\" class=\"form-section\" data-section=\"contact\">\n");
    fprintf(f, "      <h2>Contact Us</h2>\n");
    fprintf(f, "      <form id=\"contact-form\" method=\"post\" action=\"/api/contact\" data-validate=\"true\" novalidate>\n");

    const char *field_names[] = {"first_name", "last_name", "email", "phone", "company", "website"};
    const char *field_labels[] = {"First Name", "Last Name", "Email Address", "Phone Number", "Company", "Website"};
    const char *field_types[] = {"text", "text", "email", "tel", "text", "url"};
    const char *field_placeholders[] = {"Enter your first name", "Enter your last name",
        "your.email@example.com", "+1 (555) 123-4567", "Your company name", "https://example.com"};

    for (int fi = 0; fi < 6; fi++) {
        fprintf(f, "        <div class=\"form-group\" data-field=\"%s\">\n", field_names[fi]);
        fprintf(f, "          <label for=\"%s\">%s</label>\n", field_names[fi], field_labels[fi]);
        fprintf(f, "          <input type=\"%s\" id=\"%s\" name=\"%s\" placeholder=\"%s\" required aria-required=\"true\" autocomplete=\"%s\">\n",
                field_types[fi], field_names[fi], field_names[fi], field_placeholders[fi], field_names[fi]);
        fprintf(f, "        </div>\n");
    }

    fprintf(f, "        <div class=\"form-group\" data-field=\"subject\">\n");
    fprintf(f, "          <label for=\"subject\">Subject</label>\n");
    fprintf(f, "          <select id=\"subject\" name=\"subject\" required>\n");
    fprintf(f, "            <option value=\"\">Select a subject...</option>\n");
    fprintf(f, "            <option value=\"general\">General Inquiry</option>\n");
    fprintf(f, "            <option value=\"support\">Technical Support</option>\n");
    fprintf(f, "            <option value=\"billing\">Billing Question</option>\n");
    fprintf(f, "            <option value=\"feedback\">Feedback</option>\n");
    fprintf(f, "            <option value=\"partnership\">Partnership Opportunity</option>\n");
    fprintf(f, "          </select>\n");
    fprintf(f, "        </div>\n");

    fprintf(f, "        <div class=\"form-group\" data-field=\"message\">\n");
    fprintf(f, "          <label for=\"message\">Message</label>\n");
    fprintf(f, "          <textarea id=\"message\" name=\"message\" rows=\"6\" placeholder=\"Type your message here...\" required aria-required=\"true\"></textarea>\n");
    fprintf(f, "        </div>\n");

    fprintf(f, "        <div class=\"form-actions\">\n");
    fprintf(f, "          <button type=\"submit\" class=\"btn btn-primary\">Send Message</button>\n");
    fprintf(f, "          <button type=\"reset\" class=\"btn btn-secondary\">Clear Form</button>\n");
    fprintf(f, "        </div>\n");
    fprintf(f, "      </form>\n");
    fprintf(f, "    </section>\n\n");

    /* Additional paragraphs for bulk content */
    fprintf(f, "    <!-- Article Content -->\n");
    fprintf(f, "    <section id=\"articles\" class=\"article-section\">\n");
    fprintf(f, "      <h2>Latest Articles</h2>\n");
    for (int art = 0; art < 10; art++) {
        fprintf(f, "      <article class=\"article\" id=\"article-%d\" data-author=\"author-%d\" data-date=\"2024-%02d-%02d\">\n",
                art, art % 5, (art % 12) + 1, (art % 28) + 1);
        fprintf(f, "        <h3 class=\"article-title\">");
        gen_lorem(f, 5 + gen_rand() % 5);
        fprintf(f, "</h3>\n");
        fprintf(f, "        <div class=\"article-meta\">\n");
        fprintf(f, "          <span class=\"author\">By Author %d</span>\n", art % 5);
        fprintf(f, "          <span class=\"date\">2024-%02d-%02d</span>\n", (art % 12) + 1, (art % 28) + 1);
        fprintf(f, "          <span class=\"category\">%s</span>\n", categories[gen_rand() % 8]);
        fprintf(f, "        </div>\n");
        for (int para = 0; para < 3 + (int)(gen_rand() % 3); para++) {
            fprintf(f, "        <p class=\"article-paragraph\" data-paragraph=\"%d\">", para);
            gen_lorem(f, 25 + gen_rand() % 35);
            fprintf(f, "</p>\n");
        }
        if (art % 2 == 0) {
            fprintf(f, "        <!-- Inline image placeholder -->\n");
            fprintf(f, "        <figure class=\"article-image\">\n");
            fprintf(f, "          <img src=\"/images/article-%d.jpg\" alt=\"", art);
            gen_lorem(f, 4);
            fprintf(f, "\" width=\"800\" height=\"400\" loading=\"lazy\">\n");
            fprintf(f, "          <figcaption>");
            gen_lorem(f, 6 + gen_rand() % 6);
            fprintf(f, "</figcaption>\n");
            fprintf(f, "        </figure>\n");
        }
        fprintf(f, "        <div class=\"article-tags\">\n");
        for (int t = 0; t < 3 + (int)(gen_rand() % 3); t++) {
            fprintf(f, "          <a href=\"/tags/%s\" class=\"tag\">%s</a>\n",
                    css_classes[gen_rand() % N_CSS], css_classes[gen_rand() % N_CSS]);
        }
        fprintf(f, "        </div>\n");
        fprintf(f, "      </article>\n\n");
    }
    fprintf(f, "    </section>\n\n");

    /* Definition lists */
    fprintf(f, "    <!-- Glossary -->\n");
    fprintf(f, "    <section id=\"glossary\" class=\"glossary-section\">\n");
    fprintf(f, "      <h2>Glossary of Terms</h2>\n");
    fprintf(f, "      <dl class=\"glossary-list\">\n");
    for (int g = 0; g < 15; g++) {
        fprintf(f, "        <dt class=\"term\" id=\"term-%d\">", g);
        gen_lorem(f, 1 + gen_rand() % 2);
        fprintf(f, "</dt>\n");
        fprintf(f, "        <dd class=\"definition\">");
        gen_lorem(f, 12 + gen_rand() % 15);
        fprintf(f, "</dd>\n");
    }
    fprintf(f, "      </dl>\n");
    fprintf(f, "    </section>\n\n");

    /* Footer */
    fprintf(f, "    <!-- Footer -->\n");
    fprintf(f, "    <footer class=\"footer\" role=\"contentinfo\">\n");
    fprintf(f, "      <div class=\"footer-grid\">\n");
    fprintf(f, "        <div class=\"footer-col\">\n");
    fprintf(f, "          <h4>Company</h4>\n");
    fprintf(f, "          <ul>\n");
    fprintf(f, "            <li><a href=\"/about\">About Us</a></li>\n");
    fprintf(f, "            <li><a href=\"/careers\">Careers</a></li>\n");
    fprintf(f, "            <li><a href=\"/press\">Press</a></li>\n");
    fprintf(f, "            <li><a href=\"/blog\">Blog</a></li>\n");
    fprintf(f, "          </ul>\n");
    fprintf(f, "        </div>\n");
    fprintf(f, "        <div class=\"footer-col\">\n");
    fprintf(f, "          <h4>Support</h4>\n");
    fprintf(f, "          <ul>\n");
    fprintf(f, "            <li><a href=\"/help\">Help Center</a></li>\n");
    fprintf(f, "            <li><a href=\"/docs\">Documentation</a></li>\n");
    fprintf(f, "            <li><a href=\"/status\">Status</a></li>\n");
    fprintf(f, "            <li><a href=\"/contact\">Contact</a></li>\n");
    fprintf(f, "          </ul>\n");
    fprintf(f, "        </div>\n");
    fprintf(f, "        <div class=\"footer-col\">\n");
    fprintf(f, "          <h4>Legal</h4>\n");
    fprintf(f, "          <ul>\n");
    fprintf(f, "            <li><a href=\"/privacy\">Privacy Policy</a></li>\n");
    fprintf(f, "            <li><a href=\"/terms\">Terms of Service</a></li>\n");
    fprintf(f, "            <li><a href=\"/cookies\">Cookie Policy</a></li>\n");
    fprintf(f, "            <li><a href=\"/gdpr\">GDPR</a></li>\n");
    fprintf(f, "          </ul>\n");
    fprintf(f, "        </div>\n");
    fprintf(f, "      </div>\n");
    fprintf(f, "      <p>&copy; 2024 GreedyGuy Compression. All rights reserved.</p>\n");
    fprintf(f, "      <p>Built with care by the context-mixing compression team.</p>\n");
    fprintf(f, "    </footer>\n\n");

    fprintf(f, "  </div>\n");

    /* Comments and extra HTML structure at the end */
    fprintf(f, "\n");
    fprintf(f, "  <!-- Hidden modals -->\n");
    for (int m = 0; m < 5; m++) {
        fprintf(f, "  <div class=\"modal\" id=\"modal-%d\" data-modal=\"%d\" role=\"dialog\" aria-hidden=\"true\" aria-labelledby=\"modal-%d-title\">\n", m, m, m);
        fprintf(f, "    <div class=\"modal-overlay\" data-dismiss=\"modal\"></div>\n");
        fprintf(f, "    <div class=\"modal-content\">\n");
        fprintf(f, "      <div class=\"modal-header\">\n");
        fprintf(f, "        <h3 id=\"modal-%d-title\">", m);
        gen_lorem(f, 3 + gen_rand() % 3);
        fprintf(f, "</h3>\n");
        fprintf(f, "        <button class=\"modal-close\" data-dismiss=\"modal\" aria-label=\"Close\">&times;</button>\n");
        fprintf(f, "      </div>\n");
        fprintf(f, "      <div class=\"modal-body\">\n");
        fprintf(f, "        <p>");
        gen_lorem(f, 20 + gen_rand() % 20);
        fprintf(f, "</p>\n");
        fprintf(f, "      </div>\n");
        fprintf(f, "      <div class=\"modal-footer\">\n");
        fprintf(f, "        <button class=\"btn btn-primary\" data-action=\"confirm\">Confirm</button>\n");
        fprintf(f, "        <button class=\"btn btn-secondary\" data-dismiss=\"modal\">Cancel</button>\n");
        fprintf(f, "      </div>\n");
        fprintf(f, "    </div>\n");
        fprintf(f, "  </div>\n\n");
    }

    fprintf(f, "  <!-- Script data -->\n");
    fprintf(f, "  <script type=\"application/json\" id=\"app-config\">\n");
    fprintf(f, "  {\n");
    fprintf(f, "    \"apiEndpoint\": \"https://api.example.com/v2\",\n");
    fprintf(f, "    \"debug\": false,\n");
    fprintf(f, "    \"features\": {\n");
    fprintf(f, "      \"darkMode\": true,\n");
    fprintf(f, "      \"notifications\": true,\n");
    fprintf(f, "      \"analytics\": true,\n");
    fprintf(f, "      \"experimentalFeatures\": false\n");
    fprintf(f, "    },\n");
    fprintf(f, "    \"pagination\": {\n");
    fprintf(f, "      \"pageSize\": 20,\n");
    fprintf(f, "      \"maxPages\": 100\n");
    fprintf(f, "    }\n");
    fprintf(f, "  }\n");
    fprintf(f, "  </script>\n\n");

    fprintf(f, "</body>\n");
    fprintf(f, "</html>\n");

    fclose(f);
    return 0;
}

/* =========================================================================
 * Commands: compress, decompress, test, generate, benchmark
 * ========================================================================= */

static int cmd_compress(const char *inpath, const char *outpath) {
    size_t in_size;
    uint8_t *in_data = read_file(inpath, &in_size);
    if (!in_data) return 1;

    uint8_t *out_data;
    size_t out_size;
    if (compress_best(in_data, in_size, &out_data, &out_size) != 0) {
        free(in_data);
        return 1;
    }

    int ret = write_file(outpath, out_data, out_size);
    printf("Compressed: %zu -> %zu bytes (%.2f%%)\n",
           in_size, out_size, 100.0 * out_size / (in_size ? in_size : 1));

    free(in_data);
    free(out_data);
    return ret;
}

static int cmd_decompress(const char *inpath, const char *outpath) {
    size_t in_size;
    uint8_t *in_data = read_file(inpath, &in_size);
    if (!in_data) return 1;

    uint8_t *out_data;
    size_t out_size;
    if (decompress_data(in_data, in_size, &out_data, &out_size) != 0) {
        free(in_data);
        return 1;
    }

    int ret = write_file(outpath, out_data, out_size);
    printf("Decompressed: %zu -> %zu bytes\n", in_size, out_size);

    free(in_data);
    free(out_data);
    return ret;
}

static int cmd_test(const char *inpath) {
    printf("Testing roundtrip on '%s'...\n", inpath);

    size_t orig_size;
    uint8_t *orig_data = read_file(inpath, &orig_size);
    if (!orig_data) return 1;

    printf("  Original size: %zu bytes\n", orig_size);

    /* Compress */
    uint8_t *comp_data;
    size_t comp_size;
    clock_t t0 = clock();
    if (compress_data(orig_data, orig_size, &comp_data, &comp_size) != 0) {
        free(orig_data);
        return 1;
    }
    double comp_time = (double)(clock() - t0) / CLOCKS_PER_SEC;
    printf("  Compressed:    %zu bytes (%.2f%%) in %.2fs\n",
           comp_size, 100.0 * comp_size / (orig_size ? orig_size : 1), comp_time);

    /* Decompress */
    uint8_t *decomp_data;
    size_t decomp_size;
    t0 = clock();
    if (decompress_data(comp_data, comp_size, &decomp_data, &decomp_size) != 0) {
        free(orig_data);
        free(comp_data);
        return 1;
    }
    double decomp_time = (double)(clock() - t0) / CLOCKS_PER_SEC;
    printf("  Decompressed:  %zu bytes in %.2fs\n", decomp_size, decomp_time);

    /* Verify */
    int ok = 1;
    if (decomp_size != orig_size) {
        printf("  FAIL: size mismatch (expected %zu, got %zu)\n", orig_size, decomp_size);
        ok = 0;
    } else if (memcmp(orig_data, decomp_data, orig_size) != 0) {
        /* Find first difference */
        for (size_t i = 0; i < orig_size; i++) {
            if (orig_data[i] != decomp_data[i]) {
                printf("  FAIL: byte mismatch at offset %zu (expected 0x%02X, got 0x%02X)\n",
                       i, orig_data[i], decomp_data[i]);
                break;
            }
        }
        ok = 0;
    }

    if (ok) {
        printf("  PASS: roundtrip verified, byte-for-byte identical\n");
    }

    free(orig_data);
    free(comp_data);
    free(decomp_data);
    return ok ? 0 : 1;
}

static int cmd_generate(const char *outpath) {
    printf("Generating HTML test data to '%s'...\n", outpath);
    if (generate_html(outpath) != 0) return 1;

    size_t size;
    uint8_t *data = read_file(outpath, &size);
    if (data) {
        printf("Generated %zu bytes of HTML\n", size);
        free(data);
    }
    return 0;
}

static int cmd_benchmark(const char *inpath) {
    size_t orig_size;
    uint8_t *orig_data = read_file(inpath, &orig_size);
    if (!orig_data) return 1;

    printf("GreedyGuy HTML Benchmark:\n");
    printf("  Input:     %zu bytes\n", orig_size);

    /* GreedyGuy compress */
    uint8_t *gg_data;
    size_t gg_size;
    clock_t t0 = clock();
    if (compress_best(orig_data, orig_size, &gg_data, &gg_size) != 0) {
        free(orig_data);
        return 1;
    }
    double gg_time = (double)(clock() - t0) / CLOCKS_PER_SEC;
    printf("  GreedyGuy: %zu bytes (%.2f%%) [%.2fs]\n",
           gg_size, 100.0 * gg_size / (orig_size ? orig_size : 1), gg_time);
    free(gg_data);

    /* gzip -9 */
    {
        char cmd[512];
        snprintf(cmd, sizeof(cmd), "gzip -9 -c \"%s\" > \"%s.gz\" 2>/dev/null", inpath, inpath);
        if (system(cmd) == 0) {
            char gzpath[512];
            snprintf(gzpath, sizeof(gzpath), "%s.gz", inpath);
            size_t gz_size;
            uint8_t *gz_data = read_file(gzpath, &gz_size);
            if (gz_data) {
                printf("  gzip -9:   %zu bytes (%.2f%%)\n",
                       gz_size, 100.0 * gz_size / (orig_size ? orig_size : 1));
                free(gz_data);
            }
            remove(gzpath);
        } else {
            printf("  gzip -9:   (not available)\n");
        }
    }

    /* xz -9 */
    {
        char cmd[512];
        snprintf(cmd, sizeof(cmd), "xz -9 -c \"%s\" > \"%s.xz\" 2>/dev/null", inpath, inpath);
        if (system(cmd) == 0) {
            char xzpath[512];
            snprintf(xzpath, sizeof(xzpath), "%s.xz", inpath);
            size_t xz_size;
            uint8_t *xz_data = read_file(xzpath, &xz_size);
            if (xz_data) {
                printf("  xz -9:     %zu bytes (%.2f%%)\n",
                       xz_size, 100.0 * xz_size / (orig_size ? orig_size : 1));
                free(xz_data);
            }
            remove(xzpath);
        } else {
            printf("  xz -9:     (not available)\n");
        }
    }

    /* bzip2 -9 */
    {
        char cmd[512];
        snprintf(cmd, sizeof(cmd), "bzip2 -9 -c \"%s\" > \"%s.bz2\" 2>/dev/null", inpath, inpath);
        if (system(cmd) == 0) {
            char bz2path[512];
            snprintf(bz2path, sizeof(bz2path), "%s.bz2", inpath);
            size_t bz2_size;
            uint8_t *bz2_data = read_file(bz2path, &bz2_size);
            if (bz2_data) {
                printf("  bzip2 -9:  %zu bytes (%.2f%%)\n",
                       bz2_size, 100.0 * bz2_size / (orig_size ? orig_size : 1));
                free(bz2_data);
            }
            remove(bz2path);
        } else {
            printf("  bzip2 -9:  (not available)\n");
        }
    }

    free(orig_data);
    return 0;
}

/* =========================================================================
 * Main
 * ========================================================================= */

#ifndef GG_VERSION_STRING
#define GG_VERSION_STRING "1.0.0"
#endif

static void usage(void) {
    fprintf(stderr,
        "greedyguy v" GG_VERSION_STRING " — byte-prediction compressor\n"
        "\n"
        "Usage:\n"
        "  greedyguy c <input> <output>   — compress file\n"
        "  greedyguy d <input> <output>   — decompress file\n"
        "  greedyguy pc                   — compress stdin → stdout (pipe)\n"
        "  greedyguy pd                   — decompress stdin → stdout (pipe)\n"
        "  greedyguy t <input>            — test (roundtrip verify)\n"
        "  greedyguy g <output>           — generate HTML test data\n"
        "  greedyguy b <input>            — benchmark vs gzip/xz/bzip2\n"
        "  greedyguy -V                   — print version\n"
    );
}

int main(int argc, char **argv) {
    if (argc < 2) {
        usage();
        return 1;
    }

    init_tables();

    const char *cmd = argv[1];

    if (strcmp(cmd, "-V") == 0 || strcmp(cmd, "--version") == 0) {
        printf("greedyguy %s\n", GG_VERSION_STRING);
        return 0;
    }

    switch (cmd[0]) {
    case 'p':
        if (cmd[1] == 'c') return cmd_pipe_compress();
        if (cmd[1] == 'd') return cmd_pipe_decompress();
        usage(); return 1;
    case 'c':
        if (argc < 4) { usage(); return 1; }
        return cmd_compress(argv[2], argv[3]);
    case 'd':
        if (argc < 4) { usage(); return 1; }
        return cmd_decompress(argv[2], argv[3]);
    case 't':
        if (argc < 3) { usage(); return 1; }
        return cmd_test(argv[2]);
    case 'g':
        if (argc < 3) { usage(); return 1; }
        return cmd_generate(argv[2]);
    case 'b':
        if (argc < 3) { usage(); return 1; }
        return cmd_benchmark(argv[2]);
    default:
        usage();
        return 1;
    }
}

#endif /* GG_LIBRARY */
