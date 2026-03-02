// Compression Web Worker — parallel deflate compression of ISO blocks
//
// The main thread splits the disc image into block ranges and dispatches each
// range to a separate compress-worker instance. This enables multi-core
// compression — the "Workers" slider in the UI controls how many of these
// run simultaneously.
//
// Each worker receives a batch of raw ISO blocks (as transferred ArrayBuffers),
// compresses them via compressBlocks() from psisoimg.js, and returns the
// compressed parts + index entries back to the main thread.
//
// Message protocol:
//   IN:  { blocks: ArrayBuffer[], compressionLevel: 0-9, rangeIndex: number }
//   OUT: { type: 'progress', rangeIndex, blockIndex, totalBlocks }
//   OUT: { type: 'done', rangeIndex, parts: Uint8Array[], indexEntries, stats }
//
// rangeIndex identifies which chunk this worker is handling, so the main
// thread can reassemble results in order.

import { compressBlocks } from './eboot/psisoimg.js';

self.onmessage = function(e) {
  const { blocks, compressionLevel, rangeIndex } = e.data;

  // Convert transferred ArrayBuffers back to Uint8Arrays
  const blockArrays = blocks.map(b => new Uint8Array(b));

  const result = compressBlocks(blockArrays, compressionLevel, {
    onProgress(blockIndex, totalBlocks) {
      self.postMessage({ type: 'progress', rangeIndex, blockIndex, totalBlocks });
    },
  });

  // Transfer compressed buffers back to main thread
  const transferable = result.parts.map(p => p.buffer);
  self.postMessage({
    type: 'done',
    rangeIndex,
    parts: result.parts,
    indexEntries: result.indexEntries,
    stats: result.stats,
  }, transferable);
};
