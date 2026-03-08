// Pure JS VCDIFF (RFC 3284) decoder
//
// Works directly on JS typed arrays — no WASM heap limits, handles
// arbitrarily large disc images. Supports standard VCDIFF and LZMA
// secondary compression (xdelta3 -S lzma).

import { StreamingXZDecoder } from './xz.js';

const VCDIFF_MAGIC = [0xD6, 0xC3, 0xC4];            // RFC 3284 magic bytes
const VCDIFF_VERSION_STANDARD = 0x00;
const VCDIFF_VERSION_XDELTA3 = 0x53;                // 'S' — xdelta3 extension

const VCD_DECOMPRESS = 0x01;
const VCD_CODETABLE  = 0x02;
const VCD_APPHEADER  = 0x04;                         // xdelta3 extension

const VCD_SOURCE  = 0x01;                            // window indicator: source segment
const VCD_TARGET  = 0x02;                            // window indicator: target segment
const VCD_ADLER32 = 0x04;                            // window indicator: adler32 present (xdelta3)

const NOOP = 0, ADD = 1, RUN = 2, COPY = 3;

// Address cache sizes (RFC 3284 §5.3)
const NEAR_CACHE_SIZE = 4;                           // s_near
const SAME_CACHE_SIZE = 256 * 3;                     // s_same × 256

// Default code table per RFC 3284 §5.6 / Appendix A
const defaultTable = buildDefaultCodeTable();

function buildDefaultCodeTable() {
  const t = new Array(256);
  let idx = 0;

  // 0: RUN size=0
  t[idx++] = [RUN, 0, 0, NOOP, 0, 0];
  // 1: ADD size=0 (size read from inst stream)
  t[idx++] = [ADD, 0, 0, NOOP, 0, 0];
  // 2-18: ADD sizes 1-17
  for (let s = 1; s <= 17; s++) t[idx++] = [ADD, s, 0, NOOP, 0, 0];
  // 19-162: COPY mode 0-8, for each: size=0 then sizes 4-18
  for (let m = 0; m <= 8; m++) {
    t[idx++] = [COPY, 0, m, NOOP, 0, 0];
    for (let s = 4; s <= 18; s++) t[idx++] = [COPY, s, m, NOOP, 0, 0];
  }
  // 163-234: ADD 1-4 + COPY 4-6, modes 0-5
  // RFC 3284 §5.6: loop order is mode (outer), add size (middle), copy size (inner)
  for (let m = 0; m <= 5; m++) {
    for (let a = 1; a <= 4; a++) {
      for (let c = 4; c <= 6; c++) {
        t[idx++] = [ADD, a, 0, COPY, c, m];
      }
    }
  }
  // 235-246: ADD 1-4, COPY 4, modes 6-8
  for (let m = 6; m <= 8; m++) {
    for (let a = 1; a <= 4; a++) {
      t[idx++] = [ADD, a, 0, COPY, 4, m];
    }
  }
  // 247-255: COPY 4 mode 0-8, ADD 1 (reversed order)
  for (let m = 0; m <= 8; m++) {
    t[idx++] = [COPY, 4, m, ADD, 1, 0];
  }
  return t;
}

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }

  u8() {
    if (this.pos >= this.buf.length) throw new Error('VCDIFF: unexpected end of data');
    return this.buf[this.pos++];
  }

  integer() {
    let val = 0, b, count = 0;
    const startPos = this.pos;
    do {
      if (this.pos >= this.buf.length) throw new Error(`VCDIFF: truncated integer at pos ${startPos}`);
      b = this.buf[this.pos++];
      val = val * 128 + (b & 0x7F); // multiply (not shift) to avoid 32-bit overflow
      if (++count > 5) {
        const bytes = [...this.buf.subarray(startPos, this.pos)].map(x => x.toString(16).padStart(2, '0')).join(' ');
        throw new Error(`VCDIFF: integer overflow at pos ${startPos} (bytes: ${bytes}, buf.length: ${this.buf.length})`);
      }
    } while (b & 0x80);
    return val;
  }

  bytes(n) {
    if (this.pos + n > this.buf.length) throw new Error('VCDIFF: unexpected end of data');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  get done() { return this.pos >= this.buf.length; }
}

function decompressSection(reader, sectionLen, isCompressed, streamDecoder) {
  const raw = reader.bytes(sectionLen);
  if (!isCompressed) return raw;
  // First VCDIFF integer in the section = decompressed size
  const sectionReader = new Reader(raw);
  const decompressedSize = sectionReader.integer();
  const compressed = raw.subarray(sectionReader.pos);
  return streamDecoder.decode(compressed);
}

/**
 * Apply a VCDIFF patch to a source buffer.
 * @param {Uint8Array} source - Original file data
 * @param {Uint8Array} patch  - VCDIFF patch data
 * @param {function} [onProgress] - Optional callback(pct) called after each window
 * @returns {Uint8Array} Patched output
 */
export function applyVCDIFF(source, patch, onProgress) {
  const r = new Reader(patch);

  if (r.u8() !== VCDIFF_MAGIC[0] || r.u8() !== VCDIFF_MAGIC[1] || r.u8() !== VCDIFF_MAGIC[2]) {
    throw new Error('VCDIFF: invalid magic bytes');
  }
  const version = r.u8();
  if (version !== VCDIFF_VERSION_STANDARD && version !== VCDIFF_VERSION_XDELTA3) {
    throw new Error(`VCDIFF: unsupported version ${version}`);
  }

  const hdrIndicator = r.u8();
  let hasSecondaryCompression = false;
  if (hdrIndicator & VCD_DECOMPRESS) {
    const compId = r.u8();
    if (compId === 2) {
      // LZMA secondary compression — xdelta3 wraps in XZ format
      hasSecondaryCompression = true;
    } else {
      const names = { 1: 'DJW', 16: 'FGK' };
      const name = names[compId] || `ID=${compId}`;
      throw new Error(
        `VCDIFF: secondary compression (${name}) not supported. ` +
        'Re-create the patch with: xdelta3 -S none -e -s source target patch'
      );
    }
  }
  if (hdrIndicator & VCD_CODETABLE) {
    const ctLen = r.integer();
    r.bytes(ctLen);
  }
  if (hdrIndicator & VCD_APPHEADER) {
    const appLen = r.integer();
    r.bytes(appLen);
  }

  // Streaming decoders — one per section type, persisted across windows.
  // xdelta3 initializes the XZ encoder once and uses LZMA_SYNC_FLUSH
  // between windows, so the XZ header only appears in the first window.
  let dataDecoder, instDecoder, addrDecoder;
  if (hasSecondaryCompression) {
    dataDecoder = new StreamingXZDecoder();
    instDecoder = new StreamingXZDecoder();
    addrDecoder = new StreamingXZDecoder();
  }

  const windows = [];
  let totalOutputLen = 0;
  let winNum = 0;

  while (!r.done) {
    const winStartPos = r.pos;
    try {

    const winIndicator = r.u8();
    const hasSource = !!(winIndicator & VCD_SOURCE);
    const hasTarget = !!(winIndicator & VCD_TARGET);
    const hasAdler32 = !!(winIndicator & VCD_ADLER32);

    let srcLen = 0, srcOff = 0;
    let srcData = null;

    if (hasSource || hasTarget) {
      srcLen = r.integer();
      srcOff = r.integer();
      if (hasSource) {
        if (srcOff + srcLen > source.length) {
          throw new Error(
            `source window [${srcOff}..${srcOff + srcLen}] exceeds source size ${source.length}`
          );
        }
        srcData = source.subarray(srcOff, srcOff + srcLen);
      }
    }

    const deltaLen = r.integer();
    const deltaEnd = r.pos + deltaLen;

    const targetWindowLen = r.integer();
    const indicator = r.u8();
    if (indicator !== 0 && !hasSecondaryCompression) {
      throw new Error(
        'per-window section compression not supported. ' +
        'Re-create the patch with: xdelta3 -S none -e -s source target patch'
      );
    }

    const dataLen = r.integer();
    const instLen = r.integer();
    const addrLen = r.integer();

    // xdelta3 extension: optional adler32 checksum (4 raw bytes) between
    // section lengths and section data when VCD_ADLER32 is set.
    // Some encoders set the flag but omit the bytes, so we probe:
    // if sections don't fit with the 4-byte skip, the encoder omitted them.
    if (hasAdler32 && dataLen + instLen + addrLen + 4 <= deltaEnd - r.pos) {
      r.bytes(4);
    }

    let dataSection, instSection, addrSection;

    if (indicator !== 0 && hasSecondaryCompression) {
      // Decompress sections that have their compression bit set
      // indicator bits: 0x01 = data, 0x02 = inst, 0x04 = addr
      dataSection = decompressSection(r, dataLen, indicator & 0x01, dataDecoder);
      instSection = decompressSection(r, instLen, indicator & 0x02, instDecoder);
      addrSection = decompressSection(r, addrLen, indicator & 0x04, addrDecoder);
    } else {
      dataSection = r.bytes(dataLen);
      instSection = r.bytes(instLen);
      addrSection = r.bytes(addrLen);
    }

    const targetWindow = new Uint8Array(targetWindowLen);
    const instReader = new Reader(instSection);
    const dataReader = new Reader(dataSection);
    const addrReader = new Reader(addrSection);

    // Address caches (RFC 3284 §5.3)
    const near = new Array(NEAR_CACHE_SIZE).fill(0);
    let nearIdx = 0;
    const same = new Array(SAME_CACHE_SIZE).fill(0);
    let tPos = 0;

    function decodeAddress(mode, here) {
      let addr;
      if (mode === 0) {
        addr = addrReader.integer();
      } else if (mode === 1) {
        addr = here - addrReader.integer();
      } else if (mode >= 2 && mode <= 5) {
        addr = near[mode - 2] + addrReader.integer();
      } else {
        addr = same[(mode - 6) * 256 + addrReader.u8()];
      }
      near[nearIdx] = addr;
      nearIdx = (nearIdx + 1) % NEAR_CACHE_SIZE;
      same[addr % SAME_CACHE_SIZE] = addr;
      return addr;
    }

    function execInst(type, size, mode) {
      if (type === NOOP) return;
      if (type === ADD) {
        targetWindow.set(dataReader.bytes(size), tPos);
        tPos += size;
      } else if (type === RUN) {
        const val = dataReader.u8();
        targetWindow.fill(val, tPos, tPos + size);
        tPos += size;
      } else if (type === COPY) {
        const addr = decodeAddress(mode, srcLen + tPos);
        if (addr < srcLen) {
          const copyEnd = addr + size;
          if (copyEnd <= srcLen) {
            targetWindow.set(srcData.subarray(addr, copyEnd), tPos);
          } else {
            const fromSrc = srcLen - addr;
            targetWindow.set(srcData.subarray(addr, srcLen), tPos);
            for (let i = fromSrc; i < size; i++) {
              targetWindow[tPos + i] = targetWindow[tPos + i - fromSrc];
            }
          }
          tPos += size;
        } else {
          const tAddr = addr - srcLen;
          if (tAddr + size <= tPos) {
            targetWindow.copyWithin(tPos, tAddr, tAddr + size);
          } else {
            for (let i = 0; i < size; i++) {
              targetWindow[tPos + i] = targetWindow[tAddr + i];
            }
          }
          tPos += size;
        }
      }
    }

    while (!instReader.done) {
      const code = instReader.u8();
      const [type1, size1, mode1, type2, size2, mode2] = defaultTable[code];

      const s1 = size1 || (type1 !== NOOP ? instReader.integer() : 0);
      execInst(type1, s1, mode1);

      const s2 = size2 || (type2 !== NOOP ? instReader.integer() : 0);
      execInst(type2, s2, mode2);
    }

    if (tPos !== targetWindowLen) {
      throw new Error(`window decode error — produced ${tPos} bytes, expected ${targetWindowLen}`);
    }

    windows.push(targetWindow);
    totalOutputLen += targetWindowLen;
    r.pos = deltaEnd;

    } catch (e) {
      throw new Error(`VCDIFF window ${winNum} (patch offset ${winStartPos}): ${e.message}`);
    }
    winNum++;
    if (onProgress) onProgress(Math.round((r.pos / patch.length) * 100));
  }

  if (windows.length === 1) return windows[0];
  const output = new Uint8Array(totalOutputLen);
  let off = 0;
  for (const w of windows) {
    output.set(w, off);
    off += w.length;
  }
  return output;
}
