#!/usr/bin/env node
// Generate XZ test fixtures using the xz CLI tool
//
// Creates small XZ-compressed payloads for unit testing the LZMA/LZMA2/XZ
// decoder. Each fixture is a pair: raw data + XZ-compressed version.

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function compress(data) {
  // Use xz CLI to compress. --check=crc32 for smaller output.
  const result = execSync('xz --compress --format=xz --check=crc32 --stdout', {
    input: Buffer.from(data),
    maxBuffer: 10 * 1024 * 1024,
  });
  return new Uint8Array(result);
}

const fixtures = {
  // Single byte
  'xz-single-byte': new Uint8Array([0x42]),

  // Small repetitive data (compresses well)
  'xz-repetitive': (() => {
    const d = new Uint8Array(256);
    d.fill(0xAA);
    return d;
  })(),

  // Sequential bytes
  'xz-sequential': (() => {
    const d = new Uint8Array(256);
    for (let i = 0; i < 256; i++) d[i] = i;
    return d;
  })(),

  // Mixed pattern (harder to compress)
  'xz-mixed': (() => {
    const d = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) {
      d[i] = (i * 7 + 13) & 0xFF;
    }
    // Add some repetitive sections
    d.fill(0xFF, 200, 400);
    d.fill(0x00, 600, 800);
    return d;
  })(),

  // Larger data (4KB)
  'xz-4k': (() => {
    const d = new Uint8Array(4096);
    // Pattern: groups of repeated bytes
    for (let i = 0; i < 4096; i++) {
      d[i] = (i >>> 4) & 0xFF;
    }
    return d;
  })(),
};

for (const [name, data] of Object.entries(fixtures)) {
  const rawPath = path.join(FIXTURES, `${name}.bin`);
  const xzPath = path.join(FIXTURES, `${name}.xz`);

  fs.writeFileSync(rawPath, data);
  const compressed = compress(data);
  fs.writeFileSync(xzPath, compressed);

  console.log(`${name}: ${data.length} bytes → ${compressed.length} bytes XZ`);
}

console.log('Done generating XZ fixtures');
