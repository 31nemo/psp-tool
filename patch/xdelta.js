// xdelta/VCDIFF patch format applier
//
// Pure JS VCDIFF decoder (RFC 3284). Works with arbitrarily large files
// since it operates on JS typed arrays directly (no WASM heap limits).

import { applyVCDIFF } from './vcdiff.js';

/**
 * Apply an xdelta/VCDIFF patch to a source buffer.
 * @param {Uint8Array} source - Original file data
 * @param {Uint8Array} patch - xdelta/VCDIFF patch data
 * @param {function} [onProgress] - Optional callback(pct) called during processing
 * @returns {Promise<Uint8Array>} Patched output
 */
export async function applyXDELTA(source, patch, onProgress) {
  return applyVCDIFF(source, patch, onProgress);
}
