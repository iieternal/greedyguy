#!/bin/bash
cd /mnt/d/Personal/compression/greedyguy
mkdir -p testdata/realweb

echo "Fetching real web pages..."
curl -sL -o testdata/realweb/youtube.html "https://www.youtube.com" 2>/dev/null
curl -sL -o testdata/realweb/google.html "https://www.google.com" 2>/dev/null
curl -sL -o testdata/realweb/github.html "https://github.com" 2>/dev/null
curl -sL -o testdata/realweb/wikipedia.html "https://en.wikipedia.org/wiki/Data_compression" 2>/dev/null
curl -sL -o testdata/realweb/stackoverflow.html "https://stackoverflow.com/questions" 2>/dev/null
curl -sL -o testdata/realweb/amazon.html "https://www.amazon.com" 2>/dev/null
curl -sL -o testdata/realweb/reddit.html "https://www.reddit.com" 2>/dev/null
curl -sL -o testdata/realweb/twitter.html "https://x.com" 2>/dev/null

echo ""
echo "=== File sizes ==="
for f in testdata/realweb/*.html; do
    sz=$(wc -c < "$f")
    echo "  $(basename $f): $sz bytes"
done