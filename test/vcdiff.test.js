import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyVCDIFF } from '../patch/vcdiff.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function readFixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

describe('VCDIFF small patches (4KB)', () => {
  it('applies an xdelta patch with LZMA secondary compression', () => {
    const source = readFixture('vcdiff-lzma-source.bin');
    const target = readFixture('vcdiff-lzma-target.bin');
    const patch = readFixture('vcdiff-lzma.xdelta');
    const result = applyVCDIFF(source, patch);
    assert.deepEqual(result, target);
  });

  it('applies an xdelta patch without secondary compression', () => {
    const source = readFixture('vcdiff-lzma-source.bin');
    const target = readFixture('vcdiff-lzma-target.bin');
    const patch = readFixture('vcdiff-none.xdelta');
    const result = applyVCDIFF(source, patch);
    assert.deepEqual(result, target);
  });
});

describe('VCDIFF multi-window (1MB, 32 windows)', () => {
  // Lazily load since these are 1MB each
  let source, target;
  function loadFixtures() {
    if (!source) {
      source = readFixture('vcdiff-multi-source.bin');
      target = readFixture('vcdiff-multi-target.bin');
    }
  }

  it('applies a 32-window patch without secondary compression', () => {
    loadFixtures();
    const patch = readFixture('vcdiff-multi-none.xdelta');
    const result = applyVCDIFF(source, patch);
    assert.equal(result.length, target.length, 'output size mismatch');
    assert.deepEqual(result, target);
  });

  it('applies a 32-window patch with LZMA secondary compression', () => {
    loadFixtures();
    const patch = readFixture('vcdiff-multi-lzma.xdelta');
    const result = applyVCDIFF(source, patch);
    assert.equal(result.length, target.length, 'output size mismatch');
    assert.deepEqual(result, target);
  });

  it('progress callback fires for each window', () => {
    loadFixtures();
    const patch = readFixture('vcdiff-multi-none.xdelta');
    const progressValues = [];
    applyVCDIFF(source, patch, (pct) => progressValues.push(pct));

    // Should have received multiple progress updates (one per window)
    assert.ok(progressValues.length >= 10,
      `expected >=10 progress callbacks, got ${progressValues.length}`);
    // Progress should be monotonically non-decreasing
    for (let i = 1; i < progressValues.length; i++) {
      assert.ok(progressValues[i] >= progressValues[i - 1],
        `progress went backwards: ${progressValues[i - 1]} → ${progressValues[i]}`);
    }
    // Should reach 100
    assert.equal(progressValues[progressValues.length - 1], 100);
  });

  it('progress callback fires with LZMA compression too', () => {
    loadFixtures();
    const patch = readFixture('vcdiff-multi-lzma.xdelta');
    const progressValues = [];
    applyVCDIFF(source, patch, (pct) => progressValues.push(pct));

    assert.ok(progressValues.length >= 10,
      `expected >=10 progress callbacks, got ${progressValues.length}`);
    assert.equal(progressValues[progressValues.length - 1], 100);
  });

  it('output matches byte-for-byte across both compression modes', () => {
    loadFixtures();
    const patchNone = readFixture('vcdiff-multi-none.xdelta');
    const patchLzma = readFixture('vcdiff-multi-lzma.xdelta');
    const resultNone = applyVCDIFF(source, patchNone);
    const resultLzma = applyVCDIFF(source, patchLzma);
    assert.deepEqual(resultNone, resultLzma,
      'LZMA and uncompressed patches should produce identical output');
  });
});

describe('VCDIFF error handling', () => {
  it('rejects unsupported secondary compression (DJW)', () => {
    // Craft a minimal VCDIFF header with DJW secondary compression
    const patch = new Uint8Array([
      0xD6, 0xC3, 0xC4, 0x00, // magic + version
      0x01,                     // hdr_indicator: VCD_DECOMPRESS
      0x01,                     // compressor ID: DJW
    ]);
    assert.throws(() => applyVCDIFF(new Uint8Array(0), patch), /DJW.*not supported/);
  });

  it('rejects invalid magic bytes', () => {
    const bad = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);
    assert.throws(() => applyVCDIFF(new Uint8Array(0), bad), /invalid magic/);
  });

  it('rejects truncated patch', () => {
    const patch = new Uint8Array([0xD6, 0xC3, 0xC4]);
    assert.throws(() => applyVCDIFF(new Uint8Array(0), patch), /unexpected end/);
  });
});
