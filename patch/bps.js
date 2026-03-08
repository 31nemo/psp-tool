// BPS patch format — apply BPS patches with full CRC32 validation
//
// Format: "BPS1" header, variable-length ints for sizes,
// 4 command types: SourceRead, TargetRead, SourceCopy, TargetCopy
// Footer: 3x CRC32 (source, target, patch)

const BPS_MAGIC = [0x42, 0x50, 0x53, 0x31];       // "BPS1"
const BPS_HEADER_SIZE = 4;
const BPS_CRC32_SIZE = 4;
const BPS_FOOTER_SIZE = 12;                        // 3 × CRC32 (source, target, patch)

// Command types (2-bit action field)
const BPS_SOURCE_READ = 0;
const BPS_TARGET_READ = 1;
const BPS_SOURCE_COPY = 2;
const BPS_TARGET_COPY = 3;

/**
 * Decode a BPS variable-length integer.
 * 7 bits per byte, high bit = terminator (1 = last byte).
 * @param {Uint8Array} data
 * @param {number} offset
 * @returns {{value: number, newOffset: number}}
 */
export function decodeBPSInt(data, offset) {
  let value = 0;
  let shift = 1;
  let pos = offset;
  while (true) {
    const b = data[pos++];
    value += (b & 0x7F) * shift;
    if (b & 0x80) break;
    shift <<= 7;
    value += shift;
  }
  return { value, newOffset: pos };
}

/** CRC-32 (ISO 3309) with lazy table init. */
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
 * Apply a BPS patch to a source buffer.
 * @param {Uint8Array} source - Source ROM data
 * @param {Uint8Array} patch - BPS patch data
 * @returns {Uint8Array} Patched target
 */
export function applyBPS(source, patch) {
  // Validate header
  if (patch[0] !== BPS_MAGIC[0] || patch[1] !== BPS_MAGIC[1] || patch[2] !== BPS_MAGIC[2] || patch[3] !== BPS_MAGIC[3]) {
    throw new Error('Invalid BPS patch: bad header');
  }

  // Validate patch CRC (CRC of everything except the last 4 bytes)
  const patchDataEnd = patch.length - BPS_CRC32_SIZE;
  const patchCRC = new DataView(patch.buffer, patch.byteOffset + patchDataEnd, BPS_CRC32_SIZE).getUint32(0, true);
  const computedPatchCRC = crc32(patch.subarray(0, patchDataEnd));
  if (patchCRC !== computedPatchCRC) {
    throw new Error(`BPS patch CRC mismatch: expected ${patchCRC.toString(16)}, got ${computedPatchCRC.toString(16)}`);
  }

  let pos = BPS_HEADER_SIZE;

  // Source size
  const src = decodeBPSInt(patch, pos);
  pos = src.newOffset;
  if (src.value !== source.length) {
    throw new Error(`BPS source size mismatch: expected ${src.value}, got ${source.length}`);
  }

  // Target size
  const tgt = decodeBPSInt(patch, pos);
  pos = tgt.newOffset;
  const target = new Uint8Array(tgt.value);

  // Metadata size (skip metadata)
  const meta = decodeBPSInt(patch, pos);
  pos = meta.newOffset + meta.value;

  // Validate source CRC
  const footerStart = patch.length - BPS_FOOTER_SIZE;
  const sourceCRC = new DataView(patch.buffer, patch.byteOffset + footerStart, BPS_CRC32_SIZE).getUint32(0, true);
  const computedSourceCRC = crc32(source);
  if (sourceCRC !== computedSourceCRC) {
    throw new Error(`BPS source CRC mismatch: expected ${sourceCRC.toString(16)}, got ${computedSourceCRC.toString(16)}`);
  }

  // Apply commands
  let outputOffset = 0;
  let sourceRelOffset = 0;
  let targetRelOffset = 0;
  const commandEnd = footerStart;

  while (pos < commandEnd) {
    const cmd = decodeBPSInt(patch, pos);
    pos = cmd.newOffset;
    const action = cmd.value & 0x03;
    const length = (cmd.value >> 2) + 1;

    switch (action) {
      case BPS_SOURCE_READ: // copy from source at same offset
        for (let i = 0; i < length; i++) {
          target[outputOffset] = source[outputOffset];
          outputOffset++;
        }
        break;

      case BPS_TARGET_READ: // copy bytes from patch data
        for (let i = 0; i < length; i++) {
          target[outputOffset++] = patch[pos++];
        }
        break;

      case BPS_SOURCE_COPY: { // copy from source at relative offset
        const d = decodeBPSInt(patch, pos);
        pos = d.newOffset;
        sourceRelOffset += (d.value & 1 ? -(d.value >> 1) : (d.value >> 1));
        for (let i = 0; i < length; i++) {
          target[outputOffset++] = source[sourceRelOffset++];
        }
        break;
      }

      case BPS_TARGET_COPY: { // copy from target at relative offset
        const d = decodeBPSInt(patch, pos);
        pos = d.newOffset;
        targetRelOffset += (d.value & 1 ? -(d.value >> 1) : (d.value >> 1));
        for (let i = 0; i < length; i++) {
          target[outputOffset++] = target[targetRelOffset++];
        }
        break;
      }
    }
  }

  // Validate target CRC
  const targetCRC = new DataView(patch.buffer, patch.byteOffset + footerStart + BPS_CRC32_SIZE, BPS_CRC32_SIZE).getUint32(0, true);
  const computedTargetCRC = crc32(target);
  if (targetCRC !== computedTargetCRC) {
    throw new Error(`BPS target CRC mismatch: expected ${targetCRC.toString(16)}, got ${computedTargetCRC.toString(16)}`);
  }

  return target;
}
