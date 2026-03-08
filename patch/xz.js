// XZ container parser
//
// Parses the XZ stream format to extract LZMA2 block data.
// Used by xdelta3 for secondary compression (-S lzma wraps in XZ).
//
// XZ format: magic(6) + stream_flags(2) + blocks + index + footer

import { decodeLZMA2, StreamingLZMA2Decoder } from './lzma2.js';

const XZ_MAGIC = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00];  // "\xFD7zXZ\0"
const XZ_STREAM_FLAGS_SIZE = 2;
const XZ_CRC32_SIZE = 4;
const XZ_LZMA2_FILTER_ID = 0x21;

/**
 * Parse XZ stream header and block header, return LZMA2 props and block data offset.
 */
function parseXZHeader(data) {
  let pos = 0;

  // Validate magic
  for (let i = 0; i < 6; i++) {
    if (data[pos++] !== XZ_MAGIC[i]) {
      throw new Error('XZ: invalid magic bytes');
    }
  }

  // Stream flags (2 bytes) + CRC32 (4 bytes) — skip
  pos += XZ_STREAM_FLAGS_SIZE + XZ_CRC32_SIZE;

  // ── Block header ──────────────────────────────────────────────────────

  const blockHeaderSizeByte = data[pos++];
  if (blockHeaderSizeByte === 0) {
    return { lzma2Props: 0, blockDataPos: pos };
  }
  const blockHeaderSize = (blockHeaderSizeByte + 1) * 4;
  const blockHeaderStart = pos - 1;

  const blockFlags = data[pos++];
  const numFilters = (blockFlags & 0x03) + 1;
  const hasCompressedSize = !!(blockFlags & 0x40);
  const hasUncompressedSize = !!(blockFlags & 0x80);

  if (hasCompressedSize) {
    pos = readMultibyteInt(data, pos).newPos;
  }
  if (hasUncompressedSize) {
    pos = readMultibyteInt(data, pos).newPos;
  }

  // Read filters — we expect filter ID 0x21 (LZMA2)
  let lzma2Props = 0;
  for (let f = 0; f < numFilters; f++) {
    const { value: filterId, newPos: p1 } = readMultibyteInt(data, pos);
    pos = p1;
    const { value: propsSize, newPos: p2 } = readMultibyteInt(data, pos);
    pos = p2;

    if (filterId === XZ_LZMA2_FILTER_ID) {
      if (propsSize >= 1) {
        lzma2Props = data[pos];
      }
    }
    pos += propsSize;
  }

  // Skip block header padding + CRC32
  pos = blockHeaderStart + blockHeaderSize;

  return { lzma2Props, blockDataPos: pos };
}

/**
 * Decompress XZ-compressed data (standalone, non-streaming).
 * @param {Uint8Array} data - XZ stream
 * @returns {Uint8Array} Decompressed data
 */
export function decompressXZ(data) {
  const { lzma2Props, blockDataPos } = parseXZHeader(data);
  if (blockDataPos >= data.length) return new Uint8Array(0);
  return decodeLZMA2(data.subarray(blockDataPos), lzma2Props);
}

/**
 * Streaming XZ decoder for xdelta3 secondary compression.
 *
 * xdelta3 initializes the XZ encoder ONCE per section type (data/inst/addr)
 * and uses LZMA_SYNC_FLUSH between windows. The first call receives the
 * XZ header + LZMA2 chunks; subsequent calls receive only LZMA2 chunks.
 */
export class StreamingXZDecoder {
  constructor() {
    this.lzma2Decoder = null;
    this.initialized = false;
  }

  decode(compressedData) {
    if (!this.initialized) {
      const { lzma2Props, blockDataPos } = parseXZHeader(compressedData);
      this.lzma2Decoder = new StreamingLZMA2Decoder(lzma2Props);
      this.initialized = true;
      return this.lzma2Decoder.decode(compressedData.subarray(blockDataPos));
    }
    return this.lzma2Decoder.decode(compressedData);
  }
}

function readMultibyteInt(data, pos) {
  let value = 0, shift = 0;
  while (pos < data.length) {
    const b = data[pos++];
    value |= (b & 0x7F) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 63) throw new Error('XZ: multibyte integer overflow');
  }
  return { value, newPos: pos };
}
