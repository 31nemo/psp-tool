#!/usr/bin/env node
// Generate realistic VCDIFF test fixtures using xdelta3 CLI
//
// Creates 1MB source/target pairs that produce multi-window patches
// with various compression settings. Uses small window sizes (-B, -W)
// to force many windows even at 1MB.
//
// Requires: xdelta3 CLI in PATH
//
// Outputs to test/fixtures/:
//   vcdiff-multi-source.bin    — 1MB source with pseudo-random pattern
//   vcdiff-multi-target.bin    — 1MB target with scattered modifications
//   vcdiff-multi-none.xdelta   — multi-window, no secondary compression
//   vcdiff-multi-lzma.xdelta   — multi-window, LZMA secondary compression

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const SIZE = 1024 * 1024; // 1MB

// Simple deterministic PRNG (mulberry32) for reproducible test data
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Build source: pseudo-random data with some structure
// (repeated patterns mixed with varying content, like a real disc image)
function buildSource() {
  const buf = new Uint8Array(SIZE);
  const rng = mulberry32(12345);

  for (let i = 0; i < SIZE; i++) {
    // Mix of patterns: some blocks are repetitive (like padding in a disc),
    // others are pseudo-random (like compressed/encrypted data)
    const block = Math.floor(i / 4096);
    if (block % 5 === 0) {
      // Repetitive block (simulates padding/headers)
      buf[i] = (i & 0xFF) ^ (block & 0xFF);
    } else if (block % 5 === 1) {
      // Zero-filled block (simulates unused sectors)
      buf[i] = 0;
    } else {
      // Pseudo-random data (simulates game data)
      buf[i] = Math.floor(rng() * 256);
    }
  }
  return buf;
}

// Build target: source with scattered modifications
// - Some regions completely rewritten (simulates patched code/data)
// - Some bytes changed in-place (simulates small fixes)
// - Some regions inserted/shifted
function buildTarget(source) {
  const buf = new Uint8Array(source);
  const rng = mulberry32(67890);

  // 1. Rewrite ~50 scattered 256-byte blocks (simulates patched functions)
  for (let i = 0; i < 50; i++) {
    const offset = Math.floor(rng() * (SIZE - 256));
    for (let j = 0; j < 256; j++) {
      buf[offset + j] = Math.floor(rng() * 256);
    }
  }

  // 2. Single-byte patches at ~200 locations (simulates small fixes)
  for (let i = 0; i < 200; i++) {
    const offset = Math.floor(rng() * SIZE);
    buf[offset] = buf[offset] ^ 0xFF;
  }

  // 3. Overwrite a larger 8KB region (simulates a replaced asset)
  const bigPatchOffset = 0x40000;
  for (let i = 0; i < 8192; i++) {
    buf[bigPatchOffset + i] = Math.floor(rng() * 256);
  }

  return buf;
}

function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });

  console.log('Generating 1MB source...');
  const source = buildSource();
  const sourcePath = path.join(FIXTURES, 'vcdiff-multi-source.bin');
  fs.writeFileSync(sourcePath, source);

  console.log('Generating 1MB target...');
  const target = buildTarget(source);
  const targetPath = path.join(FIXTURES, 'vcdiff-multi-target.bin');
  fs.writeFileSync(targetPath, target);

  // Verify they differ
  let diffCount = 0;
  for (let i = 0; i < SIZE; i++) {
    if (source[i] !== target[i]) diffCount++;
  }
  console.log(`  ${diffCount} bytes differ (${(diffCount / SIZE * 100).toFixed(1)}%)`);

  // Generate multi-window patches with small input window to force many windows.
  // -W 32768: 32KB input window → ~32 windows for 1MB
  // -B 524288: 512KB source window (xdelta3 minimum)
  const windowOpts = '-W 32768 -B 524288';

  // Patch without secondary compression
  const nonePath = path.join(FIXTURES, 'vcdiff-multi-none.xdelta');
  console.log('Generating multi-window patch (no compression)...');
  execSync(`xdelta3 -e -s "${sourcePath}" -S none ${windowOpts} "${targetPath}" "${nonePath}"`);
  const noneSize = fs.statSync(nonePath).size;
  console.log(`  ${nonePath}: ${noneSize} bytes`);

  // Count windows
  const nonePatch = fs.readFileSync(nonePath);
  let windowCount = countVCDIFFWindows(nonePatch);
  console.log(`  ${windowCount} windows`);

  // Patch with LZMA secondary compression
  const lzmaPath = path.join(FIXTURES, 'vcdiff-multi-lzma.xdelta');
  console.log('Generating multi-window patch (LZMA compression)...');
  execSync(`xdelta3 -e -s "${sourcePath}" -S lzma ${windowOpts} "${targetPath}" "${lzmaPath}"`);
  const lzmaSize = fs.statSync(lzmaPath).size;
  console.log(`  ${lzmaPath}: ${lzmaSize} bytes`);

  windowCount = countVCDIFFWindows(fs.readFileSync(lzmaPath));
  console.log(`  ${windowCount} windows`);

  console.log('\nDone! Generated VCDIFF fixtures in test/fixtures/');
}

// Count VCDIFF windows by walking the patch structure
function countVCDIFFWindows(buf) {
  let pos = 4; // skip magic + version
  const hdrIndicator = buf[pos++];
  if (hdrIndicator & 0x01) pos++; // secondary compressor ID
  if (hdrIndicator & 0x02) { // custom code table
    let len = 0, shift = 1;
    while (true) {
      const b = buf[pos++];
      len += (b & 0x7F) * shift;
      if (b & 0x80) break;
      shift *= 128;
    }
    pos += len;
  }
  if (hdrIndicator & 0x04) { // app header
    let len = readVCDIFFInt(buf, pos);
    pos = len.newPos;
    pos += len.value;
  }

  let windows = 0;
  while (pos < buf.length) {
    const winIndicator = buf[pos++];
    if (winIndicator & 0x01 || winIndicator & 0x02) {
      // source/target segment lengths
      let r = readVCDIFFInt(buf, pos); pos = r.newPos;
      r = readVCDIFFInt(buf, pos); pos = r.newPos;
    }
    const deltaLen = readVCDIFFInt(buf, pos);
    pos = deltaLen.newPos + deltaLen.value;
    windows++;
  }
  return windows;
}

function readVCDIFFInt(buf, pos) {
  let val = 0, b;
  do {
    b = buf[pos++];
    val = val * 128 + (b & 0x7F);
  } while (b & 0x80);
  return { value: val, newPos: pos };
}

main();
