/**
 * ggFetch — Drop-in fetch replacement that auto-decompresses GGW1 responses.
 *
 * Works on all Expo platforms (Android, iOS, Web).
 *
 * Usage:
 *   import { ggFetch } from 'gg-cache-expo/fetch';
 *   const res = await ggFetch('https://api.example.com/data');
 *   const json = await res.json(); // auto-decompressed if server sent GGW1
 *
 * The server should set `Content-Encoding: ggw1` or `X-Content-Encoding: ggw1`
 * header, OR the response body can just start with the GGW1 magic bytes.
 */

import { decompress, decompressText, isGGCompressed, initDecompressor } from './decompressor.js';

const GG_ENCODINGS = new Set(['ggw1', 'greedyguy', 'gg']);

/**
 * Create a configured ggFetch function.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.autoInit=true]   - Auto-initialize decompressor on first call
 * @param {object}  [opts.initOpts]        - Options to pass to initDecompressor()
 * @param {boolean} [opts.addAcceptHeader=true] - Add Accept-Encoding: ggw1 to requests
 * @param {Function} [opts.onDecompress]   - Callback when decompression occurs (url, originalSize, decompressedSize)
 */
export function createGGFetch(opts = {}) {
  const autoInit = opts.autoInit ?? true;
  const addAcceptHeader = opts.addAcceptHeader ?? true;
  let initialized = false;
  let initFailed = null;

  return async function ggFetch(input, init = {}) {
    // Auto-initialize on first call
    if (autoInit && !initialized) {
      if (initFailed) throw initFailed;
      try {
        await initDecompressor(opts.initOpts || {});
        initialized = true;
      } catch (err) {
        initFailed = new Error(`GG WASM init failed: ${err.message}. ggFetch disabled.`);
        throw initFailed;
      }
    }

    // Add Accept-Encoding header to signal server we support GGW1
    if (addAcceptHeader) {
      const headers = new Headers(init.headers || {});
      const existing = headers.get('Accept-Encoding') || '';
      if (!existing.includes('ggw1')) {
        headers.set('Accept-Encoding', existing ? `${existing}, ggw1` : 'ggw1, gzip, deflate, br');
      }
      init = { ...init, headers };
    }

    const response = await fetch(input, init);

    // Check if response is GG-compressed
    const encoding = (
      response.headers.get('content-encoding') ||
      response.headers.get('x-content-encoding') ||
      ''
    ).toLowerCase().trim();

    const isGGEncoded = GG_ENCODINGS.has(encoding);

    if (!isGGEncoded) {
      // Might still be GGW1 without the header — we'll check the body
      return wrapResponse(response, opts);
    }

    // Definitely GG-compressed — decompress the entire body
    return decompressResponse(response, opts);
  };
}

/**
 * Wrap a response to auto-detect GGW1 on body access.
 * This handles the case where the server doesn't set Content-Encoding
 * but the body starts with GGW1 magic bytes.
 */
function wrapResponse(response, opts) {
  let _originalAB = response.arrayBuffer.bind(response);
  let _cachedBuffer = null;

  async function getBuffer() {
    if (_cachedBuffer) return _cachedBuffer;
    const raw = new Uint8Array(await _originalAB());
    _originalAB = null; // Release reference to allow GC of original Response body

    if (isGGCompressed(raw)) {
      const decompressed = decompress(raw);
      opts?.onDecompress?.(response.url, raw.length, decompressed.length);
      _cachedBuffer = decompressed.buffer;
    } else {
      _cachedBuffer = raw.buffer;
    }
    return _cachedBuffer;
  }

  // Create a new response-like object with overridden body methods
  return new Proxy(response, {
    get(target, prop) {
      switch (prop) {
        case 'arrayBuffer':
          return async () => getBuffer();

        case 'text':
          return async () => {
            const buf = await getBuffer();
            return new TextDecoder().decode(buf);
          };

        case 'json':
          return async () => {
            const buf = await getBuffer();
            const text = new TextDecoder().decode(buf);
            return JSON.parse(text);
          };

        case 'blob':
          return async () => {
            const buf = await getBuffer();
            const contentType = target.headers.get('content-type') || 'application/octet-stream';
            return new Blob([buf], { type: contentType });
          };

        case 'clone':
          return () => wrapResponse(target.clone(), opts);

        case '_ggDecompressed':
          return true;

        default:
          const val = target[prop];
          return typeof val === 'function' ? val.bind(target) : val;
      }
    },
  });
}

/**
 * Decompress a response that is definitely GG-compressed.
 */
async function decompressResponse(response, opts) {
  // Size guard before reading body — hard cap regardless of Content-Length
  const MAX_RESPONSE_BODY = 100 * 1024 * 1024;
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

  // Reconstruct response with decompressed body
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('x-content-encoding');
  headers.set('content-length', String(decompressed.length));
  headers.set('x-gg-original-size', String(compressed.length));
  headers.set('x-gg-ratio', (decompressed.length / compressed.length).toFixed(1));

  return new Response(decompressed.buffer, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Default ggFetch — auto-initializes on first call.
 * Import directly for the simplest usage.
 */
export const ggFetch = createGGFetch();
