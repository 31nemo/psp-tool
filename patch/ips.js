// IPS patch format — apply IPS patches to ROM buffers
//
// Format: "PATCH" header, then records until "EOF" sentinel.
// Standard record: 3-byte offset (BE) + 2-byte size (BE) + data
// RLE record: 3-byte offset + size=0 + 2-byte count + 1-byte value
// Optional 3-byte truncation size after EOF.

const IPS_HEADER_SIZE = 5;                         // "PATCH"
const IPS_OFFSET_SIZE = 3;                         // 3-byte big-endian offset per record
const IPS_EOF = [0x45, 0x4F, 0x46];                // "EOF" sentinel

/**
 * Apply an IPS patch to a ROM buffer.
 * @param {Uint8Array} rom - Source ROM data
 * @param {Uint8Array} patch - IPS patch data
 * @returns {Uint8Array} Patched ROM
 */
export function applyIPS(rom, patch) {
  const dv = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);

  // Validate header
  const magic = String.fromCharCode(patch[0], patch[1], patch[2], patch[3], patch[4]);
  if (magic !== 'PATCH') throw new Error('Invalid IPS patch: bad header');

  // Work on a copy; may need to grow for writes past end
  let result = new Uint8Array(rom);
  let pos = IPS_HEADER_SIZE;

  function grow(needed) {
    if (needed > result.length) {
      const bigger = new Uint8Array(needed);
      bigger.set(result);
      result = bigger;
    }
  }

  while (pos + IPS_OFFSET_SIZE <= patch.length) {
    // Check for EOF sentinel
    if (patch[pos] === IPS_EOF[0] && patch[pos + 1] === IPS_EOF[1] && patch[pos + 2] === IPS_EOF[2]) {
      pos += IPS_OFFSET_SIZE;
      break;
    }

    const offset = (patch[pos] << 16) | (patch[pos + 1] << 8) | patch[pos + 2];
    pos += IPS_OFFSET_SIZE;

    const size = (patch[pos] << 8) | patch[pos + 1];
    pos += 2;

    if (size === 0) {
      // RLE record
      const count = (patch[pos] << 8) | patch[pos + 1];
      pos += 2;
      const value = patch[pos];
      pos += 1;
      grow(offset + count);
      result.fill(value, offset, offset + count);
    } else {
      // Standard record
      grow(offset + size);
      result.set(patch.subarray(pos, pos + size), offset);
      pos += size;
    }
  }

  // Optional truncation (3 bytes after EOF)
  if (pos + IPS_OFFSET_SIZE <= patch.length) {
    const truncSize = (patch[pos] << 16) | (patch[pos + 1] << 8) | patch[pos + 2];
    result = result.slice(0, truncSize);
  }

  return result;
}
