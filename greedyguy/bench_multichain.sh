#!/bin/bash
cd /mnt/d/Personal/compression/greedyguy

echo "=== Building with multi-chain match model ==="
gcc -O3 -march=native -flto -o greedyguy_v2 greedyguy.c -lm || exit 1

echo ""
echo "=== Roundtrip tests ==="
for f in test.html testdata/test.css testdata/test.js; do
    ./greedyguy_v2 c "$f" /tmp/gg_test.gg
    ./greedyguy_v2 d /tmp/gg_test.gg /tmp/gg_test.out
    if cmp -s "$f" /tmp/gg_test.out; then
        echo "  $(basename $f):   PASS: roundtrip verified, byte-for-byte identical"
    else
        echo "  $(basename $f):   FAIL"
        exit 1
    fi
    rm -f /tmp/gg_test.gg /tmp/gg_test.out
done

echo ""
echo "=== Benchmark: multi-chain vs old (selected files) ==="
printf "%-35s %10s %10s %10s %8s %8s\n" "FILE" "SIZE" "GG" "GZIP" "XZ" "vs_GZ" "vs_XZ"
echo "------------------------------------------------------------------------------------"

TOTAL_SIZE=0; TOTAL_GG=0; TOTAL_GZ=0; TOTAL_XZ=0
GG_BEAT_GZ=0; GG_BEAT_XZ=0; N_FILES=0

for f in test.html testdata/test.css testdata/test.js testdata/test.json testdata/test_plain.txt testdata/test.xml \
    testdata/realweb/youtube.html testdata/realweb/youtube_watch.html testdata/realweb/google.html \
    testdata/realweb/github.html testdata/realweb/github_repo.html testdata/realweb/wikipedia.html \
    testdata/realweb/stackoverflow_q.html testdata/realweb/amazon.html testdata/realweb/bbc.html \
    testdata/realweb/cnn.html testdata/realweb/netflix.html testdata/realweb/twitter.html \
    testdata/realweb/ebay.html testdata/realweb/figma.html testdata/realweb/nytimes.html \
    testdata/realweb/apple.html testdata/realweb/microsoft.html testdata/realweb/linkedin.html \
    testdata/realweb/espn.html testdata/realweb/w3schools.html testdata/realweb/react_docs.html \
    testdata/realweb/mdn.html testdata/realweb/bootstrap.html testdata/realweb/npmjs.html \
    testdata/realweb/reddit.html testdata/realweb/weather.html testdata/realweb/pinterest.html \
    testdata/realweb/vercel.html testdata/realweb/tailwind.html testdata/realweb/discord.html \
    testdata/realweb/target.html testdata/realweb/notion.html testdata/realweb/twitch.html \
    testdata/realweb/gitlab.html testdata/realweb/coursera.html \
    testdata/realweb/github_api_commits.json \
    testdata/realweb/walmart.html testdata/realweb/shopify.html testdata/realweb/slack.html \
    testdata/realweb/spotify.html testdata/realweb/dropbox.html testdata/realweb/salesforce.html \
    testdata/realweb/instagram.html testdata/realweb/tiktok.html testdata/realweb/wordpress.html \
    testdata/realweb/paypal.html testdata/realweb/craigs.html testdata/realweb/whatsapp.html \
    testdata/realweb/zoom.html \
    testdata/realweb/behance.html testdata/realweb/drive.html testdata/realweb/translate.html \
    testdata/realweb/github_explore.html testdata/realweb/hackernews.html testdata/realweb/caniuse.html \
    testdata/realweb/jsfiddle.html testdata/realweb/office365.html testdata/realweb/msn.html \
    testdata/realweb/maps.html testdata/realweb/dribbble.html testdata/realweb/teams.html; do
    [ ! -f "$f" ] && continue
    SZ=$(stat -c%s "$f")
    [ "$SZ" -lt 100 ] && continue

    ./greedyguy_v2 c "$f" /tmp/gg_bench.gg 2>/dev/null
    GG=$(stat -c%s /tmp/gg_bench.gg)
    gzip -9 -c "$f" > /tmp/gg_bench.gz 2>/dev/null; GZ=$(stat -c%s /tmp/gg_bench.gz)
    xz -9 -c "$f" > /tmp/gg_bench.xz 2>/dev/null; XZ=$(stat -c%s /tmp/gg_bench.xz)
    rm -f /tmp/gg_bench.gg /tmp/gg_bench.gz /tmp/gg_bench.xz

    VGZ=$((GZ - GG)); VXZ=$((XZ - GG))
    NAME=$(basename "$f")
    printf "%-35s %10d %10d %10d %10d %+8d %+8d\n" "$NAME" "$SZ" "$GG" "$GZ" "$XZ" "$VGZ" "$VXZ"

    TOTAL_SIZE=$((TOTAL_SIZE + SZ)); TOTAL_GG=$((TOTAL_GG + GG))
    TOTAL_GZ=$((TOTAL_GZ + GZ)); TOTAL_XZ=$((TOTAL_XZ + XZ))
    N_FILES=$((N_FILES + 1))
    [ "$GG" -lt "$GZ" ] && GG_BEAT_GZ=$((GG_BEAT_GZ + 1))
    [ "$GG" -lt "$XZ" ] && GG_BEAT_XZ=$((GG_BEAT_XZ + 1))
done

echo "------------------------------------------------------------------------------------"
printf "%-35s %10d %10d %10d %10d %+8d %+8d\n" "TOTAL ($N_FILES files)" "$TOTAL_SIZE" "$TOTAL_GG" "$TOTAL_GZ" "$TOTAL_XZ" "$((TOTAL_GZ - TOTAL_GG))" "$((TOTAL_XZ - TOTAL_GG))"
echo ""
echo "GG beats gzip-9: $GG_BEAT_GZ / $N_FILES files"
echo "GG beats xz-9:   $GG_BEAT_XZ / $N_FILES files"