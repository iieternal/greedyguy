/**
 * GGProvider — React context provider for GreedyGuy decompression.
 *
 * Initializes the WASM decompressor and provides it to the component tree.
 * Works with Expo on Android, iOS, and Web.
 *
 * Usage:
 *   import { GGProvider } from 'gg-cache-expo/provider';
 *
 *   export default function App() {
 *     return (
 *       <GGProvider wasmUrl="/assets/greedyguy.wasm" glueUrl="/assets/greedyguy.js">
 *         <YourApp />
 *       </GGProvider>
 *     );
 *   }
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { initDecompressor, decompress, decompressText, isGGCompressed, getStatus } from './decompressor.js';
import { createGGFetch } from './ggFetch.js';

const GGContext = createContext(null);

/**
 * Provider component that initializes the GG decompressor.
 *
 * @param {object} props
 * @param {string}     [props.wasmUrl]     - URL to greedyguy.wasm
 * @param {string}     [props.glueUrl]     - URL to greedyguy.js
 * @param {ArrayBuffer} [props.wasmBinary] - Pre-loaded WASM binary
 * @param {Function}   [props.glueModule]  - Pre-imported Emscripten factory
 * @param {Function}   [props.onReady]     - Called when decompressor is ready
 * @param {Function}   [props.onError]     - Called on initialization error
 * @param {React.ReactNode} [props.fallback] - Shown while loading WASM
 * @param {React.ReactNode} props.children
 */
export function GGProvider({
  wasmUrl,
  glueUrl,
  wasmBinary,
  glueModule,
  onReady,
  onError,
  fallback = null,
  children,
}) {
  const [state, setState] = useState({ ready: false, error: null, loading: true });
  const fetchRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    initDecompressor({ wasmUrl, glueUrl, wasmBinary, glueModule })
      .then(() => {
        if (cancelled) return;
        fetchRef.current = createGGFetch({ autoInit: false });
        setState({ ready: true, error: null, loading: false });
        onReady?.();
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ ready: false, error: err, loading: false });
        onError?.(err);
      });

    return () => { cancelled = true; };
  }, [wasmUrl, glueUrl, wasmBinary, glueModule]);

  const value = {
    ready: state.ready,
    loading: state.loading,
    error: state.error,
    decompress,
    decompressText,
    isGGCompressed,
    getStatus,
    ggFetch: (...args) => {
      if (!fetchRef.current) throw new Error('GG not initialized yet');
      return fetchRef.current(...args);
    },
  };

  if (state.loading && fallback) return fallback;

  return React.createElement(GGContext.Provider, { value }, children);
}

/**
 * Hook to access the GG decompressor from any component.
 *
 * @returns {{ ready, loading, error, decompress, decompressText, isGGCompressed, ggFetch, getStatus }}
 */
export function useGG() {
  const ctx = useContext(GGContext);
  if (!ctx) {
    throw new Error('useGG must be used within a <GGProvider>');
  }
  return ctx;
}

/**
 * Hook for fetching data with automatic GG decompression.
 *
 * @param {string} url - URL to fetch
 * @param {object} [opts]
 * @param {object}  [opts.fetchOpts]  - Options for fetch()
 * @param {boolean} [opts.json=false] - Parse response as JSON
 * @param {boolean} [opts.text=false] - Parse response as text
 * @param {boolean} [opts.auto=true]  - Fetch immediately
 */
export function useGGFetch(url, opts = {}) {
  const { ggFetch, ready } = useGG();
  const [state, setState] = useState({
    data: null,
    loading: opts.auto !== false,
    error: null,
    compressed: false,
    ratio: null,
  });

  const execute = useCallback(async (overrideUrl) => {
    const target = overrideUrl || url;
    setState(s => ({ ...s, loading: true, error: null }));

    try {
      const res = await ggFetch(target, opts.fetchOpts);

      let data;
      if (opts.json) {
        data = await res.json();
      } else if (opts.text) {
        data = await res.text();
      } else {
        data = await res.arrayBuffer();
      }

      const ggRatio = res.headers?.get?.('x-gg-ratio');
      setState({
        data,
        loading: false,
        error: null,
        compressed: !!ggRatio || !!res._ggDecompressed,
        ratio: ggRatio ? parseFloat(ggRatio) : null,
      });
      return data;
    } catch (err) {
      setState(s => ({ ...s, loading: false, error: err }));
      throw err;
    }
  }, [url, ready, opts]);

  useEffect(() => {
    if (ready && opts.auto !== false) {
      execute().catch(() => {});
    }
  }, [ready, url, execute]);

  return { ...state, refetch: execute };
}

export { GGContext };
