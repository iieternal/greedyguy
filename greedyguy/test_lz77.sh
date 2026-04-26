#!/bin/bash
cd /mnt/d/Personal/compression/greedyguy

echo "=== Building with LZ77 preprocessor ==="
gcc -O3 -march=native -flto -o greedyguy_v2 greedyguy.c -lm 2>&1
if [ $? -ne 0 ]; then echo "BUILD FAILED"; exit 1; fi
echo "BUILD OK"

echo ""
echo "=== Roundtrip tests ==="
PASS=0; FAIL=0
for f in test.html testdata/test.css testdata/test.js testdata/test.json testdata/test_plain.txt; do
    ./greedyguy_v2 c "$f" /tmp/gg_test.gg 2>/dev/null
    ./greedyguy_v2 d /tmp/gg_test.gg /tmp/gg_test.out 2>/dev/null
    if cmp -s "$f" /tmp/gg_test.out; then
        echo "  $(basename $f): PASS"
        PASS=$((PASS+1))
    else
        echo "  $(basename $f): FAIL"
        FAIL=$((FAIL+1))
    fi
    rm -f /tmp/gg_test.gg /tmp/gg_test.out
done

echo ""
echo "=== Large file roundtrip tests ==="
for f in testdata/realweb/youtube.html testdata/realweb/cnn.html testdata/realweb/netflix.html; do
    [ ! -f "$f" ] && continue
    NAME=$(basename "$f")
    SZ=$(stat -c%s "$f")
    ./greedyguy_v2 c "$f" /tmp/gg_test.gg 2>&1 | head -3
    ./greedyguy_v2 d /tmp/gg_test.gg /tmp/gg_test.out 2>/dev/null
    if cmp -s "$f" /tmp/gg_test.out; then
        GG=$(stat -c%s /tmp/gg_test.gg)
        echo "  $NAME ($SZ): PASS (compressed=$GG)"
        PASS=$((PASS+1))
    else
        echo "  $NAME ($SZ): FAIL"
        FAIL=$((FAIL+1))
    fi
    rm -f /tmp/gg_test.gg /tmp/gg_test.out
done

echo ""
echo "Results: $PASS passed, $FAIL failed"