#!/bin/bash
cd /mnt/d/Personal/compression/greedyguy
SRC=greedyguy.c
BACKUP=/tmp/gg_realweb_backup.c
cp "$SRC" "$BACKUP"

# Test files: mix of large and small
FILES="testdata/realweb/youtube_watch.html testdata/realweb/cnn.html testdata/realweb/netflix.html testdata/realweb/figma.html testdata/realweb/nytimes.html testdata/realweb/stackoverflow_q.html testdata/realweb/github.html testdata/realweb/bbc.html test.html testdata/test.css testdata/test.js"

echo "=== Context Table Size Sweep ==="
echo "Files: yt_watch cnn netflix figma nytimes so_q github bbc [orig: html css js]"
echo ""

# Baseline
printf "BASELINE:        "
total=0
for f in $FILES; do
    ./greedyguy_v2 c "$f" /tmp/gg.out 2>/dev/null
    sz=$(wc -c < /tmp/gg.out); total=$((total + sz)); printf "%7d" "$sz"
done
echo " =$total"

# 4x tables
cp "$BACKUP" "$SRC"
sed -i 's/SIZE_ORDER4   2097152/SIZE_ORDER4   8388608/' "$SRC"
sed -i 's/SIZE_ORDER6   4194304/SIZE_ORDER6   16777216/' "$SRC"
sed -i 's/SIZE_ORDER8   16777216/SIZE_ORDER8   67108864/' "$SRC"
sed -i 's/SIZE_WORD     1048576/SIZE_WORD     4194304/' "$SRC"
gcc -O3 -march=native -flto -o greedyguy_v2 "$SRC" -lm 2>/dev/null
printf "4x TABLES:       "
total=0
for f in $FILES; do
    ./greedyguy_v2 c "$f" /tmp/gg.out 2>/dev/null
    sz=$(wc -c < /tmp/gg.out); total=$((total + sz)); printf "%7d" "$sz"
done
echo " =$total"

# 4x tables + bigger hash
cp "$BACKUP" "$SRC"
sed -i 's/SIZE_ORDER4   2097152/SIZE_ORDER4   8388608/' "$SRC"
sed -i 's/SIZE_ORDER6   4194304/SIZE_ORDER6   16777216/' "$SRC"
sed -i 's/SIZE_ORDER8   16777216/SIZE_ORDER8   67108864/' "$SRC"
sed -i 's/SIZE_WORD     1048576/SIZE_WORD     4194304/' "$SRC"
sed -i 's/MATCH_HASH_SIZE (1 << 20)/MATCH_HASH_SIZE (1 << 23)/' "$SRC"
gcc -O3 -march=native -flto -o greedyguy_v2 "$SRC" -lm 2>/dev/null
printf "4x+HASH8M:       "
total=0
for f in $FILES; do
    ./greedyguy_v2 c "$f" /tmp/gg.out 2>/dev/null
    sz=$(wc -c < /tmp/gg.out); total=$((total + sz)); printf "%7d" "$sz"
done
echo " =$total"

# Restore
cp "$BACKUP" "$SRC"
rm -f /tmp/gg.out
echo "=== Done ==="