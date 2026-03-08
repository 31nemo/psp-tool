import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decompressXZ } from '../patch/xz.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function readFixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

describe('XZ decompression', () => {
  it('decompresses a single byte', () => {
    const compressed = readFixture('xz-single-byte.xz');
    const expected = readFixture('xz-single-byte.bin');
    const result = decompressXZ(compressed);
    assert.deepEqual(result, expected);
  });

  it('decompresses repetitive data', () => {
    const compressed = readFixture('xz-repetitive.xz');
    const expected = readFixture('xz-repetitive.bin');
    const result = decompressXZ(compressed);
    assert.deepEqual(result, expected);
  });

  it('decompresses sequential bytes', () => {
    const compressed = readFixture('xz-sequential.xz');
    const expected = readFixture('xz-sequential.bin');
    const result = decompressXZ(compressed);
    assert.deepEqual(result, expected);
  });

  it('decompresses mixed pattern data', () => {
    const compressed = readFixture('xz-mixed.xz');
    const expected = readFixture('xz-mixed.bin');
    const result = decompressXZ(compressed);
    assert.deepEqual(result, expected);
  });

  it('decompresses 4KB data', () => {
    const compressed = readFixture('xz-4k.xz');
    const expected = readFixture('xz-4k.bin');
    const result = decompressXZ(compressed);
    assert.deepEqual(result, expected);
  });

  it('rejects invalid magic bytes', () => {
    const bad = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    assert.throws(() => decompressXZ(bad), /invalid magic/);
  });
});
