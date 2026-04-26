/**
 * Request compression tests — validates the guard rails and logic.
 */

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

// --- Test createCompressingFetch guard rails ---

const { createCompressingFetch } = await import('../src/requestCompressor.js');

await test('createCompressingFetch: requires endpoints', async () => {
  let threw = false;
  try {
    createCompressingFetch();
  } catch (e) {
    threw = true;
    assert(e.message.includes('endpoints'), `error mentions endpoints: "${e.message}"`);
  }
  assert(threw, 'throws without endpoints');
});

await test('createCompressingFetch: requires non-empty endpoints', async () => {
  let threw = false;
  try {
    createCompressingFetch({ endpoints: [] });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'throws with empty endpoints array');
});

await test('createCompressingFetch: returns a function', async () => {
  const cfetch = createCompressingFetch({ endpoints: [/\/api\//] });
  assert(typeof cfetch === 'function', 'returns function');
});

// --- Test Fastify request decompressor module loading ---

await test('Fastify request decompressor: exports correctly', async () => {
  const mod = await import('../../gg-cache/src/middleware/fastify-request.js');
  assert(typeof mod.ggRequestDecompressor === 'function', 'ggRequestDecompressor is a function');
  assert(typeof mod.default === 'function', 'default export exists');
});

// --- Test Express request middleware module loading ---

await test('Express request middleware: exports correctly', async () => {
  const mod = await import('../../gg-cache/src/middleware/express-request.js');
  assert(typeof mod.ggRequestMiddleware === 'function', 'ggRequestMiddleware is a function');
});

await test('Express request middleware: returns middleware function', async () => {
  const { ggRequestMiddleware } = await import('../../gg-cache/src/middleware/express-request.js');
  const mw = ggRequestMiddleware({ routes: ['/api/'] });
  assert(typeof mw === 'function', 'returns function');
});

await test('Express request middleware: skips non-ggw1 requests', async () => {
  const { ggRequestMiddleware } = await import('../../gg-cache/src/middleware/express-request.js');
  const mw = ggRequestMiddleware({ routes: ['/api/'] });

  let nextCalled = false;
  const req = { headers: { 'content-encoding': 'gzip' } };
  const res = {};

  await mw(req, res, () => { nextCalled = true; });
  assert(nextCalled, 'calls next() for non-ggw1 encoding');
});

await test('Express request middleware: skips no encoding', async () => {
  const { ggRequestMiddleware } = await import('../../gg-cache/src/middleware/express-request.js');
  const mw = ggRequestMiddleware();

  let nextCalled = false;
  const req = { headers: {} };
  const res = {};

  await mw(req, res, () => { nextCalled = true; });
  assert(nextCalled, 'calls next() for no encoding');
});

// --- Security tests for Express middleware ---

await test('Express request middleware: rejects non-allowed routes', async () => {
  const { ggRequestMiddleware } = await import('../../gg-cache/src/middleware/express-request.js');
  const mw = ggRequestMiddleware({ routes: ['/api/bulk/'] });

  let statusCode = 0;
  let responseBody = null;
  const req = {
    headers: { 'content-encoding': 'ggw1' },
    url: '/api/users',
  };
  const res = {
    status(code) { statusCode = code; return res; },
    json(body) { responseBody = body; return res; },
  };

  await mw(req, res, () => {});
  assert(statusCode === 415, `rejects with 415, got ${statusCode}`);
  assert(responseBody?.error?.includes('not accepted'), 'error message explains');
});

// --- Summary ---
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
