// PSISOIMG0000 writer — single-disc PlayStation ARchive (PSAR) construction
//
// Compresses a PS1 disc image into the format Sony's POPS (PlayStation One
// PS Portable Station) emulator expects. Each 0x9300-byte block of the disc
// is independently deflate-compressed, with an index table for random access.
//
// Uses the pop-fe / Sony PSN layout variant. See docs/eboot-format.md for the
// full byte-level spec, layout variants, and source references.
//
// Memory layout:
//   Block 1  (0x0000)   magic "PSISOIMG0000" + p1_offset
//   Block 2  (0x0400)   disc ID string (e.g. "_SLUS_00896")
//   Block 3  (0x0800)   TOC data + disc start offset at +0x3FC
//   Block 4  (0x0C00)   audio track table (zeros for data-only discs)
//   Block 5  (0x1220)   p2_offset + 0xFF07 marker + game title
//   Blocks 6–16 (0x1400) reserved zeros
//   Index    (0x4000)   32-byte entries: offset, size, flags, SHA-1 truncated
//   Gap      (index end → 0x100000) zero padding
//   ISO data (0x100000) compressed blocks (raw deflate, RFC 1951)
//   STARTDAT (after ISO) boot splash header + PGD footer (single-disc only)
//
// Sources:
//   pop-fe: https://github.com/sahlberg/pop-fe (popstation.py)
//   beetle-psx-libretro: CDAccess_PBP.cpp (reference reader)
//   PSDevWiki: https://www.psdevwiki.com/ps3/PSISOIMG0000

const PSISOIMG_MAGIC = 'PSISOIMG0000';

const ISO_BLOCK_SIZE = 0x9300;   // 37,632 bytes — POPS reads disc in these chunks
const INDEX_ENTRY_SIZE = 32;     // 4 offset + 2 size + 2 flags + 16 SHA-1 + 8 padding
const ISO_DATA_BASE = 0x100000;  // compressed blocks always start at 1 MB
const INDEX_OFFSET = 0x4000;     // index table starts after all header blocks
const STARTDAT_CONST = 0x2D31;   // offset added to p1 for p2 calculation

// Header block offsets (pop-fe layout uses 1024-byte blocks)
const BLOCK1_OFFSET = 0x0000;    // magic + p1_offset
const BLOCK2_OFFSET = 0x0400;    // disc ID + POPS config area
const BLOCK3_OFFSET = 0x0800;    // TOC + disc start offset
const BLOCK4_OFFSET = 0x0C00;    // audio track table (CDDA/AT3)
const BLOCK5_OFFSET = 0x1220;    // p2_offset + 0xFF07 + title string
// Blocks 6–16: 0x1400, 11264 bytes of zeros (implicit from Uint8Array init)

// ── STARTDAT generators ──────────────────────────────────────────────────────
//
// STARTDAT is appended after the compressed ISO data in single-disc EBOOTs.
// It contains a boot splash image (originally a 480×272 grayscale PNG) wrapped
// in a header, plus a PGD (PlayStation Game Data) footer with crypto hashes.
//
// On custom firmware, POPS doesn't validate the splash image content or PGD
// signatures — these sections just need to exist with the right structure.
/** Build an 80-byte STARTDAT header. Points to the logo PNG that follows. */
export function makeStartdatHeader(logoSize) {
  const buf = new Uint8Array(0x50); // 80 bytes, zero-initialized
  const dv = new DataView(buf.buffer);
  const magic = 'STARTDAT';
  for (let i = 0; i < magic.length; i++) buf[i] = magic.charCodeAt(i);
  dv.setUint32(0x08, 1, true);           // version
  dv.setUint32(0x0C, 1, true);           // version
  dv.setUint32(0x10, 0x50, true);        // header size (80 bytes)
  dv.setUint32(0x14, logoSize, true);     // logo PNG size in bytes
  return buf;
}

/**
 * Generate a minimal valid 1×1 grayscale PNG for the STARTDAT logo.
 *
 * The original is a 480×272 grayscale boot splash from popstationr, but POPS
 * on CFW doesn't render or validate it — the section just needs a valid PNG.
 * Built per PNG spec (https://www.w3.org/TR/png/): signature + IHDR + IDAT + IEND.
 */
export function makeStartdatLogo() {
  const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

  function chunk(type, data) {
    const out = [];
    // Length (4 bytes big-endian)
    out.push((data.length >> 24) & 0xFF, (data.length >> 16) & 0xFF,
             (data.length >> 8) & 0xFF, data.length & 0xFF);
    // Type (4 bytes ASCII)
    for (let i = 0; i < 4; i++) out.push(type.charCodeAt(i));
    // Data
    for (let i = 0; i < data.length; i++) out.push(data[i]);
    // CRC32 over type+data
    const crcData = [];
    for (let i = 0; i < 4; i++) crcData.push(type.charCodeAt(i));
    for (let i = 0; i < data.length; i++) crcData.push(data[i]);
    const crc = crc32(crcData);
    out.push((crc >> 24) & 0xFF, (crc >> 16) & 0xFF, (crc >> 8) & 0xFF, crc & 0xFF);
    return out;
  }

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // IHDR: 1x1, 8-bit grayscale
  const ihdr = [0,0,0,1, 0,0,0,1, 8, 0, 0, 0, 0]; // w=1, h=1, depth=8, colorType=0(gray)
  // IDAT: zlib-wrapped scanline (filter=0, pixel=0x00)
  // Minimal valid zlib stream: CMF=0x78, FLG=0x01, stored block, adler32
  const scanline = [0x00, 0x00]; // filter byte + 1 gray pixel
  const adler = adler32(scanline);
  const idat = [
    0x78, 0x01,                            // zlib header (deflate, no dict)
    0x01,                                   // BFINAL=1, BTYPE=00 (stored)
    scanline.length & 0xFF, (scanline.length >> 8) & 0xFF,
    ~scanline.length & 0xFF, (~scanline.length >> 8) & 0xFF,
    ...scanline,
    (adler >> 24) & 0xFF, (adler >> 16) & 0xFF, (adler >> 8) & 0xFF, adler & 0xFF,
  ];

  function adler32(bytes) {
    let a = 1, b = 0;
    for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  }

  const png = [...signature, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', [])];
  return new Uint8Array(png);
}

/**
 * Generate a stub STARTDAT footer (4976 bytes).
 *
 * The original is a PGD (PlayStation Game Data) container with crypto hashes.
 * On CFW, POPS doesn't validate PGD signatures — it just needs to be present
 * and the right size. We write the PGD magic and version fields for structural
 * correctness but leave the crypto fields zeroed.
 */
export function makeStartdatFooter() {
  const FOOTER_SIZE = 4976;
  const buf = new Uint8Array(FOOTER_SIZE); // zero-initialized
  const dv = new DataView(buf.buffer);
  // .PGD magic + version fields (matches original structure)
  buf[0] = 0x00; buf[1] = 0x50; buf[2] = 0x47; buf[3] = 0x44; // "\0PGD"
  dv.setUint32(0x04, 1, true);  // version
  dv.setUint32(0x08, 1, true);  // version
  // Rest is zeros (original had crypto hashes that CFW ignores)
  return buf;
}

// ── Synchronous SHA-1 ──────────────────────────────────────────────────────────
//
// Minimal SHA-1 implementation (FIPS 180-4) for computing per-block hashes
// stored in the index table. Only the first 16 of 20 hash bytes are kept.
//
// We use a synchronous implementation rather than Web Crypto because
// crypto.subtle.digest() is async — hashing ~18K blocks in a compression
// loop would require 18K awaits with microtask queue overhead. Synchronous
// SHA-1 on blocks of at most 37,632 bytes is fast enough.
//
// SHA-1 spec: https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf
function sha1(data) {
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;

  const msgLen = data.length;
  const bitLen = msgLen * 8;
  const padLen = (((msgLen + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[msgLen] = 0x80;
  const pdv = new DataView(padded.buffer);
  pdv.setUint32(padLen - 4, bitLen, false);

  const w = new Int32Array(80);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = pdv.getInt32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }

      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const result = new Uint8Array(20);
  const rdv = new DataView(result.buffer);
  rdv.setUint32(0, h0, false);
  rdv.setUint32(4, h1, false);
  rdv.setUint32(8, h2, false);
  rdv.setUint32(12, h3, false);
  rdv.setUint32(16, h4, false);
  return result;
}

/**
 * Compress an array of ISO blocks using raw deflate (RFC 1951).
 *
 * Pure function — no file I/O. Each block is independently compressed, making
 * this suitable for multi-worker parallelism (see compress-worker.js).
 *
 * For each block:
 *   1. Pad to ISO_BLOCK_SIZE if shorter (last block)
 *   2. Compute SHA-1 of the uncompressed data (first 16 bytes stored in index)
 *   3. Deflate with the given compression level
 *   4. If compressed >= original size, store uncompressed (size = ISO_BLOCK_SIZE)
 *
 * @param {Uint8Array[]} blocksData - Array of blocks (each ISO_BLOCK_SIZE bytes, last may be shorter)
 * @param {number} compressionLevel - zlib deflate level (0–9)
 * @param {Object} [opts]
 * @param {function} [opts.onProgress] - Called every 64 blocks with (blockIndex, totalBlocks)
 * @returns {{ parts: Uint8Array[], indexEntries: {offset: number, size: number, sha1: Uint8Array}[], stats: {compressedCount: number, uncompressedCount: number, totalCompressedBytes: number} }}
 */
export function compressBlocks(blocksData, compressionLevel, opts) {
  const onProgress = opts?.onProgress;
  const parts = [];
  const indexEntries = [];
  let relativeOffset = 0;
  let compressedCount = 0;
  let uncompressedCount = 0;
  let totalCompressedBytes = 0;

  for (let i = 0; i < blocksData.length; i++) {
    // Pad to full block size if needed
    let block = blocksData[i];
    if (block.length < ISO_BLOCK_SIZE) {
      const padded = new Uint8Array(ISO_BLOCK_SIZE);
      padded.set(block);
      block = padded;
    }

    // SHA-1 of uncompressed block (first 16 bytes stored in index)
    const hash = sha1(block);
    const sha1_16 = hash.slice(0, 16);

    let compressed;
    let storedSize;

    if (compressionLevel === 0) {
      compressed = block;
      storedSize = ISO_BLOCK_SIZE;
    } else {
      compressed = deflateRaw(block, { level: compressionLevel });
      if (compressed.length >= ISO_BLOCK_SIZE) {
        compressed = block;
        storedSize = ISO_BLOCK_SIZE;
      } else {
        storedSize = compressed.length;
      }
    }

    if (storedSize < ISO_BLOCK_SIZE) {
      compressedCount++;
      totalCompressedBytes += storedSize;
    } else {
      uncompressedCount++;
      totalCompressedBytes += ISO_BLOCK_SIZE;
    }

    indexEntries.push({ offset: relativeOffset, size: storedSize, sha1: sha1_16 });
    parts.push(compressed.slice(0, storedSize));
    relativeOffset += storedSize;

    if (onProgress && i % 64 === 0) {
      onProgress(i, blocksData.length);
    }
  }

  return {
    parts,
    indexEntries,
    stats: { compressedCount, uncompressedCount, totalCompressedBytes },
  };
}

/**
 * Build a complete PSISOIMG0000 section from a PS1 disc image.
 *
 * This is the main entry point for single-disc PSAR construction. It reads the
 * disc image in ISO_BLOCK_SIZE chunks, compresses each block, builds the index
 * table, assembles the header blocks, and appends STARTDAT (single-disc only).
 *
 * For multi-disc EBOOTs, buildPsisoimg is called once per disc with
 * opts.multiDisc=true, which changes p1/p2 calculation and omits STARTDAT.
 *
 * @param {File|number} file - Disc image file, or file size if using preCompressed data
 * @param {Object} opts
 * @param {string} opts.discId         - e.g. "SCUS94163"
 * @param {string} opts.title          - Game title for Block 5
 * @param {Uint8Array} opts.toc        - TOC binary from generateToc/generateTocFromCue
 * @param {number} [opts.compressionLevel=5] - deflate level (0–9)
 * @param {boolean} [opts.multiDisc]   - true when building for PSTITLEIMG wrapper
 * @param {function} [opts.onProgress] - Progress callback(fraction, label)
 * @param {Object} [opts.preCompressed] - Pre-compressed data from parallel workers
 * @returns {Promise<{data: Uint8Array, stats: Object}>}
 */
export async function buildPsisoimg(file, opts) {
  const fileSize = typeof file === 'number' ? file : file.size;
  const compressionLevel = opts.compressionLevel ?? 5;
  const onProgress = opts.onProgress || (() => {});

  const totalBlocks = Math.ceil(fileSize / ISO_BLOCK_SIZE);

  let compressedParts, indexEntries, compressionStats;

  if (opts.preCompressed) {
    compressedParts = opts.preCompressed.parts;
    indexEntries = opts.preCompressed.indexEntries;
    compressionStats = opts.preCompressed.stats;
    onProgress(0.95, 'Using pre-compressed data...');
  } else {
    const blocksData = [];
    for (let i = 0; i < totalBlocks; i++) {
      const start = i * ISO_BLOCK_SIZE;
      const end = Math.min(start + ISO_BLOCK_SIZE, fileSize);
      blocksData.push(new Uint8Array(await file.slice(start, end).arrayBuffer()));
      if (i % 64 === 0) {
        onProgress(i / totalBlocks * 0.5, `Reading block ${i}/${totalBlocks}`);
      }
    }

    onProgress(0.5, 'Compressing...');
    ({ parts: compressedParts, indexEntries, stats: compressionStats } =
      compressBlocks(blocksData, compressionLevel, {
        onProgress(i, total) {
          onProgress(0.5 + (i / total) * 0.45, `Compressing block ${i}/${total}`);
        },
      }));
  }

  const { compressedCount, uncompressedCount, totalCompressedBytes } = compressionStats;

  // After compression, align end to 16-byte boundary (pop-fe does this)
  const compressedEnd = ISO_DATA_BASE + totalCompressedBytes;
  const alignedEnd = (compressedEnd + 0xF) & ~0xF;

  // Multi-disc uses Sony PSN format: p1 = uncompressed size, p2 = 0, no STARTDAT.
  // Single-disc uses popstationr format: p1 = compressed end, p2 = p1 + 0x2D31, STARTDAT present.
  const isMultiDisc = !!opts.multiDisc;

  let p1_offset, p2_value, startdatSize;
  if (isMultiDisc) {
    p1_offset = totalBlocks * ISO_BLOCK_SIZE + ISO_DATA_BASE;
    p2_value = 0;
    startdatSize = 0;
  } else {
    p1_offset = alignedEnd;
    p2_value = p1_offset + STARTDAT_CONST;
    const startdatLogo = makeStartdatLogo();
    const startdatHeader = makeStartdatHeader(startdatLogo.length);
    const startdatFooter = makeStartdatFooter();
    startdatSize = startdatHeader.length + startdatLogo.length + startdatFooter.length;
    // Store for later assembly
    opts._startdat = { header: startdatHeader, logo: startdatLogo, footer: startdatFooter };
  }

  // --- Assemble PSISOIMG ---
  const totalSize = alignedEnd + startdatSize;
  onProgress(0.95, 'Assembling PSISOIMG...');

  const result = new Uint8Array(totalSize); // zero-initialized
  const dv = new DataView(result.buffer);

  // Block 1 (0x0000, 1024 bytes): magic + p1_offset
  writeAscii(result, PSISOIMG_MAGIC, BLOCK1_OFFSET);
  dv.setUint32(BLOCK1_OFFSET + 0x0C, p1_offset, true);

  // Block 2 (0x0400, 1024 bytes): disc ID
  writeDiscId(result, opts.discId, BLOCK2_OFFSET);

  // Block 3 (0x0800, 1024 bytes): TOC + disc start offset
  const toc = opts.toc;
  if (toc.length > 0) {
    result.set(toc, BLOCK3_OFFSET);
  }
  // Disc start offset at end of Block 3 (offset 0x0BFC = 0x0800 + 0x3FC)
  dv.setUint32(BLOCK3_OFFSET + 0x3FC, ISO_DATA_BASE, true);

  // Block 4 (0x0C00, 1568 bytes): audio track table — zeros (no audio tracks)
  // Already zero from initialization

  // Block 5 (0x1220, 480 bytes): p2_offset + 0xFF07 + title
  dv.setUint32(BLOCK5_OFFSET, p2_value, true);
  result[BLOCK5_OFFSET + 8] = 0xFF;
  result[BLOCK5_OFFSET + 9] = 0x07;
  writeString(result, opts.title, BLOCK5_OFFSET + 12, 128);

  // Blocks 6-16 (0x1400, 11264 bytes): zeros — already zero

  // Index table at 0x4000 (32 bytes per block)
  let pos = INDEX_OFFSET;
  for (const entry of indexEntries) {
    dv.setUint32(pos, entry.offset, true);       // bytes 0-3: offset (uint32 LE)
    dv.setUint16(pos + 4, entry.size, true);     // bytes 4-5: size (uint16 LE)
    // bytes 6-7: flags — 0x00 for compressed, 0x01 for uncompressed (PS3 flag)
    if (entry.size === ISO_BLOCK_SIZE && compressionLevel === 0) {
      dv.setUint16(pos + 6, 0x01, true);
    }
    // bytes 8-23: first 16 bytes of SHA-1 hash
    if (entry.sha1) {
      result.set(entry.sha1, pos + 8);
    }
    // bytes 24-31: padding — already zero
    pos += INDEX_ENTRY_SIZE;
  }

  // Compressed ISO data at 0x100000
  pos = ISO_DATA_BASE;
  for (const part of compressedParts) {
    result.set(part, pos);
    pos += part.length;
  }

  // STARTDAT after aligned end of ISO data (single-disc only)
  if (!isMultiDisc && opts._startdat) {
    pos = alignedEnd;
    result.set(opts._startdat.header, pos); pos += opts._startdat.header.length;
    result.set(opts._startdat.logo, pos); pos += opts._startdat.logo.length;
    result.set(opts._startdat.footer, pos); pos += opts._startdat.footer.length;
  }

  onProgress(1, 'PSISOIMG complete');
  return {
    data: result,
    stats: {
      totalBlocks,
      compressedCount,
      uncompressedCount,
      inputSize: fileSize,
      outputSize: totalSize,
      totalCompressedBytes,
    },
  };
}

/** Write disc ID at the given offset in the format POPS expects: "_SLUS_00896". */
function writeDiscId(buf, discId, offset) {
  const formatted = '_' + discId.slice(0, 4) + '_' + discId.slice(4);
  writeAscii(buf, formatted, offset);
}

function writeAscii(buf, str, offset) {
  for (let i = 0; i < str.length && (offset + i) < buf.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
}

function writeString(buf, str, offset, maxLen) {
  const len = Math.min(str.length, maxLen);
  for (let i = 0; i < len && (offset + i) < buf.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
}
