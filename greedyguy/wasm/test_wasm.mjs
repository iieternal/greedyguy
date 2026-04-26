/*
 * test_wasm.mjs — Test GreedyGuy WASM in Node.js
 *
 * Run: node --experimental-vm-modules wasm/test_wasm.mjs
 * Or:  node wasm/test_wasm.mjs (Node 20+)
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the Emscripten module (ESM)
const { default: createGreedyGuy } = await import('./dist/greedyguy.js');

async function main() {
    console.log('=== GreedyGuy WASM Test ===\n');

    // Initialize WASM
    console.log('Loading WASM module...');
    const t0 = performance.now();

    // Read .wasm file manually for Node.js (Emscripten web/worker env can't do fs reads)
    const wasmPath = join(__dirname, 'dist', 'greedyguy.wasm');
    const wasmBinary = readFileSync(wasmPath);

    const mod = await createGreedyGuy({
        wasmBinary,
    });
    console.log(`WASM loaded in ${(performance.now() - t0).toFixed(0)}ms\n`);

    function compress(input) {
        const inputPtr = mod._malloc(input.length);
        const outPtrPtr = mod._malloc(4);
        const outLenPtr = mod._malloc(4);
        try {
            mod.HEAPU8.set(input, inputPtr);
            mod.setValue(outPtrPtr, 0, 'i32');
            mod.setValue(outLenPtr, 0, 'i32');
            const rc = mod._gg_web_compress(inputPtr, input.length, outPtrPtr, outLenPtr);
            if (rc !== 0) throw new Error(`Compression failed (${rc})`);
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
            if (rc !== 0) throw new Error(`Decompression failed (${rc})`);
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

    // Test 1: Small string roundtrip
    {
        const text = 'Hello, GreedyGuy WASM! This is a test.';
        const input = new TextEncoder().encode(text);
        const compressed = compress(input);
        const decompressed = decompress(compressed);
        const decoded = new TextDecoder().decode(decompressed);
        const pass = decoded === text;
        console.log(`Test 1 (string): ${input.length} → ${compressed.length} bytes`);
        console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}: roundtrip ${pass ? 'OK' : 'MISMATCH'}\n`);
        if (!pass) process.exit(1);
    }

    // Test 2: HTML content
    {
        const html = '<html><head><title>Test</title></head><body>' +
            '<div class="container"><h1>Hello</h1></div>'.repeat(50) +
            '</body></html>';
        const input = new TextEncoder().encode(html);
        const t1 = performance.now();
        const compressed = compress(input);
        const t2 = performance.now();
        const decompressed = decompress(compressed);
        const t3 = performance.now();
        const decoded = new TextDecoder().decode(decompressed);
        const pass = decoded === html;
        const ratio = (input.length / compressed.length).toFixed(1);
        console.log(`Test 2 (HTML): ${input.length} → ${compressed.length} bytes (${ratio}:1)`);
        console.log(`  Compress: ${(t2-t1).toFixed(0)}ms | Decompress: ${(t3-t2).toFixed(0)}ms`);
        console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}\n`);
        if (!pass) process.exit(1);
    }

    // Test 3: Binary data
    {
        const input = new Uint8Array(5000);
        for (let i = 0; i < input.length; i++) input[i] = i & 0xFF;
        const compressed = compress(input);
        const decompressed = decompress(compressed);
        let pass = input.length === decompressed.length;
        if (pass) {
            for (let i = 0; i < input.length; i++) {
                if (input[i] !== decompressed[i]) { pass = false; break; }
            }
        }
        console.log(`Test 3 (binary): ${input.length} → ${compressed.length} bytes`);
        console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}\n`);
        if (!pass) process.exit(1);
    }

    // Test 4: Empty data
    {
        const input = new Uint8Array(0);
        const compressed = compress(input);
        const decompressed = decompress(compressed);
        const pass = decompressed.length === 0;
        console.log(`Test 4 (empty): ${input.length} → ${compressed.length} → ${decompressed.length}`);
        console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}\n`);
        if (!pass) process.exit(1);
    }

    // Test 5: Real file (if available)
    const testFiles = [
        join(__dirname, '..', 'testdata', 'test.css'),
        join(__dirname, '..', 'testdata', 'test.js'),
    ];
    for (const file of testFiles) {
        if (!existsSync(file)) continue;
        const input = new Uint8Array(readFileSync(file));
        const t1 = performance.now();
        const compressed = compress(input);
        const t2 = performance.now();
        const decompressed = decompress(compressed);
        const t3 = performance.now();
        let pass = input.length === decompressed.length;
        if (pass) {
            for (let i = 0; i < input.length; i++) {
                if (input[i] !== decompressed[i]) { pass = false; break; }
            }
        }
        const ratio = (input.length / compressed.length).toFixed(1);
        const name = file.split('/').pop();
        console.log(`Test (${name}): ${input.length} → ${compressed.length} bytes (${ratio}:1)`);
        console.log(`  Compress: ${(t2-t1).toFixed(0)}ms | Decompress: ${(t3-t2).toFixed(0)}ms`);
        console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}\n`);
        if (!pass) process.exit(1);
    }

    // Verify magic bytes
    {
        const input = new TextEncoder().encode('test magic');
        const compressed = compress(input);
        const magic = String.fromCharCode(...compressed.slice(0, 4));
        const pass = magic === 'GGW1';
        console.log(`Magic check: "${magic}" ${pass ? '✅ GGW1' : '❌ Expected GGW1'}\n`);
        if (!pass) process.exit(1);
    }

    console.log('=== All WASM tests passed! ===');
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
