import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSFO } from './helpers.js';

function getSfoInt(sfo, keyName) {
  const dv = new DataView(sfo.buffer);
  const count = dv.getUint32(16, true);
  const keyTableOffset = dv.getUint32(8, true);
  const dataTableOffset = dv.getUint32(12, true);
  for (let i = 0; i < count; i++) {
    const base = 20 + i * 16;
    const keyOff = dv.getUint16(base, true);
    let key = '';
    for (let j = keyTableOffset + keyOff; sfo[j] !== 0; j++) key += String.fromCharCode(sfo[j]);
    if (key === keyName) {
      const dataOff = dv.getUint32(base + 12, true);
      return dv.getUint32(dataTableOffset + dataOff, true);
    }
  }
  return undefined;
}

describe('buildSFO', () => {
  it('starts with PSF magic 0x00505346', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001' });
    const dv = new DataView(sfo.buffer);
    assert.equal(dv.getUint32(0, true), 0x46535000);
  });

  it('has version 1.1', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001' });
    const dv = new DataView(sfo.buffer);
    assert.equal(dv.getUint32(4, true), 0x00000101);
  });

  it('contains expected keys in alphabetical order', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001' });
    const text = new TextDecoder().decode(sfo);
    const keys = ['BOOTABLE', 'CATEGORY', 'DISC_ID', 'DISC_VERSION',
                  'LICENSE', 'PARENTAL_LEVEL', 'PSP_SYSTEM_VER', 'REGION', 'TITLE'];
    // Keys should appear in order in the binary
    let lastIdx = -1;
    for (const key of keys) {
      const idx = text.indexOf(key);
      assert.ok(idx > lastIdx, `Key "${key}" not in order (at ${idx}, prev was ${lastIdx})`);
      lastIdx = idx;
    }
  });

  it('sets CATEGORY to ME', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001' });
    const text = new TextDecoder().decode(sfo);
    assert.ok(text.includes('ME'), 'CATEGORY ME not found');
  });

  it('sets BOOTABLE to 1', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001' });
    const dv = new DataView(sfo.buffer);
    // BOOTABLE is first entry — its data starts at dataTableOffset
    // Header is 20 bytes, 9 entries * 16 = 144, keyTable at 164
    // We can find it by reading the index table
    const keyTableOffset = dv.getUint32(8, true);
    const dataTableOffset = dv.getUint32(12, true);
    // First entry data offset is at header(20) + 0*16 + 12
    const firstDataOff = dv.getUint32(20 + 12, true);
    assert.equal(dv.getUint32(dataTableOffset + firstDataOff, true), 1);
  });

  it('sets REGION to 0x8000', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001' });
    const dv = new DataView(sfo.buffer);
    const count = dv.getUint32(16, true);
    const dataTableOffset = dv.getUint32(12, true);
    const keyTableOffset = dv.getUint32(8, true);
    // Find REGION entry
    for (let i = 0; i < count; i++) {
      const base = 20 + i * 16;
      const keyOff = dv.getUint16(base, true);
      // Read key name from key table
      let key = '';
      for (let j = keyTableOffset + keyOff; sfo[j] !== 0; j++) {
        key += String.fromCharCode(sfo[j]);
      }
      if (key === 'REGION') {
        const dataOff = dv.getUint32(base + 12, true);
        assert.equal(dv.getUint32(dataTableOffset + dataOff, true), 0x8000);
        return;
      }
    }
    assert.fail('REGION key not found');
  });

  it('omits DISC_TOTAL for single disc', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001', discTotal: 1 });
    const text = new TextDecoder().decode(sfo);
    assert.ok(!text.includes('DISC_TOTAL'), 'DISC_TOTAL should not be present for single disc');
  });

  it('omits DISC_TOTAL for multi-disc (matching Sony format)', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001', discTotal: 3 });
    const text = new TextDecoder().decode(sfo);
    assert.ok(!text.includes('DISC_TOTAL'), 'DISC_TOTAL should not be present (Sony omits it)');
  });

  it('defaults PARENTAL_LEVEL to 3', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001' });
    assert.equal(getSfoInt(sfo, 'PARENTAL_LEVEL'), 3);
  });

  it('accepts custom parentalLevel', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001', parentalLevel: 9 });
    assert.equal(getSfoInt(sfo, 'PARENTAL_LEVEL'), 9);
  });

  it('defaults REGION to 0x8000', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001' });
    assert.equal(getSfoInt(sfo, 'REGION'), 0x8000);
  });

  it('accepts custom region', () => {
    const sfo = buildSFO({ title: 'Test', discId: 'SLUS00001', region: 0x4000 });
    assert.equal(getSfoInt(sfo, 'REGION'), 0x4000);
  });

  it('has correct entry count', () => {
    const sfo1 = buildSFO({ title: 'Test', discId: 'SLUS00001', discTotal: 1 });
    const sfo3 = buildSFO({ title: 'Test', discId: 'SLUS00001', discTotal: 3 });
    const dv1 = new DataView(sfo1.buffer);
    const dv3 = new DataView(sfo3.buffer);
    // Always 9 entries (DISC_TOTAL is never included, matching Sony format)
    assert.equal(dv1.getUint32(16, true), 9);
    assert.equal(dv3.getUint32(16, true), 9);
  });
});
