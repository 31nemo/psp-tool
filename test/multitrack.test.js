import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockFile, parseCue, generateTocFromCue, buildPsar, buildEboot, verifyEboot } from './helpers.js';
import { createMultiTrackDisc } from './fixtures.js';

describe('multi-file CUE/BIN handling', () => {
  it('parseCue extracts both FILE directives from multi-file CUE', () => {
    const mt = createMultiTrackDisc({ discId: 'SLUS00896' });
    const result = parseCue(mt.cueText);
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0], mt.track1Name);
    assert.equal(result.files[1], mt.track2Name);
    assert.equal(result.tracks.length, 2);
    assert.equal(result.tracks[0].type, 'MODE2/2352');
    assert.equal(result.tracks[1].type, 'AUDIO');
  });

  it('tracks carry their FILE reference', () => {
    const mt = createMultiTrackDisc({ discId: 'SLUS00896' });
    const result = parseCue(mt.cueText);
    assert.equal(result.tracks[0].file, mt.track1Name);
    assert.equal(result.tracks[1].file, mt.track2Name);
  });
});

describe('TOC generation with multi-file CUE', () => {
  it('generates correct track count for multi-track CUE', () => {
    const mt = createMultiTrackDisc({ discId: 'SLUS00896', dataSectors: 100, audioSectors: 50 });
    const tracks = parseCue(mt.cueText).tracks;
    const totalSize = mt.track1.length + mt.track2.length;
    const toc = generateTocFromCue(tracks, totalSize, 2352);
    // 3 header entries (A0, A1, A2) + 2 track entries = 5 entries × 10 bytes
    assert.equal(toc.length, 50);
  });

  it('lead-out reflects combined disc size', () => {
    const mt = createMultiTrackDisc({ discId: 'SLUS00896', dataSectors: 1000, audioSectors: 500 });
    const tracks = parseCue(mt.cueText).tracks;
    const totalSize = mt.track1.length + mt.track2.length;
    const fileSizes = [mt.track1.length, mt.track2.length];
    const toc = generateTocFromCue(tracks, totalSize, 2352, fileSizes);

    // A2 entry at offset 20
    // Lead-out should be totalSectors + 150 frames
    const totalSectors = totalSize / 2352;
    const expectedFrames = totalSectors + 150;
    // Verify it's larger than just track 1
    const track1Frames = mt.track1.length / 2352 + 150;
    // Extract lead-out MSF from TOC
    const fromBcd = b => ((b >> 4) & 0xF) * 10 + (b & 0xF);
    const pmin = fromBcd(toc[27]);
    const psec = fromBcd(toc[28]);
    const pframe = fromBcd(toc[29]);
    const leadOutFrames = pmin * 60 * 75 + psec * 75 + pframe;
    assert.equal(leadOutFrames, expectedFrames);
    assert.ok(leadOutFrames > track1Frames, 'lead-out should include audio track');
  });

  it('track 2 offset accounts for file boundary in multi-file CUE', () => {
    const mt = createMultiTrackDisc({ discId: 'SLUS00896', dataSectors: 1000, audioSectors: 500 });
    const tracks = parseCue(mt.cueText).tracks;
    const totalSize = mt.track1.length + mt.track2.length;
    const fileSizes = [mt.track1.length, mt.track2.length];
    const toc = generateTocFromCue(tracks, totalSize, 2352, fileSizes);

    // Track 2 entry at offset 40 (5th entry: A0, A1, A2, Track1, Track2)
    const fromBcd = b => ((b >> 4) & 0xF) * 10 + (b & 0xF);
    const pmin = fromBcd(toc[47]);
    const psec = fromBcd(toc[48]);
    const pframe = fromBcd(toc[49]);
    const track2Start = pmin * 60 * 75 + psec * 75 + pframe;

    // Track 2 INDEX 01 is at 00:02:00 within its file
    // Absolute position = track1 sectors + 150 (lead-in) + 150 (INDEX 01 at 00:02:00)
    const track1Sectors = mt.track1.length / 2352;
    const expectedTrack2Start = track1Sectors + 150 + 150; // file offset + lead-in + INDEX 01
    assert.equal(track2Start, expectedTrack2Start);
  });

  it('without fileSizes, multi-file INDEX offsets are relative (backwards compat)', () => {
    const mt = createMultiTrackDisc({ discId: 'SLUS00896', dataSectors: 1000, audioSectors: 500 });
    const tracks = parseCue(mt.cueText).tracks;
    const totalSize = mt.track1.length + mt.track2.length;
    // No fileSizes — old behavior
    const toc = generateTocFromCue(tracks, totalSize, 2352);

    const fromBcd = b => ((b >> 4) & 0xF) * 10 + (b & 0xF);
    const pmin = fromBcd(toc[47]);
    const psec = fromBcd(toc[48]);
    const pframe = fromBcd(toc[49]);
    const track2Start = pmin * 60 * 75 + psec * 75 + pframe;

    // Without fileSizes, track 2 INDEX 01 at 00:02:00 = 150 + 150 = 300
    assert.equal(track2Start, 300);
  });
});

describe('end-to-end EBOOT with multi-track disc', () => {
  it('builds and verifies a single-disc EBOOT from merged multi-track BINs', async () => {
    const mt = createMultiTrackDisc({ discId: 'SLUS00896', volumeId: 'TRON_BONNE', dataSectors: 100, audioSectors: 50 });

    // Merge track BINs into a single file (simulating what the UI does)
    const merged = new Uint8Array(mt.track1.length + mt.track2.length);
    merged.set(mt.track1, 0);
    merged.set(mt.track2, mt.track1.length);
    const file = new MockFile(merged, mt.track1Name);

    const tracks = parseCue(mt.cueText).tracks;
    const fileSizes = [mt.track1.length, mt.track2.length];

    const { pbp, buildLog } = await buildEboot({
      files: [file],
      title: 'Tron Bonne',
      discIds: ['SLUS00896'],
      compressionLevel: 1,
      discInfo: [{
        tracks,
        fileSize: merged.length,
        sectorSize: 2352,
        fileSizes,
      }],
    });

    // Verify
    const result = verifyEboot(pbp);
    assert.ok(result.ok, `Verification failed: ${result.error}`);
    assert.ok(result.checks.length > 0);

    // Single disc should use bare PSISOIMG, not PSTITLEIMG wrapper
    const psarMagicCheck = result.checks.find(c => c.includes('PSAR magic'));
    assert.ok(psarMagicCheck.includes('PSISOIMG'), `Single disc should be bare PSISOIMG, got: ${psarMagicCheck}`);

    // Check build log
    assert.equal(buildLog.sfo.discId, 'SLUS00896');
    assert.equal(buildLog.sfo.title, 'Tron Bonne');
    assert.equal(buildLog.sfo.discTotal, 1);
    assert.equal(buildLog.inputFiles.length, 1);
    assert.equal(buildLog.inputFiles[0].trackCount, 2);
  });
});
