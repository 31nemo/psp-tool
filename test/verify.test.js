import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPsisoimg, buildPBP, buildSFO, generateToc, ASSETS, verifyEboot, MockFile } from './helpers.js';

const BLOCK_SIZE = 0x9300;

async function buildValidPbp() {
  const discSize = BLOCK_SIZE * 2;
  const discData = new Uint8Array(discSize);
  for (let i = 0; i < discSize; i++) discData[i] = i & 0xFF;
  const file = new MockFile(discData, 'test.bin');
  const toc = generateToc(discSize, 2352);

  const psisoimg = await buildPsisoimg(file, {
    discId: 'SLUS00001',
    title: 'Test Game',
    toc,
    compressionLevel: 5,
  });

  const paramSfo = buildSFO({ title: 'Test Game', discId: 'SLUS00001' });

  return buildPBP({
    paramSfo,
    icon0: new Uint8Array(0),
    dataPsp: ASSETS.dataPsp,
    dataPsar: psisoimg.data,
  });
}

describe('verifyEboot', () => {
  it('passes on a correctly-built EBOOT', async () => {
    const pbp = await buildValidPbp();
    const result = verifyEboot(pbp);
    assert.equal(result.ok, true, result.error);
    assert.ok(result.checks.length > 0);
  });

  it('rejects bad PBP magic', async () => {
    const pbp = await buildValidPbp();
    pbp[0] = 0xFF;
    const result = verifyEboot(pbp);
    assert.equal(result.ok, false);
    assert.match(result.error, /PBP magic/);
  });

  it('rejects non-monotonic section offsets', async () => {
    const pbp = await buildValidPbp();
    const dv = new DataView(pbp.buffer);
    // Make offset[2] < offset[1]
    const offset1 = dv.getUint32(8 + 1 * 4, true);
    dv.setUint32(8 + 2 * 4, offset1 - 1, true);
    const result = verifyEboot(pbp);
    assert.equal(result.ok, false);
    assert.match(result.error, /backwards/);
  });

  it('rejects bad PSISOIMG magic', async () => {
    const pbp = await buildValidPbp();
    const dv = new DataView(pbp.buffer);
    const psarOffset = dv.getUint32(8 + 7 * 4, true);
    // Corrupt the PSISOIMG magic
    pbp[psarOffset] = 0x00;
    const result = verifyEboot(pbp);
    assert.equal(result.ok, false);
    assert.match(result.error, /magic/i);
  });

  it('rejects first index offset != 0', async () => {
    const pbp = await buildValidPbp();
    const dv = new DataView(pbp.buffer);
    const psarOffset = dv.getUint32(8 + 7 * 4, true);
    // Index table at PSISOIMG + 0x4000 (pop-fe layout), first entry offset
    dv.setUint32(psarOffset + 0x4000, 99, true);
    const result = verifyEboot(pbp);
    assert.equal(result.ok, false);
    assert.match(result.error, /First index offset/);
  });

  it('rejects non-zero reserved area', async () => {
    const pbp = await buildValidPbp();
    const dv = new DataView(pbp.buffer);
    const psarOffset = dv.getUint32(8 + 7 * 4, true);
    // Write non-zero into reserved area
    pbp[psarOffset + 0x10] = 0xFF;
    const result = verifyEboot(pbp);
    assert.equal(result.ok, false);
    assert.match(result.error, /Reserved area|non-zero/i);
  });
});
