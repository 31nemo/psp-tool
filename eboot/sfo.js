// PARAM.SFO (System File Object) builder
//
// Builds a PSF binary key-value store used by PSP firmware to read game
// metadata (title, disc ID, region, parental level, etc.) and display it
// on the XMB (cross-media bar).
//
// The SFO is embedded in the PBP container at index 0 (PARAM.SFO).
//
// Format spec: https://www.psdevwiki.com/ps3/PARAM.SFO
// Layout:
//   [header 20 bytes] [index table 16*N bytes] [key table] [data table]
//
// The header stores offsets to the key and data tables plus the entry count.
// Each index entry maps a key name (in the key table) to a typed value (in the
// data table), with both "used size" and "max size" to allow padded allocations.

const SFO_MAGIC = 0x46535000; // "\0PSF" — PSF format identifier
const SFO_VERSION = 0x00000101; // Version 1.1

// Data format types (stored in index table entry bytes 2-3)
const SFO_UTF8S = 0x0004; // UTF-8 special mode, not null-terminated (unused; POPS expects 0x0204)
const SFO_UTF8  = 0x0204; // UTF-8 string, null-terminated, zero-padded to maxSize
const SFO_INT32 = 0x0404; // 32-bit unsigned integer, little-endian

/**
 * Build a PARAM.SFO binary for a PS1 EBOOT.
 *
 * Constructs the complete PSF binary: header → index table → key table → data
 * table. Keys must be sorted alphabetically (they already are in the entries
 * array below), as required by the PSF spec.
 *
 * Entry values match what Sony PSN PS1 classics use (CATEGORY="ME" for PS1
 * minis/classics, PSP_SYSTEM_VER="3.01", etc.).
 *
 * @param {Object} opts
 * @param {string} opts.title          - Game title shown on XMB (e.g. "FINAL FANTASY VII")
 * @param {string} opts.discId         - Disc ID without hyphen (e.g. "SCUS94163")
 * @param {number} [opts.parentalLevel=3] - Parental control level (1–11, default 3 = Everyone)
 * @param {number} [opts.region=0x8000]   - Region bitmask (0x8000=NTSC-U, 0x4000=NTSC-J, 0x0001=PAL)
 * @returns {Uint8Array} Complete PARAM.SFO binary
 */
export function buildSFO(opts) {
  const title = opts.title || 'Unknown';
  const discId = opts.discId || 'SLUS00000';
  const discTotal = opts.discTotal || 1;
  const parentalLevel = opts.parentalLevel || 3;
  const region = opts.region || 0x8000;

  // SFO entries: [key, type, value, maxSize]
  // Keys MUST be in alphabetical order per PSF spec.
  // maxSize is the padded allocation in the data table (strings are zero-filled
  // to this length; firmware reads up to maxSize bytes).
  const entries = [
    ['BOOTABLE',       SFO_INT32, 1,          4],
    ['CATEGORY',       SFO_UTF8,  'ME',       4],
    ['DISC_ID',        SFO_UTF8,  discId,     16],
    ['DISC_VERSION',   SFO_UTF8,  '1.00',     8],
    ['LICENSE',        SFO_UTF8,  'Copyright(C) Sony Computer Entertainment America Inc.', 512],
    ['PARENTAL_LEVEL', SFO_INT32, parentalLevel, 4],
    ['PSP_SYSTEM_VER', SFO_UTF8,  '3.01',     8],
    ['REGION',         SFO_INT32, region,     4],
    ['TITLE',          SFO_UTF8,  title,      128],
  ];

  // NOTE: Sony PSN multi-disc EBOOTs (FF7, FF8) do NOT include DISC_TOTAL
  // in the SFO. The disc count is encoded structurally in PSTITLEIMG. Omitting
  // it to match Sony's format.

  const count = entries.length;

  // Build key table (null-terminated strings, consecutive)
  const keyParts = [];
  const keyOffsets = [];
  let keyTableSize = 0;
  for (const [key] of entries) {
    keyOffsets.push(keyTableSize);
    const encoded = new TextEncoder().encode(key + '\0');
    keyParts.push(encoded);
    keyTableSize += encoded.length;
  }
  // Align key table to 4 bytes
  const keyTablePadded = align4(keyTableSize);

  // Build data table
  const dataParts = [];
  const dataLens = [];  // actual data size
  const dataMaxes = []; // padded allocation
  for (const [, type, value, maxSize] of entries) {
    let buf;
    let len;
    if (type === SFO_INT32) {
      buf = new Uint8Array(4);
      new DataView(buf.buffer).setUint32(0, value, true);
      len = 4;
    } else {
      const encoded = new TextEncoder().encode(value + '\0');
      len = encoded.length;
      buf = new Uint8Array(maxSize);
      buf.set(encoded);
    }
    dataParts.push(buf);
    dataLens.push(len);
    dataMaxes.push(maxSize);
  }

  // Calculate section offsets:
  //   [header 20B] [index 16*N B] [keys (4-aligned)] [data values]
  const indexTableSize = count * 16;
  const headerSize = 20;
  const keyTableOffset = headerSize + indexTableSize;
  const dataTableOffset = keyTableOffset + keyTablePadded;

  const totalSize = dataTableOffset + dataMaxes.reduce((a, b) => a + b, 0);
  const result = new Uint8Array(totalSize);
  const dv = new DataView(result.buffer);

  // Header
  dv.setUint32(0, SFO_MAGIC, true); // "\0PSF" magic
  dv.setUint32(4, SFO_VERSION, true);
  dv.setUint32(8, keyTableOffset, true);
  dv.setUint32(12, dataTableOffset, true);
  dv.setUint32(16, count, true);

  // Index table entries
  let dataOffset = 0;
  for (let i = 0; i < count; i++) {
    const base = headerSize + i * 16;
    dv.setUint16(base + 0, keyOffsets[i], true);      // key offset
    dv.setUint16(base + 2, entries[i][1], true);       // data type
    dv.setUint32(base + 4, dataLens[i], true);         // data used size
    dv.setUint32(base + 8, dataMaxes[i], true);        // data max size
    dv.setUint32(base + 12, dataOffset, true);         // data offset
    dataOffset += dataMaxes[i];
  }

  // Key table
  let keyPos = keyTableOffset;
  for (const part of keyParts) {
    result.set(part, keyPos);
    keyPos += part.length;
  }

  // Data table
  let dataPos = dataTableOffset;
  for (let i = 0; i < count; i++) {
    result.set(dataParts[i], dataPos);
    dataPos += dataMaxes[i];
  }

  return result;
}

/** Round up to next 4-byte boundary (required for key table padding). */
function align4(n) {
  return (n + 3) & ~3;
}
