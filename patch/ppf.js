// PPF patch format — apply PPF v1/v2/v3 patches to disc images
//
// Header: "PPF" + ASCII version digit ('1'=v1, '2'=v2, '3'=v3) + '0' + encoding
// v1: description(50), then records with 4-byte LE offsets
// v2: description(50), then records with 4-byte LE offsets, optional block check at EOF
// v3: description(50), imagetype(1), blockcheck(1), undo(1), reserved(1),
//     optional 1024-byte block check, then records with 8-byte LE offsets
// Total v3 header = 60 bytes before records (or 60+1024 with block check)
//
// Block check validation:
//   v3 BIN: 1024 bytes from source at offset 0x9320
//   v3 GI:  1024 bytes from source at offset 0x80A0
//   v2:     last 1024 bytes of patch, compared to source at offset 0x9320

const PPF_MAGIC = [0x50, 0x50, 0x46];              // "PPF"
const PPF_V1 = 0x31;                               // ASCII '1'
const PPF_V2 = 0x32;                               // ASCII '2'
const PPF_V3 = 0x33;                               // ASCII '3'
const PPF_DESCRIPTION_END = 56;                    // bytes 6–55 = 50-byte description
const PPF_V3_HEADER_SIZE = 60;                     // description(50) + 6 header bytes + 4 extra v3 fields
const PPF_BLOCK_CHECK_SIZE = 1024;
const PPF_V2_BLOCK_CHECK_TRAILER = 1028;           // 4-byte size prefix + 1024-byte block check
const PPF_V3_RECORDS_WITH_CHECK = 1084;            // 60 + 1024 (header + block check)
const PPF_BIN_CHECK_OFFSET = 0x9320;               // block check offset for BIN images
const PPF_GI_CHECK_OFFSET = 0x80A0;                // block check offset for GI images

function validateBlockCheck(rom, expected, romOffset) {
  if (romOffset + PPF_BLOCK_CHECK_SIZE > rom.length) return false;
  for (let i = 0; i < PPF_BLOCK_CHECK_SIZE; i++) {
    if (rom[romOffset + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Apply a PPF patch to a ROM/disc image buffer.
 * @param {Uint8Array} rom - Source image data
 * @param {Uint8Array} patch - PPF patch data
 * @returns {Uint8Array} Patched image
 */
export function applyPPF(rom, patch) {
  const dv = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);

  // Validate magic "PPF"
  if (patch[0] !== PPF_MAGIC[0] || patch[1] !== PPF_MAGIC[1] || patch[2] !== PPF_MAGIC[2]) {
    throw new Error('Invalid PPF patch: bad header');
  }

  // Version is ASCII: '1'=0x31, '2'=0x32, '3'=0x33
  const version = patch[3];
  if (version !== PPF_V1 && version !== PPF_V2 && version !== PPF_V3) {
    throw new Error(`Unsupported PPF version: 0x${version.toString(16)}`);
  }

  const result = new Uint8Array(rom);
  let pos;

  // Description is at bytes 6-55 (50 bytes) for all versions
  // Records start after version-specific headers

  if (version === PPF_V1) {
    // PPF v1: records at offset 56, 4-byte LE offsets
    pos = PPF_DESCRIPTION_END;
    while (pos + 5 <= patch.length) {
      const offset = dv.getUint32(pos, true); pos += 4;
      const len = patch[pos]; pos += 1;
      if (pos + len > patch.length) break;
      result.set(patch.subarray(pos, pos + len), offset);
      pos += len;
    }
  } else if (version === PPF_V2) {
    // PPF v2: records at offset 56, 4-byte LE offsets
    // Block check: last 1028 bytes may be validation data (4-byte size + 1024 bytes)
    pos = PPF_DESCRIPTION_END;
    const hasBlockCheck = patch.length > PPF_DESCRIPTION_END + PPF_V2_BLOCK_CHECK_TRAILER;
    const dataEnd = hasBlockCheck ? patch.length - PPF_V2_BLOCK_CHECK_TRAILER : patch.length;

    if (hasBlockCheck) {
      const expected = patch.subarray(patch.length - PPF_BLOCK_CHECK_SIZE);
      if (!validateBlockCheck(rom, expected, PPF_BIN_CHECK_OFFSET)) {
        throw new Error('PPF block check failed — wrong source image');
      }
    }

    while (pos + 5 <= dataEnd) {
      const offset = dv.getUint32(pos, true); pos += 4;
      const len = patch[pos]; pos += 1;
      if (pos + len > dataEnd) break;
      result.set(patch.subarray(pos, pos + len), offset);
      pos += len;
    }
  } else {
    // PPF v3: extra 3 bytes after description
    const imageType = patch[PPF_DESCRIPTION_END]; // 0=BIN, 1=GI
    const blockCheckFlag = patch[PPF_DESCRIPTION_END + 1];
    const undoFlag = patch[PPF_DESCRIPTION_END + 2];

    pos = PPF_V3_HEADER_SIZE; // past description(50) + imagetype(1) + blockcheck(1) + undo(1) + reserved(1)

    // If block check is present, 1024-byte validation block is at offset 60
    // Records then start at 60 + 1024 = 1084
    if (blockCheckFlag === 1) {
      const checkOffset = imageType === 1 ? PPF_GI_CHECK_OFFSET : PPF_BIN_CHECK_OFFSET;
      const expected = patch.subarray(PPF_V3_HEADER_SIZE, PPF_V3_HEADER_SIZE + PPF_BLOCK_CHECK_SIZE);
      if (!validateBlockCheck(rom, expected, checkOffset)) {
        throw new Error('PPF block check failed — wrong source image');
      }
      pos = PPF_V3_RECORDS_WITH_CHECK;
    }

    const undoMul = undoFlag === 1 ? 2 : 1;

    while (pos + 9 <= patch.length) {
      // 8-byte LE offset (64-bit, but we only support 32-bit range)
      const offsetLo = dv.getUint32(pos, true);
      pos += 8; // skip full 8 bytes
      const len = patch[pos]; pos += 1;
      if (pos + len * undoMul > patch.length) break;
      result.set(patch.subarray(pos, pos + len), offsetLo);
      pos += len * undoMul; // skip undo data if present
    }
  }

  return result;
}
