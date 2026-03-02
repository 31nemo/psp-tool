#!/usr/bin/env node
// Generate a synthetic ISO fixture for unit and E2E tests.
// Output: test/fixtures/test.iso (~64KB, 32 blocks of 2048 bytes)
//
// Block pattern alternates between compressible (repeating) and
// pseudo-random (LCG) data, exercising both compressed and uncompressed
// storage paths in CSO/ZSO formats.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE_PATH = path.join(ROOT, 'test', 'fixtures', 'test.iso');

const BLOCK_SIZE = 2048;
const TOTAL_BLOCKS = 32;
const TOTAL_BYTES = BLOCK_SIZE * TOTAL_BLOCKS; // 65536

const iso = new Uint8Array(TOTAL_BYTES);

for (let b = 0; b < TOTAL_BLOCKS; b++) {
  const offset = b * BLOCK_SIZE;
  if (b % 2 === 0) {
    // Compressible: repeating pattern
    for (let i = 0; i < BLOCK_SIZE; i++) {
      iso[offset + i] = (b + i) % 251;
    }
  } else {
    // Less compressible: pseudo-random via simple LCG
    let seed = b * 1337;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      iso[offset + i] = (seed >>> 16) & 0xff;
    }
  }
}

fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
fs.writeFileSync(FIXTURE_PATH, iso);
console.log(`Generated ${FIXTURE_PATH} (${TOTAL_BYTES} bytes, ${TOTAL_BLOCKS} blocks)`);
