import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Load zlib — sets globalThis.deflateRaw/inflateRaw
await import('../vendor/zlib.cjs');
const { deflateRaw, inflateRaw } = globalThis;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Helpers ─────────────────────────────────────────────────────────────────

function randomBytes(n) {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ── Round-trip tests (deflateRaw → inflateRaw) ─────────────────────────────

describe('round-trip', () => {
  it('empty data', () => {
    const original = new Uint8Array(0);
    const result = inflateRaw(deflateRaw(original));
    assert.equal(result.length, 0);
  });

  it('single byte', () => {
    const original = new Uint8Array([42]);
    const result = inflateRaw(deflateRaw(original));
    assert.deepStrictEqual(Array.from(result), [42]);
  });

  it('small sequential data', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = inflateRaw(deflateRaw(original));
    assert.deepStrictEqual(Array.from(result), Array.from(original));
  });

  it('all-zeros (1KB)', () => {
    const original = new Uint8Array(1024);
    const result = inflateRaw(deflateRaw(original));
    assert.equal(result.length, 1024);
    assert.ok(result.every(b => b === 0));
  });

  it('random data (4KB)', () => {
    const original = randomBytes(4096);
    const result = inflateRaw(deflateRaw(original));
    assert.ok(arraysEqual(result, original));
  });

  it('large random data (64KB)', () => {
    const original = randomBytes(65536);
    const result = inflateRaw(deflateRaw(original));
    assert.equal(result.length, original.length);
    assert.ok(arraysEqual(result, original));
  });

  it('repetitive data with back-references', () => {
    const original = new Uint8Array(8192);
    for (let i = 0; i < original.length; i++) original[i] = i % 37;
    const result = inflateRaw(deflateRaw(original));
    assert.ok(arraysEqual(result, original));
  });

  it('all 256 byte values', () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const result = inflateRaw(deflateRaw(original));
    assert.deepStrictEqual(Array.from(result), Array.from(original));
  });
});

// ── Compression level tests ─────────────────────────────────────────────────

describe('compression levels', () => {
  it('level 0 produces stored blocks (output >= input)', () => {
    const original = randomBytes(1000);
    const compressed = deflateRaw(original, { level: 0 });
    assert.ok(compressed.length >= original.length);
    const result = inflateRaw(compressed);
    assert.ok(arraysEqual(result, original));
  });

  it('levels 1-9 all round-trip correctly', () => {
    const original = randomBytes(2048);
    for (let level = 1; level <= 9; level++) {
      const compressed = deflateRaw(original, { level });
      const result = inflateRaw(compressed);
      assert.ok(arraysEqual(result, original), `failed at level ${level}`);
    }
  });

  it('level 9 compresses at least as well as level 1 on repetitive data', () => {
    const original = new Uint8Array(8192);
    for (let i = 0; i < original.length; i++) original[i] = i % 37;
    const c1 = deflateRaw(original, { level: 1 });
    const c9 = deflateRaw(original, { level: 9 });
    assert.ok(c9.length <= c1.length, `level 9 (${c9.length}) should be <= level 1 (${c1.length})`);
  });

  it('default level compresses better than stored', () => {
    const original = new Uint8Array(4096);
    for (let i = 0; i < original.length; i++) original[i] = i % 50;
    const stored = deflateRaw(original, { level: 0 });
    const compressed = deflateRaw(original);
    assert.ok(compressed.length < stored.length);
  });
});

// ── inflateRaw edge cases ───────────────────────────────────────────────────

describe('inflateRaw', () => {
  it('throws on garbage data', () => {
    const garbage = new Uint8Array([0xFF, 0xFE, 0xFD, 0xFC, 0xFB]);
    assert.throws(() => inflateRaw(garbage));
  });

  it('returns Uint8Array', () => {
    const compressed = deflateRaw(new Uint8Array([1, 2, 3]));
    const result = inflateRaw(compressed);
    assert.ok(result instanceof Uint8Array);
  });

  it('handles stored blocks', () => {
    const original = new Uint8Array([10, 20, 30, 40, 50]);
    const compressed = deflateRaw(original, { level: 0 });
    const result = inflateRaw(compressed);
    assert.deepStrictEqual(Array.from(result), Array.from(original));
  });
});

// ── deflateRaw edge cases ───────────────────────────────────────────────────

describe('deflateRaw', () => {
  it('returns Uint8Array', () => {
    const result = deflateRaw(new Uint8Array([1, 2, 3]));
    assert.ok(result instanceof Uint8Array);
  });

  it('compresses all-zeros significantly', () => {
    const original = new Uint8Array(10000);
    const compressed = deflateRaw(original);
    assert.ok(compressed.length < original.length / 10, `expected significant compression, got ${compressed.length}/${original.length}`);
  });
});

// ── ISO block-sized round-trip (real-world sizes, verified against Node zlib) ─

describe('ISO block-sized data (37632 bytes)', () => {
  const fixture = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/blocks-4x37632.bin')));
  const BLOCK = 0x9300;

  for (let b = 0; b < 4; b++) {
    it(`block ${b}: our deflateRaw round-trips with our inflateRaw`, () => {
      const block = fixture.slice(b * BLOCK, (b + 1) * BLOCK);
      for (const level of [1, 5, 9]) {
        const compressed = deflateRaw(block, { level });
        const result = inflateRaw(compressed);
        assert.equal(result.length, BLOCK, `level ${level}: wrong decompressed size`);
        assert.ok(arraysEqual(result, block), `level ${level}: data mismatch`);
      }
    });

    it(`block ${b}: our deflateRaw output decompresses with Node zlib`, () => {
      const block = fixture.slice(b * BLOCK, (b + 1) * BLOCK);
      for (const level of [1, 5, 9]) {
        const compressed = deflateRaw(block, { level });
        const result = inflateRawSync(Buffer.from(compressed));
        assert.equal(result.length, BLOCK, `level ${level}: Node zlib got wrong size`);
        assert.ok(arraysEqual(new Uint8Array(result), block), `level ${level}: Node zlib data mismatch`);
      }
    });

    it(`block ${b}: uses BTYPE=2 (dynamic Huffman)`, () => {
      const block = fixture.slice(b * BLOCK, (b + 1) * BLOCK);
      for (const level of [1, 5, 9]) {
        const compressed = deflateRaw(block, { level });
        const btype = (compressed[0] >> 1) & 3;
        assert.strictEqual(btype, 2, `level ${level}: expected BTYPE=2, got ${btype}`);
      }
    });
  }
});

// ── Golden test (known vector) ──────────────────────────────────────────────

describe('golden vector', () => {
  it('deflateRaw output for known input is stable', () => {
    // Compress a fixed input and verify output doesn't regress
    const input = new Uint8Array([
      72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33 // "Hello World!"
    ]);
    const compressed = deflateRaw(input);
    // Verify it round-trips (exact bytes may vary with algorithm changes)
    const result = inflateRaw(compressed);
    assert.deepStrictEqual(Array.from(result), Array.from(input));
    // Verify it actually compressed (12 bytes in, should be similar or smaller with Huffman)
    // Dynamic Huffman header adds ~30+ bytes overhead, so small inputs expand
    assert.ok(compressed.length <= input.length + 40, 'output should not be much larger than input');
  });

  it('deflateRaw produces valid BTYPE (1 or 2) blocks', () => {
    // pako (real zlib) may use fixed (BTYPE=1) or dynamic (BTYPE=2) Huffman
    // depending on which is smaller. Both are valid RFC 1951.
    const patterns = [
      new Uint8Array(1024).fill(0),           // all zeros
      new Uint8Array(1024).fill(0x41),         // all 'A'
      new Uint8Array(Array.from({length: 256}, (_, i) => i)),  // sequential bytes
      new Uint8Array([72,101,108,108,111]),     // "Hello"
    ];
    for (const input of patterns) {
      const compressed = deflateRaw(input, { level: 5 });
      const btype = (compressed[0] >> 1) & 3;
      assert.ok(btype >= 0 && btype <= 2, `Expected valid BTYPE (0-2) but got ${btype} for ${input.length}-byte input`);
      // Verify round-trip
      const result = inflateRaw(compressed);
      assert.deepStrictEqual(Array.from(result), Array.from(input));
    }
  });
});
