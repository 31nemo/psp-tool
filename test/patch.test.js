import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyIPS } from '../patch/ips.js';
import { applyPPF } from '../patch/ppf.js';
import { applyBPS, decodeBPSInt } from '../patch/bps.js';
import { applyXDELTA } from '../patch/xdelta.js';
import { detectFormat, applyPatch } from '../patch/index.js';
import { buildIPS, buildPPF, buildPPFv1, buildPPFv2, buildBPS, encodeBPSInt } from './helpers/patch-builders.js';
import { init, xd3_encode_memory } from '../vendor/xdelta3-inline.js';

// ── IPS ──────────────────────────────────────────────────────────────────────

describe('IPS', () => {
  it('applies a standard record (overwrite bytes at offset)', () => {
    const rom = new Uint8Array(16).fill(0);
    const patch = buildIPS([{ offset: 4, data: new Uint8Array([0xAA, 0xBB, 0xCC]) }]);
    const result = applyIPS(rom, patch);
    assert.equal(result[3], 0);
    assert.equal(result[4], 0xAA);
    assert.equal(result[5], 0xBB);
    assert.equal(result[6], 0xCC);
    assert.equal(result[7], 0);
  });

  it('applies an RLE record (repeat byte N times)', () => {
    const rom = new Uint8Array(32).fill(0);
    const patch = buildIPS([{ offset: 8, rle: { count: 5, value: 0xFF } }]);
    const result = applyIPS(rom, patch);
    assert.equal(result[7], 0);
    for (let i = 8; i < 13; i++) assert.equal(result[i], 0xFF);
    assert.equal(result[13], 0);
  });

  it('applies multiple records in sequence', () => {
    const rom = new Uint8Array(32).fill(0);
    const patch = buildIPS([
      { offset: 0, data: new Uint8Array([0x11, 0x22]) },
      { offset: 10, data: new Uint8Array([0x33]) },
      { offset: 20, rle: { count: 3, value: 0x44 } },
    ]);
    const result = applyIPS(rom, patch);
    assert.equal(result[0], 0x11);
    assert.equal(result[1], 0x22);
    assert.equal(result[10], 0x33);
    assert.equal(result[20], 0x44);
    assert.equal(result[22], 0x44);
  });

  it('truncates output when truncation extension is present', () => {
    const rom = new Uint8Array(256).fill(0xAA);
    const patch = buildIPS([{ offset: 0, data: new Uint8Array([0xBB]) }], 128);
    const result = applyIPS(rom, patch);
    assert.equal(result.length, 128);
    assert.equal(result[0], 0xBB);
  });

  it('grows ROM when writing past end', () => {
    const rom = new Uint8Array(8).fill(0);
    const patch = buildIPS([{ offset: 16, data: new Uint8Array([0xDD, 0xEE]) }]);
    const result = applyIPS(rom, patch);
    assert.equal(result.length, 18);
    assert.equal(result[16], 0xDD);
    assert.equal(result[17], 0xEE);
  });

  it('rejects invalid header', () => {
    const bad = new Uint8Array([0, 0, 0, 0, 0]);
    assert.throws(() => applyIPS(new Uint8Array(16), bad), /bad header/);
  });
});

// ── PPF ──────────────────────────────────────────────────────────────────────

describe('PPF', () => {
  it('applies a v3 patch (single record)', () => {
    const rom = new Uint8Array(256).fill(0);
    const patch = buildPPF([{ offset: 100, data: new Uint8Array([0x11, 0x22, 0x33]) }]);
    const result = applyPPF(rom, patch);
    assert.equal(result[99], 0);
    assert.equal(result[100], 0x11);
    assert.equal(result[101], 0x22);
    assert.equal(result[102], 0x33);
    assert.equal(result[103], 0);
  });

  it('applies a v3 patch (multiple records)', () => {
    const rom = new Uint8Array(256).fill(0);
    const patch = buildPPF([
      { offset: 0, data: new Uint8Array([0xAA]) },
      { offset: 200, data: new Uint8Array([0xBB, 0xCC]) },
    ]);
    const result = applyPPF(rom, patch);
    assert.equal(result[0], 0xAA);
    assert.equal(result[200], 0xBB);
    assert.equal(result[201], 0xCC);
  });

  it('applies a v3 patch with block check flag', () => {
    // ROM must be large enough to have 1024 bytes at 0x9320
    const rom = new Uint8Array(0x9320 + 1024).fill(0xAB);
    const patch = buildPPF(
      [{ offset: 10, data: new Uint8Array([0xFF]) }],
      { blockCheck: true, sourceRom: rom },
    );
    const result = applyPPF(rom, patch);
    assert.equal(result[10], 0xFF);
  });

  it('rejects block check when source image is wrong', () => {
    const correctRom = new Uint8Array(0x9320 + 1024).fill(0xAB);
    const patch = buildPPF(
      [{ offset: 10, data: new Uint8Array([0xFF]) }],
      { blockCheck: true, sourceRom: correctRom },
    );
    // Different ROM content at 0x9320
    const wrongRom = new Uint8Array(0x9320 + 1024).fill(0xCD);
    assert.throws(() => applyPPF(wrongRom, patch), /block check failed/);
  });

  it('applies a v3 patch with undo data', () => {
    const rom = new Uint8Array(256).fill(0);
    const patch = buildPPF(
      [{ offset: 50, data: new Uint8Array([0x99]) }],
      { undo: true },
    );
    const result = applyPPF(rom, patch);
    assert.equal(result[50], 0x99);
  });

  it('applies a v1 patch', () => {
    const rom = new Uint8Array(256).fill(0);
    const patch = buildPPFv1([{ offset: 30, data: new Uint8Array([0x77, 0x88]) }]);
    const result = applyPPF(rom, patch);
    assert.equal(result[30], 0x77);
    assert.equal(result[31], 0x88);
  });

  it('applies a v2 patch', () => {
    const rom = new Uint8Array(256).fill(0);
    const patch = buildPPFv2([{ offset: 40, data: new Uint8Array([0x55]) }]);
    const result = applyPPF(rom, patch);
    assert.equal(result[40], 0x55);
  });

  it('rejects invalid header', () => {
    const bad = new Uint8Array(64).fill(0);
    assert.throws(() => applyPPF(new Uint8Array(256), bad), /bad header/);
  });
});

// ── BPS ──────────────────────────────────────────────────────────────────────

describe('BPS', () => {
  it('variable-length integer encode/decode round-trip', () => {
    const values = [0, 1, 127, 128, 255, 1000, 65535, 100000];
    for (const v of values) {
      const encoded = encodeBPSInt(v);
      const decoded = decodeBPSInt(encoded, 0);
      assert.equal(decoded.value, v, `Round-trip failed for ${v}`);
      assert.equal(decoded.newOffset, encoded.length);
    }
  });

  it('applies SourceRead command (bytes match at same offset)', () => {
    const source = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const target = new Uint8Array([0x11, 0x22, 0x33, 0x44]); // identical
    const patch = buildBPS(source, target);
    const result = applyBPS(source, patch);
    assert.deepEqual(result, target);
  });

  it('applies TargetRead command (differing bytes)', () => {
    const source = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    const target = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
    const patch = buildBPS(source, target);
    const result = applyBPS(source, patch);
    assert.deepEqual(result, target);
  });

  it('handles mixed SourceRead and TargetRead', () => {
    const source = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    const target = new Uint8Array([0x11, 0x22, 0xFF, 0xFE, 0x55, 0x66]);
    const patch = buildBPS(source, target);
    const result = applyBPS(source, patch);
    assert.deepEqual(result, target);
  });

  it('handles target larger than source', () => {
    const source = new Uint8Array([0x11, 0x22]);
    const target = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
    const patch = buildBPS(source, target);
    const result = applyBPS(source, patch);
    assert.deepEqual(result, target);
  });

  it('handles target smaller than source', () => {
    const source = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
    const target = new Uint8Array([0x11, 0x22]);
    const patch = buildBPS(source, target);
    const result = applyBPS(source, patch);
    assert.deepEqual(result, target);
  });

  it('validates CRC and rejects corrupted patch', () => {
    const source = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const target = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
    const patch = buildBPS(source, target);
    // Corrupt a byte in the middle
    patch[6] ^= 0xFF;
    assert.throws(() => applyBPS(source, patch), /CRC mismatch/);
  });

  it('validates source CRC and rejects wrong source', () => {
    const source = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const target = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
    const patch = buildBPS(source, target);
    const wrongSource = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
    assert.throws(() => applyBPS(wrongSource, patch), /CRC mismatch/);
  });

  it('rejects invalid header', () => {
    const bad = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
    assert.throws(() => applyBPS(new Uint8Array(4), bad), /bad header/);
  });
});

// ── xdelta/VCDIFF ────────────────────────────────────────────────────────────

describe('xdelta', () => {
  async function buildXDELTA(source, target) {
    await init();
    const maxOut = Math.max(source.length * 2, 4096);
    const { ret, str, output } = xd3_encode_memory(target, source, maxOut);
    if (ret !== 0) throw new Error(`encode failed: ${str}`);
    return output;
  }

  it('applies a simple xdelta patch', async () => {
    const source = new Uint8Array(256).fill(0);
    const target = new Uint8Array(256).fill(0);
    target[0x10] = 0xDE; target[0x11] = 0xAD;
    const patch = await buildXDELTA(source, target);
    const result = await applyXDELTA(source, patch);
    assert.equal(result[0x10], 0xDE);
    assert.equal(result[0x11], 0xAD);
    assert.equal(result.length, 256);
  });

  it('detects VCDIFF magic bytes', async () => {
    const source = new Uint8Array(64).fill(0);
    const target = new Uint8Array(64).fill(0xFF);
    const patch = await buildXDELTA(source, target);
    assert.equal(patch[0], 0xD6);
    assert.equal(patch[1], 0xC3);
    assert.equal(patch[2], 0xC4);
  });

  it('rejects corrupted patch', async () => {
    const source = new Uint8Array(256).fill(0);
    const target = new Uint8Array(256).fill(0);
    target[0] = 0xFF;
    const patch = await buildXDELTA(source, target);
    patch[10] ^= 0xFF;
    await assert.rejects(() => applyXDELTA(source, patch), /VCDIFF/);
  });
});

// ── Format detection ─────────────────────────────────────────────────────────

describe('detectFormat', () => {
  it('detects IPS', () => {
    const patch = buildIPS([{ offset: 0, data: new Uint8Array([1]) }]);
    assert.equal(detectFormat(patch), 'ips');
  });

  it('detects PPF', () => {
    const patch = buildPPF([{ offset: 0, data: new Uint8Array([1]) }]);
    assert.equal(detectFormat(patch), 'ppf');
  });

  it('detects BPS', () => {
    const source = new Uint8Array([0]);
    const target = new Uint8Array([1]);
    const patch = buildBPS(source, target);
    assert.equal(detectFormat(patch), 'bps');
  });

  it('detects xdelta/VCDIFF', () => {
    const patch = new Uint8Array([0xD6, 0xC3, 0xC4, 0x00, 0x00]);
    assert.equal(detectFormat(patch), 'xdelta');
  });

  it('returns null for unknown format', () => {
    assert.equal(detectFormat(new Uint8Array([0, 0, 0, 0, 0])), null);
  });

  it('returns null for too-short data', () => {
    assert.equal(detectFormat(new Uint8Array([1, 2])), null);
  });
});

// ── applyPatch dispatch ──────────────────────────────────────────────────────

describe('applyPatch', () => {
  it('auto-detects and applies IPS patch', async () => {
    const rom = new Uint8Array(16).fill(0);
    const patch = buildIPS([{ offset: 4, data: new Uint8Array([0xAA]) }]);
    const { result, format } = await applyPatch(rom, patch);
    assert.equal(format, 'ips');
    assert.equal(result[4], 0xAA);
  });

  it('auto-detects and applies BPS patch', async () => {
    const source = new Uint8Array([0x11, 0x22, 0x33]);
    const target = new Uint8Array([0x11, 0xFF, 0x33]);
    const bpsPatch = buildBPS(source, target);
    const { result, format } = await applyPatch(source, bpsPatch);
    assert.equal(format, 'bps');
    assert.deepEqual(result, target);
  });

  it('auto-detects and applies xdelta patch', async () => {
    await init();
    const source = new Uint8Array(128).fill(0);
    const target = new Uint8Array(128).fill(0);
    target[0] = 0xAB;
    const { output } = xd3_encode_memory(target, source, 4096);
    const { result, format } = await applyPatch(source, output);
    assert.equal(format, 'xdelta');
    assert.equal(result[0], 0xAB);
  });

  it('throws on unknown format', async () => {
    await assert.rejects(
      () => applyPatch(new Uint8Array(16), new Uint8Array(16)),
      /Unrecognized patch format/,
    );
  });
});
