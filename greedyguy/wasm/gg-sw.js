/**
 * GreedyGuy Service Worker — Transparent decompression proxy
 *
 * Intercepts fetch requests for .ggw files, decompresses them via WASM,
 * and returns the original content. Caches decompressed results.
 *
 * How it works:
 *   1. Page requests "bundle.js" (or any asset)
 *   2. SW checks if "bundle.js.ggw" exists on server
 *   3. If yes: fetches compressed, decompresses via WASM, returns original
 *   4. If no: passes through to network normally
 *   5. Decompressed results are cached for instant subsequent loads
 *
 * Registration (in your page):
 *   navigator.serviceWorker.register('/gg-sw.js', { scope: '/' });
 */

// =========================================================================
// Configuration
// =========================================================================

const CACHE_NAME = 'greedyguy-v1';
const GGW_SUFFIX = '.ggw';          // compressed file extension
const WASM_PATH = '/wasm/dist/';     // path to WASM files (override via message)

// Content type mapping
const CONTENT_TYPES = {
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.html': 'text/html',
    '.json': 'application/json',
    '.xml':  'application/xml',
    '.svg':  'image/svg+xml',
    '.txt':  'text/plain',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
};

// =========================================================================
// WASM Decompressor (loaded lazily)
// =========================================================================

let wasmModule = null;

async function loadWasm() {
    if (wasmModule) return wasmModule;

    // Import the Emscripten module
    const script = await import(WASM_PATH + 'greedyguy.js');
    wasmModule = await script.default({
        locateFile: (path) => WASM_PATH + path
    });

    return wasmModule;
}

function wasmDecompress(mod, compressedBytes) {
    const inputLen = compressedBytes.length;
    const inputPtr = mod._malloc(inputLen);
    const outPtrPtr = mod._malloc(4);
    const outLenPtr = mod._malloc(4);

    try {
        mod.HEAPU8.set(compressedBytes, inputPtr);
        mod.setValue(outPtrPtr, 0, 'i32');
        mod.setValue(outLenPtr, 0, 'i32');

        const rc = mod._gg_web_decompress(inputPtr, inputLen, outPtrPtr, outLenPtr);
        if (rc !== 0) throw new Error(`GG decompress failed: ${rc}`);

        const outPtr = mod.getValue(outPtrPtr, 'i32');
        const outLen = mod.getValue(outLenPtr, 'i32');

        const result = new Uint8Array(outLen);
        result.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
        mod._gg_web_free(outPtr);

        return result;
    } finally {
        mod._free(inputPtr);
        mod._free(outPtrPtr);
        mod._free(outLenPtr);
    }
}

// =========================================================================
// Service Worker Events
// =========================================================================

self.addEventListener('install', (event) => {
    console.log('[GG-SW] Installing...');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[GG-SW] Activating...');
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Only intercept same-origin requests
    if (url.origin !== self.location.origin) return;

    // Skip SW/WASM files themselves
    if (url.pathname.includes('/wasm/') || url.pathname.endsWith('gg-sw.js')) return;

    // Check if this is an asset type we can compress
    const ext = getExtension(url.pathname);
    if (!ext || !CONTENT_TYPES[ext]) return;

    event.respondWith(handleRequest(event.request, url, ext));
});

async function handleRequest(request, url, ext) {
    // 1. Check cache first
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    // 2. Try to fetch compressed version (.ggw)
    const ggwUrl = url.pathname + GGW_SUFFIX;
    try {
        const ggwResponse = await fetch(ggwUrl, { mode: 'same-origin' });
        if (ggwResponse.ok) {
            // Found compressed version — decompress
            const compressed = new Uint8Array(await ggwResponse.arrayBuffer());

            // Verify magic
            if (compressed.length >= 4 &&
                compressed[0] === 0x47 && compressed[1] === 0x47 &&
                compressed[2] === 0x57 && compressed[3] === 0x31) {

                const t0 = performance.now();
                const mod = await loadWasm();
                const decompressed = wasmDecompress(mod, compressed);
                const dt = performance.now() - t0;

                console.log(`[GG-SW] ${url.pathname}: ${compressed.length} → ${decompressed.length} bytes (${dt.toFixed(0)}ms)`);

                const response = new Response(decompressed, {
                    status: 200,
                    statusText: 'OK',
                    headers: {
                        'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
                        'Content-Length': decompressed.length.toString(),
                        'X-GG-Compressed': `${compressed.length}`,
                        'X-GG-Ratio': (decompressed.length / compressed.length).toFixed(1),
                    }
                });

                // Cache the decompressed response
                cache.put(request, response.clone());
                return response;
            }
        }
    } catch (e) {
        // .ggw not available — fall through to normal fetch
    }

    // 3. Fallback: normal fetch
    const response = await fetch(request);
    return response;
}

function getExtension(pathname) {
    const dot = pathname.lastIndexOf('.');
    if (dot === -1) return null;
    return pathname.slice(dot).toLowerCase();
}

// Handle messages from main page (e.g., config updates)
self.addEventListener('message', (event) => {
    if (event.data?.type === 'SET_WASM_PATH') {
        // Allow runtime WASM path configuration
        // (in practice, import path is fixed at build time)
        console.log('[GG-SW] WASM path updated:', event.data.path);
    }
});
