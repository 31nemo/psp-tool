// LZ4 Block Format compress/decompress
//
// Minimal LZ4 block compress/decompress, implemented from the spec:
// https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
//
// Each block is a sequence of tokens. Each token encodes:
//   - Literal length (4 high bits of token byte, extended with 0xFF bytes)
//   - Literal bytes (copied verbatim)
//   - Match offset (2 bytes LE, backward reference distance)
//   - Match length (4 low bits of token + 4 minimum, extended with 0xFF bytes)
//
// Uses a 16-bit hash table for match finding (Knuth multiplicative hash).

const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;
const MIN_MATCH = 4;
const RUN_BITS = 4;

function hashU32(v) {
  return ((v * 2654435761) >>> 0) >>> (32 - HASH_BITS);
}

function read32(buf, i) {
  return buf[i] | (buf[i+1] << 8) | (buf[i+2] << 16) | (buf[i+3] << 24);
}

/** Compress a single block using LZ4 block format. */
export function compressBlock(src) {
  const sLen = src.length;
  if (sLen === 0) return new Uint8Array(0);
  const dst = new Uint8Array(sLen + Math.ceil(sLen / 255) + 16);
  const hashTable = new Int32Array(HASH_SIZE).fill(-65536);
  let sIdx = 0, dIdx = 0, anchor = 0;

  while (sIdx < sLen - 5) {
    const seq = read32(src, sIdx);
    const h = hashU32(seq);
    let ref = hashTable[h];
    hashTable[h] = sIdx;

    if (ref >= sIdx - 65535 && ref >= 0 && read32(src, ref) === seq) {
      let litLen = sIdx - anchor;
      let mIdx = sIdx + MIN_MATCH;
      let rIdx = ref + MIN_MATCH;
      const matchLimit = sLen - 5;  // last 5 bytes must be literals (LZ4 spec)
      while (mIdx < matchLimit && src[mIdx] === src[rIdx]) { mIdx++; rIdx++; }
      let matchLen = mIdx - sIdx - MIN_MATCH;

      let token = Math.min(matchLen, 15);
      if (litLen >= 15) {
        dst[dIdx++] = (15 << RUN_BITS) | token;
        let rem = litLen - 15;
        while (rem >= 255) { dst[dIdx++] = 255; rem -= 255; }
        dst[dIdx++] = rem;
      } else {
        dst[dIdx++] = (litLen << RUN_BITS) | token;
      }
      for (let i = 0; i < litLen; i++) dst[dIdx++] = src[anchor + i];
      const offset = sIdx - ref;
      dst[dIdx++] = offset & 0xff;
      dst[dIdx++] = (offset >>> 8) & 0xff;
      if (matchLen >= 15) {
        let rem = matchLen - 15;
        while (rem >= 255) { dst[dIdx++] = 255; rem -= 255; }
        dst[dIdx++] = rem;
      }
      sIdx = mIdx;
      anchor = sIdx;
    } else {
      sIdx++;
    }
  }

  let litLen = sLen - anchor;
  if (litLen >= 15) {
    dst[dIdx++] = (15 << RUN_BITS);
    let rem = litLen - 15;
    while (rem >= 255) { dst[dIdx++] = 255; rem -= 255; }
    dst[dIdx++] = rem;
  } else {
    dst[dIdx++] = (litLen << RUN_BITS);
  }
  for (let i = 0; i < litLen; i++) dst[dIdx++] = src[anchor + i];

  return dst.slice(0, dIdx);
}

/** Decompress an LZ4 block given the known uncompressed size. */
export function decompressBlock(src, uncompressedSize) {
  const dst = new Uint8Array(uncompressedSize);
  let sIdx = 0, dIdx = 0;
  const sLen = src.length;

  while (sIdx < sLen) {
    const token = src[sIdx++];
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b;
      do { b = src[sIdx++]; litLen += b; } while (b === 255);
    }
    for (let i = 0; i < litLen; i++) dst[dIdx++] = src[sIdx++];
    if (sIdx >= sLen) break;

    const offset = src[sIdx] | (src[sIdx+1] << 8);
    sIdx += 2;
    if (offset === 0) throw new Error('LZ4: invalid zero offset');

    let matchLen = (token & 0x0f) + MIN_MATCH;
    if ((token & 0x0f) === 15) {
      let b;
      do { b = src[sIdx++]; matchLen += b; } while (b === 255);
    }
    let mPos = dIdx - offset;
    for (let i = 0; i < matchLen; i++) dst[dIdx++] = dst[mPos++];
  }
  return dst;
}
