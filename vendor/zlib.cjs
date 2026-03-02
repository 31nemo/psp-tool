// vendor/zlib.cjs — Raw deflate/inflate (RFC 1951) powered by pako 2.1.0
//
// Public API (set on globalThis/self/module.exports):
//   deflateRaw(data, opts)  → Uint8Array   (opts.level: 0-9, default 6)
//   inflateRaw(data)        → Uint8Array
//
// Only raw format (no zlib/gzip headers). Input/output are Uint8Array.
// pako 2.1.0: https://github.com/nodeca/pako  (MIT AND Zlib license)
//
// The readable pako source lives in vendor/pako/. This file is the entry point
// that build.js bundles with esbuild into a self-contained IIFE for the browser.

'use strict';

const pako = require('./pako/deflate');
const pakoInflate = require('./pako/inflate');

function deflateRaw(data, opts) {
  if (!(data instanceof Uint8Array)) {
    data = new Uint8Array(data);
  }
  const level = (opts && opts.level !== undefined) ? opts.level : 6;
  return pako.deflateRaw(data, { level: level });
}

function inflateRaw(data) {
  if (!(data instanceof Uint8Array)) {
    data = new Uint8Array(data);
  }
  return pakoInflate.inflateRaw(data);
}

// Browser global / Web Worker
if (typeof self !== 'undefined') {
  self.deflateRaw = deflateRaw;
  self.inflateRaw = inflateRaw;
}

// Node.js / CJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports.deflateRaw = deflateRaw;
  module.exports.inflateRaw = inflateRaw;
}

// globalThis fallback (ESM, SharedArrayBuffer workers, etc.)
if (typeof globalThis !== 'undefined') {
  globalThis.deflateRaw = deflateRaw;
  globalThis.inflateRaw = inflateRaw;
}
