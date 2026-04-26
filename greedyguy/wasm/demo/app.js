// GreedyGuy WASM Demo — Application Module
// Handles WASM loading, compression, benchmarks, and all UI interactions.

// ===========================================================================
// State
// ===========================================================================
let mod = null;          // Emscripten module instance
let wasmBytes = 0;       // .wasm file size
let benchAbort = false;  // benchmark cancellation flag
let memTimer = null;     // memory monitor interval

// ===========================================================================
// Helpers
// ===========================================================================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatSpeed(bytes, ms) {
    if (ms <= 0) return '—';
    const mbps = (bytes / (1024 * 1024)) / (ms / 1000);
    return mbps >= 1 ? mbps.toFixed(1) + ' MB/s' : (mbps * 1024).toFixed(0) + ' KB/s';
}

function pct(a, b) { return b ? ((a / b) * 100).toFixed(1) + '%' : '—'; }

// Yield to the browser so UI updates render
function tick() { return new Promise(r => setTimeout(r, 0)); }

// ===========================================================================
// WASM Loading
// ===========================================================================
async function loadWasm() {
    if (mod) return mod;

    const statusVal = $('#hs-status-val');
    statusVal.textContent = 'Loading…';

    const t0 = performance.now();

    // Fetch WASM size for display
    try {
        const resp = await fetch('../dist/greedyguy.wasm', { method: 'HEAD' });
        if (resp.ok) {
            const cl = resp.headers.get('content-length');
            if (cl) wasmBytes = parseInt(cl, 10);
        }
    } catch (_) { /* ignore */ }

    // Dynamic import of the Emscripten ESM glue
    const { default: createGreedyGuy } = await import('../dist/greedyguy.js');

    mod = await createGreedyGuy({
        locateFile: (path) => '../dist/' + path
    });

    const dt = performance.now() - t0;

    // Update hero stats
    statusVal.textContent = 'Ready';
    statusVal.classList.remove('loading');
    $('#hs-status').classList.add('ready');

    if (wasmBytes) {
        $('#hs-size-val').textContent = formatSize(wasmBytes);
        $('#hs-size').classList.add('ready');
        $('#mem-wasm-size').textContent = formatSize(wasmBytes);
    }

    $('#hs-time-val').textContent = dt.toFixed(0) + ' ms';
    $('#hs-time').classList.add('ready');

    const heapSize = mod.HEAPU8.buffer.byteLength;
    $('#hs-mem-val').textContent = formatSize(heapSize);
    $('#hs-mem').classList.add('ready');

    // Enable buttons
    $$('.btn[disabled]').forEach(b => b.disabled = false);

    // Start memory monitor
    startMemoryMonitor();

    return mod;
}

// ===========================================================================
// Compress / Decompress wrappers
// ===========================================================================
function compress(input) {
    const inputPtr = mod._malloc(input.length);
    const outPtrPtr = mod._malloc(4);
    const outLenPtr = mod._malloc(4);
    try {
        mod.HEAPU8.set(input, inputPtr);
        mod.setValue(outPtrPtr, 0, 'i32');
        mod.setValue(outLenPtr, 0, 'i32');
        const rc = mod._gg_web_compress(inputPtr, input.length, outPtrPtr, outLenPtr);
        if (rc !== 0) throw new Error(`Compression failed (rc=${rc})`);
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

function decompress(input) {
    const inputPtr = mod._malloc(input.length);
    const outPtrPtr = mod._malloc(4);
    const outLenPtr = mod._malloc(4);
    try {
        mod.HEAPU8.set(input, inputPtr);
        mod.setValue(outPtrPtr, 0, 'i32');
        mod.setValue(outLenPtr, 0, 'i32');
        const rc = mod._gg_web_decompress(inputPtr, input.length, outPtrPtr, outLenPtr);
        if (rc !== 0) throw new Error(`Decompression failed (rc=${rc})`);
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

// ===========================================================================
// Sample Data Generators
// ===========================================================================
const samples = {
    html() {
        let h = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Sample Dashboard</title>\n  <style>\n    * { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, sans-serif; background: #f0f2f5; color: #1a1a2e; }\n    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }\n    .header { background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 2rem; border-radius: 12px; margin-bottom: 2rem; }\n    .header h1 { font-size: 2rem; margin-bottom: 0.5rem; }\n    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; }\n    .card { background: white; border-radius: 8px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s; }\n    .card:hover { transform: translateY(-2px); }\n    .card h3 { color: #667eea; margin-bottom: 0.75rem; }\n    .card p { color: #666; line-height: 1.6; }\n    .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 2rem; font-size: 0.8rem; font-weight: 600; }\n    .badge-success { background: #d4edda; color: #155724; }\n    .badge-warning { background: #fff3cd; color: #856404; }\n    .badge-info { background: #d1ecf1; color: #0c5460; }\n    .stats { display: flex; gap: 2rem; margin-top: 1rem; }\n    .stat-value { font-size: 1.5rem; font-weight: 700; color: #333; }\n    .stat-label { font-size: 0.8rem; color: #999; }\n  </style>\n</head>\n<body>\n  <div class="container">\n    <div class="header">\n      <h1>Dashboard Overview</h1>\n      <p>Welcome back! Here is a summary of your analytics data for this period.</p>\n      <div class="stats">\n        <div><div class="stat-value">12,847</div><div class="stat-label">Total Visitors</div></div>\n        <div><div class="stat-value">3,291</div><div class="stat-label">Conversions</div></div>\n        <div><div class="stat-value">25.6%</div><div class="stat-label">Conv. Rate</div></div>\n      </div>\n    </div>\n    <div class="grid">\n`;
        for (let i = 1; i <= 12; i++) {
            const badges = ['success', 'warning', 'info'];
            const b = badges[i % 3];
            h += `      <div class="card">\n        <h3>Card ${i}: Analytics Module</h3>\n        <p>This card shows metrics and KPIs for module ${i}. Performance data is updated in real-time with live monitoring and alerting capabilities.</p>\n        <p style="margin-top:0.75rem"><span class="badge badge-${b}">${b}</span></p>\n      </div>\n`;
        }
        h += `    </div>\n  </div>\n  <script>\n    document.querySelectorAll('.card').forEach((card, i) => {\n      card.addEventListener('click', () => {\n        card.style.borderLeft = '4px solid #667eea';\n        console.log('Card ' + (i + 1) + ' selected');\n      });\n    });\n  <\/script>\n</body>\n</html>`;
        return h;
    },

    css() {
        let c = `/* Design System — Generated CSS */\n:root {\n  --color-primary: #6366f1;\n  --color-primary-hover: #4f46e5;\n  --color-secondary: #ec4899;\n  --color-success: #22c55e;\n  --color-warning: #f59e0b;\n  --color-danger: #ef4444;\n  --color-info: #3b82f6;\n  --color-bg: #ffffff;\n  --color-surface: #f8fafc;\n  --color-border: #e2e8f0;\n  --color-text: #0f172a;\n  --color-text-secondary: #64748b;\n  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;\n  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;\n  --radius-sm: 4px;\n  --radius-md: 8px;\n  --radius-lg: 12px;\n  --radius-xl: 16px;\n  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);\n  --shadow-md: 0 4px 12px rgba(0,0,0,0.1);\n  --shadow-lg: 0 8px 24px rgba(0,0,0,0.12);\n  --transition: 200ms ease;\n}\n\n`;
        const components = ['button', 'input', 'card', 'badge', 'avatar', 'tooltip', 'modal', 'dropdown', 'tabs', 'alert', 'progress', 'skeleton'];
        const states = ['default', 'hover', 'active', 'focus', 'disabled'];
        const sizes = ['sm', 'md', 'lg', 'xl'];
        for (const comp of components) {
            c += `/* ${comp.charAt(0).toUpperCase() + comp.slice(1)} Component */\n`;
            for (const size of sizes) {
                c += `.${comp}-${size} {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  font-family: var(--font-sans);\n  font-weight: 500;\n  border-radius: var(--radius-md);\n  transition: all var(--transition);\n  cursor: pointer;\n  padding: ${size === 'sm' ? '0.25rem 0.5rem' : size === 'md' ? '0.5rem 1rem' : size === 'lg' ? '0.75rem 1.5rem' : '1rem 2rem'};\n  font-size: ${size === 'sm' ? '0.75rem' : size === 'md' ? '0.875rem' : size === 'lg' ? '1rem' : '1.125rem'};\n}\n`;
            }
            for (const state of states) {
                c += `.${comp}:${state === 'default' ? '' : state} {\n  background: var(--color-${state === 'disabled' ? 'border' : 'primary'});\n  color: ${state === 'disabled' ? 'var(--color-text-secondary)' : '#fff'};\n  opacity: ${state === 'disabled' ? '0.6' : '1'};\n  box-shadow: ${state === 'focus' ? '0 0 0 3px rgba(99,102,241,0.3)' : 'var(--shadow-sm)'};\n}\n`;
            }
            c += '\n';
        }
        c += `/* Responsive Grid */\n.grid { display: grid; gap: 1rem; }\n`;
        for (let i = 1; i <= 12; i++) {
            c += `.col-${i} { grid-column: span ${i}; }\n`;
            c += `@media (max-width: 768px) { .col-md-${i} { grid-column: span ${Math.min(i, 6)}; } }\n`;
            c += `@media (max-width: 480px) { .col-sm-${i} { grid-column: span ${Math.min(i, 4)}; } }\n`;
        }
        c += `\n/* Animations */\n@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }\n@keyframes slideIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }\n@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }\n@keyframes spin { to { transform: rotate(360deg); } }\n@keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }\n`;
        return c;
    },

    js() {
        let j = `// Application Module — Generated JavaScript\n'use strict';\n\n`;
        j += `class EventEmitter {\n  constructor() { this._listeners = new Map(); }\n  on(event, fn) {\n    if (!this._listeners.has(event)) this._listeners.set(event, new Set());\n    this._listeners.get(event).add(fn);\n    return () => this._listeners.get(event)?.delete(fn);\n  }\n  emit(event, ...args) {\n    this._listeners.get(event)?.forEach(fn => fn(...args));\n  }\n}\n\n`;
        j += `class Store extends EventEmitter {\n  #state;\n  constructor(initial) { super(); this.#state = structuredClone(initial); }\n  get state() { return this.#state; }\n  update(partial) {\n    const prev = this.#state;\n    this.#state = { ...this.#state, ...partial };\n    this.emit('change', this.#state, prev);\n  }\n}\n\n`;
        const modules = ['UserService', 'ProductService', 'OrderService', 'NotificationService', 'AnalyticsService'];
        for (const name of modules) {
            j += `class ${name} {\n  #baseUrl;\n  #cache = new Map();\n  constructor(baseUrl) { this.#baseUrl = baseUrl; }\n\n`;
            const methods = ['getAll', 'getById', 'create', 'update', 'delete', 'search', 'validate'];
            for (const method of methods) {
                j += `  async ${method}(params = {}) {\n    const cacheKey = JSON.stringify({ method: '${method}', params });\n    if (this.#cache.has(cacheKey)) return this.#cache.get(cacheKey);\n    try {\n      const response = await fetch(\`\${this.#baseUrl}/${name.toLowerCase()}/${method}\`, {\n        method: '${method === 'create' ? 'POST' : method === 'update' ? 'PUT' : method === 'delete' ? 'DELETE' : 'GET'}',\n        headers: { 'Content-Type': 'application/json' },\n        body: ${method === 'getAll' || method === 'getById' || method === 'search' ? 'undefined' : 'JSON.stringify(params)'},\n      });\n      if (!response.ok) throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);\n      const data = await response.json();\n      this.#cache.set(cacheKey, data);\n      return data;\n    } catch (error) {\n      console.error(\`[${name}] ${method} failed:\`, error);\n      throw error;\n    }\n  }\n\n`;
            }
            j += `  clearCache() { this.#cache.clear(); }\n}\n\n`;
        }
        j += `// Utility functions\nconst debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };\nconst throttle = (fn, ms) => { let last = 0; return (...a) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...a); } }; };\nconst sleep = ms => new Promise(r => setTimeout(r, ms));\nconst retry = async (fn, n = 3, d = 1000) => { for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { if (i === n - 1) throw e; await sleep(d * (i + 1)); } } };\n`;
        return j;
    },

    json() {
        const users = [];
        const depts = ['Engineering', 'Design', 'Marketing', 'Sales', 'Support', 'Operations', 'Finance', 'Legal'];
        const skills = ['JavaScript', 'TypeScript', 'Python', 'Rust', 'Go', 'React', 'Vue', 'Angular', 'Node.js', 'Docker', 'Kubernetes', 'AWS', 'GCP', 'PostgreSQL', 'Redis', 'GraphQL'];
        for (let i = 1; i <= 50; i++) {
            const dept = depts[i % depts.length];
            const userSkills = [];
            for (let s = 0; s < 3 + (i % 4); s++) userSkills.push(skills[(i + s * 7) % skills.length]);
            users.push({
                id: i,
                name: `User ${i}`,
                email: `user${i}@example.com`,
                department: dept,
                role: i % 5 === 0 ? 'manager' : i % 3 === 0 ? 'senior' : 'member',
                skills: userSkills,
                active: i % 7 !== 0,
                joinedAt: `2023-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}T09:00:00Z`,
                metrics: {
                    tasksCompleted: 50 + i * 3,
                    avgResponseTime: (1.2 + (i % 10) * 0.3).toFixed(1) + 's',
                    satisfaction: (3.5 + (i % 15) * 0.1).toFixed(1)
                },
                address: {
                    street: `${100 + i} Main Street`,
                    city: ['San Francisco', 'New York', 'London', 'Berlin', 'Tokyo'][i % 5],
                    country: ['US', 'US', 'UK', 'DE', 'JP'][i % 5],
                    postalCode: String(10000 + i * 111)
                }
            });
        }
        return JSON.stringify({ version: '2.1.0', generatedAt: new Date().toISOString(), totalRecords: users.length, data: users }, null, 2);
    },

    svg() {
        let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">\n  <defs>\n    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">\n      <stop offset="0%" style="stop-color:#667eea;stop-opacity:1" />\n      <stop offset="100%" style="stop-color:#764ba2;stop-opacity:1" />\n    </linearGradient>\n    <linearGradient id="grad2" x1="0%" y1="0%" x2="0%" y2="100%">\n      <stop offset="0%" style="stop-color:#f093fb;stop-opacity:1" />\n      <stop offset="100%" style="stop-color:#f5576c;stop-opacity:1" />\n    </linearGradient>\n    <filter id="shadow">\n      <feDropShadow dx="2" dy="4" stdDeviation="4" flood-opacity="0.15"/>\n    </filter>\n  </defs>\n  <rect width="800" height="600" fill="#0f172a" rx="8"/>\n`;
        for (let i = 0; i < 20; i++) {
            const cx = 50 + (i % 5) * 175;
            const cy = 80 + Math.floor(i / 5) * 130;
            const r = 30 + (i % 3) * 15;
            s += `  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#grad${1 + i % 2})" opacity="${0.3 + (i % 5) * 0.12}" filter="url(#shadow)"/>\n`;
            s += `  <rect x="${cx + 40}" y="${cy - 20}" width="${60 + i * 3}" height="12" rx="6" fill="#334155" opacity="0.6"/>\n`;
            s += `  <text x="${cx}" y="${cy + 5}" text-anchor="middle" fill="white" font-size="14" font-family="system-ui">${i + 1}</text>\n`;
        }
        for (let i = 0; i < 8; i++) {
            const x1 = 100 + i * 90, y1 = 500, x2 = 100 + i * 90, y2 = 500 - (20 + i * 25 + (i % 3) * 15);
            s += `  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="url(#grad1)" stroke-width="24" stroke-linecap="round" opacity="0.8"/>\n`;
            s += `  <text x="${x1}" y="${y1 + 20}" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="system-ui">Col ${i + 1}</text>\n`;
        }
        s += `</svg>`;
        return s;
    },

    mixed() {
        return samples.html().slice(0, 2000) + '\n\n' + samples.css().slice(0, 2000) + '\n\n' +
               samples.js().slice(0, 2000) + '\n\n' + samples.json().slice(0, 1500);
    }
};

// ===========================================================================
// Section 1: Live Text Compressor
// ===========================================================================
function initTextCompressor() {
    const textarea = $('#text-input');
    const sizeLabel = $('#text-input-size');
    const resultsEl = $('#text-results');

    // Track input size
    textarea.addEventListener('input', () => {
        const len = new TextEncoder().encode(textarea.value).length;
        sizeLabel.textContent = formatSize(len);
    });

    // Sample tabs
    $('#sample-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.sample-tab');
        if (!tab) return;
        $$('.sample-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const key = tab.dataset.sample;
        if (samples[key]) {
            textarea.value = samples[key]();
            textarea.dispatchEvent(new Event('input'));
        }
    });

    // Load initial sample
    textarea.value = samples.html();
    textarea.dispatchEvent(new Event('input'));

    // Compress button
    $('#btn-compress').addEventListener('click', async () => {
        const text = textarea.value;
        if (!text) return;
        try {
            await loadWasm();
            const input = new TextEncoder().encode(text);
            const t0 = performance.now();
            const compressed = compress(input);
            const compressTime = performance.now() - t0;
            showTextResults(resultsEl, input.length, compressed.length, compressTime, null, null);
        } catch (e) {
            resultsEl.classList.remove('hidden');
            resultsEl.innerHTML = `<div class="roundtrip-badge fail">❌ Error: ${e.message}</div>`;
        }
    });

    // Roundtrip verify
    $('#btn-roundtrip').addEventListener('click', async () => {
        const text = textarea.value;
        if (!text) return;
        try {
            await loadWasm();
            const input = new TextEncoder().encode(text);
            const t0 = performance.now();
            const compressed = compress(input);
            const t1 = performance.now();
            const decompressed = decompress(compressed);
            const t2 = performance.now();
            const decoded = new TextDecoder().decode(decompressed);
            const match = decoded === text;
            showTextResults(resultsEl, input.length, compressed.length, t1 - t0, t2 - t1, match);
        } catch (e) {
            resultsEl.classList.remove('hidden');
            resultsEl.innerHTML = `<div class="roundtrip-badge fail">❌ Error: ${e.message}</div>`;
        }
    });
}

function showTextResults(el, originalSize, compressedSize, compressMs, decompressMs, roundtripOk) {
    const ratio = (originalSize / (compressedSize || 1)).toFixed(2);
    const pctVal = ((compressedSize / (originalSize || 1)) * 100).toFixed(1);
    const barWidth = Math.max(2, Math.min(100, parseFloat(pctVal)));

    let html = `<div class="stats-grid">
        <div class="stat-card"><div class="stat-card-value accent">${formatSize(originalSize)}</div><div class="stat-card-label">Original</div></div>
        <div class="stat-card"><div class="stat-card-value green">${formatSize(compressedSize)}</div><div class="stat-card-label">Compressed</div></div>
        <div class="stat-card"><div class="stat-card-value orange">${ratio}:1</div><div class="stat-card-label">Ratio</div></div>
        <div class="stat-card"><div class="stat-card-value purple">${pctVal}%</div><div class="stat-card-label">Of Original</div></div>
        <div class="stat-card"><div class="stat-card-value accent">${compressMs.toFixed(0)} ms</div><div class="stat-card-label">Compress</div></div>`;
    if (decompressMs !== null) {
        html += `<div class="stat-card"><div class="stat-card-value accent">${decompressMs.toFixed(0)} ms</div><div class="stat-card-label">Decompress</div></div>`;
    }
    html += `</div>`;

    // Comparison bars
    html += `<div class="comparison-bars">
        <div class="comparison-row">
            <span class="comparison-label">Original</span>
            <div class="comparison-track"><div class="comparison-fill original" style="width:100%">${formatSize(originalSize)}</div></div>
        </div>
        <div class="comparison-row">
            <span class="comparison-label">Compressed</span>
            <div class="comparison-track"><div class="comparison-fill compressed" style="width:${barWidth}%">${formatSize(compressedSize)}</div></div>
        </div>
    </div>`;

    if (roundtripOk !== null) {
        html += `<div class="roundtrip-badge ${roundtripOk ? 'pass' : 'fail'}">
            ${roundtripOk ? '✅ Roundtrip verified — byte-for-byte identical' : '❌ Roundtrip FAILED — data mismatch'}
        </div>`;
    }

    el.innerHTML = html;
    el.classList.remove('hidden');
}

// ===========================================================================
// Section 2: File Drop Zone
// ===========================================================================
function initFileDrop() {
    const zone = $('#drop-zone');
    const fileInput = $('#file-input');
    const spinner = $('#file-spinner');
    const resultsEl = $('#file-results');

    zone.addEventListener('click', () => fileInput.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
        if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) processFile(fileInput.files[0]);
        fileInput.value = '';
    });

    async function processFile(file) {
        zone.classList.add('hidden');
        spinner.classList.remove('hidden');
        resultsEl.classList.add('hidden');
        const spinnerText = spinner.querySelector('.spinner-text');
        spinnerText.textContent = `Compressing ${file.name}…`;

        await tick();

        try {
            await loadWasm();
            const input = new Uint8Array(await file.arrayBuffer());

            const t0 = performance.now();
            const compressed = compress(input);
            const t1 = performance.now();
            spinnerText.textContent = 'Decompressing for verification…';
            await tick();
            const decompressed = decompress(compressed);
            const t2 = performance.now();

            // Verify
            let match = input.length === decompressed.length;
            if (match) {
                for (let i = 0; i < input.length; i++) {
                    if (input[i] !== decompressed[i]) { match = false; break; }
                }
            }

            showFileResults(resultsEl, file, input, compressed, t1 - t0, t2 - t1, match);
        } catch (e) {
            resultsEl.classList.remove('hidden');
            resultsEl.innerHTML = `<div class="roundtrip-badge fail">❌ Error: ${e.message}</div>`;
        } finally {
            spinner.classList.add('hidden');
            zone.classList.remove('hidden');
        }
    }
}

function showFileResults(el, file, input, compressed, compressMs, decompressMs, match) {
    const ratio = (input.length / (compressed.length || 1)).toFixed(2);
    const pctVal = ((compressed.length / (input.length || 1)) * 100).toFixed(1);
    const barWidth = Math.max(2, Math.min(100, parseFloat(pctVal)));
    const saved = input.length - compressed.length;

    let html = `<h4 style="margin-bottom:0.75rem;font-size:0.95rem">📄 ${file.name}</h4>
    <div class="stats-grid">
        <div class="stat-card"><div class="stat-card-value accent">${formatSize(input.length)}</div><div class="stat-card-label">Original</div></div>
        <div class="stat-card"><div class="stat-card-value green">${formatSize(compressed.length)}</div><div class="stat-card-label">Compressed</div></div>
        <div class="stat-card"><div class="stat-card-value orange">${ratio}:1</div><div class="stat-card-label">Ratio</div></div>
        <div class="stat-card"><div class="stat-card-value purple">${pctVal}%</div><div class="stat-card-label">Of Original</div></div>
        <div class="stat-card"><div class="stat-card-value accent">${compressMs.toFixed(0)} ms</div><div class="stat-card-label">Compress</div></div>
        <div class="stat-card"><div class="stat-card-value accent">${decompressMs.toFixed(0)} ms</div><div class="stat-card-label">Decompress</div></div>
    </div>`;

    // Comparison bars
    html += `<div class="comparison-bars">
        <div class="comparison-row">
            <span class="comparison-label">Original</span>
            <div class="comparison-track"><div class="comparison-fill original" style="width:100%">${formatSize(input.length)}</div></div>
        </div>
        <div class="comparison-row">
            <span class="comparison-label">Compressed</span>
            <div class="comparison-track"><div class="comparison-fill compressed" style="width:${barWidth}%">${formatSize(compressed.length)}</div></div>
        </div>
    </div>`;

    // Roundtrip badge
    html += `<div class="roundtrip-badge ${match ? 'pass' : 'fail'}">
        ${match ? '✅ Roundtrip verified — byte-for-byte identical' : '❌ Roundtrip FAILED'}
    </div>`;

    // Download button
    if (saved > 0) {
        html += `<div class="download-row">
            <button class="btn btn-accent btn-sm" id="btn-download-ggw">⬇ Download ${file.name}.ggw (${formatSize(compressed.length)})</button>
            <span style="font-size:0.78rem;color:var(--text-1)">Saved ${formatSize(saved)}</span>
        </div>`;
    }

    el.innerHTML = html;
    el.classList.remove('hidden');

    // Download handler
    const dlBtn = $('#btn-download-ggw');
    if (dlBtn) {
        dlBtn.addEventListener('click', () => {
            const blob = new Blob([compressed], { type: 'application/octet-stream' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = file.name + '.ggw';
            a.click();
            URL.revokeObjectURL(a.href);
        });
    }
}

// ===========================================================================
// Section 3: Benchmark Suite
// ===========================================================================
const benchTypes = [
    { key: 'html',  label: 'HTML',       icon: '🌐', gen: () => samples.html() },
    { key: 'css',   label: 'CSS',        icon: '🎨', gen: () => samples.css() },
    { key: 'js',    label: 'JavaScript', icon: '⚡', gen: () => samples.js() },
    { key: 'json',  label: 'JSON',       icon: '📋', gen: () => samples.json() },
    { key: 'svg',   label: 'SVG',        icon: '🖼️', gen: () => samples.svg() },
    { key: 'mixed', label: 'Mixed',      icon: '🔀', gen: () => samples.mixed() },
];

function initBenchmarks() {
    const tbody = $('#bench-body');
    const statusEl = $('#bench-status');
    const runBtn = $('#btn-run-bench');
    const stopBtn = $('#btn-stop-bench');

    // Pre-populate table rows
    populateBenchTable(tbody);

    runBtn.addEventListener('click', () => runBenchmarks(tbody, statusEl, runBtn, stopBtn));
    stopBtn.addEventListener('click', () => { benchAbort = true; });
}

function populateBenchTable(tbody) {
    tbody.innerHTML = '';
    for (const t of benchTypes) {
        const tr = document.createElement('tr');
        tr.id = `bench-row-${t.key}`;
        tr.innerHTML = `
            <td class="type-cell">${t.icon} ${t.label}</td>
            <td class="pending">—</td>
            <td class="pending">—</td>
            <td class="pending">—</td>
            <td><div class="mini-bar"><div class="mini-bar-fill" style="width:0%"></div></div></td>
            <td class="pending">—</td>
            <td class="pending">—</td>`;
        tbody.appendChild(tr);
    }
}

async function runBenchmarks(tbody, statusEl, runBtn, stopBtn) {
    benchAbort = false;
    runBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    populateBenchTable(tbody);

    try {
        await loadWasm();
    } catch (e) {
        statusEl.textContent = 'WASM load failed';
        runBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        return;
    }

    for (let i = 0; i < benchTypes.length; i++) {
        if (benchAbort) break;

        const t = benchTypes[i];
        statusEl.textContent = `Running ${t.label}… (${i + 1}/${benchTypes.length})`;
        const row = $(`#bench-row-${t.key}`);
        const cells = row.querySelectorAll('td');
        cells[1].className = 'running';
        cells[1].textContent = '⏳';

        await tick();

        try {
            const text = t.gen();
            const input = new TextEncoder().encode(text);

            const t0 = performance.now();
            const compressed = compress(input);
            const t1 = performance.now();
            const _decompressed = decompress(compressed);
            const t2 = performance.now();

            const compressMs = t1 - t0;
            const decompressMs = t2 - t1;
            const ratio = (input.length / (compressed.length || 1));
            const pctVal = ((compressed.length / (input.length || 1)) * 100);
            const barWidth = Math.max(2, Math.min(100, pctVal));

            cells[1].textContent = formatSize(input.length);
            cells[1].className = '';
            cells[2].textContent = formatSize(compressed.length);
            cells[2].className = '';
            cells[3].textContent = ratio.toFixed(1) + ':1';
            cells[3].className = '';
            cells[3].style.color = 'var(--green)';
            cells[4].querySelector('.mini-bar-fill').style.width = barWidth + '%';
            cells[5].textContent = formatSpeed(input.length, compressMs);
            cells[5].className = '';
            cells[6].textContent = formatSpeed(compressed.length, decompressMs);
            cells[6].className = '';
        } catch (e) {
            cells[1].textContent = 'Error';
            cells[1].style.color = 'var(--red)';
        }

        await tick();
    }

    statusEl.textContent = benchAbort ? 'Stopped' : 'Complete ✓';
    runBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
}

// ===========================================================================
// Section 4: Memory Monitor
// ===========================================================================
const MAX_HEAP = 256 * 1024 * 1024; // 256 MB

function startMemoryMonitor() {
    updateMemory();
    if (memTimer) clearInterval(memTimer);
    memTimer = setInterval(updateMemory, 1500);
}

function updateMemory() {
    if (!mod) return;
    const heap = mod.HEAPU8.buffer.byteLength;
    const heapPct = ((heap / MAX_HEAP) * 100).toFixed(1);

    $('#mem-heap').textContent = formatSize(heap);
    $('#mem-pct').textContent = formatSize(heap);
    $('#mem-bar-fill').style.width = heapPct + '%';
    $('#mem-max-pct').textContent = heapPct + '%';
    $('#mem-max-fill').style.width = heapPct + '%';

    // Also update hero stat
    $('#hs-mem-val').textContent = formatSize(heap);
}

// ===========================================================================
// Initialization
// ===========================================================================
initTextCompressor();
initFileDrop();
initBenchmarks();

// Auto-load WASM
loadWasm().catch(e => {
    $('#hs-status-val').textContent = 'Error';
    $('#hs-status-val').classList.remove('loading');
    $('#hs-status-val').style.color = 'var(--red)';
    console.error('WASM load error:', e);
});
