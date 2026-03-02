// EBOOT.PBP post-build verification
// Spot-checks the output to catch structural errors before download

const VERIFY_SAMPLE_BLOCKS = 5; // number of random compressed blocks to test-decompress
const VERIFY_ISO_DATA_BASE = 0x100000;
const VERIFY_INDEX_OFFSET = 0x4000;  // pop-fe layout
const VERIFY_BLOCK_SIZE = 0x9300;

/**
 * Verify a built EBOOT.PBP buffer.
 * Returns { ok: true } or { ok: false, error: string }.
 *
 * @param {Uint8Array} pbp - The complete PBP file
 * @returns {{ok: boolean, error?: string, checks?: string[]}}
 */
export function verifyEboot(pbp) {
  const checks = [];
  const dv = new DataView(pbp.buffer, pbp.byteOffset, pbp.byteLength);

  // 1. PBP header magic
  if (pbp[0] !== 0x00 || pbp[1] !== 0x50 || pbp[2] !== 0x42 || pbp[3] !== 0x50) {
    return { ok: false, error: 'PBP magic mismatch' };
  }
  checks.push('PBP magic OK');

  // 2. Section offsets are monotonically increasing and in bounds
  const offsets = [];
  for (let i = 0; i < 8; i++) {
    offsets.push(dv.getUint32(8 + i * 4, true));
  }
  for (let i = 1; i < 8; i++) {
    if (offsets[i] < offsets[i - 1]) {
      return { ok: false, error: `PBP section offset ${i} goes backwards: ${offsets[i]} < ${offsets[i-1]}` };
    }
  }
  if (offsets[7] >= pbp.length) {
    return { ok: false, error: `DATA.PSAR offset ${offsets[7]} exceeds file size ${pbp.length}` };
  }
  checks.push('PBP offsets OK');

  // 3. PARAM.SFO validation
  const sfoOffset = offsets[0];
  const sfoEnd = offsets[1];
  if (sfoEnd - sfoOffset < 20) {
    return { ok: false, error: 'PARAM.SFO too small' };
  }
  if (pbp[sfoOffset] !== 0x00 || pbp[sfoOffset+1] !== 0x50 ||
      pbp[sfoOffset+2] !== 0x53 || pbp[sfoOffset+3] !== 0x46) {
    return { ok: false, error: 'PARAM.SFO magic mismatch' };
  }
  checks.push('PARAM.SFO magic OK');

  // 4. DATA.PSAR magic — PSISOIMG0000 or PSTITLEIMG0000
  const psarOffset = offsets[7];
  const psarMagic = String.fromCharCode(...pbp.slice(psarOffset, psarOffset + 14));
  const isPsisoimg = psarMagic.startsWith('PSISOIMG0000');
  const isPstitleimg = psarMagic.startsWith('PSTITLEIMG0000');
  if (!isPsisoimg && !isPstitleimg) {
    return { ok: false, error: `DATA.PSAR magic unrecognized: "${psarMagic.slice(0, 14)}"` };
  }
  checks.push(`PSAR magic: ${isPstitleimg ? 'PSTITLEIMG' : 'PSISOIMG'} OK`);

  // 5. Find a PSISOIMG section
  let psisoStart;
  if (isPstitleimg) {
    const disc1Offset = dv.getUint32(psarOffset + 0x200, true);
    psisoStart = psarOffset + disc1Offset;
    if (psisoStart + 14 > pbp.length) {
      return { ok: false, error: 'PSTITLEIMG disc 1 offset out of bounds' };
    }
    const disc1Magic = String.fromCharCode(...pbp.slice(psisoStart, psisoStart + 12));
    if (disc1Magic !== 'PSISOIMG0000') {
      return { ok: false, error: `Disc 1 magic mismatch: "${disc1Magic}"` };
    }
    checks.push('PSTITLEIMG disc 1 points to valid PSISOIMG');
  } else {
    psisoStart = psarOffset;
  }

  // 6. Validate p1_offset (must be >= ISO_DATA_BASE)
  const p1_offset = dv.getUint32(psisoStart + 0x0C, true);
  if (p1_offset < VERIFY_ISO_DATA_BASE) {
    return { ok: false, error: `p1_offset 0x${p1_offset.toString(16)} < ISO_DATA_BASE (0x100000)` };
  }
  checks.push(`p1_offset: 0x${p1_offset.toString(16)}`);

  // 7. Validate reserved zeros at 0x10–0x3FF
  let nonZeroCount = 0;
  for (let i = 0x10; i < 0x400 && (psisoStart + i) < pbp.length; i++) {
    if (pbp[psisoStart + i] !== 0) nonZeroCount++;
  }
  if (nonZeroCount > 0) {
    return { ok: false, error: `Reserved area 0x10-0x3FF has ${nonZeroCount} non-zero bytes` };
  }
  checks.push('Reserved zeros OK');

  // 8. Check for disc ID at PSISOIMG + 0x400
  const discIdStart = psisoStart + 0x400;
  if (discIdStart + 11 < pbp.length && pbp[discIdStart] === 0x5F) { // '_'
    const discIdStr = String.fromCharCode(...pbp.slice(discIdStart, discIdStart + 11));
    checks.push(`Disc ID: ${discIdStr}`);
  }

  // 9. Check for TOC at PSISOIMG + 0x800
  const tocStart = psisoStart + 0x800;
  if (tocStart + 10 < pbp.length) {
    const adrCtrl = pbp[tocStart];
    const point = pbp[tocStart + 2];
    if (adrCtrl === 0x41 && point === 0xA0) {
      checks.push('TOC present at 0x800');
    }
  }

  // 10. Validate index table at 0x4000
  const indexStart = psisoStart + VERIFY_INDEX_OFFSET;
  const maxEntries = Math.floor((pbp.length - indexStart) / 32);
  if (maxEntries < 1) {
    return { ok: false, error: 'No index entries found' };
  }

  let numEntries = 0;
  let prevEnd = 0;
  for (let i = 0; i < maxEntries && i < 500000; i++) {
    const entryBase = indexStart + i * 32;
    if (entryBase + 8 > pbp.length) break;
    const offset = dv.getUint32(entryBase, true);
    const length = dv.getUint32(entryBase + 4, true);
    if (length === 0 || length > VERIFY_BLOCK_SIZE) break;
    if (i === 0 && offset !== 0) {
      return { ok: false, error: `First index offset should be 0, got ${offset}` };
    }
    if (i > 0 && offset < prevEnd - 1) break;
    prevEnd = offset + length;
    numEntries = i + 1;
  }

  if (numEntries === 0) {
    return { ok: false, error: `No valid index entries found at 0x${VERIFY_INDEX_OFFSET.toString(16)}` };
  }
  checks.push(`Index table: ${numEntries} blocks`);

  // 11. Sample-decompress a few compressed blocks
  let samplesOk = 0;
  const step = Math.max(1, Math.floor(numEntries / VERIFY_SAMPLE_BLOCKS));
  for (let i = 0; i < numEntries && samplesOk < VERIFY_SAMPLE_BLOCKS; i += step) {
    const entryBase = indexStart + i * 32;
    const offset = dv.getUint32(entryBase, true);
    const length = dv.getUint32(entryBase + 4, true);
    const absOffset = psisoStart + VERIFY_ISO_DATA_BASE + offset;

    if (absOffset + length > pbp.length) {
      return { ok: false, error: `Block ${i} data extends past file end (0x${absOffset.toString(16)} + ${length})` };
    }

    if (length < VERIFY_BLOCK_SIZE) {
      try {
        const blockData = pbp.slice(absOffset, absOffset + length);
        const inflated = inflateRaw(blockData);
        if (inflated.length !== VERIFY_BLOCK_SIZE) {
          return { ok: false, error: `Block ${i} decompressed to ${inflated.length} bytes, expected ${VERIFY_BLOCK_SIZE}` };
        }
      } catch (e) {
        return { ok: false, error: `Block ${i} failed to decompress: ${e.message}` };
      }
    }
    samplesOk++;
  }

  checks.push(`Sample decompress: ${samplesOk} blocks OK`);

  return { ok: true, checks };
}
