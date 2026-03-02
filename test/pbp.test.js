import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPBP } from './helpers.js';

function makeSections(psarSize = 256) {
  return {
    paramSfo: new Uint8Array([0x00, 0x50, 0x53, 0x46, ...new Array(96).fill(0)]),
    icon0: new Uint8Array(16),
    dataPsp: new Uint8Array(32),
    dataPsar: new Uint8Array(psarSize),
  };
}

describe('buildPBP', () => {
  it('starts with \\0PBP magic', () => {
    const pbp = buildPBP(makeSections());
    assert.equal(pbp[0], 0x00);
    assert.equal(pbp[1], 0x50);
    assert.equal(pbp[2], 0x42);
    assert.equal(pbp[3], 0x50);
  });

  it('has version 0x00010000', () => {
    const pbp = buildPBP(makeSections());
    const dv = new DataView(pbp.buffer);
    assert.equal(dv.getUint32(4, true), 0x00010000);
  });

  it('has 8 section offsets monotonically increasing', () => {
    const pbp = buildPBP(makeSections());
    const dv = new DataView(pbp.buffer);
    const offsets = [];
    for (let i = 0; i < 8; i++) {
      offsets.push(dv.getUint32(8 + i * 4, true));
    }
    for (let i = 1; i < 8; i++) {
      assert.ok(offsets[i] >= offsets[i - 1],
        `Offset ${i} (${offsets[i]}) < offset ${i-1} (${offsets[i-1]})`);
    }
  });

  it('aligns PSAR offset to 0x10000 boundary', () => {
    const pbp = buildPBP(makeSections());
    const dv = new DataView(pbp.buffer);
    const psarOffset = dv.getUint32(8 + 7 * 4, true);
    assert.equal(psarOffset % 0x10000, 0, `PSAR offset 0x${psarOffset.toString(16)} not aligned`);
  });

  it('first offset starts at header size 0x28', () => {
    const pbp = buildPBP(makeSections());
    const dv = new DataView(pbp.buffer);
    assert.equal(dv.getUint32(8, true), 0x28);
  });

  it('sections contain correct data', () => {
    const sections = makeSections();
    sections.paramSfo[4] = 0xAA;
    const pbp = buildPBP(sections);
    const dv = new DataView(pbp.buffer);
    const sfoOffset = dv.getUint32(8, true);
    assert.equal(pbp[sfoOffset + 4], 0xAA);
  });

  it('PSAR data is at the aligned offset', () => {
    const sections = makeSections();
    sections.dataPsar[0] = 0xBB;
    const pbp = buildPBP(sections);
    const dv = new DataView(pbp.buffer);
    const psarOffset = dv.getUint32(8 + 7 * 4, true);
    assert.equal(pbp[psarOffset], 0xBB);
  });
});
