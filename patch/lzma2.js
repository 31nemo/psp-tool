// LZMA2 chunk decoder
//
// LZMA2 wraps LZMA with chunked encoding, allowing state resets between
// chunks. Used inside XZ containers for VCDIFF secondary decompression.

import { LZMADecoder } from './lzma.js';

/**
 * Decode LZMA2-compressed data.
 * @param {Uint8Array} data - LZMA2 chunk stream
 * @param {number} dictSizeProp - Dictionary size property byte from XZ filter
 * @returns {Uint8Array} Decompressed data
 */
export function decodeLZMA2(data, dictSizeProp) {
  const dictSize = lzma2DictSize(dictSizeProp);
  const decoder = new LZMADecoder();
  const chunks = [];
  let pos = 0;
  let needInit = true;

  while (pos < data.length) {
    const control = data[pos++];

    if (control === 0x00) {
      // End of stream
      break;
    }

    if (control === 0x01 || control === 0x02) {
      // Uncompressed chunk
      const size = ((data[pos] << 8) | data[pos + 1]) + 1;
      pos += 2;
      if (control === 0x01) {
        // Reset dictionary
        decoder.init(0, 0, 0, dictSize);
        needInit = false;
      }
      const chunk = data.subarray(pos, pos + size);
      // Feed uncompressed bytes into the output window for future references
      for (let i = 0; i < chunk.length; i++) {
        decoder.outWindow.putByte(chunk[i]);
      }
      chunks.push(new Uint8Array(chunk));
      pos += size;
      continue;
    }

    if (control < 0x80) {
      throw new Error(`LZMA2: invalid control byte 0x${control.toString(16)}`);
    }

    // Compressed LZMA chunk
    // Control byte layout for >= 0x80:
    //   Bit 7: always 1
    //   Bits 5-6: reset level (0=none, 1=state reset, 2=state+props, 3=full reset)
    //   Bits 0-4: high 5 bits of uncompressed size - 1
    const resetLevel = (control >>> 5) & 0x03;
    const uncompHigh = control & 0x1F;

    const uncompressedSize = ((uncompHigh << 16) | (data[pos] << 8) | data[pos + 1]) + 1;
    pos += 2;
    const compressedSize = ((data[pos] << 8) | data[pos + 1]) + 1;
    pos += 2;

    if (needInit || resetLevel === 3) {
      // Full reset: new props + state + dict
      const propByte = data[pos++];
      const lc = propByte % 9;
      const remainder = (propByte / 9) | 0;
      const lp = remainder % 5;
      const pb = (remainder / 5) | 0;
      decoder.init(lc, lp, pb, dictSize);
      needInit = false;
    } else if (resetLevel === 2) {
      // State + props reset
      const propByte = data[pos++];
      const lc = propByte % 9;
      const remainder = (propByte / 9) | 0;
      const lp = remainder % 5;
      const pb = (remainder / 5) | 0;
      decoder.setProps(lc, lp, pb);
      decoder.resetState();
    } else if (resetLevel === 1) {
      // State reset only
      decoder.resetState();
    }
    // resetLevel 0 = no reset, continue with existing state

    const compressedData = data.subarray(pos, pos + compressedSize);
    pos += compressedSize;

    const decompressed = decoder.decode(compressedData, uncompressedSize);
    chunks.push(decompressed);
  }

  // Concatenate all chunks
  if (chunks.length === 1) return chunks[0];
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    result.set(c, off);
    off += c.length;
  }
  return result;
}

/**
 * Streaming LZMA2 decoder that preserves state across calls.
 * Used for xdelta3 secondary compression where the LZMA2 stream
 * spans multiple VCDIFF windows (encoder uses LZMA_SYNC_FLUSH
 * between sections, so each call gets complete LZMA2 chunks).
 */
export class StreamingLZMA2Decoder {
  constructor(dictSizeProp) {
    this.dictSize = lzma2DictSize(dictSizeProp);
    this.decoder = new LZMADecoder();
    this.needInit = true;
  }

  decode(data) {
    const chunks = [];
    let pos = 0;

    while (pos < data.length) {
      const control = data[pos++];

      if (control === 0x00) break;

      if (control === 0x01 || control === 0x02) {
        const size = ((data[pos] << 8) | data[pos + 1]) + 1;
        pos += 2;
        if (control === 0x01) {
          this.decoder.init(0, 0, 0, this.dictSize);
          this.needInit = false;
        }
        const chunk = data.subarray(pos, pos + size);
        for (let i = 0; i < chunk.length; i++) {
          this.decoder.outWindow.putByte(chunk[i]);
        }
        chunks.push(new Uint8Array(chunk));
        pos += size;
        continue;
      }

      if (control < 0x80) {
        throw new Error(`LZMA2: invalid control byte 0x${control.toString(16)}`);
      }

      const resetLevel = (control >>> 5) & 0x03;
      const uncompHigh = control & 0x1F;
      const uncompressedSize = (uncompHigh << 16) | (((data[pos] << 8) | data[pos + 1]) + 1);
      pos += 2;
      const compressedSize = ((data[pos] << 8) | data[pos + 1]) + 1;
      pos += 2;

      if (this.needInit || resetLevel === 3) {
        const propByte = data[pos++];
        const lc = propByte % 9;
        const remainder = (propByte / 9) | 0;
        const lp = remainder % 5;
        const pb = (remainder / 5) | 0;
        this.decoder.init(lc, lp, pb, this.dictSize);
        this.needInit = false;
      } else if (resetLevel === 2) {
        const propByte = data[pos++];
        const lc = propByte % 9;
        const remainder = (propByte / 9) | 0;
        const lp = remainder % 5;
        const pb = (remainder / 5) | 0;
        this.decoder.setProps(lc, lp, pb);
        this.decoder.resetState();
      } else if (resetLevel === 1) {
        this.decoder.resetState();
      }

      const compressedData = data.subarray(pos, pos + compressedSize);
      pos += compressedSize;

      const decompressed = this.decoder.decode(compressedData, uncompressedSize);
      chunks.push(decompressed);
    }

    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const result = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    return result;
  }
}

function lzma2DictSize(prop) {
  if (prop > 40) throw new Error(`LZMA2: invalid dict size property ${prop}`);
  if (prop === 40) return 0xFFFFFFFF;
  const base = (2 | (prop & 1)) << ((prop >>> 1) + 11);
  return base;
}
