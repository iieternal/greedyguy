/**
 * Global fetch interceptor for Expo/React Native.
 *
 * Patches the global `fetch` so ALL network requests automatically
 * decompress GGW1 responses. Call once at app startup.
 *
 * Usage:
 *   // In your App.js or entry point:
 *   import { installGlobalInterceptor } from 'gg-cache-expo';
 *
 *   await installGlobalInterceptor({
 *     wasmUrl: require('./assets/greedyguy.wasm'),
 *     include: [/\/api\//],
 *   });
 *
 *   // Now ALL fetch() calls auto-decompress GGW1 responses:
 *   const res = await fetch('https://api.example.com/data');
 */

import { initDecompressor, decompress, isGGCompressed } from './decompressor.js';

let _originalFetch = null;

/**
 * Install a global fetch interceptor that auto-decompresses GGW1 responses.
 *
 * @param {object} [opts]
 * @param {object}   [opts.initOpts]      - Options for initDecompressor()
 * @param {string}   [opts.wasmUrl]       - Shorthand for initOpts.wasmUrl
 * @param {RegExp[]} [opts.include]       - Only intercept matching URLs
 * @param {RegExp[]} [opts.exclude]       - Skip matching URLs
 * @param {boolean}  [opts.addAcceptHeader=true] - Add Accept-Encoding: ggw1
 * @param {Function} [opts.onDecompress]  - Callback(url, compressedSize, originalSize)
 */
export async function installGlobalInterceptor(opts = {}) {
  if (_originalFetch) {
    throw new Error('GG interceptor already installed. Call removeGlobalInterceptor() first.');
  }

  // Initialize the decompressor
  const initOpts = opts.initOpts || {};
  if (opts.wasmUrl) initOpts.wasmUrl = opts.wasmUrl;
  if (opts.glueUrl) initOpts.glueUrl = opts.glueUrl;
  if (opts.wasmBinary) initOpts.wasmBinary = opts.wasmBinary;
  if (opts.glueModule) initOpts.glueModule = opts.glueModule;
  await initDecompressor(initOpts);

  _originalFetch = globalThis.fetch;
  const addAcceptHeader = opts.addAcceptHeader ?? true;

  globalThis.fetch = async function ggInterceptedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input?.url || String(input);

    // Check include/exclude filters
    if (!shouldIntercept(url, opts)) {
      return _originalFetch(input, init);
    }

    // Add Accept-Encoding header
    if (addAcceptHeader) {
      const headers = new Headers(init.headers || {});
      const existing = headers.get('Accept-Encoding') || '';
      if (!existing.includes('ggw1')) {
        headers.set('Accept-Encoding', existing ? `${existing}, ggw1` : 'ggw1, gzip, deflate, br');
      }
      init = { ...init, headers };
    }

    const response = await _originalFetch(input, init);

    // Check Content-Encoding header
    const encoding = (
      response.headers.get('content-encoding') ||
      response.headers.get('x-content-encoding') ||
      ''
    ).toLowerCase().trim();

    if (['ggw1', 'greedyguy', 'gg'].includes(encoding)) {
      return decompressFullResponse(response, opts);
    }

    // For other responses, wrap to auto-detect GGW1 body
    return wrapForAutoDetect(response, opts);
  };
}

/**
 * Remove the global interceptor and restore original fetch.
 */
export function removeGlobalInterceptor() {
  if (_originalFetch) {
    globalThis.fetch = _originalFetch;
    _originalFetch = null;
  }
}

async function decompressFullResponse(response, opts) {
  // Size guard before reading body — enforce hard cap regardless of Content-Length
  const MAX_RESPONSE_BODY = 100 * 1024 * 1024; // 100MB absolute max
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const cl = parseInt(contentLength, 10);
    if (cl > MAX_RESPONSE_BODY) {
      throw new Error(`GGW1 response too large (${cl} bytes, max ${MAX_RESPONSE_BODY})`);
    }
  }

  const compressed = new Uint8Array(await response.arrayBuffer());
  if (compressed.length > MAX_RESPONSE_BODY) {
    throw new Error(`GGW1 response body ${compressed.length} bytes exceeds ${MAX_RESPONSE_BODY} byte limit`);
  }
  const decompressed = decompress(compressed);

  opts?.onDecompress?.(response.url, compressed.length, decompressed.length);

  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('x-content-encoding');
  headers.set('content-length', String(decompressed.length));
  headers.set('x-gg-decompressed', 'true');
  headers.set('x-gg-ratio', (decompressed.length / compressed.length).toFixed(1));

  return new Response(decompressed.buffer, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function wrapForAutoDetect(response, opts) {
  let _origAB = response.arrayBuffer.bind(response);
  let _buf = null;

  async function getBuf() {
    if (_buf) return _buf;
    const raw = new Uint8Array(await _origAB());
    _origAB = null; // Release reference to allow GC of original Response body
    if (isGGCompressed(raw)) {
      const dec = decompress(raw);
      opts?.onDecompress?.(response.url, raw.length, dec.length);
      _buf = dec.buffer;
    } else {
      _buf = raw.buffer;
    }
    return _buf;
  }

  return new Proxy(response, {
    get(target, prop) {
      if (prop === 'arrayBuffer') return () => getBuf();
      if (prop === 'text') return async () => new TextDecoder().decode(await getBuf());
      if (prop === 'json') return async () => JSON.parse(new TextDecoder().decode(await getBuf()));
      if (prop === 'blob') return async () => {
        const ct = target.headers.get('content-type') || 'application/octet-stream';
        return new Blob([await getBuf()], { type: ct });
      };
      if (prop === 'clone') return () => wrapForAutoDetect(target.clone(), opts);
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

function shouldIntercept(url, opts) {
  if (opts.exclude) {
    for (const re of opts.exclude) if (re.test(url)) return false;
  }
  if (opts.include) {
    for (const re of opts.include) if (re.test(url)) return true;
    return false;
  }
  return true;
}
