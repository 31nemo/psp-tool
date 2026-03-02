import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../vendor/zlib.cjs');

import { compressBlocks, buildPsisoimg } from '../eboot/psisoimg.js';
import { generateToc } from '../eboot/toc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ISO_BLOCK_SIZE = 0x9300; // 37632

// Minimal mock File for Node.js tests
class MockFile {
  constructor(data, name = 'test.bin') {
    this._data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.name = name;
    this.size = this._data.length;
  }
  slice(start, end) {
    const sliced = this._data.slice(start, end);
    return { arrayBuffer: () => Promise.resolve(sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength)) };
  }
}

// Load 4-block fixture and split into individual blocks
const allData = new Uint8Array(fs.readFileSync(join(__dirname, 'fixtures', 'blocks-4x37632.bin')));
const blocks = [];
for (let i = 0; i < 4; i++) {
  blocks.push(allData.slice(i * ISO_BLOCK_SIZE, (i + 1) * ISO_BLOCK_SIZE));
}

describe('compressBlocks', () => {
  it('compresses all 4 blocks and each decompresses to original', () => {
    const { parts, indexEntries } = compressBlocks(blocks, 5);
    assert.equal(parts.length, 4);
    assert.equal(indexEntries.length, 4);

    for (let i = 0; i < 4; i++) {
      const { offset, size } = indexEntries[i];
      let decompressed;
      if (size < ISO_BLOCK_SIZE) {
        decompressed = inflateRaw(parts[i]);
      } else {
        decompressed = parts[i];
      }
      assert.equal(decompressed.length, ISO_BLOCK_SIZE, `Block ${i} decompressed length`);
      assert.deepStrictEqual(
        Array.from(decompressed),
        Array.from(blocks[i]),
        `Block ${i} data mismatch`
      );
    }
  });

  it('index offsets are cumulative', () => {
    const { indexEntries } = compressBlocks(blocks, 5);
    assert.equal(indexEntries[0].offset, 0, 'First entry offset should be 0');
    let expectedOffset = 0;
    for (let i = 0; i < indexEntries.length; i++) {
      assert.equal(indexEntries[i].offset, expectedOffset, `Block ${i} offset`);
      expectedOffset += indexEntries[i].size;
    }
  });

  it('split-range stitching matches full-range result', () => {
    const fullResult = compressBlocks(blocks, 5);
    const firstHalf = compressBlocks(blocks.slice(0, 2), 5);
    const secondHalf = compressBlocks(blocks.slice(2, 4), 5);

    // Parts should be identical
    assert.equal(firstHalf.parts.length + secondHalf.parts.length, fullResult.parts.length);
    for (let i = 0; i < 2; i++) {
      assert.deepStrictEqual(
        Array.from(firstHalf.parts[i]),
        Array.from(fullResult.parts[i]),
        `Part ${i} mismatch`
      );
    }
    for (let i = 0; i < 2; i++) {
      assert.deepStrictEqual(
        Array.from(secondHalf.parts[i]),
        Array.from(fullResult.parts[i + 2]),
        `Part ${i + 2} mismatch`
      );
    }

    // Second half offsets need adjustment — add first half's total size
    const firstHalfTotal = firstHalf.indexEntries.reduce((sum, e) => sum + e.size, 0);
    for (let i = 0; i < 2; i++) {
      const adjusted = secondHalf.indexEntries[i].offset + firstHalfTotal;
      assert.equal(adjusted, fullResult.indexEntries[i + 2].offset,
        `Adjusted offset for block ${i + 2}`);
    }
  });

  it('level 0 stores blocks uncompressed', () => {
    const { parts, indexEntries, stats } = compressBlocks(blocks, 0);
    assert.equal(stats.compressedCount, 0);
    assert.equal(stats.uncompressedCount, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(indexEntries[i].size, ISO_BLOCK_SIZE, `Block ${i} stored size`);
      assert.equal(parts[i].length, ISO_BLOCK_SIZE, `Block ${i} part length`);
    }
  });

  it('short last block gets zero-padded before compression', () => {
    const shortBlock = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) shortBlock[i] = i & 0xFF;

    const blocksWithShort = [...blocks.slice(0, 3), shortBlock];
    const { parts, indexEntries } = compressBlocks(blocksWithShort, 5);

    assert.equal(parts.length, 4);
    // Decompress the last block — should be ISO_BLOCK_SIZE with zero padding
    const lastSize = indexEntries[3].size;
    let decompressed;
    if (lastSize < ISO_BLOCK_SIZE) {
      decompressed = inflateRaw(parts[3]);
    } else {
      decompressed = parts[3];
    }
    assert.equal(decompressed.length, ISO_BLOCK_SIZE, 'Padded block should be full size');
    // First 1000 bytes match original
    for (let i = 0; i < 1000; i++) {
      assert.equal(decompressed[i], i & 0xFF, `Byte ${i}`);
    }
    // Rest should be zeros
    for (let i = 1000; i < ISO_BLOCK_SIZE; i++) {
      assert.equal(decompressed[i], 0, `Padding byte ${i} should be zero`);
    }
  });

  it('stats are correct', () => {
    const { stats } = compressBlocks(blocks, 5);
    assert.equal(stats.compressedCount + stats.uncompressedCount, 4,
      'compressedCount + uncompressedCount === totalBlocks');
    assert.ok(stats.totalCompressedBytes > 0, 'totalCompressedBytes > 0');
    // With compressible data, at least some blocks should compress
    assert.ok(stats.compressedCount > 0, 'Some blocks should compress');
  });
});

describe('buildPsisoimg preCompressed path', () => {
  it('produces identical output to normal compression path', async () => {
    const file = new MockFile(allData, 'test.bin');
    const toc = generateToc(allData.length, 2352);

    // Normal path
    const normalResult = await buildPsisoimg(file, {
      discId: 'SLUS00000',
      title: 'Test Game',
      toc,
      compressionLevel: 5,
    });

    // Pre-compressed path: compress separately, then pass to buildPsisoimg
    const compressed = compressBlocks(blocks, 5);
    const preCompResult = await buildPsisoimg(file.size, {
      discId: 'SLUS00000',
      title: 'Test Game',
      toc,
      compressionLevel: 5,
      preCompressed: compressed,
    });

    assert.equal(preCompResult.data.length, normalResult.data.length,
      'Output sizes should match');
    assert.deepStrictEqual(
      Array.from(preCompResult.data),
      Array.from(normalResult.data),
      'Output bytes should be identical'
    );
    assert.deepStrictEqual(preCompResult.stats, normalResult.stats,
      'Stats should match');
  });

  it('split-range preCompressed matches normal path', async () => {
    const file = new MockFile(allData, 'test.bin');
    const toc = generateToc(allData.length, 2352);

    // Normal path
    const normalResult = await buildPsisoimg(file, {
      discId: 'SLUS00000',
      title: 'Test Game',
      toc,
      compressionLevel: 5,
    });

    // Simulate parallel workers: compress in two halves, then stitch
    const firstHalf = compressBlocks(blocks.slice(0, 2), 5);
    const secondHalf = compressBlocks(blocks.slice(2, 4), 5);

    const firstHalfTotal = firstHalf.stats.totalCompressedBytes;
    const stitched = {
      parts: [...firstHalf.parts, ...secondHalf.parts],
      indexEntries: [
        ...firstHalf.indexEntries,
        ...secondHalf.indexEntries.map(e => ({
          offset: e.offset + firstHalfTotal,
          size: e.size,
          sha1: e.sha1,
        })),
      ],
      stats: {
        compressedCount: firstHalf.stats.compressedCount + secondHalf.stats.compressedCount,
        uncompressedCount: firstHalf.stats.uncompressedCount + secondHalf.stats.uncompressedCount,
        totalCompressedBytes: firstHalf.stats.totalCompressedBytes + secondHalf.stats.totalCompressedBytes,
      },
    };

    const preCompResult = await buildPsisoimg(file.size, {
      discId: 'SLUS00000',
      title: 'Test Game',
      toc,
      compressionLevel: 5,
      preCompressed: stitched,
    });

    assert.equal(preCompResult.data.length, normalResult.data.length,
      'Output sizes should match');
    assert.deepStrictEqual(
      Array.from(preCompResult.data),
      Array.from(normalResult.data),
      'Output bytes should be identical'
    );
  });
});
