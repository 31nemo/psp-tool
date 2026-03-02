import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockFile, buildPsisoimg, generateToc } from './helpers.js';
import { createMockPS1Disc } from './fixtures.js';

describe('PSISOIMG title writing', () => {
  it('short title is written correctly at block 5 offset', async () => {
    const disc = createMockPS1Disc({ discId: 'SLUS00001', dataSectors: 50 });
    const file = new MockFile(disc, 'test.bin');
    const toc = generateToc(disc.length, 2352);

    const { data } = await buildPsisoimg(file, {
      discId: 'SLUS00001',
      title: 'Hi', // very short title
      toc,
      compressionLevel: 1,
    });

    // pop-fe layout: title at Block 5 (0x1220) + 12
    const titleStart = 0x1220 + 12;
    const titleBytes = data.slice(titleStart, titleStart + 128);

    // First 2 bytes should be 'Hi'
    assert.equal(titleBytes[0], 'H'.charCodeAt(0));
    assert.equal(titleBytes[1], 'i'.charCodeAt(0));

    // Everything after should be null (buffer is zero-initialized)
    for (let i = 2; i < 128; i++) {
      assert.equal(titleBytes[i], 0, `byte at title offset ${i} should be 0, got ${titleBytes[i]}`);
    }
  });

  it('full-length title fills the field correctly', async () => {
    const disc = createMockPS1Disc({ discId: 'SLUS00001', dataSectors: 50 });
    const file = new MockFile(disc, 'test.bin');
    const toc = generateToc(disc.length, 2352);
    const title = 'A'.repeat(128);

    const { data } = await buildPsisoimg(file, {
      discId: 'SLUS00001',
      title,
      toc,
      compressionLevel: 1,
    });

    const titleStart = 0x1220 + 12;
    for (let i = 0; i < 128; i++) {
      assert.equal(data[titleStart + i], 'A'.charCodeAt(0));
    }
  });
});
