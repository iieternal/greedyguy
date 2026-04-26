#!/bin/bash
cd /mnt/d/Personal/compression/greedyguy

echo "=== Building 8M?2 chain ==="
gcc -O3 -march=native -flto -o greedyguy_v2 greedyguy.c -lm || exit 1

echo "=== Quick test ==="
./greedyguy_v2 c test.html /tmp/gg.gg && ./greedyguy_v2 d /tmp/gg.gg /tmp/gg.out
cmp -s test.html /tmp/gg.out && echo "PASS" || echo "FAIL"
rm -f /tmp/gg.gg /tmp/gg.out

echo "=== Key files benchmark ==="
printf "%-35s %10s %10s %10s\n" "FILE" "SIZE" "GG" "?_vs_old"
echo "-----------------------------------------------------------"

# old results for comparison (from previous run with 8M?1)
declare -A OLD=( [test.html]=10672 [test.css]=3958 [test.js]=7608 [test.json]=4493 [test_plain.txt]=4341 [test.xml]=3454 [youtube.html]=78110 [youtube_watch.html]=157484 [cnn.html]=530863 [netflix.html]=374931 [weather.html]=186892 [npmjs.html]=106882 [wikipedia.html]=66039 [stackoverflow_q.html]=125297 [github.html]=79424 [bbc.html]=62150 [nytimes.html]=128585 )

TOTAL_NEW=0; TOTAL_OLD=0
for f in test.html testdata/test.css testdata/test.js testdata/test.json testdata/test_plain.txt testdata/test.xml \
    testdata/realweb/youtube.html testdata/realweb/youtube_watch.html testdata/realweb/cnn.html \
    testdata/realweb/netflix.html testdata/realweb/weather.html testdata/realweb/npmjs.html \
    testdata/realweb/wikipedia.html testdata/realweb/stackoverflow_q.html testdata/realweb/github.html \
    testdata/realweb/bbc.html testdata/realweb/nytimes.html; do
    [ ! -f "$f" ] && continue
    SZ=$(stat -c%s "$f")
    ./greedyguy_v2 c "$f" /tmp/gg_bench.gg 2>/dev/null
    GG=$(stat -c%s /tmp/gg_bench.gg)
    rm -f /tmp/gg_bench.gg
    NAME=$(basename "$f")
    OLD_V=${OLD[$NAME]:-0}
    DELTA=$((GG - OLD_V))
    printf "%-35s %10d %10d %+10d\n" "$NAME" "$SZ" "$GG" "$DELTA"
    TOTAL_NEW=$((TOTAL_NEW + GG))
    TOTAL_OLD=$((TOTAL_OLD + OLD_V))
done
echo "-----------------------------------------------------------"
printf "%-35s %10s %10d %+10d\n" "TOTAL" "" "$TOTAL_NEW" "$((TOTAL_NEW - TOTAL_OLD))"