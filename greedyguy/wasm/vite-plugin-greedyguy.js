/**
 * vite-plugin-greedyguy — Compress build assets with GreedyGuy web profile
 *
 * At build time, compresses JS/CSS/HTML output files into .ggw format.
 * The browser's Service Worker decompresses them transparently.
 *
 * Usage:
 *   // vite.config.js
 *   import greedyguy from './wasm/vite-plugin-greedyguy.js';
 *
 *   export default {
 *     plugins: [
 *       greedyguy({
 *         threshold: 1024,        // min size to compress (bytes)
 *         extensions: ['.js', '.css', '.html', '.json', '.svg'],
 *         injectSW: true,         // auto-inject SW registration
 *       })
 *     ]
 *   };
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);

const DEFAULT_OPTIONS = {
    threshold: 1024,
    extensions: ['.js', '.css', '.html', '.json', '.svg', '.xml'],
    injectSW: true,
    compressorPath: null,  // auto-detect
    verbose: true,
};

function findCompressor() {
    // Look for the web-profile CLI binary
    const candidates = [
        path.resolve('wasm/dist/greedyguy-web'),
        path.resolve('node_modules/greedyguy/wasm/dist/greedyguy-web'),
        'greedyguy-web',
    ];
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return c;
        } catch (e) { /* ignore */ }
    }
    return null;
}

export default function greedyguyPlugin(options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let compressor = opts.compressorPath || findCompressor();

    return {
        name: 'vite-plugin-greedyguy',
        enforce: 'post',

        configResolved(config) {
            if (!compressor) {
                console.warn('[greedyguy] Web-profile compressor not found. Run wasm/build.sh first.');
            }
        },

        // Inject Service Worker registration into HTML
        transformIndexHtml(html) {
            if (!opts.injectSW) return html;
            const swScript = `
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/gg-sw.js', { scope: '/' })
    .then(reg => console.log('[GG] Service Worker registered'))
    .catch(err => console.warn('[GG] SW registration failed:', err));
}
</script>`;
            return html.replace('</head>', swScript + '\n</head>');
        },

        // After build: compress output files
        async closeBundle() {
            if (!compressor) return;

            const outDir = 'dist';  // Vite default
            if (!fs.existsSync(outDir)) return;

            const files = getAllFiles(outDir);
            let totalSaved = 0;
            let compressed = 0;

            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if (!opts.extensions.includes(ext)) continue;

                const stat = fs.statSync(file);
                if (stat.size < opts.threshold) continue;

                try {
                    const ggwPath = file + '.ggw';
                    await execFileAsync(compressor, ['c', file, ggwPath]);

                    const ggwStat = fs.statSync(ggwPath);
                    const saved = stat.size - ggwStat.size;

                    if (saved > 0) {
                        totalSaved += saved;
                        compressed++;
                        if (opts.verbose) {
                            const ratio = (stat.size / ggwStat.size).toFixed(1);
                            console.log(`[greedyguy] ${path.relative(outDir, file)}: ${formatSize(stat.size)} → ${formatSize(ggwStat.size)} (${ratio}:1)`);
                        }
                    } else {
                        // Compressed is bigger — remove it
                        fs.unlinkSync(ggwPath);
                    }
                } catch (e) {
                    console.warn(`[greedyguy] Failed to compress ${file}:`, e.message);
                }
            }

            if (compressed > 0) {
                console.log(`[greedyguy] Compressed ${compressed} files, saved ${formatSize(totalSaved)}`);
            }

            // Copy SW and WASM files to output
            const wasmDir = path.resolve('wasm');
            const swSrc = path.join(wasmDir, 'gg-sw.js');
            const wasmDist = path.join(wasmDir, 'dist');

            if (fs.existsSync(swSrc)) {
                fs.copyFileSync(swSrc, path.join(outDir, 'gg-sw.js'));
            }
            if (fs.existsSync(wasmDist)) {
                const destWasm = path.join(outDir, 'wasm', 'dist');
                fs.mkdirSync(destWasm, { recursive: true });
                for (const f of ['greedyguy.js', 'greedyguy.wasm']) {
                    const src = path.join(wasmDist, f);
                    if (fs.existsSync(src)) {
                        fs.copyFileSync(src, path.join(destWasm, f));
                    }
                }
            }
        }
    };
}

function getAllFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...getAllFiles(full));
        } else {
            results.push(full);
        }
    }
    return results;
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}
