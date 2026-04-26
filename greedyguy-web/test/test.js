/**
 * greedyguy-web — Node.js test suite
 *
 * Tests the ESM source module (src/index.js).
 * Run: node test/test.js
 */

import assert from 'node:assert';
import {
  init, compress, decompress,
  compressText, decompressText,
  compressToBase64, decompressFromBase64, decompressBase64Text,
  isCompressed, isSupported, status, destroy,
} from '../src/index.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

// --- Pre-init tests ---
console.log('Pre-init:');

test('isSupported returns true', () => {
  assert.strictEqual(isSupported(), true);
});

test('isCompressed rejects short data', () => {
  assert.strictEqual(isCompressed(new Uint8Array([1, 2])), false);
});

test('isCompressed rejects non-GGW1', () => {
  assert.strictEqual(isCompressed(new Uint8Array([0, 0, 0, 0, 0])), false);
});

test('isCompressed accepts GGW1 magic', () => {
  assert.strictEqual(isCompressed(new Uint8Array([0x47, 0x47, 0x57, 0x31, 0])), true);
});

test('status shows not initialized', () => {
  const s = status();
  assert.strictEqual(s.initialized, false);
  assert.strictEqual(s.supported, true);
});

test('compress throws before init', () => {
  assert.throws(() => compress(new Uint8Array([1])), /not initialized/i);
});

// --- Init ---
console.log('\nInit:');

await testAsync('init() succeeds', async () => {
  await init();
  const s = status();
  assert.strictEqual(s.initialized, true);
});

await testAsync('init() is idempotent', async () => {
  await init();
  assert.strictEqual(status().initialized, true);
});

// --- Compress/Decompress ---
console.log('\nCompress/Decompress:');

test('compress returns Uint8Array with GGW1 header', () => {
  const input = new TextEncoder().encode('Hello, World!');
  const result = compress(input);
  assert(result instanceof Uint8Array);
  assert(result.length > 0);
  assert(isCompressed(result));
});

test('compress + decompress roundtrip', () => {
  const text = 'GreedyGuy uses context mixing with arithmetic coding.';
  const input = new TextEncoder().encode(text);
  const compressed = compress(input);
  const decompressed = decompress(compressed);
  assert.deepStrictEqual(decompressed, input);
});

test('compressText + decompressText roundtrip', () => {
  const text = '<html><body><h1>Test</h1><p>Content here</p></body></html>';
  const compressed = compressText(text);
  const restored = decompressText(compressed);
  assert.strictEqual(restored, text);
});

test('compressToBase64 + decompressBase64Text', () => {
  const text = '{"users":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]}';
  const b64 = compressToBase64(text);
  assert.strictEqual(typeof b64, 'string');
  assert(b64.length > 0);
  const restored = decompressBase64Text(b64);
  assert.strictEqual(restored, text);
});

test('decompressFromBase64 returns Uint8Array', () => {
  const input = new Uint8Array([65, 66, 67, 68, 69]);
  const compressed = compress(input);
  const b64 = btoa(String.fromCharCode(...compressed));
  const result = decompressFromBase64(b64);
  assert(result instanceof Uint8Array);
  assert.deepStrictEqual(result, input);
});

test('larger data roundtrip', () => {
  const text = 'function fibonacci(n) { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }\n'.repeat(100);
  const compressed = compressText(text);
  const restored = decompressText(compressed);
  assert.strictEqual(restored, text);
  assert(compressed.length < new TextEncoder().encode(text).length, 'should be smaller');
});

// --- Error cases ---
console.log('\nError handling:');

test('compress rejects non-Uint8Array', () => {
  assert.throws(() => compress('string'), /Uint8Array/);
});

test('compress handles empty input', () => {
  const result = compress(new Uint8Array(0));
  assert.strictEqual(result.length, 0);
});

test('decompress handles empty input', () => {
  const result = decompress(new Uint8Array(0));
  assert.strictEqual(result.length, 0);
});

test('decompress rejects non-GGW1 data', () => {
  assert.throws(() => decompress(new Uint8Array([1, 2, 3, 4, 5])), /GGW1/);
});

// --- Destroy ---
console.log('\nDestroy:');

test('destroy unloads module', () => {
  destroy();
  assert.strictEqual(status().initialized, false);
});

test('compress throws after destroy', () => {
  assert.throws(() => compress(new Uint8Array([1])), /not initialized/i);
});

await testAsync('re-init works after destroy', async () => {
  await init();
  assert.strictEqual(status().initialized, true);
  const result = compressText('re-init test');
  assert(isCompressed(result));
  destroy();
});

// --- Summary ---
console.log(`\n${'─'.repeat(40)}`);
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
