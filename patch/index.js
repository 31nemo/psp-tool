// Patch format detection and dispatch
//
// Sniffs magic bytes to detect IPS, PPF, BPS, or VCDIFF (xdelta) format,
// then delegates to the appropriate format module.

import { applyIPS } from './ips.js';
import { applyPPF } from './ppf.js';
import { applyBPS } from './bps.js';
import { applyXDELTA } from './xdelta.js';

const VCDIFF_MAGIC = [0xD6, 0xC3, 0xC4];           // RFC 3284
const PPF_MAGIC    = [0x50, 0x50, 0x46];            // "PPF"

/**
 * Detect patch format from magic bytes.
 * @param {Uint8Array} patch - Patch file data
 * @returns {'ips'|'ppf'|'bps'|'xdelta'|null}
 */
export function detectFormat(patch) {
  if (patch.length < 5) return null;
  // VCDIFF magic: 0xD6 0xC3 0xC4 (RFC 3284)
  if (patch[0] === VCDIFF_MAGIC[0] && patch[1] === VCDIFF_MAGIC[1] && patch[2] === VCDIFF_MAGIC[2]) return 'xdelta';
  const magic4 = String.fromCharCode(patch[0], patch[1], patch[2], patch[3]);
  if (magic4 === 'BPS1') return 'bps';
  const magic5 = magic4 + String.fromCharCode(patch[4]);
  if (magic5 === 'PATCH') return 'ips';
  if (patch[0] === PPF_MAGIC[0] && patch[1] === PPF_MAGIC[1] && patch[2] === PPF_MAGIC[2]) return 'ppf';
  return null;
}

/**
 * Apply a patch to a ROM buffer, auto-detecting the format.
 * @param {Uint8Array} rom - Source ROM/disc image
 * @param {Uint8Array} patch - Patch file data
 * @param {function} [onProgress] - Optional callback(pct) for progress updates
 * @returns {Promise<{result: Uint8Array, format: string}>}
 */
export async function applyPatch(rom, patch, onProgress) {
  const format = detectFormat(patch);
  if (!format) throw new Error('Unrecognized patch format');

  let result;
  switch (format) {
    case 'ips': result = applyIPS(rom, patch); break;
    case 'ppf': result = applyPPF(rom, patch); break;
    case 'bps': result = applyBPS(rom, patch); break;
    case 'xdelta': result = await applyXDELTA(rom, patch, onProgress); break;
  }

  return { result, format };
}
