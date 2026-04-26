/**
 * GG-Cache integration tests.
 *
 * Tests core cache behavior using NoopCompressor (no WASM dependency)
 * so they run anywhere without the WASM binary.
 */

import { GGCache, NoopCompressor, MemoryStore } from '../src/index.js';

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try { await fn(); }
  catch (err) { failed++; console.error(`  ✗ THREW: ${err.message}`); }
}

// ─── MemoryStore tests ───────────────────────────────────────────

await test('MemoryStore: basic CRUD', async () => {
  const store = new MemoryStore({ maxSize: 10000 });

  await store.set('a', { data: new Uint8Array([1, 2, 3]), size: 3, expiresAt: null, meta: {} });
  assert(await store.has('a'), 'has returns true for existing key');

  const entry = await store.get('a');
  assert(entry !== null, 'get returns entry');
  assert(entry.data.length === 3, 'data preserved');
  assert(entry.data[0] === 1 && entry.data[2] === 3, 'data bytes match');

  await store.delete('a');
  assert(!(await store.has('a')), 'deleted key is gone');
});

await test('MemoryStore: TTL expiry', async () => {
  const store = new MemoryStore();

  // Set entry that expires in 50ms
  await store.set('exp', {
    data: new Uint8Array([99]),
    size: 1,
    expiresAt: Date.now() + 50,
    meta: {},
  });

  assert(await store.has('exp'), 'entry exists before expiry');

  await new Promise(r => setTimeout(r, 80));

  assert(!(await store.has('exp')), 'entry expired after TTL');
  const val = await store.get('exp');
  assert(val === null, 'get returns null for expired entry');
});

await test('MemoryStore: LRU eviction', async () => {
  const store = new MemoryStore({ maxSize: 10 });

  await store.set('x', { data: new Uint8Array(5), size: 5, expiresAt: null, meta: {} });
  await store.set('y', { data: new Uint8Array(5), size: 5, expiresAt: null, meta: {} });

  // At capacity (10). Adding z (5 bytes) should evict x (oldest).
  await store.set('z', { data: new Uint8Array(5), size: 5, expiresAt: null, meta: {} });

  assert(!(await store.has('x')), 'oldest entry evicted');
  assert(await store.has('y'), 'newer entry preserved');
  assert(await store.has('z'), 'newest entry exists');
});

await test('MemoryStore: LRU refresh on access', async () => {
  const store = new MemoryStore({ maxSize: 10 });

  await store.set('a', { data: new Uint8Array(4), size: 4, expiresAt: null, meta: {} });
  await store.set('b', { data: new Uint8Array(4), size: 4, expiresAt: null, meta: {} });

  // Access 'a' to refresh its LRU position
  await store.get('a');

  // Adding 'c' should evict 'b' (now oldest), not 'a'
  await store.set('c', { data: new Uint8Array(4), size: 4, expiresAt: null, meta: {} });

  assert(await store.has('a'), 'accessed entry preserved');
  assert(!(await store.has('b')), 'unaccessed entry evicted');
});

await test('MemoryStore: sweep', async () => {
  const store = new MemoryStore();

  await store.set('live', { data: new Uint8Array(1), size: 1, expiresAt: Date.now() + 60000, meta: {} });
  await store.set('dead', { data: new Uint8Array(1), size: 1, expiresAt: Date.now() - 1, meta: {} });

  const swept = await store.sweep();
  assert(swept === 1, `swept ${swept} expired entries`);
  assert(await store.has('live'), 'live entry preserved');
  assert(!(await store.has('dead')), 'dead entry removed');
});

await test('MemoryStore: stats', async () => {
  const store = new MemoryStore({ maxSize: 1000 });

  await store.set('s1', { data: new Uint8Array(100), size: 100, expiresAt: null, meta: {} });
  await store.set('s2', { data: new Uint8Array(200), size: 200, expiresAt: null, meta: {} });

  const st = store.stats();
  assert(st.entries === 2, `entries=${st.entries}`);
  assert(st.bytes === 300, `bytes=${st.bytes}`);
  assert(st.maxSize === 1000, `maxSize=${st.maxSize}`);
  assert(Math.abs(st.utilization - 0.3) < 0.01, `utilization=${st.utilization}`);
});

// ─── GGCache tests (with NoopCompressor) ─────────────────────────

await test('GGCache: basic set/get', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), ttl: 60 });
  await cache.init();

  await cache.set('test', 'hello world', { contentType: 'text/plain' });
  const result = await cache.getText('test');

  assert(result !== null, 'got result');
  assert(result.data === 'hello world', `data="${result.data}"`);
  assert(result.meta.contentType === 'text/plain', `contentType=${result.meta.contentType}`);
});

await test('GGCache: binary data', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor() });
  await cache.init();

  const data = new Uint8Array([0, 1, 2, 255, 254, 253]);
  await cache.set('bin', data, { contentType: 'application/octet-stream' });

  const result = await cache.get('bin');
  assert(result !== null, 'got binary result');
  assert(result.data.length === 6, `length=${result.data.length}`);
  assert(result.data[3] === 255, 'binary preserved');
});

await test('GGCache: TTL expiry', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), ttl: 0.05, sweepInterval: 0 });
  await cache.init();

  await cache.set('expires', 'temp');
  assert(await cache.has('expires'), 'exists before TTL');

  await new Promise(r => setTimeout(r, 80));
  const result = await cache.get('expires');
  assert(result === null, 'expired after TTL');
});

await test('GGCache: cache miss', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), sweepInterval: 0 });
  await cache.init();

  const result = await cache.get('nonexistent');
  assert(result === null, 'miss returns null');
});

await test('GGCache: stats tracking', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), sweepInterval: 0 });
  await cache.init();

  await cache.set('s1', 'value1');
  await cache.get('s1');  // hit
  await cache.get('s2');  // miss

  const st = cache.stats();
  assert(st.sets === 1, `sets=${st.sets}`);
  assert(st.hits === 1, `hits=${st.hits}`);
  assert(st.misses === 1, `misses=${st.misses}`);
  assert(st.hitRate === 0.5, `hitRate=${st.hitRate}`);
});

await test('GGCache: keys/delete/clear', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), sweepInterval: 0 });
  await cache.init();

  await cache.set('a', 'A');
  await cache.set('b', 'B');
  await cache.set('c', 'C');

  let keys = await cache.keys();
  assert(keys.length === 3, `3 keys: ${keys}`);

  await cache.delete('b');
  keys = await cache.keys();
  assert(keys.length === 2, '2 keys after delete');
  assert(!keys.includes('b'), 'b removed');

  await cache.clear();
  keys = await cache.keys();
  assert(keys.length === 0, 'cleared');
});

await test('GGCache: destroy stops sweep timer', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), sweepInterval: 100 });
  await cache.init();

  await cache.set('x', 'y');
  await cache.destroy();

  const keys = await cache.keys();
  assert(keys.length === 0, 'cleared on destroy');
});

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
