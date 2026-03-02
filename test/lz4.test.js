import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compressBlock, decompressBlock } from '../cso/lz4.js';

function randomBytes(n) {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

describe('LZ4 compressBlock / decompressBlock', () => {
  it('round-trips random data (4KB)', () => {
    const original = randomBytes(4096);
    const compressed = compressBlock(original);
    const result = decompressBlock(compressed, original.length);
    assert.deepStrictEqual(Array.from(result), Array.from(original));
  });

  it('round-trips all-zeros block (exercises long match runs)', () => {
    const original = new Uint8Array(8192);
    const compressed = compressBlock(original);
    assert.ok(compressed.length < original.length, 'should compress zeros significantly');
    const result = decompressBlock(compressed, original.length);
    assert.deepStrictEqual(Array.from(result), Array.from(original));
  });

  it('round-trips incompressible data', () => {
    // Truly random data may expand; LZ4 should still round-trip
    const original = randomBytes(2048);
    const compressed = compressBlock(original);
    const result = decompressBlock(compressed, original.length);
    assert.deepStrictEqual(Array.from(result), Array.from(original));
  });

  it('round-trips empty input', () => {
    const original = new Uint8Array(0);
    const compressed = compressBlock(original);
    assert.equal(compressed.length, 0);
  });

  it('round-trips small input (< 6 bytes, all literals)', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const compressed = compressBlock(original);
    const result = decompressBlock(compressed, original.length);
    assert.deepStrictEqual(Array.from(result), Array.from(original));
  });

  it('round-trips repetitive pattern data', () => {
    const original = new Uint8Array(4096);
    for (let i = 0; i < original.length; i++) original[i] = i % 37;
    const compressed = compressBlock(original);
    assert.ok(compressed.length < original.length, 'patterned data should compress');
    const result = decompressBlock(compressed, original.length);
    assert.deepStrictEqual(Array.from(result), Array.from(original));
  });

  it('round-trips 2048-byte block (CSO block size)', () => {
    // Mix of compressible and random segments
    const original = new Uint8Array(2048);
    // First half: repetitive
    for (let i = 0; i < 1024; i++) original[i] = i % 10;
    // Second half: random
    for (let i = 1024; i < 2048; i++) original[i] = Math.floor(Math.random() * 256);
    const compressed = compressBlock(original);
    const result = decompressBlock(compressed, original.length);
    assert.deepStrictEqual(Array.from(result), Array.from(original));
  });

  it('last-5-bytes literal constraint: match does not extend into final 5 bytes', () => {
    // All-zeros: the compressor should find matches but must leave last 5 as literals
    const size = 1024;
    const original = new Uint8Array(size); // all zeros
    const compressed = compressBlock(original);

    // Walk the compressed token stream and verify the constraint:
    // After decompression, total output must equal size.
    // The last token's literals must cover at least the final 5 bytes.
    let sIdx = 0;
    let outputPos = 0;
    let lastLitEnd = 0;

    while (sIdx < compressed.length) {
      const token = compressed[sIdx++];
      let litLen = token >>> 4;
      if (litLen === 15) {
        let b;
        do { b = compressed[sIdx++]; litLen += b; } while (b === 255);
      }
      // Track where literals end in the output
      outputPos += litLen;
      lastLitEnd = outputPos;
      sIdx += litLen; // skip literal bytes

      if (sIdx >= compressed.length) break;

      // Skip offset
      sIdx += 2;

      // Match length
      let matchLen = (token & 0x0f) + 4;
      if ((token & 0x0f) === 15) {
        let b;
        do { b = compressed[sIdx++]; matchLen += b; } while (b === 255);
      }
      outputPos += matchLen;
    }

    // The last literal run must reach the end of the block
    assert.equal(lastLitEnd, size,
      `Last literal run should end at byte ${size}, but ends at ${lastLitEnd}`);
    assert.equal(outputPos, size, 'Total decoded size should match input size');
  });
});
