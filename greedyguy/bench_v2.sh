#!/bin/bash
cd /mnt/d/Personal/compression/greedyguy
echo "=== GreedyGuy v2 MoE Benchmark ==="
for f in test.html testdata/test.css testdata/test.js testdata/test.json testdata/test_plain.txt testdata/test.xml; do
    sz=$(wc -c < "$f")
    ./greedyguy_v2 c "$f" /tmp/gg.out > /dev/null 2>&1
    gg=$(wc -c < /tmp/gg.out)
    gzip -9 -c "$f" > /tmp/gz.out 2>/dev/null
    gz=$(wc -c < /tmp/gz.out)
    xz -9 -c "$f" > /tmp/xz.out 2>/dev/null
    xz=$(wc -c < /tmp/xz.out)
    diff=$((xz - gg))
    printf "%-30s  size=%6d  GGv2=%5d  gzip=%5d  xz=%5d  vs_xz=%+d\n" "$f" "$sz" "$gg" "$gz" "$xz" "$diff"
done
rm -f /tmp/gg.out /tmp/gz.out /tmp/xz.out