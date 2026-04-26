#!/bin/bash
# Automated benchmark across ALL file types
cd /mnt/d/Personal/compression/greedyguy

echo "=========================================="
echo "GreedyGuy Full Multi-Type Benchmark"
echo "=========================================="

TOTAL_GG=0; TOTAL_GZ=0; TOTAL_XZ=0
BEAT_GZ=0; BEAT_XZ=0; N=0
WIN_GZ=0; WIN_XZ=0

# Collect file stats per type
declare -A TYPE_GG TYPE_GZ TYPE_XZ TYPE_N TYPE_WIN_XZ

benchmark_file() {
    local f="$1"
    local type="$2"
    [ ! -f "$f" ] && return
    local SZ=$(stat -c%s "$f")
    [ "$SZ" -lt 100 ] && return
    
    # Skip huge files (>10MB) for speed
    [ "$SZ" -gt 10000000 ] && return
    
    local NAME=$(basename "$f")
    ./greedyguy_v2 c "$f" /tmp/gg.gg 2>/dev/null
    local GG=$(stat -c%s /tmp/gg.gg); rm -f /tmp/gg.gg
    gzip -9 -c "$f" > /tmp/gz.gz 2>/dev/null
    local GZ=$(stat -c%s /tmp/gz.gz); rm -f /tmp/gz.gz
    xz -9 -c "$f" > /tmp/xz.xz 2>/dev/null
    local XZ=$(stat -c%s /tmp/xz.xz); rm -f /tmp/xz.xz
    
    local GGRATIO=$(echo "scale=1; $GG * 100 / $SZ" | bc)
    local MARK=""
    [ "$GG" -lt "$GZ" ] && BEAT_GZ=$((BEAT_GZ+1))
    [ "$GG" -lt "$XZ" ] && { MARK="★"; BEAT_XZ=$((BEAT_XZ+1)); }
    
    printf "  %-35s %8d %7d %7d %7d %5s%% %s\n" "$NAME" "$SZ" "$GG" "$GZ" "$XZ" "$GGRATIO" "$MARK"
    
    TOTAL_GG=$((TOTAL_GG+GG)); TOTAL_GZ=$((TOTAL_GZ+GZ)); TOTAL_XZ=$((TOTAL_XZ+XZ))
    N=$((N+1))
    
    # Per-type accumulation
    TYPE_GG[$type]=$(( ${TYPE_GG[$type]:-0} + GG ))
    TYPE_GZ[$type]=$(( ${TYPE_GZ[$type]:-0} + GZ ))
    TYPE_XZ[$type]=$(( ${TYPE_XZ[$type]:-0} + XZ ))
    TYPE_N[$type]=$(( ${TYPE_N[$type]:-0} + 1 ))
    [ "$GG" -lt "$XZ" ] && TYPE_WIN_XZ[$type]=$(( ${TYPE_WIN_XZ[$type]:-0} + 1 ))
}

printf "  %-35s %8s %7s %7s %7s %6s\n" "FILE" "SIZE" "GG" "gzip9" "xz9" "ratio"
echo "  -------------------------------------------------------------------------"

echo ""
echo "=== HTML (original test files) ==="
for f in test.html testdata/test.css testdata/test.js testdata/test.json testdata/test_plain.txt testdata/test.xml; do
    benchmark_file "$f" "orig"
done

echo ""
echo "=== HTML (real web pages) ==="
for f in testdata/realweb/*.html; do
    benchmark_file "$f" "html"
done

echo ""
echo "=== CSS ==="
for f in testdata/realweb/css/*.css; do
    benchmark_file "$f" "css"
done

echo ""
echo "=== JavaScript ==="
for f in testdata/realweb/js/*.js testdata/realweb/js/*.ts; do
    benchmark_file "$f" "js"
done

echo ""
echo "=== JSON ==="
for f in testdata/realweb/json/*.json; do
    benchmark_file "$f" "json"
done

echo ""
echo "=== XML ==="
for f in testdata/realweb/xml/*.xml testdata/realweb/xml/*.svg; do
    benchmark_file "$f" "xml"
done

echo ""
echo "=== SVG ==="
for f in testdata/realweb/svg/*.svg testdata/realweb/svg/*.png; do
    benchmark_file "$f" "svg"
done

echo ""
echo "=== TXT/CSV/MD/YML ==="
for f in testdata/realweb/txt/*; do
    benchmark_file "$f" "txt"
done

echo ""
echo "=========================================="
echo "SUMMARY BY FILE TYPE"
echo "=========================================="
printf "%-8s %6s %10s %10s %10s %6s %6s\n" "TYPE" "FILES" "GG" "gzip-9" "xz-9" "vs_gz" "vs_xz"
echo "------------------------------------------------------------"
for type in orig html css js json xml svg txt; do
    tn=${TYPE_N[$type]:-0}
    [ "$tn" -eq 0 ] && continue
    tg=${TYPE_GG[$type]:-0}
    tgz=${TYPE_GZ[$type]:-0}
    txz=${TYPE_XZ[$type]:-0}
    twx=${TYPE_WIN_XZ[$type]:-0}
    local vgz=""
    local vxz=""
    [ "$tgz" -gt 0 ] && vgz=$(echo "scale=1; $tg * 100 / $tgz" | bc)
    [ "$txz" -gt 0 ] && vxz=$(echo "scale=1; $tg * 100 / $txz" | bc)
    printf "%-8s %6d %10d %10d %10d %5s%% %5s%%  (beat xz: %d/%d)\n" \
        "$type" "$tn" "$tg" "$tgz" "$txz" "$vgz" "$vxz" "$twx" "$tn"
done
echo "------------------------------------------------------------"
VGZT=$(echo "scale=1; $TOTAL_GG * 100 / $TOTAL_GZ" | bc)
VXZT=$(echo "scale=1; $TOTAL_GG * 100 / $TOTAL_XZ" | bc)
printf "%-8s %6d %10d %10d %10d %5s%% %5s%%  (beat xz: %d/%d)\n" \
    "TOTAL" "$N" "$TOTAL_GG" "$TOTAL_GZ" "$TOTAL_XZ" "$VGZT" "$VXZT" "$BEAT_XZ" "$N"
echo ""
echo "Gap vs xz-9: $((TOTAL_GG - TOTAL_XZ)) bytes"
echo "Beat gzip-9: $BEAT_GZ / $N"
echo "Beat xz-9:   $BEAT_XZ / $N"
