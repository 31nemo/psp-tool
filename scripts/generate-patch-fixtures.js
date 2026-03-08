#!/usr/bin/env node
// Generate synthetic ROM + patch fixtures for E2E tests
//
// Creates:
//   test/fixtures/patch-test.bin  — 1KB synthetic ROM
//   test/fixtures/patch-test.ips  — IPS patch that modifies known bytes
//   test/fixtures/patch-test.xdelta — xdelta/VCDIFF patch that modifies known bytes

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { init, xd3_encode_memory } from '../vendor/xdelta3-inline.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

// Generate a 1KB ROM with a recognizable pattern
const ROM_SIZE = 1024;
const rom = new Uint8Array(ROM_SIZE);
for (let i = 0; i < ROM_SIZE; i++) rom[i] = i & 0xFF;

// Build an IPS patch that writes [0xDE, 0xAD, 0xBE, 0xEF] at offset 0x100
function buildIPSFixture() {
  const offset = 0x100;
  const data = [0xDE, 0xAD, 0xBE, 0xEF];
  const parts = [];

  // Header
  parts.push(Buffer.from('PATCH'));

  // Record: 3-byte offset + 2-byte size + data
  parts.push(Buffer.from([
    (offset >> 16) & 0xFF, (offset >> 8) & 0xFF, offset & 0xFF,
    (data.length >> 8) & 0xFF, data.length & 0xFF,
    ...data,
  ]));

  // EOF
  parts.push(Buffer.from('EOF'));

  return Buffer.concat(parts);
}

// Build a PPF v3 patch with block check enabled that writes [0xCA, 0xFE] at offset 0x10
// Requires a ROM large enough to have 1024 bytes at 0x9320
function buildPPFBlockCheckFixture(sourceRom) {
  const parts = [];

  // 56-byte header
  const header = new Uint8Array(56);
  header[0] = 0x50; header[1] = 0x50; header[2] = 0x46; // PPF
  header[3] = 0x33; header[4] = 0x30; // v3, '0'
  header[5] = 0x02; // encoding
  for (let i = 6; i < 56; i++) header[i] = 0x20;
  parts.push(Buffer.from(header));

  // v3 extra: imageType=BIN(0), blockCheck=1, undo=0, dummy=0
  parts.push(Buffer.from([0, 1, 0, 0]));

  // 1024-byte block check data from source at 0x9320
  parts.push(Buffer.from(sourceRom.subarray(0x9320, 0x9320 + 1024)));

  // One record: 8-byte offset (LE) + 1-byte len + data
  const data = [0xCA, 0xFE];
  const rec = Buffer.alloc(8 + 1 + data.length);
  rec.writeUInt32LE(0x10, 0); // offset low
  rec.writeUInt32LE(0, 4);    // offset high
  rec[8] = data.length;
  for (let i = 0; i < data.length; i++) rec[9 + i] = data[i];
  parts.push(rec);

  return Buffer.concat(parts);
}

// Large ROM for PPF block check test (needs data at 0x9320)
const LARGE_ROM_SIZE = 0x9320 + 1024;
const largeRom = new Uint8Array(LARGE_ROM_SIZE);
for (let i = 0; i < LARGE_ROM_SIZE; i++) largeRom[i] = (i * 7) & 0xFF;

// Build an xdelta/VCDIFF patch using xdelta3-wasm encoder
// Target: same ROM but with [0xDE, 0xAD, 0xBE, 0xEF] at offset 0x80
async function buildXDELTAFixture() {
  await init();
  const target = new Uint8Array(rom);
  target[0x80] = 0xDE;
  target[0x81] = 0xAD;
  target[0x82] = 0xBE;
  target[0x83] = 0xEF;
  const { ret, str, output } = xd3_encode_memory(target, rom, rom.length * 2);
  if (ret !== 0) throw new Error(`xdelta3 encode failed: ${str}`);
  return output;
}

// Multi-disc fixtures: 3 ROMs with different patterns, 3 xdelta patches
// Each disc ROM is 1KB filled with a unique byte, each patch writes unique bytes at offset 0x40
const DISC_SPECS = [
  { fill: 0x11, patchBytes: [0xAA, 0xBB] },
  { fill: 0x22, patchBytes: [0xCC, 0xDD] },
  { fill: 0x33, patchBytes: [0xEE, 0xFF] },
];

async function buildDiscFixtures() {
  await init();
  for (let i = 0; i < DISC_SPECS.length; i++) {
    const { fill, patchBytes } = DISC_SPECS[i];
    const discNum = i + 1;
    const discRom = new Uint8Array(ROM_SIZE);
    discRom.fill(fill);
    fs.writeFileSync(path.join(FIXTURES, `patch-disc${discNum}.bin`), discRom);

    const target = new Uint8Array(discRom);
    for (let j = 0; j < patchBytes.length; j++) target[0x40 + j] = patchBytes[j];
    const { ret, str, output } = xd3_encode_memory(target, discRom, discRom.length * 2);
    if (ret !== 0) throw new Error(`xdelta3 encode disc${discNum} failed: ${str}`);
    fs.writeFileSync(path.join(FIXTURES, `patch-disc${discNum}.xdelta`), output);
  }
}

async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, 'patch-test.bin'), rom);
  fs.writeFileSync(path.join(FIXTURES, 'patch-test.ips'), buildIPSFixture());
  fs.writeFileSync(path.join(FIXTURES, 'patch-test-large.bin'), largeRom);
  fs.writeFileSync(path.join(FIXTURES, 'patch-test-blockcheck.ppf'), buildPPFBlockCheckFixture(largeRom));

  const xdeltaPatch = await buildXDELTAFixture();
  fs.writeFileSync(path.join(FIXTURES, 'patch-test.xdelta'), xdeltaPatch);

  await buildDiscFixtures();

  console.log('Generated patch fixtures in test/fixtures/');
}

main();
