#!/usr/bin/env node
// Generate synthetic PS1 disc image fixtures for EBOOT E2E tests.
// Output:
//   test/fixtures/ps1-disc1.bin  — single-disc raw PS1 image (SLUS00001)
//   test/fixtures/ps1-disc2.bin  — second disc raw PS1 image (SLUS00002)
//   test/fixtures/ps1-disc1.cue  — CUE sheet for disc 1

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPS1Disc } from '../test/fixtures.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

fs.mkdirSync(FIXTURES, { recursive: true });

// Disc 1
const disc1 = createMockPS1Disc({ discId: 'SLUS00001', volumeId: 'TEST GAME DISC1', dataSectors: 100 });
fs.writeFileSync(path.join(FIXTURES, 'ps1-disc1.bin'), disc1);
console.log(`Generated ps1-disc1.bin (${disc1.length} bytes, ${disc1.length / 2352} sectors)`);

// Disc 2
const disc2 = createMockPS1Disc({ discId: 'SLUS00002', volumeId: 'TEST GAME DISC2', dataSectors: 100 });
fs.writeFileSync(path.join(FIXTURES, 'ps1-disc2.bin'), disc2);
console.log(`Generated ps1-disc2.bin (${disc2.length} bytes, ${disc2.length / 2352} sectors)`);

// CUE sheet for disc 1
const cue = `FILE "ps1-disc1.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`;
fs.writeFileSync(path.join(FIXTURES, 'ps1-disc1.cue'), cue);
console.log('Generated ps1-disc1.cue');
