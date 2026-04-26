/**
 * greedyguy — Node.js integration tests
 *
 * Usage: node lib/test.js
 *
 * On platforms without the binary (e.g. Windows) the tests that need the
 * binary are gracefully skipped.
 */

'use strict';

const gg = require('./index');
const assert = require('assert');

let passed = 0;
let skipped = 0;
let failed = 0;

function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function skip(name, reason) { skipped++; console.log(`  ⊘ ${name} (skipped: ${reason})`); }
function fail(name, err) { failed++; console.error(`  ✗ ${name}: ${err}`); }

/** Check whether the binary is reachable AND executable on this platform. */
function hasBinary() {
    try {
        const bin = gg.findBinary();
        // Actually try to run it — the file may exist but be a foreign ELF on Windows
        require('child_process').execFileSync(bin, [], { timeout: 3000, stdio: 'ignore' });
        return true;
    } catch (e) {
        // Exit code != 0 is fine (usage error), ENOENT / EACCES means not runnable
        if (e.status != null) return true;   // process ran but returned non-zero
        return false;
    }
}

async function main() {
    console.log('=== GreedyGuy Node.js Tests ===\n');

    /* ── Sync tests (no binary needed) ──────────────────────────────── */

    console.log('Sync:');

    // version()
    try {
        const v = gg.version();
        assert.strictEqual(typeof v, 'string');
        assert(/^\d+\.\d+\.\d+$/.test(v), `version "${v}" should be semver-ish`);
        ok(`version() → "${v}"`);
    } catch (e) { fail('version()', e.message); }

    // isGGCompressed — positive
    try {
        const magic = Buffer.from('GG01somedata');
        assert.strictEqual(gg.isGGCompressed(magic), true);
        ok('isGGCompressed(GG01…) → true');
    } catch (e) { fail('isGGCompressed positive', e.message); }

    // isGGCompressed — negative
    try {
        assert.strictEqual(gg.isGGCompressed(Buffer.from('nope')), false);
        assert.strictEqual(gg.isGGCompressed(Buffer.alloc(2)), false);
        assert.strictEqual(gg.isGGCompressed(null), false);
        ok('isGGCompressed(other) → false');
    } catch (e) { fail('isGGCompressed negative', e.message); }

    // Type checking
    try {
        await gg.compress(12345);
        fail('rejects invalid input', 'should have thrown');
    } catch (e) {
        if (e instanceof TypeError) ok('compress rejects non-buffer');
        else fail('compress rejects non-buffer', e.message);
    }

    /* ── Async tests (binary required) ──────────────────────────────── */

    console.log('\nAsync (binary required):');

    if (!hasBinary()) {
        const names = [
            'string roundtrip',
            'buffer roundtrip',
            'HTML roundtrip',
            'empty roundtrip',
            'corrupt data rejected'
        ];
        names.forEach((n) => skip(n, 'binary not found'));
    } else {
        // String roundtrip
        try {
            const text = 'Hello, GreedyGuy! This is a test of the byte-prediction compressor.';
            const compressed = await gg.compress(text);
            assert(compressed.length > 0);
            assert(gg.isGGCompressed(compressed), 'output should have GG01 magic');
            const out = await gg.decompress(compressed);
            assert.strictEqual(out.toString('utf8'), text);
            ok(`string roundtrip (${text.length} → ${compressed.length} bytes)`);
        } catch (e) { fail('string roundtrip', e.message); }

        // Buffer roundtrip
        try {
            const buf = Buffer.alloc(10000);
            for (let i = 0; i < buf.length; i++) buf[i] = i & 0xFF;
            const comp = await gg.compress(buf);
            const dec  = await gg.decompress(comp);
            assert(buf.equals(dec), 'Buffer roundtrip mismatch');
            ok(`buffer roundtrip (${buf.length} → ${comp.length} bytes)`);
        } catch (e) { fail('buffer roundtrip', e.message); }

        // HTML roundtrip
        try {
            const html = '<html><head><title>Test</title></head><body>' +
                '<div class="container"><h1>Hello</h1>'.repeat(100) +
                '</div></body></html>';
            const comp = await gg.compress(html);
            const dec  = await gg.decompress(comp);
            assert.strictEqual(dec.toString('utf8'), html);
            const ratio = html.length / comp.length;
            ok(`HTML roundtrip (${html.length} → ${comp.length} bytes, ${ratio.toFixed(1)}:1)`);
        } catch (e) { fail('HTML roundtrip', e.message); }

        // Empty roundtrip
        try {
            const comp  = await gg.compress(Buffer.alloc(0));
            const dec   = await gg.decompress(comp);
            assert.strictEqual(dec.length, 0);
            ok('empty roundtrip');
        } catch (e) { fail('empty roundtrip', e.message); }

        // Corrupt data
        try {
            await gg.decompress(Buffer.from('this is not compressed data'));
            fail('corrupt data rejected', 'should have thrown');
        } catch (e) {
            ok('corrupt data rejected');
        }
    }

    /* ── Summary ────────────────────────────────────────────────────── */

    console.log(`\n=== ${passed} passed, ${skipped} skipped, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('TEST FAILED:', err);
    process.exit(1);
});
