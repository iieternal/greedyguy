/**
 * greedyguy-wasm — basic test suite
 *
 * Run: node test/wasm.test.js
 */

import assert from 'node:assert/strict';
import {
  init,
  compress,
  decompress,
  decompressText,
  isGGCompressed,
  isWasmSupported,
  getStatus,
  reset,
} from '../src/index.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('greedyguy-wasm tests\n');

// --- Utility tests (no init needed) ---

console.log('Utility functions:');

await test('isWasmSupported() returns true', () => {
  assert.equal(isWasmSupported(), true);
});

await test('isGGCompressed() with valid GGW1 header', () => {
  const data = new Uint8Array([0x47, 0x47, 0x57, 0x31, 0x00, 0x01]);
  assert.equal(isGGCompressed(data), true);
});

await test('isGGCompressed() with invalid data', () => {
  assert.equal(isGGCompressed(new Uint8Array([0x00, 0x01, 0x02, 0x03])), false);
  assert.equal(isGGCompressed(new Uint8Array([0x47, 0x47])), false);
  assert.equal(isGGCompressed(new Uint8Array([])), false);
  assert.equal(isGGCompressed(null), false);
});

await test('getStatus() before init', () => {
  const status = getStatus();
  assert.equal(status.initialized, false);
  assert.equal(status.loading, false);
});

// --- Error handling before init ---

console.log('\nPre-init error handling:');

await test('compress() throws before init', () => {
  assert.throws(() => compress(new Uint8Array([1, 2, 3])), {
    message: /not initialized/i,
  });
});

await test('decompress() throws before init', () => {
  assert.throws(() => decompress(new Uint8Array([0x47, 0x47, 0x57, 0x31])), {
    message: /not initialized/i,
  });
});

// --- Init + roundtrip tests ---

console.log('\nInit & roundtrip:');

await test('init() succeeds', async () => {
  await init();
  const status = getStatus();
  assert.equal(status.initialized, true);
  assert.equal(status.loading, false);
});

await test('init() is idempotent', async () => {
  await init(); // should not throw
  assert.equal(getStatus().initialized, true);
});

await test('compress() + decompress() roundtrip', async () => {
  const input = new TextEncoder().encode('Hello, GreedyGuy WASM!');
  const compressed = compress(input);

  assert.ok(compressed.length > 0, 'compressed output should not be empty');
  assert.ok(isGGCompressed(compressed), 'output should have GGW1 header');

  const decompressed = decompress(compressed);
  assert.deepEqual(decompressed, input);
});

await test('compress() + decompressText() roundtrip', async () => {
  const text = 'The quick brown fox jumps over the lazy dog. 🦊';
  const input = new TextEncoder().encode(text);
  const compressed = compress(input);
  const result = decompressText(compressed);
  assert.equal(result, text);
});

await test('compress() + decompress() with larger data', async () => {
  const size = 10_000;
  const input = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    input[i] = i & 0xff;
  }
  const compressed = compress(input);
  const decompressed = decompress(compressed);
  assert.deepEqual(decompressed, input);
});

// --- Error handling after init ---

console.log('\nPost-init error handling:');

await test('compress() rejects empty input', () => {
  assert.throws(() => compress(new Uint8Array([])), {
    message: /empty/i,
  });
});

await test('compress() rejects non-Uint8Array', () => {
  assert.throws(() => compress('not bytes'), {
    message: /Uint8Array/i,
  });
});

await test('decompress() rejects garbage data', () => {
  assert.throws(
    () => decompress(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])),
    { message: /GGW1 header/i },
  );
});

await test('decompress() rejects empty input', () => {
  assert.throws(() => decompress(new Uint8Array([])), {
    message: /empty/i,
  });
});

// --- Reset ---

console.log('\nReset:');

await test('reset() unloads module', () => {
  reset();
  const status = getStatus();
  assert.equal(status.initialized, false);
  assert.equal(status.loading, false);
});

await test('compress() throws after reset', () => {
  assert.throws(() => compress(new Uint8Array([1, 2, 3])), {
    message: /not initialized/i,
  });
});

// --- Summary ---

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
