import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPstitleimg, buildPsisoimg, generateToc, MockFile } from './helpers.js';

const BLOCK_SIZE = 0x9300;
const TEST_OPTS = { discId: 'SLUS00001', title: 'Test Game' };

async function makeTestPsisoimg(fillByte = 1) {
  const discSize = BLOCK_SIZE * 2;
  const discData = new Uint8Array(discSize);
  discData.fill(fillByte);
  const file = new MockFile(discData, `disc${fillByte}.bin`);
  const toc = generateToc(discSize, 2352);
  const result = await buildPsisoimg(file, {
    discId: 'SLUS00001',
    title: 'Test',
    toc,
    compressionLevel: 5,
  });
  return result.data;
}

describe('buildPstitleimg', () => {
  it('writes PSTITLEIMG000000 magic (16 chars)', async () => {
    const disc1 = await makeTestPsisoimg(1);
    const result = buildPstitleimg([disc1], TEST_OPTS);
    const magic = String.fromCharCode(...result.slice(0, 16));
    assert.equal(magic, 'PSTITLEIMG000000');
  });

  it('p1_offset at +0x10 points to STARTDAT', async () => {
    const disc1 = await makeTestPsisoimg(1);
    const result = buildPstitleimg([disc1], TEST_OPTS);
    const dv = new DataView(result.buffer);
    const p1 = dv.getUint32(0x10, true);
    // p1 should point to STARTDAT magic within the result
    assert.ok(p1 < result.length, 'p1 should be before end of data');
    const magic = String.fromCharCode(...result.slice(p1, p1 + 8));
    assert.equal(magic, 'STARTDAT');
  });

  it('writes hash constants at +0x18 as uint32 LE', async () => {
    const disc1 = await makeTestPsisoimg(1);
    const result = buildPstitleimg([disc1], TEST_OPTS);
    const dv = new DataView(result.buffer);
    // First uint32 LE = 0x2CC9C5BC → bytes: BC C5 C9 2C
    assert.equal(result[0x18], 0xBC);
    assert.equal(result[0x19], 0xC5);
    assert.equal(result[0x1A], 0xC9);
    assert.equal(result[0x1B], 0x2C);
    assert.equal(dv.getUint32(0x18, true), 0x2CC9C5BC);
  });

  it('writes disc ID at +0x264', async () => {
    const disc1 = await makeTestPsisoimg(1);
    const result = buildPstitleimg([disc1], TEST_OPTS);
    // +0x260 should be zero, disc ID starts at +0x264
    assert.equal(result[0x260], 0);
    const id = String.fromCharCode(...result.slice(0x264, 0x264 + 11));
    assert.equal(id, '_SLUS_00001');
  });

  it('writes p2 at +0x284 (not +0x280)', async () => {
    const disc1 = await makeTestPsisoimg(1);
    const result = buildPstitleimg([disc1], TEST_OPTS);
    const dv = new DataView(result.buffer);
    // +0x280 should be zero
    assert.equal(dv.getUint32(0x280, true), 0);
    // +0x284 should be p1 + 0x2D31
    const p1 = dv.getUint32(0x10, true);
    assert.equal(dv.getUint32(0x284, true), p1 + 0x2D31);
  });

  it('disc offset table starts at 0x200', async () => {
    const disc1 = await makeTestPsisoimg(1);
    const disc2 = await makeTestPsisoimg(2);
    const result = buildPstitleimg([disc1, disc2], TEST_OPTS);
    const dv = new DataView(result.buffer);
    const offset1 = dv.getUint32(0x200, true);
    const offset2 = dv.getUint32(0x204, true);
    assert.ok(offset1 > 0);
    assert.ok(offset2 > offset1);
  });

  it('first disc starts at 0x8000', async () => {
    const disc1 = await makeTestPsisoimg(1);
    const result = buildPstitleimg([disc1], TEST_OPTS);
    const dv = new DataView(result.buffer);
    const offset = dv.getUint32(0x200, true);
    assert.equal(offset, 0x8000);
  });

  it('each disc has valid PSISOIMG magic', async () => {
    const disc1 = await makeTestPsisoimg(1);
    const disc2 = await makeTestPsisoimg(2);
    const result = buildPstitleimg([disc1, disc2], TEST_OPTS);
    const dv = new DataView(result.buffer);

    for (let d = 0; d < 2; d++) {
      const discOffset = dv.getUint32(0x200 + d * 4, true);
      const magic = String.fromCharCode(...result.slice(discOffset, discOffset + 12));
      assert.equal(magic, 'PSISOIMG0000', `Disc ${d + 1} magic mismatch`);
    }
  });

  it('second disc offset is 0x8000-aligned after first disc', async () => {
    const disc1 = await makeTestPsisoimg(1);
    const disc2 = await makeTestPsisoimg(2);
    const result = buildPstitleimg([disc1, disc2], TEST_OPTS);
    const dv = new DataView(result.buffer);
    const offset1 = dv.getUint32(0x200, true);
    const offset2 = dv.getUint32(0x204, true);
    // Second disc starts at next 0x8000 boundary after first disc ends
    const expected = (offset1 + disc1.length + 0x7FFF) & ~0x7FFF;
    assert.equal(offset2, expected);
    assert.equal(offset2 % 0x8000, 0, 'offset2 should be 0x8000-aligned');
  });

  it('rejects more than 5 discs', () => {
    const fakeDisc = new Uint8Array(100);
    assert.throws(() => buildPstitleimg(new Array(6).fill(fakeDisc), TEST_OPTS), /Invalid disc count/);
  });
});
