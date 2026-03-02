import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateToc, generateTocFromCue, toBcd, framesToMsfBcd } from './helpers.js';

describe('toBcd', () => {
  it('converts 0 to 0x00', () => {
    assert.equal(toBcd(0), 0x00);
  });

  it('converts 99 to 0x99', () => {
    assert.equal(toBcd(99), 0x99);
  });

  it('converts 15 to 0x15', () => {
    assert.equal(toBcd(15), 0x15);
  });

  it('converts 42 to 0x42', () => {
    assert.equal(toBcd(42), 0x42);
  });
});

describe('framesToMsfBcd', () => {
  it('converts 0 frames to [0,0,0]', () => {
    assert.deepEqual(framesToMsfBcd(0), [0x00, 0x00, 0x00]);
  });

  it('converts 150 frames (2 seconds) to [0x00, 0x02, 0x00]', () => {
    assert.deepEqual(framesToMsfBcd(150), [0x00, 0x02, 0x00]);
  });

  it('converts 4500 frames (1 minute) to [0x01, 0x00, 0x00]', () => {
    assert.deepEqual(framesToMsfBcd(4500), [0x01, 0x00, 0x00]);
  });
});

describe('generateToc', () => {
  it('produces 4 entries of 10 bytes each', () => {
    const toc = generateToc(700 * 1024 * 1024, 2352);
    assert.equal(toc.length, 40);
  });

  it('A0 entry has control 0x41 and point 0xA0', () => {
    const toc = generateToc(700 * 1024 * 1024, 2352);
    assert.equal(toc[0], 0x41); // adr/ctrl
    assert.equal(toc[2], 0xA0); // point
  });

  it('A0 entry has PSEC = 0x20 (not BCD-encoded)', () => {
    const toc = generateToc(700 * 1024 * 1024, 2352);
    // A0 entry: bytes [7]=PMIN, [8]=PSEC, [9]=PFRAME
    assert.equal(toc[7], 0x01); // first track
    assert.equal(toc[8], 0x20); // PSEC = 0x20 (disc type)
    assert.equal(toc[9], 0x00);
  });

  it('track 1 starts at 00:02:00 (150 frames)', () => {
    const toc = generateToc(700 * 1024 * 1024, 2352);
    // Track 1 entry is the 4th entry (index 3), at offset 30
    assert.equal(toc[30 + 2], 0x01); // point = track 1
    assert.equal(toc[30 + 7], 0x00); // PMIN
    assert.equal(toc[30 + 8], 0x02); // PSEC
    assert.equal(toc[30 + 9], 0x00); // PFRAME
  });

  it('lead-out position matches expected frames', () => {
    const fileSize = 2352 * 1000; // exactly 1000 sectors
    const toc = generateToc(fileSize, 2352);
    // A2 entry is the 3rd (index 2), at offset 20
    // Lead-out = 1000 + 150 = 1150 frames
    const expected = framesToMsfBcd(1150);
    assert.equal(toc[20 + 7], expected[0]);
    assert.equal(toc[20 + 8], expected[1]);
    assert.equal(toc[20 + 9], expected[2]);
  });
});

describe('generateTocFromCue', () => {
  it('includes per-track entries after A0/A1/A2', () => {
    const tracks = [
      { number: 1, type: 'MODE2/2352', indexes: [{ id: 1, msf: [0, 0, 0] }] },
      { number: 2, type: 'AUDIO', indexes: [{ id: 1, msf: [10, 0, 0] }] },
    ];
    const toc = generateTocFromCue(tracks, 2352 * 100000, 2352);
    // 3 header entries + 2 track entries = 5 entries × 10 bytes
    assert.equal(toc.length, 50);
  });

  it('audio track gets control 0x01', () => {
    const tracks = [
      { number: 1, type: 'MODE2/2352', indexes: [{ id: 1, msf: [0, 0, 0] }] },
      { number: 2, type: 'AUDIO', indexes: [{ id: 1, msf: [10, 0, 0] }] },
    ];
    const toc = generateTocFromCue(tracks, 2352 * 100000, 2352);
    // Track 2 entry is at index 4 (offset 40)
    assert.equal(toc[40], 0x01); // audio control
  });
});
