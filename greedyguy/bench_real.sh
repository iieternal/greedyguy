#!/bin/bash
cd /mnt/d/Personal/compression/greedyguy

echo "=== Real Web Benchmark: GreedyGuy vs gzip-9 vs xz-9 ==="
echo ""
printf "%-35s %8s %8s %8s %8s %7s %7s\n" "FILE" "SIZE" "GG" "GZIP" "XZ" "vs_GZ" "vs_XZ"
echo "--------------------------------------------------------------------------------"

gg_total=0; gz_total=0; xz_total=0; sz_total=0; count=0
gg_wins_gz=0; gg_wins_xz=0

for f in testdata/realweb/*.html testdata/realweb/*.json; do
    [ -f "$f" ] || continue
    sz=$(wc -c < "$f")
    [ "$sz" -lt 1000 ] && continue  # skip tiny files
    
    # GreedyGuy
    ./greedyguy_v2 c "$f" /tmp/gg_bench.out 2>/dev/null
    gg=$(wc -c < /tmp/gg_bench.out)
    
    # gzip
    gzip -9 -c "$f" > /tmp/gz_bench.out 2>/dev/null
    gz=$(wc -c < /tmp/gz_bench.out)
    
    # xz
    xz -9 -c "$f" > /tmp/xz_bench.out 2>/dev/null
    xz=$(wc -c < /tmp/xz_bench.out)
    
    vs_gz=$((gz - gg))
    vs_xz=$((xz - gg))
    
    [ "$gg" -lt "$gz" ] && gg_wins_gz=$((gg_wins_gz + 1))
    [ "$gg" -lt "$xz" ] && gg_wins_xz=$((gg_wins_xz + 1))
    
    printf "%-35s %8d %8d %8d %8d %+7d %+7d\n" "$(basename $f)" "$sz" "$gg" "$gz" "$xz" "$vs_gz" "$vs_xz"
    
    gg_total=$((gg_total + gg))
    gz_total=$((gz_total + gz))
    xz_total=$((xz_total + xz))
    sz_total=$((sz_total + sz))
    count=$((count + 1))
done

echo "--------------------------------------------------------------------------------"
printf "%-35s %8d %8d %8d %8d %+7d %+7d\n" "TOTAL ($count files)" "$sz_total" "$gg_total" "$gz_total" "$xz_total" "$((gz_total - gg_total))" "$((xz_total - gg_total))"
echo ""
echo "GG beats gzip-9: $gg_wins_gz / $count files"
echo "GG beats xz-9:   $gg_wins_xz / $count files"
echo ""
gg_ratio=$(echo "scale=3; $gg_total * 100 / $sz_total" | bc)
gz_ratio=$(echo "scale=3; $gz_total * 100 / $sz_total" | bc)
xz_ratio=$(echo "scale=3; $xz_total * 100 / $sz_total" | bc)
echo "Compression ratios: GG=${gg_ratio}%  gzip=${gz_ratio}%  xz=${xz_ratio}%"

rm -f /tmp/gg_bench.out /tmp/gz_bench.out /tmp/xz_bench.out