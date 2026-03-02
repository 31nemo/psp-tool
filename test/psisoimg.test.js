import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPsisoimg, generateToc, ASSETS, MockFile } from './helpers.js';

// Build a small synthetic disc image — 3 blocks worth of data
const BLOCK_SIZE = 0x9300;
const NUM_BLOCKS = 3;
const DISC_SIZE = BLOCK_SIZE * NUM_BLOCKS;

function makeTestDisc() {
  const data = new Uint8Array(DISC_SIZE);
  // Fill with recognizable pattern per block
  for (let b = 0; b < NUM_BLOCKS; b++) {
    for (let i = 0; i < BLOCK_SIZE; i++) {
      data[b * BLOCK_SIZE + i] = (b + 1) & 0xFF;
    }
  }
  return new MockFile(data, 'test.bin');
}

async function buildTestPsisoimg(compressionLevel = 5) {
  const file = makeTestDisc();
  const toc = generateToc(DISC_SIZE, 2352);
  return buildPsisoimg(file, {
    discId: 'SLUS00001',
    title: 'Test Game',
    toc,
    compressionLevel,
  });
}

describe('buildPsisoimg', () => {
  it('writes magic "PSISOIMG0000" at offset 0x0000', async () => {
    const { data } = await buildTestPsisoimg();
    const magic = String.fromCharCode(...data.slice(0, 12));
    assert.equal(magic, 'PSISOIMG0000');
  });

  it('p1_offset at 0x000C points past compressed data', async () => {
    const { data, stats } = await buildTestPsisoimg();
    const dv = new DataView(data.buffer);
    const p1 = dv.getUint32(0x0C, true);
    // p1 = aligned end of compressed data (>= 0x100000 + totalCompressedBytes)
    assert.ok(p1 >= 0x100000 + stats.totalCompressedBytes);
  });

  it('reserved area 0x0010–0x03FF is all zeros', async () => {
    const { data } = await buildTestPsisoimg();
    for (let i = 0x10; i < 0x400; i++) {
      assert.equal(data[i], 0, `Non-zero at offset 0x${i.toString(16)}`);
    }
  });

  it('disc ID is at 0x0400', async () => {
    const { data } = await buildTestPsisoimg();
    // Disc ID formatted as "_SLUS_00001"
    const discId = String.fromCharCode(...data.slice(0x400, 0x400 + 11));
    assert.equal(discId, '_SLUS_00001');
  });

  it('TOC is present at 0x0800', async () => {
    const { data } = await buildTestPsisoimg();
    // A0 entry starts the TOC
    assert.equal(data[0x800], 0x41); // control
    assert.equal(data[0x802], 0xA0); // point
  });

  it('disc start offset at 0x0BFC = 0x100000', async () => {
    const { data } = await buildTestPsisoimg();
    const dv = new DataView(data.buffer);
    assert.equal(dv.getUint32(0x0BFC, true), 0x100000);
  });

  it('block 5 has 0xFF07 marker and title', async () => {
    const { data } = await buildTestPsisoimg();
    // Block 5 at 0x1220: bytes 8-9 = 0xFF 0x07, title at +12
    assert.equal(data[0x1220 + 8], 0xFF);
    assert.equal(data[0x1220 + 9], 0x07);
    const title = String.fromCharCode(...data.slice(0x1220 + 12, 0x1220 + 12 + 9));
    assert.equal(title, 'Test Game');
  });

  it('p2 value at 0x1220 = p1 + 0x2D31', async () => {
    const { data } = await buildTestPsisoimg();
    const dv = new DataView(data.buffer);
    const p1 = dv.getUint32(0x0C, true);
    const p2 = dv.getUint32(0x1220, true);
    assert.equal(p2, p1 + 0x2D31);
  });

  it('index table starts at 0x4000 with uint16 sizes', async () => {
    const { data } = await buildTestPsisoimg();
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // First entry: offset should be 0
    const firstOffset = dv.getUint32(0x4000, true);
    assert.equal(firstOffset, 0, 'First index entry offset should be 0');
    // First entry: size (uint16) should be > 0
    const firstLen = dv.getUint16(0x4004, true);
    assert.ok(firstLen > 0, 'First index entry length should be > 0');
    assert.ok(firstLen <= BLOCK_SIZE, 'Index entry size should be <= block size');
  });

  it('index entries have SHA-1 hashes', async () => {
    const { data } = await buildTestPsisoimg();
    // SHA-1 hash at index entry bytes 8-23
    const hashStart = 0x4000 + 8;
    let hasNonZero = false;
    for (let i = 0; i < 16; i++) {
      if (data[hashStart + i] !== 0) { hasNonZero = true; break; }
    }
    assert.ok(hasNonZero, 'SHA-1 hash should not be all zeros');
  });

  it('index offsets are cumulative', async () => {
    const { data } = await buildTestPsisoimg();
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let expectedOffset = 0;
    for (let i = 0; i < NUM_BLOCKS; i++) {
      const entryBase = 0x4000 + i * 32;
      const offset = dv.getUint32(entryBase, true);
      const length = dv.getUint16(entryBase + 4, true);
      assert.equal(offset, expectedOffset, `Block ${i} offset mismatch`);
      expectedOffset += length;
    }
  });

  it('ISO data starts at 0x100000', async () => {
    const { data } = await buildTestPsisoimg();
    assert.equal(data[0x100000 - 1], 0, 'Byte before ISO_DATA_BASE should be zero');
    let hasData = false;
    for (let i = 0; i < 100; i++) {
      if (data[0x100000 + i] !== 0) { hasData = true; break; }
    }
    assert.ok(hasData, 'No data found at ISO_DATA_BASE');
  });

  it('compressed blocks decompress to original data', async () => {
    const { data } = await buildTestPsisoimg();
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

    for (let i = 0; i < NUM_BLOCKS; i++) {
      const entryBase = 0x4000 + i * 32;
      const offset = dv.getUint32(entryBase, true);
      const length = dv.getUint16(entryBase + 4, true);
      const absOffset = 0x100000 + offset;
      const blockData = data.slice(absOffset, absOffset + length);

      let decompressed;
      if (length < BLOCK_SIZE) {
        decompressed = inflateRaw(blockData);
      } else {
        decompressed = blockData;
      }
      assert.equal(decompressed.length, BLOCK_SIZE);
      const expected = (i + 1) & 0xFF;
      assert.equal(decompressed[0], expected, `Block ${i} first byte`);
      assert.equal(decompressed[BLOCK_SIZE - 1], expected, `Block ${i} last byte`);
    }
  });

  it('STARTDAT is present after aligned compressed data', async () => {
    const { data } = await buildTestPsisoimg();
    const dv = new DataView(data.buffer);
    const p1 = dv.getUint32(0x0C, true);
    const startdatMagic = String.fromCharCode(...data.slice(p1, p1 + 8));
    assert.equal(startdatMagic, 'STARTDAT');
  });

  it('uncompressed mode (level 0) stores raw blocks', async () => {
    const { data, stats } = await buildTestPsisoimg(0);
    assert.equal(stats.uncompressedCount, NUM_BLOCKS);
    assert.equal(stats.compressedCount, 0);
    assert.equal(stats.totalCompressedBytes, BLOCK_SIZE * NUM_BLOCKS);
  });
});
