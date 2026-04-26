#!/bin/bash
cd /mnt/d/Personal/compression/greedyguy
SRC=greedyguy.c
BACKUP=/tmp/gg_realweb_backup.c
cp "$SRC" "$BACKUP"

FILES="testdata/realweb/youtube_watch.html testdata/realweb/cnn.html testdata/realweb/netflix.html testdata/realweb/figma.html testdata/realweb/nytimes.html testdata/realweb/stackoverflow_q.html testdata/realweb/github.html testdata/realweb/bbc.html test.html testdata/test.css testdata/test.js"

echo "=== Extended Table + Order-12 Sweep ==="

# 4x tables (reference)
cp "$BACKUP" "$SRC"
sed -i 's/SIZE_ORDER4   2097152/SIZE_ORDER4   8388608/' "$SRC"
sed -i 's/SIZE_ORDER6   4194304/SIZE_ORDER6   16777216/' "$SRC"
sed -i 's/SIZE_ORDER8   16777216/SIZE_ORDER8   67108864/' "$SRC"
sed -i 's/SIZE_WORD     1048576/SIZE_WORD     4194304/' "$SRC"
sed -i 's/MATCH_HASH_SIZE (1 << 20)/MATCH_HASH_SIZE (1 << 23)/' "$SRC"
gcc -O3 -march=native -flto -o greedyguy_v2 "$SRC" -lm 2>/dev/null
printf "4x+HASH8M ref:   "
total=0
for f in $FILES; do ./greedyguy_v2 c "$f" /tmp/gg.out 2>/dev/null; sz=$(wc -c < /tmp/gg.out); total=$((total + sz)); printf "%7d" "$sz"; done
echo " =$total"

# 8x tables
cp "$BACKUP" "$SRC"
sed -i 's/SIZE_ORDER4   2097152/SIZE_ORDER4   16777216/' "$SRC"
sed -i 's/SIZE_ORDER6   4194304/SIZE_ORDER6   33554432/' "$SRC"
sed -i 's/SIZE_ORDER8   16777216/SIZE_ORDER8   134217728/' "$SRC"
sed -i 's/SIZE_WORD     1048576/SIZE_WORD     8388608/' "$SRC"
sed -i 's/MATCH_HASH_SIZE (1 << 20)/MATCH_HASH_SIZE (1 << 23)/' "$SRC"
gcc -O3 -march=native -flto -o greedyguy_v2 "$SRC" -lm 2>/dev/null
printf "8x+HASH8M:       "
total=0
for f in $FILES; do ./greedyguy_v2 c "$f" /tmp/gg.out 2>/dev/null; sz=$(wc -c < /tmp/gg.out); total=$((total + sz)); printf "%7d" "$sz"; done
echo " =$total"

# 4x tables + order-12 model (add new model)
cp "$BACKUP" "$SRC"
sed -i 's/SIZE_ORDER4   2097152/SIZE_ORDER4   8388608/' "$SRC"
sed -i 's/SIZE_ORDER6   4194304/SIZE_ORDER6   16777216/' "$SRC"
sed -i 's/SIZE_ORDER8   16777216/SIZE_ORDER8   67108864/' "$SRC"
sed -i 's/SIZE_WORD     1048576/SIZE_WORD     4194304/' "$SRC"
sed -i 's/MATCH_HASH_SIZE (1 << 20)/MATCH_HASH_SIZE (1 << 23)/' "$SRC"

# Add order-12 table size
sed -i 's/#define SIZE_WORD     4194304/#define SIZE_WORD     4194304\n#define SIZE_ORDER12  67108864/' "$SRC"

# Change N_STATE_MODELS and N_MODELS
sed -i 's/#define N_STATE_MODELS 11/#define N_STATE_MODELS 12/' "$SRC"
sed -i 's/#define N_MODELS    12/#define N_MODELS    13/' "$SRC"

# Add order12 field to struct (after word_model)
sed -i 's/StateEntry \*word_model;/StateEntry *word_model;\n    StateEntry *order12;/' "$SRC"

# Allocate order12
sed -i 's/p->word_model = (StateEntry \*)calloc(SIZE_WORD/p->order12 = (StateEntry *)calloc(SIZE_ORDER12, sizeof(StateEntry));\n    p->word_model = (StateEntry *)calloc(SIZE_WORD/' "$SRC"

# Free order12
sed -i 's/free(p->word_model);/free(p->word_model); free(p->order12);/' "$SRC"

# Add null check
sed -i 's/!p->word_model ||/!p->word_model || !p->order12 ||/' "$SRC"

# Add order-12 prediction (after order-8, before html_tag)
# Find the line with "Model 7: HTML tag model" and insert before it
sed -i '/Model 7: HTML tag model/i\
    /* Model 6b: Order-12 */\
    h = hash_combine(0, hist_byte(p, 11));\
    h = hash_combine(h, hist_byte(p, 10));\
    h = hash_combine(h, hist_byte(p, 9));\
    h = hash_combine(h, hist_byte(p, 8));\
    h = hash_combine(h, hist_byte(p, 7));\
    h = hash_combine(h, hist_byte(p, 6));\
    h = hash_combine(h, hist_byte(p, 5));\
    h = hash_combine(h, hist_byte(p, 4));\
    h = hash_combine(h, hist_byte(p, 3));\
    h = hash_combine(h, hist_byte(p, 2));\
    h = hash_combine(h, hist_byte(p, 1));\
    h = hash_combine(h, hist_byte(p, 0));\
    h = finalize_hash(h, bp, pb);\
    p->hash_idx[11] = h \& (SIZE_ORDER12 - 1);\
    p->predictions[11] = state_predict(\&p->order12[p->hash_idx[11]]);' "$SRC"

# Fix the update tables array - add order12
sed -i 's/p->word_model$/p->word_model,\n        p->order12/' "$SRC"

# Fix the match model index (was [11], now [12])
sed -i 's/p->predictions\[11\] = expected_bit/p->predictions[12] = expected_bit/' "$SRC"
sed -i 's/p->predictions\[11\] = PROB_HALF/p->predictions[12] = PROB_HALF/' "$SRC"

gcc -O3 -march=native -flto -o greedyguy_v2 "$SRC" -lm 2>&1 | head -5
if [ $? -eq 0 ]; then
    printf "4x+ORD12:        "
    total=0
    for f in $FILES; do ./greedyguy_v2 c "$f" /tmp/gg.out 2>/dev/null; sz=$(wc -c < /tmp/gg.out); total=$((total + sz)); printf "%7d" "$sz"; done
    echo " =$total"
    # Verify roundtrip
    ./greedyguy_v2 t test.html 2>&1 | tail -1
else
    echo "BUILD FAILED"
fi

cp "$BACKUP" "$SRC"
rm -f /tmp/gg.out
echo "=== Done ==="