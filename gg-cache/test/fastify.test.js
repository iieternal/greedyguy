/**
 * Fastify plugin tests — verifies cache integration, hooks, and decorators.
 * Uses a mock Fastify instance (no actual HTTP server needed).
 */

import { GGCache, NoopCompressor } from '../src/index.js';

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try { await fn(); }
  catch (err) { failed++; console.error(`  ✗ THREW: ${err.message}\n${err.stack}`); }
}

// --- Mock Fastify ---
function createMockFastify() {
  const hooks = { onRequest: [], onSend: [] };
  const decorators = {};
  const routes = {};

  return {
    addHook(name, fn) { hooks[name] = hooks[name] || []; hooks[name].push(fn); },
    decorate(name, val) { decorators[name] = val; },
    get(path, handler) { routes[path] = handler; },
    _hooks: hooks,
    _decorators: decorators,
    _routes: routes,

    // Simulate a request through the hooks
    async simulate(method, url, body, statusCode = 200) {
      const request = { method, url };
      const headers = {};
      let sentBody = null;

      const reply = {
        statusCode,
        header(k, v) { headers[k] = v; return reply; },
        getHeader(k) { return headers[k]; },
        send(data) { sentBody = data; return reply; },
      };

      // Run onRequest hooks
      let served = false;
      for (const hook of hooks.onRequest || []) {
        await hook(request, reply);
        if (sentBody !== null) { served = true; break; }
      }

      if (!served && body !== undefined) {
        // Simulate handler setting content-type and calling send
        reply.header('content-type', 'application/json');
        const payload = typeof body === 'string' ? body : JSON.stringify(body);

        // Run onSend hooks
        let finalPayload = payload;
        for (const hook of hooks.onSend || []) {
          const result = await hook(request, reply, finalPayload);
          if (result !== undefined) finalPayload = result;
        }
        sentBody = finalPayload;
      }

      return { headers, body: sentBody, served };
    },
  };
}

// --- Import the plugin ---
const { ggCachePlugin } = await import('../src/middleware/fastify.js');

// --- Tests ---

await test('Fastify plugin: registers hooks and decorators', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), sweepInterval: 0 });
  await cache.init();

  const fastify = createMockFastify();
  await ggCachePlugin(fastify, { cache });

  assert(fastify._hooks.onRequest.length === 1, 'onRequest hook registered');
  assert(fastify._hooks.onSend.length === 1, 'onSend hook registered');
  assert(fastify._decorators.ggCache === cache, 'ggCache decorator set');
  assert(typeof fastify._decorators.ggCacheInvalidate === 'function', 'ggCacheInvalidate decorator');
  assert(typeof fastify._decorators.ggCacheInvalidatePrefix === 'function', 'ggCacheInvalidatePrefix decorator');

  await cache.destroy();
});

await test('Fastify plugin: requires cache option', async () => {
  const fastify = createMockFastify();
  let threw = false;
  try {
    await ggCachePlugin(fastify, {});
  } catch (e) {
    threw = true;
    assert(e.message.includes('cache'), `error mentions cache: "${e.message}"`);
  }
  assert(threw, 'threw without cache option');
});

await test('Fastify plugin: caches GET responses', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), sweepInterval: 0 });
  await cache.init();

  const fastify = createMockFastify();
  await ggCachePlugin(fastify, { cache });

  // First request — MISS, body gets cached
  const r1 = await fastify.simulate('GET', '/api/users', { users: ['Alice', 'Bob'] });
  assert(r1.headers['X-GG-Cache'] === 'MISS', 'first request is MISS');

  // Wait for async cache.set to complete
  await new Promise(r => setTimeout(r, 20));

  // Second request — HIT
  const r2 = await fastify.simulate('GET', '/api/users');
  assert(r2.headers['X-GG-Cache'] === 'HIT', 'second request is HIT');
  assert(r2.served, 'served from cache');

  await cache.destroy();
});

await test('Fastify plugin: skips non-GET methods', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), sweepInterval: 0 });
  await cache.init();

  const fastify = createMockFastify();
  await ggCachePlugin(fastify, { cache });

  const r = await fastify.simulate('POST', '/api/users', { name: 'Charlie' });
  assert(r.headers['X-GG-Cache'] === undefined, 'POST not cached');

  assert(!(await cache.has('POST:/api/users')), 'POST key not in cache');

  await cache.destroy();
});

await test('Fastify plugin: invalidate key', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), sweepInterval: 0 });
  await cache.init();

  const fastify = createMockFastify();
  await ggCachePlugin(fastify, { cache });

  await cache.set('GET:/api/users', 'test');
  assert(await cache.has('GET:/api/users'), 'key exists');

  await fastify._decorators.ggCacheInvalidate('GET:/api/users');
  assert(!(await cache.has('GET:/api/users')), 'key invalidated');

  await cache.destroy();
});

await test('Fastify plugin: invalidate prefix', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), sweepInterval: 0 });
  await cache.init();

  const fastify = createMockFastify();
  await ggCachePlugin(fastify, { cache });

  await cache.set('GET:/api/users/1', 'u1');
  await cache.set('GET:/api/users/2', 'u2');
  await cache.set('GET:/api/posts', 'posts');

  const removed = await fastify._decorators.ggCacheInvalidatePrefix('/api/users');
  assert(removed === 2, `removed ${removed} keys with prefix`);
  assert(await cache.has('GET:/api/posts'), 'unrelated key preserved');

  await cache.destroy();
});

await test('Fastify plugin: stats route', async () => {
  const cache = new GGCache({ compressor: new NoopCompressor(), sweepInterval: 0 });
  await cache.init();

  const fastify = createMockFastify();
  await ggCachePlugin(fastify, { cache, statsRoute: '/_gg/stats' });

  assert(typeof fastify._routes['/_gg/stats'] === 'function', 'stats route registered');

  const stats = await fastify._routes['/_gg/stats']();
  assert(typeof stats.hits === 'number', 'stats has hits');
  assert(typeof stats.hitRate === 'number', 'stats has hitRate');

  await cache.destroy();
});

// --- Expo decompressor unit tests ---

console.log('\n' + '═'.repeat(40));
console.log('Expo decompressor module tests');
console.log('═'.repeat(40));

const {
  isGGCompressed,
  isWasmSupported,
  getStatus,
  resetDecompressor,
} = await import('../../gg-cache-expo/src/decompressor.js');

await test('isGGCompressed: detects GGW1 magic', async () => {
  const ggw1 = new Uint8Array([0x47, 0x47, 0x57, 0x31, 0x00, 0x00, 0x00, 0x10]);
  assert(isGGCompressed(ggw1), 'detects valid GGW1');
  assert(!isGGCompressed(new Uint8Array([0x00, 0x01, 0x02, 0x03])), 'rejects non-GGW1');
  assert(!isGGCompressed(new Uint8Array([0x47, 0x47])), 'rejects too short');
  assert(!isGGCompressed(null), 'rejects null');
  assert(!isGGCompressed(new Uint8Array(0)), 'rejects empty');
});

await test('isWasmSupported: returns boolean', async () => {
  const supported = isWasmSupported();
  assert(typeof supported === 'boolean', `isWasmSupported=${supported}`);
  assert(supported === true, 'Node.js supports WASM');
});

await test('getStatus: returns platform info', async () => {
  resetDecompressor();
  const status = getStatus();
  assert(status.initialized === false, 'not initialized after reset');
  assert(status.wasmSupported === true, 'wasm supported');
  assert(status.platform === 'node', `platform=${status.platform}`);
});

// --- Summary ---
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
