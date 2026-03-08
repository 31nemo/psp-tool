// Pure JS LZMA decoder
//
// Implements the LZMA compression algorithm decoder. Used by LZMA2 chunks
// within XZ containers for VCDIFF secondary decompression.
//
// References: LZMA SDK (7-zip), lzma-purejs, js-lzma

const kNumBitModelTotalBits = 11;
const kBitModelTotal = 1 << kNumBitModelTotalBits;
const kNumMoveBits = 5;

const kNumPosBitsMax = 4;
const kNumStates = 12;
const kNumLenToPosStates = 4;
const kNumAlignBits = 4;
const kStartPosModelIndex = 4;
const kEndPosModelIndex = 14;
const kNumFullDistances = 1 << (kEndPosModelIndex >>> 1); // 128
const kMatchMinLen = 2;

function initProbs(size) {
  const probs = new Uint16Array(size);
  probs.fill(kBitModelTotal >>> 1);
  return probs;
}

// ── Range Decoder ───────────────────────────────────────────────────────────

class RangeDecoder {
  constructor(data) {
    this.data = data;
    this.pos = 0;
    this.code = 0;
    this.range = 0xFFFFFFFF;
    // LZMA range coder: first byte is ignored, next 4 are the initial code
    if (this.data[this.pos++] !== 0) {
      throw new Error('LZMA: corrupted range coder initial byte');
    }
    for (let i = 0; i < 4; i++) {
      this.code = (this.code << 8) | this.data[this.pos++];
    }
    this.code = this.code >>> 0;
  }

  normalize() {
    if (this.range >>> 0 < 0x01000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.data[this.pos++]) >>> 0;
    }
  }

  decodeBit(probs, index) {
    this.normalize();
    const prob = probs[index];
    const bound = ((this.range >>> kNumBitModelTotalBits) * prob) >>> 0;
    if (this.code >>> 0 < bound) {
      this.range = bound;
      probs[index] = (prob + ((kBitModelTotal - prob) >>> kNumMoveBits)) & 0xFFFF;
      return 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[index] = (prob - (prob >>> kNumMoveBits)) & 0xFFFF;
      return 1;
    }
  }

  decodeDirectBits(numBits) {
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      this.normalize();
      this.range = (this.range >>> 1) >>> 0;
      const t = ((this.code - this.range) >>> 31) ^ 1;
      this.code = (this.code - (this.range & (0 - t))) >>> 0;
      result = (result << 1) | t;
    }
    return result;
  }
}

// ── Bit Tree Decoders ───────────────────────────────────────────────────────

function decodeBitTree(rc, probs, offset, numBits) {
  let m = 1;
  for (let i = 0; i < numBits; i++) {
    m = (m << 1) | rc.decodeBit(probs, offset + m);
  }
  return m - (1 << numBits);
}

function decodeReverseBitTree(rc, probs, offset, numBits) {
  let m = 1, symbol = 0;
  for (let i = 0; i < numBits; i++) {
    const bit = rc.decodeBit(probs, offset + m);
    m = (m << 1) | bit;
    symbol |= bit << i;
  }
  return symbol;
}

// ── Length Decoder ───────────────────────────────────────────────────────────

class LenDecoder {
  constructor() {
    this.choice = initProbs(2);
    this.low = initProbs(1 << (kNumPosBitsMax + 3));
    this.mid = initProbs(1 << (kNumPosBitsMax + 3));
    this.high = initProbs(256);
  }

  reset() {
    this.choice = initProbs(2);
    this.low = initProbs(1 << (kNumPosBitsMax + 3));
    this.mid = initProbs(1 << (kNumPosBitsMax + 3));
    this.high = initProbs(256);
  }

  decode(rc, posState) {
    if (rc.decodeBit(this.choice, 0) === 0) {
      return decodeBitTree(rc, this.low, (posState << 3), 3);
    }
    if (rc.decodeBit(this.choice, 1) === 0) {
      return 8 + decodeBitTree(rc, this.mid, (posState << 3), 3);
    }
    return 16 + decodeBitTree(rc, this.high, 0, 8);
  }
}

// ── Output Window ───────────────────────────────────────────────────────────

class OutputWindow {
  constructor(dictSize) {
    this.buf = new Uint8Array(dictSize);
    this.pos = 0;
    this.size = 0;
    this.dictSize = dictSize;
    this.totalPos = 0;
  }

  putByte(b) {
    this.buf[this.pos] = b;
    this.pos = (this.pos + 1) % this.dictSize;
    if (this.size < this.dictSize) this.size++;
    this.totalPos++;
  }

  getByte(dist) {
    let idx = this.pos - dist - 1;
    if (idx < 0) idx += this.dictSize;
    return this.buf[idx];
  }

  copyBlock(dist, len) {
    let idx = this.pos - dist - 1;
    if (idx < 0) idx += this.dictSize;
    for (let i = 0; i < len; i++) {
      const b = this.buf[idx];
      this.putByte(b);
      idx = (idx + 1) % this.dictSize;
    }
  }

  isEmpty() {
    return this.totalPos === 0;
  }
}

// ── LZMA Decoder ────────────────────────────────────────────────────────────

export class LZMADecoder {
  constructor() {
    this.lc = 0;
    this.lp = 0;
    this.pb = 0;
    this.dictSize = 0;
    this.outWindow = null;

    this.isMatch = null;
    this.isRep = null;
    this.isRepG0 = null;
    this.isRepG1 = null;
    this.isRepG2 = null;
    this.isRep0Long = null;
    this.litProbs = null;
    this.posSlotDecoder = null;
    this.posDecoders = null;
    this.alignDecoder = null;
    this.lenDecoder = null;
    this.repLenDecoder = null;
  }

  init(lc, lp, pb, dictSize) {
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.dictSize = Math.max(dictSize, 1);
    this.outWindow = new OutputWindow(this.dictSize);
    this.resetState();
  }

  resetState() {
    const numPosStates = 1 << this.pb;
    this.isMatch = initProbs(kNumStates * numPosStates);
    this.isRep = initProbs(kNumStates);
    this.isRepG0 = initProbs(kNumStates);
    this.isRepG1 = initProbs(kNumStates);
    this.isRepG2 = initProbs(kNumStates);
    this.isRep0Long = initProbs(kNumStates * numPosStates);
    this.litProbs = initProbs(0x300 << (this.lc + this.lp));
    this.posSlotDecoder = [];
    for (let i = 0; i < kNumLenToPosStates; i++) {
      this.posSlotDecoder.push(initProbs(1 << 7)); // 64 + extra
    }
    this.posDecoders = initProbs(kNumFullDistances - kEndPosModelIndex);
    this.alignDecoder = initProbs(1 << kNumAlignBits);
    this.lenDecoder = new LenDecoder();
    this.repLenDecoder = new LenDecoder();

    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
  }

  resetDict() {
    this.outWindow = new OutputWindow(this.dictSize);
  }

  setProps(lc, lp, pb) {
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    // Recreate probability tables that depend on these
    const numPosStates = 1 << this.pb;
    this.isMatch = initProbs(kNumStates * numPosStates);
    this.isRep0Long = initProbs(kNumStates * numPosStates);
    this.litProbs = initProbs(0x300 << (this.lc + this.lp));
  }

  decodeLiteral(rc, state, rep0) {
    const ow = this.outWindow;
    const prevByte = ow.isEmpty() ? 0 : ow.getByte(0);
    let symbol = 1;
    const litState = ((ow.totalPos & ((1 << this.lp) - 1)) << this.lc) |
                     (prevByte >>> (8 - this.lc));
    const base = litState * 0x300;

    if (state >= 7) {
      // After match: use match byte for context
      let matchByte = ow.getByte(rep0);
      do {
        const matchBit = (matchByte >>> 7) & 1;
        matchByte <<= 1;
        const bit = rc.decodeBit(this.litProbs, base + ((1 + matchBit) << 8) + symbol);
        symbol = (symbol << 1) | bit;
        if (matchBit !== bit) break;
      } while (symbol < 0x100);
    }

    while (symbol < 0x100) {
      symbol = (symbol << 1) | rc.decodeBit(this.litProbs, base + symbol);
    }

    return symbol & 0xFF;
  }

  decodeDistance(rc, len) {
    const lenState = Math.min(len - kMatchMinLen, kNumLenToPosStates - 1);
    const posSlot = decodeBitTree(rc, this.posSlotDecoder[lenState], 0, 6);

    if (posSlot < kStartPosModelIndex) return posSlot;

    const numDirectBits = (posSlot >>> 1) - 1;
    let dist = (2 | (posSlot & 1)) << numDirectBits;

    if (posSlot < kEndPosModelIndex) {
      // Reverse bit tree with fixed offset
      dist += decodeReverseBitTree(rc, this.posDecoders, dist - posSlot - 1, numDirectBits);
    } else {
      dist += rc.decodeDirectBits(numDirectBits - kNumAlignBits) << kNumAlignBits;
      dist += decodeReverseBitTree(rc, this.alignDecoder, 0, kNumAlignBits);
    }
    return dist;
  }

  /**
   * Decode LZMA compressed data.
   * @param {Uint8Array} data - Range-coded LZMA data (starts with range coder init byte)
   * @param {number} uncompressedSize - Expected output size
   * @returns {Uint8Array} Decompressed data
   */
  decode(data, uncompressedSize) {
    const rc = new RangeDecoder(data);
    const ow = this.outWindow;
    const output = new Uint8Array(uncompressedSize);
    let outPos = 0;
    const pbMask = (1 << this.pb) - 1;

    while (outPos < uncompressedSize) {
      const posState = ow.totalPos & pbMask;

      if (rc.decodeBit(this.isMatch, this.state * (pbMask + 1) + posState) === 0) {
        // Literal
        const byte = this.decodeLiteral(rc, this.state, this.rep0);
        ow.putByte(byte);
        output[outPos++] = byte;
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
      } else {
        let len;
        if (rc.decodeBit(this.isRep, this.state) !== 0) {
          // Rep match
          if (rc.decodeBit(this.isRepG0, this.state) === 0) {
            if (rc.decodeBit(this.isRep0Long, this.state * (pbMask + 1) + posState) === 0) {
              // ShortRep
              this.state = this.state < 7 ? 9 : 11;
              const byte = ow.getByte(this.rep0);
              ow.putByte(byte);
              output[outPos++] = byte;
              continue;
            }
          } else {
            let dist;
            if (rc.decodeBit(this.isRepG1, this.state) === 0) {
              dist = this.rep1;
            } else {
              if (rc.decodeBit(this.isRepG2, this.state) === 0) {
                dist = this.rep2;
              } else {
                dist = this.rep3;
                this.rep3 = this.rep2;
              }
              this.rep2 = this.rep1;
            }
            this.rep1 = this.rep0;
            this.rep0 = dist;
          }
          len = this.repLenDecoder.decode(rc, posState) + kMatchMinLen;
          this.state = this.state < 7 ? 8 : 11;
        } else {
          // Match
          this.rep3 = this.rep2;
          this.rep2 = this.rep1;
          this.rep1 = this.rep0;
          len = this.lenDecoder.decode(rc, posState) + kMatchMinLen;
          this.state = this.state < 7 ? 7 : 10;
          this.rep0 = this.decodeDistance(rc, len);
          if (this.rep0 === 0xFFFFFFFF) {
            // End marker (not used in LZMA2 but handle gracefully)
            break;
          }
        }

        // Copy match
        for (let i = 0; i < len && outPos < uncompressedSize; i++) {
          const byte = ow.getByte(this.rep0);
          ow.putByte(byte);
          output[outPos++] = byte;
        }
      }
    }

    return output;
  }
}
