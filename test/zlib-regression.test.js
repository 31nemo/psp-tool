import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
require('../vendor/zlib.cjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const block = new Uint8Array(fs.readFileSync(join(__dirname, 'fixtures', 'block-37632.bin')));

// Regression: specific 37632-byte data block triggered an overflow bug in
// codeLengthsFromFreqs — the dynamic Huffman header was invalid because
// overlong codes were capped at maxBits without maintaining the Kraft inequality.
describe('deflateRaw regression: 37632-byte block', () => {
  for (let level = 1; level <= 9; level++) {
    it(`round-trips at level ${level}`, () => {
      const compressed = deflateRaw(block, { level });
      const inflated = inflateRaw(compressed);
      if (inflated.length !== 37632) {
        throw new Error(`inflated to ${inflated.length}, expected 37632`);
      }
      // Spot-check data integrity
      if (inflated[0] !== block[0] || inflated[37631] !== block[37631]) {
        throw new Error('data mismatch');
      }
    });
  }
});
