#!/bin/bash
cd /mnt/d/Personal/compression/greedyguy
SRC=greedyguy.c
BACKUP=/tmp/gg_realweb_backup.c
cp "$SRC" "$BACKUP"

echo "=== Match Buffer Size Sweep on Large Real Web Files ==="
echo "Testing: youtube_watch(1.4M), cnn(4.7M), netflix(3.1M), figma(1.5M), nytimes(1M)"
echo ""

# Test different MATCH_BUF and MATCH_HASH sizes
for MBUF_EXP in "20" "22" "23" "24"; do
    for MHASH_EXP in "20" "22" "23"; do
        cp "$BACKUP" "$SRC"
        sed -i "s/#define MATCH_HASH_SIZE (1 << 20)/#define MATCH_HASH_SIZE (1 << $MHASH_EXP)/" "$SRC"
        sed -i "s/#define MATCH_BUF_INIT  (1 << 20)/#define MATCH_BUF_INIT  (1 << $MBUF_EXP)/" "$SRC"
        gcc -O3 -march=native -flto -o greedyguy_v2 "$SRC" -lm 2>/dev/null
        if [ $? -ne 0 ]; then echo "BUILD FAIL buf=$MBUF_EXP hash=$MHASH_EXP"; continue; fi
        
        total=0
        printf "buf=2^%s hash=2^%s: " "$MBUF_EXP" "$MHASH_EXP"
        for f in testdata/realweb/youtube_watch.html testdata/realweb/cnn.html testdata/realweb/netflix.html testdata/realweb/figma.html testdata/realweb/nytimes.html; do
            ./greedyguy_v2 c "$f" /tmp/gg.out 2>/dev/null
            sz=$(wc -c < /tmp/gg.out)
            total=$((total + sz))
            printf "%7d " "$sz"
        done
        echo "total=$total"
    done
done

cp "$BACKUP" "$SRC"
rm -f /tmp/gg.out
echo "=== Done ==="