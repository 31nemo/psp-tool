// Synthetic patch builders for testing — inverse of the parsers
//
// These construct valid IPS, PPF, and BPS patches from specs,
// making unit tests fully self-contained (no external fixture files).

/** CRC-32 (same as bps.js) */
function crc32(data) {
  let table = crc32._table;
  if (!table) {
    table = crc32._table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Build a valid IPS patch from record specs.
 * @param {Array<{offset: number, data?: Uint8Array, rle?: {count: number, value: number}}>} records
 * @param {number} [truncateSize] - Optional truncation size
 * @returns {Uint8Array}
 */
export function buildIPS(records, truncateSize) {
  const parts = [];

  // Header: "PATCH"
  parts.push(new Uint8Array([0x50, 0x41, 0x54, 0x43, 0x48]));

  for (const rec of records) {
    // 3-byte offset (BE)
    parts.push(new Uint8Array([
      (rec.offset >> 16) & 0xFF,
      (rec.offset >> 8) & 0xFF,
      rec.offset & 0xFF,
    ]));

    if (rec.rle) {
      // RLE: size=0, 2-byte count, 1-byte value
      parts.push(new Uint8Array([0, 0]));
      parts.push(new Uint8Array([
        (rec.rle.count >> 8) & 0xFF,
        rec.rle.count & 0xFF,
      ]));
      parts.push(new Uint8Array([rec.rle.value]));
    } else {
      // Standard: 2-byte size + data
      const data = rec.data;
      parts.push(new Uint8Array([
        (data.length >> 8) & 0xFF,
        data.length & 0xFF,
      ]));
      parts.push(data);
    }
  }

  // EOF sentinel
  parts.push(new Uint8Array([0x45, 0x4F, 0x46]));

  // Optional truncation
  if (truncateSize != null) {
    parts.push(new Uint8Array([
      (truncateSize >> 16) & 0xFF,
      (truncateSize >> 8) & 0xFF,
      truncateSize & 0xFF,
    ]));
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) { result.set(p, off); off += p.length; }
  return result;
}

/**
 * Build a valid PPF v3 patch.
 * @param {Array<{offset: number, data: Uint8Array}>} records
 * @param {{blockCheck?: boolean, undo?: boolean, sourceRom?: Uint8Array}} [opts]
 * @returns {Uint8Array}
 */
export function buildPPF(records, opts = {}) {
  const parts = [];

  // Header: 56 bytes
  const header = new Uint8Array(56);
  header[0] = 0x50; // P
  header[1] = 0x50; // P
  header[2] = 0x46; // F
  header[3] = 0x33; // '3' (v3)
  header[4] = 0x30; // '0'
  header[5] = 0x02; // encoding method

  // Description at offset 6 (50 bytes) — fill with spaces
  for (let i = 6; i < 56; i++) header[i] = 0x20;
  // Write "Test Patch" at offset 6
  const desc = 'Test Patch';
  for (let i = 0; i < desc.length; i++) header[6 + i] = desc.charCodeAt(i);

  parts.push(header);

  // v3 extra: imageType(1) + blockCheckFlag(1) + undoFlag(1) + dummy(1) = 4 bytes
  const v3extra = new Uint8Array(4);
  v3extra[0] = 0; // BIN image type
  v3extra[1] = opts.blockCheck ? 1 : 0;
  v3extra[2] = opts.undo ? 1 : 0;
  v3extra[3] = 0; // dummy/reserved byte
  parts.push(v3extra);

  // Block check validation data (1024 bytes) if enabled — copied from sourceRom at 0x9320
  if (opts.blockCheck) {
    const checkData = new Uint8Array(1024);
    if (opts.sourceRom && opts.sourceRom.length >= 0x9320 + 1024) {
      checkData.set(opts.sourceRom.subarray(0x9320, 0x9320 + 1024));
    }
    parts.push(checkData);
  }

  // Records: 8-byte offset (LE) + 1-byte length + data [+ undo data]
  for (const rec of records) {
    const recBuf = new Uint8Array(8 + 1 + rec.data.length * (opts.undo ? 2 : 1));
    const dv = new DataView(recBuf.buffer);
    dv.setUint32(0, rec.offset, true); // low 32 bits
    dv.setUint32(4, 0, true); // high 32 bits
    recBuf[8] = rec.data.length;
    recBuf.set(rec.data, 9);
    if (opts.undo) {
      // Fill undo data with zeros (original bytes)
      // Already zero from Uint8Array initialization
    }
    parts.push(recBuf);
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) { result.set(p, off); off += p.length; }
  return result;
}

/**
 * Build a valid PPF v1 patch.
 * @param {Array<{offset: number, data: Uint8Array}>} records
 * @returns {Uint8Array}
 */
export function buildPPFv1(records) {
  const parts = [];
  const header = new Uint8Array(56);
  header[0] = 0x50; header[1] = 0x50; header[2] = 0x46;
  header[3] = 0x31; // '1' (v1)
  header[4] = 0x30; // '0'
  parts.push(header);

  for (const rec of records) {
    const recBuf = new Uint8Array(4 + 1 + rec.data.length);
    const dv = new DataView(recBuf.buffer);
    dv.setUint32(0, rec.offset, true);
    recBuf[4] = rec.data.length;
    recBuf.set(rec.data, 5);
    parts.push(recBuf);
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) { result.set(p, off); off += p.length; }
  return result;
}

/**
 * Build a valid PPF v2 patch.
 * @param {Array<{offset: number, data: Uint8Array}>} records
 * @returns {Uint8Array}
 */
export function buildPPFv2(records) {
  const parts = [];
  const header = new Uint8Array(56);
  header[0] = 0x50; header[1] = 0x50; header[2] = 0x46;
  header[3] = 0x32; // '2' (v2)
  header[4] = 0x30; // '0'
  parts.push(header);

  for (const rec of records) {
    const recBuf = new Uint8Array(4 + 1 + rec.data.length);
    const dv = new DataView(recBuf.buffer);
    dv.setUint32(0, rec.offset, true);
    recBuf[4] = rec.data.length;
    recBuf.set(rec.data, 5);
    parts.push(recBuf);
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) { result.set(p, off); off += p.length; }
  return result;
}

/** Encode a BPS variable-length integer. */
export function encodeBPSInt(value) {
  const bytes = [];
  let v = value;
  while (true) {
    let b = v & 0x7F;
    v >>= 7;
    if (v === 0) {
      bytes.push(b | 0x80);
      break;
    }
    bytes.push(b);
    v--;
  }
  return new Uint8Array(bytes);
}

/**
 * Build a valid BPS patch from source→target transformation.
 * Uses TargetRead for all differing bytes (simplest correct strategy).
 * @param {Uint8Array} source
 * @param {Uint8Array} target
 * @returns {Uint8Array}
 */
export function buildBPS(source, target) {
  const parts = [];

  // Header: "BPS1"
  parts.push(new Uint8Array([0x42, 0x50, 0x53, 0x31]));

  // Source size, target size, metadata size (0)
  parts.push(encodeBPSInt(source.length));
  parts.push(encodeBPSInt(target.length));
  parts.push(encodeBPSInt(0)); // no metadata

  // Commands: use SourceRead for matching runs, TargetRead for differing runs
  let i = 0;
  while (i < target.length) {
    // Check if we can use SourceRead (bytes match at same offset)
    if (i < source.length && source[i] === target[i]) {
      let runLen = 0;
      while (i + runLen < target.length && i + runLen < source.length &&
             source[i + runLen] === target[i + runLen]) {
        runLen++;
      }
      // SourceRead: action=0, encode (length-1)<<2 | 0
      parts.push(encodeBPSInt(((runLen - 1) << 2) | 0));
      i += runLen;
    } else {
      // TargetRead: collect differing bytes
      let runLen = 0;
      while (i + runLen < target.length &&
             (i + runLen >= source.length || source[i + runLen] !== target[i + runLen])) {
        runLen++;
      }
      // TargetRead: action=1, encode (length-1)<<2 | 1
      parts.push(encodeBPSInt(((runLen - 1) << 2) | 1));
      parts.push(target.subarray(i, i + runLen));
      i += runLen;
    }
  }

  // Footer: source CRC32, target CRC32, patch CRC32
  const sourceCRC = crc32(source);
  const targetCRC = crc32(target);

  // Build everything except patch CRC
  const footer12 = new Uint8Array(12);
  const fdv = new DataView(footer12.buffer);
  fdv.setUint32(0, sourceCRC, true);
  fdv.setUint32(4, targetCRC, true);
  // Patch CRC will go at offset 8, but we need to compute it first

  // Concatenate everything so far + first 8 bytes of footer
  let totalLen = parts.reduce((s, p) => s + p.length, 0) + 12;
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) { result.set(p, off); off += p.length; }
  result.set(footer12.subarray(0, 8), off);
  off += 8;

  // Compute patch CRC over everything except the last 4 bytes
  const patchCRC = crc32(result.subarray(0, totalLen - 4));
  const pdv = new DataView(result.buffer, totalLen - 4, 4);
  pdv.setUint32(0, patchCRC, true);

  return result;
}
