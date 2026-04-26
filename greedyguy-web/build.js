/**
 * build.js — Bundle src/index.js into an IIFE for <script> tag usage.
 * Wraps all exports as window.GreedyGuy.
 * Zero dependencies — uses only Node.js built-ins.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, 'src', 'index.js'), 'utf8');

// Strip ES module syntax, wrap in IIFE
let code = src
  // Remove "export " from all function/const declarations
  .replace(/^export (async )?function /gm, '$1function ')
  .replace(/^export (const|let|var) /gm, '$1 ')
  // Remove any import statements (we inline everything)
  .replace(/^import .+$/gm, '')
  // Remove import.meta.url references — replace with script src detection
  .replace(/import\.meta\.url/g, '(document.currentScript && document.currentScript.src || "")')
  // Remove webpackIgnore comments
  .replace(/\/\* webpackIgnore: true \*\/ /g, '');

const iife = `/**
 * GreedyGuy Web — Browser compression via WASM
 * https://github.com/niceguydave/greedyguy-web
 * @license MIT
 * @version 1.0.0
 */
(function (global) {
"use strict";

${code}

// --- Public API on window.GreedyGuy ---
var GreedyGuy = {
  init: init,
  compress: compress,
  decompress: decompress,
  compressText: compressText,
  decompressText: decompressText,
  compressToBase64: compressToBase64,
  decompressFromBase64: decompressFromBase64,
  decompressBase64Text: decompressBase64Text,
  isCompressed: isCompressed,
  isSupported: isSupported,
  status: status,
  destroy: destroy,
  fetchAndDecompress: fetchAndDecompress,
  VERSION: "1.0.0"
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = GreedyGuy;
} else {
  global.GreedyGuy = GreedyGuy;
}

})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : this);
`;

writeFileSync(join(__dirname, 'dist', 'greedyguy-web.iife.js'), iife);
console.log('Built dist/greedyguy-web.iife.js (' + (iife.length / 1024).toFixed(1) + ' KB)');
