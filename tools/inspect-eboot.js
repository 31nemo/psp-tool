#!/usr/bin/env node
// EBOOT.PBP Inspector — dumps structural layout for debugging
// Usage: node tools/inspect-eboot.js [--json] EBOOT.PBP
//
// Handles two PSISOIMG layout variants:
//   popstationr: data1 at +0x00, TOC at +0x400, data2 at +0x0E24, index at +0x3C00
//   Sony PS Store: disc ID at +0x400, TOC at +0x800, index at +0x4000

import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { inflateRaw } = require('../vendor/zlib.cjs');

// --- Constants ---
const PBP_HEADER_SIZE = 0x28;
const PBP_SECTION_NAMES = [
  'PARAM.SFO', 'ICON0.PNG', 'ICON1.PMF', 'PIC0.PNG',
  'PIC1.PNG', 'SND0.AT3', 'DATA.PSP', 'DATA.PSAR',
];

const SFO_MAGIC = 0x46535000;
const SFO_UTF8S = 0x0004;
const SFO_UTF8 = 0x0204;
const SFO_INT32 = 0x0404;

const ISO_BLOCK_SIZE = 0x9300;
const INDEX_ENTRY_SIZE = 32;
const ISO_DATA_BASE = 0x100000;
const STARTDAT_CONST = 0x2D31;

// --- Helpers ---

function readBytes(fd, offset, length) {
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, offset);
  return buf;
}

function readU32(fd, offset) {
  return readBytes(fd, offset, 4).readUInt32LE(0);
}

function hex(n) {
  return '0x' + n.toString(16).toUpperCase();
}

function fromBcd(b) {
  return ((b >> 4) & 0xF) * 10 + (b & 0xF);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function readNullString(fd, offset, maxLen) {
  const buf = readBytes(fd, offset, maxLen);
  let end = 0;
  while (end < maxLen && buf[end] !== 0) end++;
  return buf.toString('utf8', 0, end);
}

// --- PBP Header ---

function inspectPbpHeader(fd, fileSize) {
  const header = readBytes(fd, 0, PBP_HEADER_SIZE);
  const magic = header.toString('ascii', 0, 4);
  const version = header.readUInt32LE(4);

  const offsets = [];
  for (let i = 0; i < 8; i++) {
    offsets.push(header.readUInt32LE(8 + i * 4));
  }

  const sections = offsets.map((offset, i) => {
    const end = i < 7 ? offsets[i + 1] : fileSize;
    return {
      name: PBP_SECTION_NAMES[i],
      offset,
      size: end - offset,
      empty: end - offset === 0,
    };
  });

  return {
    magic,
    version: `${(version >> 16) & 0xFF}.${version & 0xFFFF}`,
    versionRaw: version,
    offsets,
    sections,
  };
}

// --- PARAM.SFO ---

function inspectSfo(fd, offset, size) {
  if (size < 20) return { error: 'SFO too small' };

  const header = readBytes(fd, offset, 20);
  const magic = header.readUInt32LE(0);
  if (magic !== SFO_MAGIC) return { error: `Bad SFO magic: ${hex(magic)}` };

  const version = header.readUInt32LE(4);
  const keyTableOff = header.readUInt32LE(8);
  const dataTableOff = header.readUInt32LE(12);
  const entryCount = header.readUInt32LE(16);

  const sfo = readBytes(fd, offset, size);
  const entries = [];

  for (let i = 0; i < entryCount; i++) {
    const base = 20 + i * 16;
    const keyOff = sfo.readUInt16LE(base);
    const dataType = sfo.readUInt16LE(base + 2);
    const dataUsed = sfo.readUInt32LE(base + 4);
    const dataMax = sfo.readUInt32LE(base + 8);
    const dataOff = sfo.readUInt32LE(base + 12);

    let keyEnd = keyTableOff + keyOff;
    while (keyEnd < size && sfo[keyEnd] !== 0) keyEnd++;
    const key = sfo.toString('utf8', keyTableOff + keyOff, keyEnd);

    let value;
    const valStart = dataTableOff + dataOff;
    if (dataType === SFO_INT32) {
      value = sfo.readUInt32LE(valStart);
    } else {
      let valEnd = valStart + dataUsed;
      while (valEnd > valStart && sfo[valEnd - 1] === 0) valEnd--;
      value = sfo.toString('utf8', valStart, valEnd);
    }

    entries.push({
      key,
      type: dataType === SFO_INT32 ? 'int32' : dataType === SFO_UTF8S ? 'utf8s' : 'utf8',
      value,
      usedSize: dataUsed,
      maxSize: dataMax,
    });
  }

  return {
    magic: hex(magic),
    version: `${(version >> 8) & 0xFF}.${version & 0xFF}`,
    keyTableOffset: keyTableOff,
    dataTableOffset: dataTableOff,
    entryCount,
    entries,
  };
}

// --- TOC ---

function isTocAt(fd, absOffset) {
  const first = readBytes(fd, absOffset, 3);
  // TOC starts with addrCtrl=0x41 (data) or 0x01 (audio), tno=0x00, point=0xA0
  return (first[0] === 0x41 || first[0] === 0x01) && first[1] === 0x00 && first[2] === 0xA0;
}

function inspectToc(fd, absOffset) {
  const maxTocBytes = 102 * 10;
  const tocBuf = readBytes(fd, absOffset, maxTocBytes);
  const entries = [];

  for (let i = 0; i < 102; i++) {
    const base = i * 10;
    const addrCtrl = tocBuf[base];
    const tno = tocBuf[base + 1];
    const point = tocBuf[base + 2];

    if (addrCtrl === 0 && tno === 0 && point === 0) break;

    const pmin = fromBcd(tocBuf[base + 7]);
    const psec = fromBcd(tocBuf[base + 8]);
    const pframe = fromBcd(tocBuf[base + 9]);

    let pointLabel;
    if (point === 0xA0) pointLabel = 'A0 (first track)';
    else if (point === 0xA1) pointLabel = 'A1 (last track)';
    else if (point === 0xA2) pointLabel = 'A2 (lead-out)';
    else pointLabel = `Track ${fromBcd(point)}`;

    const isData = (addrCtrl & 0x40) !== 0;
    entries.push({
      point: hex(point),
      pointLabel,
      type: isData ? 'data' : 'audio',
      pmsf: `${String(pmin).padStart(2, '0')}:${String(psec).padStart(2, '0')}:${String(pframe).padStart(2, '0')}`,
    });
  }

  return { entryCount: entries.length, entries };
}

// --- Index Table ---

function probeIndexAt(fd, absOffset, fileSize) {
  // Check if there's a valid index table at this offset
  if (absOffset + INDEX_ENTRY_SIZE > fileSize) return null;
  const first = readBytes(fd, absOffset, 8);
  const offset = first.readUInt32LE(0);
  const length = first.readUInt32LE(4);
  // First entry should have offset=0 and reasonable length
  if (offset === 0 && length > 0 && length <= ISO_BLOCK_SIZE) return true;
  return false;
}

function inspectIndexTable(fd, absOffset, fileSize) {
  const maxEntries = Math.min(500000, Math.floor((fileSize - absOffset) / INDEX_ENTRY_SIZE));
  let numEntries = 0;
  let minLen = Infinity, maxLen = 0;
  let firstOffset = 0, firstLength = 0;
  let lastOffset = 0, lastLength = 0;
  let prevEnd = 0, gaps = 0, overlaps = 0, hashedEntries = 0;

  const chunkSize = 1024;
  for (let chunk = 0; chunk < maxEntries; chunk += chunkSize) {
    const count = Math.min(chunkSize, maxEntries - chunk);
    const buf = readBytes(fd, absOffset + chunk * INDEX_ENTRY_SIZE, count * INDEX_ENTRY_SIZE);

    for (let i = 0; i < count; i++) {
      const base = i * INDEX_ENTRY_SIZE;
      const offset = buf.readUInt32LE(base);
      const length = buf.readUInt32LE(base + 4);

      if (length === 0 || length > ISO_BLOCK_SIZE) return buildResult();

      if (numEntries === 0) {
        firstOffset = offset;
        firstLength = length;
      } else {
        if (offset < prevEnd) overlaps++;
        else if (offset > prevEnd) gaps++;
      }
      let hasHash = false;
      for (let h = base + 8; h < base + 28; h++) {
        if (buf[h] !== 0) { hasHash = true; break; }
      }
      if (hasHash) hashedEntries++;
      prevEnd = offset + length;
      lastOffset = offset;
      lastLength = length;
      if (length < minLen) minLen = length;
      if (length > maxLen) maxLen = length;
      numEntries++;
    }
  }

  function buildResult() {
    const compressedTotal = numEntries > 0 ? lastOffset + lastLength : 0;
    return {
      entryCount: numEntries,
      firstEntry: { offset: firstOffset, length: firstLength },
      lastEntry: { offset: lastOffset, length: lastLength },
      minBlockSize: minLen === Infinity ? 0 : minLen,
      maxBlockSize: maxLen,
      gaps,
      overlaps,
      hashedEntries,
      compressedTotal,
      uncompressedTotal: numEntries * ISO_BLOCK_SIZE,
      ratio: numEntries > 0 ? (compressedTotal / (numEntries * ISO_BLOCK_SIZE) * 100).toFixed(1) + '%' : 'N/A',
    };
  }

  return buildResult();
}

// --- BTYPE Analysis ---

function analyzeBtypes(fd, psisoAbsOffset, indexAbsOffset, indexInfo) {
  if (indexInfo.entryCount === 0) return { fixed: 0, dynamic: 0, stored: 0, raw: 0 };
  let fixed = 0, dynamic = 0, stored = 0, raw = 0;
  for (let i = 0; i < indexInfo.entryCount; i++) {
    const entryBuf = readBytes(fd, indexAbsOffset + i * INDEX_ENTRY_SIZE, 8);
    const length = entryBuf.readUInt32LE(4);
    if (length === ISO_BLOCK_SIZE) { raw++; continue; }
    const absDataOffset = psisoAbsOffset + ISO_DATA_BASE + entryBuf.readUInt32LE(0);
    const firstByte = readBytes(fd, absDataOffset, 1)[0];
    const btype = (firstByte >> 1) & 3;
    if (btype === 0) stored++;
    else if (btype === 1) fixed++;
    else if (btype === 2) dynamic++;
  }
  return { fixed, dynamic, stored, raw };
}

// --- Sample Decompression ---

function sampleDecompress(fd, psisoAbsOffset, indexAbsOffset, indexInfo) {
  if (indexInfo.entryCount === 0) return [];

  const results = [];
  const indices = [0, indexInfo.entryCount - 1];

  for (const idx of indices) {
    const entryBuf = readBytes(fd, indexAbsOffset + idx * INDEX_ENTRY_SIZE, 8);
    const offset = entryBuf.readUInt32LE(0);
    const length = entryBuf.readUInt32LE(4);
    const absDataOffset = psisoAbsOffset + ISO_DATA_BASE + offset;

    const sample = { block: idx, compressedSize: length };

    if (length === ISO_BLOCK_SIZE) {
      sample.stored = 'uncompressed';
      sample.decompressedSize = ISO_BLOCK_SIZE;
    } else {
      try {
        const blockData = readBytes(fd, absDataOffset, length);
        const inflated = inflateRaw(blockData);
        sample.stored = 'compressed';
        sample.decompressedSize = inflated.length;
        sample.ok = inflated.length === ISO_BLOCK_SIZE;
      } catch (e) {
        sample.stored = 'compressed';
        sample.error = e.message;
      }
    }
    results.push(sample);
  }

  return results;
}

// --- PSISOIMG ---

function detectVariant(fd, absOffset) {
  // Detect layout variant by checking what's at +0x400
  // Sony PS Store: disc ID string (starts with '_')
  // popstationr: TOC data (starts with 0x41 0x00 0xA0)
  const probe = readBytes(fd, absOffset + 0x400, 4);
  if (probe[0] === 0x5F) return 'sony';        // '_' = disc ID string
  if (isTocAt(fd, absOffset + 0x400)) return 'popstationr';
  // Fallback: try both index locations
  if (probeIndexAt(fd, absOffset + 0x4000, Infinity)) return 'sony';
  if (probeIndexAt(fd, absOffset + 0x3C00, Infinity)) return 'popstationr';
  return 'unknown';
}

function inspectPsisoimg(fd, absOffset, fileSize, label) {
  const magicBuf = readBytes(fd, absOffset, 12);
  const magic = magicBuf.toString('ascii', 0, 12);
  if (magic !== 'PSISOIMG0000') {
    return { error: `Bad PSISOIMG magic: "${magic}"`, label };
  }

  const p1_offset = readU32(fd, absOffset + 0x0C);

  // Detect which format variant
  const variant = detectVariant(fd, absOffset);

  // Layout offsets differ by variant
  const tocOffset = variant === 'sony' ? 0x800 : 0x400;
  const indexOffset = variant === 'sony' ? 0x4000 : 0x3C00;

  // Reserved area check (0x10–0x3FF) — same for both variants
  const reserved = readBytes(fd, absOffset + 0x10, 0x3F0);
  let nonZeroCount = 0;
  for (let i = 0; i < reserved.length; i++) {
    if (reserved[i] !== 0) nonZeroCount++;
  }

  // Disc ID at +0x400 (Sony format stores it here as "_SLUS_00892")
  let discIdAt400 = null;
  if (variant === 'sony') {
    discIdAt400 = readNullString(fd, absOffset + 0x400, 16);
  }

  // TOC
  let toc = { entryCount: 0, entries: [] };
  if (isTocAt(fd, absOffset + tocOffset)) {
    toc = inspectToc(fd, absOffset + tocOffset);
  }

  // p2_offset — at 0x0E20 in popstationr, may not exist in Sony format
  const p2_offset = readU32(fd, absOffset + 0x0E20);

  // Title — scan for it at known locations
  let title = '';
  if (variant === 'popstationr') {
    title = readNullString(fd, absOffset + 0x0E24 + 8, 128);
  } else {
    // Sony format: scan for title in data2 area (typically around 0x1200-0x1300)
    // The title is stored in the data2 template which varies in position
    // Scan from 0xE00 to 0x2000 looking for printable ASCII runs
    for (const probe of [0x0E24 + 8, 0x1218, 0x1220, 0x1228, 0x1008]) {
      const s = readNullString(fd, absOffset + probe, 128);
      if (s.length >= 3 && /^[\x20-\x7E]+$/.test(s)) {
        title = s;
        break;
      }
    }
  }

  // Index table
  const indexAbsOffset = absOffset + indexOffset;
  const indexInfo = inspectIndexTable(fd, indexAbsOffset, fileSize);

  // STARTDAT check
  let startdatMagic = null;
  let startdatRelOffset = null;
  if (indexInfo.compressedTotal > 0) {
    const sdAbsOffset = absOffset + ISO_DATA_BASE + indexInfo.compressedTotal;
    startdatRelOffset = ISO_DATA_BASE + indexInfo.compressedTotal;
    if (sdAbsOffset + 8 <= fileSize) {
      const sdBuf = readBytes(fd, sdAbsOffset, 8);
      startdatMagic = sdBuf.toString('ascii', 0, 8).replace(/\0/g, '');
    }
  }

  // BTYPE analysis
  const btypes = analyzeBtypes(fd, absOffset, indexAbsOffset, indexInfo);

  // Sample decompress
  const samples = sampleDecompress(fd, absOffset, indexAbsOffset, indexInfo);

  // Sanity checks
  // p1: single-disc = compressedTotal + ISO_DATA_BASE; multi-disc = uncompressedTotal + ISO_DATA_BASE
  // p2: always 0 in Sony PSN reference EBOOTs
  const compressedTotal = indexInfo.compressedTotal;
  const uncompressedTotal = indexInfo.entryCount * ISO_BLOCK_SIZE;
  const expectedP1_compressed = compressedTotal + ISO_DATA_BASE;
  const expectedP1_aligned = (expectedP1_compressed + 0xF) & ~0xF;
  const expectedP1_uncompressed = uncompressedTotal + ISO_DATA_BASE;
  const p1_ok = p1_offset === expectedP1_compressed || p1_offset === expectedP1_aligned || p1_offset === expectedP1_uncompressed;
  const checks = {
    p1_matches: p1_ok,
    p1_expected: p1_offset === expectedP1_compressed ? expectedP1_compressed : expectedP1_uncompressed,
    p1_compressed: expectedP1_compressed,
    p1_uncompressed: expectedP1_uncompressed,
    p2_matches: p2_offset === 0,
    firstIndexOffsetZero: indexInfo.entryCount === 0 || indexInfo.firstEntry.offset === 0,
    allBlocksInRange: indexInfo.maxBlockSize <= ISO_BLOCK_SIZE,
  };

  return {
    label,
    variant,
    magic,
    p1_offset,
    p2_offset,
    tocOffset,
    indexOffset,
    discIdAt400,
    reservedAreaClean: nonZeroCount === 0,
    reservedNonZeroBytes: nonZeroCount,
    toc,
    title,
    indexTable: indexInfo,
    startdatOffset: startdatRelOffset,
    startdatMagic,
    btypes,
    samples,
    sanityChecks: checks,
  };
}

// --- DATA.PSAR ---

function inspectPsar(fd, psarOffset, fileSize) {
  const magicBuf = readBytes(fd, psarOffset, 14);
  const magic = magicBuf.toString('ascii', 0, 14).replace(/\0/g, '');

  if (magic.startsWith('PSTITLEIMG')) {
    const discOffsets = [];
    for (let i = 0; i < 5; i++) {
      const off = readU32(fd, psarOffset + 0x200 + i * 4);
      if (off === 0 && i > 0) break;
      discOffsets.push(off);
    }

    const discs = discOffsets.map((off, i) => {
      return inspectPsisoimg(fd, psarOffset + off, fileSize, `Disc ${i + 1}`);
    });

    return { type: 'PSTITLEIMG', discCount: discOffsets.length, discOffsets, discs };
  } else if (magic.startsWith('PSISOIMG')) {
    const disc = inspectPsisoimg(fd, psarOffset, fileSize, 'Single disc');
    return { type: 'PSISOIMG', discCount: 1, discs: [disc] };
  } else {
    return { type: 'unknown', magic };
  }
}

// --- Output Formatting ---

function printHuman(result) {
  const { pbp, sfo, psar } = result;

  console.log('=== PBP Header ===');
  console.log(`Magic: ${pbp.magic}  Version: ${pbp.version}`);
  console.log(`File size: ${formatSize(result.fileSize)}`);
  console.log('');
  console.log('Sections:');
  for (const s of pbp.sections) {
    const status = s.empty ? '(empty)' : formatSize(s.size);
    console.log(`  ${s.name.padEnd(12)} offset=${hex(s.offset).padEnd(10)} size=${status}`);
  }

  if (result.dataPspSha1) {
    console.log(`  DATA.PSP SHA-1: ${result.dataPspSha1}`);
  }

  console.log('');
  console.log('=== PARAM.SFO ===');
  if (sfo.error) {
    console.log(`  ERROR: ${sfo.error}`);
  } else {
    for (const e of sfo.entries) {
      const val = typeof e.value === 'number' ? `${e.value} (${hex(e.value)})` : `"${e.value}"`;
      console.log(`  ${e.key.padEnd(20)} [${e.type.padEnd(5)}] = ${val}`);
    }
  }

  console.log('');
  console.log('=== DATA.PSAR ===');
  console.log(`Type: ${psar.type}  Discs: ${psar.discCount}`);
  if (psar.discOffsets) {
    console.log(`Disc offsets: ${psar.discOffsets.map(hex).join(', ')}`);
  }

  for (const disc of psar.discs) {
    console.log('');
    console.log(`--- ${disc.label} ---`);
    if (disc.error) {
      console.log(`  ERROR: ${disc.error}`);
      continue;
    }

    console.log(`  Variant: ${disc.variant}`);
    console.log(`  Magic: ${disc.magic}`);
    console.log(`  p1_offset: ${hex(disc.p1_offset)}  p2_offset: ${hex(disc.p2_offset)}`);
    if (disc.discIdAt400) {
      console.log(`  Disc ID at +0x400: "${disc.discIdAt400}"`);
    }
    console.log(`  Reserved area (0x10-0x3FF): ${disc.reservedAreaClean ? 'clean' : `${disc.reservedNonZeroBytes} non-zero bytes`}`);
    console.log(`  Title: "${disc.title}"`);

    console.log(`  TOC at +${hex(disc.tocOffset)}: ${disc.toc.entryCount} entries`);
    for (const t of disc.toc.entries) {
      console.log(`    ${t.pointLabel.padEnd(22)} ${t.type.padEnd(6)} P=${t.pmsf}`);
    }

    const idx = disc.indexTable;
    console.log(`  Index table at +${hex(disc.indexOffset)}: ${idx.entryCount} blocks`);
    if (idx.entryCount > 0) {
      console.log(`    First: offset=${hex(idx.firstEntry.offset)} len=${idx.firstEntry.length}`);
      console.log(`    Last:  offset=${hex(idx.lastEntry.offset)} len=${idx.lastEntry.length}`);
      console.log(`    Block sizes: min=${idx.minBlockSize} max=${idx.maxBlockSize} (limit=${hex(ISO_BLOCK_SIZE)})`);
      console.log(`    Compressed total: ${formatSize(idx.compressedTotal)}  Uncompressed: ${formatSize(idx.uncompressedTotal)}  Ratio: ${idx.ratio}`);
      console.log(`    Continuity: ${idx.gaps === 0 && idx.overlaps === 0 ? 'contiguous' : `${idx.gaps} gaps, ${idx.overlaps} overlaps`}`);
      console.log(`    Block hashes: ${idx.hashedEntries}/${idx.entryCount}`);
    }

    if (disc.btypes) {
      const bt = disc.btypes;
      console.log(`  BTYPE: dynamic=${bt.dynamic} fixed=${bt.fixed} stored=${bt.stored} raw=${bt.raw}`);
    }

    if (disc.startdatOffset != null) {
      console.log(`  STARTDAT: at +${hex(disc.startdatOffset)} magic="${disc.startdatMagic || 'N/A'}"`);
    }

    if (disc.samples.length > 0) {
      console.log('  Sample decompress:');
      for (const s of disc.samples) {
        if (s.error) {
          console.log(`    Block ${s.block}: FAIL - ${s.error}`);
        } else {
          console.log(`    Block ${s.block}: ${s.stored} ${s.compressedSize} -> ${s.decompressedSize}${s.ok === false ? ' WRONG SIZE' : ''}`);
        }
      }
    }

    console.log('  Sanity checks:');
    const c = disc.sanityChecks;
    console.log(`    p1: ${c.p1_matches ? 'PASS' : `FAIL (got ${hex(disc.p1_offset)}, expected ${hex(c.p1_compressed)} or ${hex(c.p1_uncompressed)})`}`);
    console.log(`    p2 == 0: ${c.p2_matches ? 'PASS' : `FAIL (got ${hex(disc.p2_offset)})`}`);
    console.log(`    First index offset == 0: ${c.firstIndexOffsetZero ? 'PASS' : 'FAIL'}`);
    console.log(`    All blocks <= 0x9300: ${c.allBlocksInRange ? 'PASS' : 'FAIL'}`);
  }
}

// --- Main ---

function main() {
  const args = process.argv.slice(2);
  let jsonMode = false;
  let filePath = null;

  for (const arg of args) {
    if (arg === '--json') jsonMode = true;
    else filePath = arg;
  }

  if (!filePath) {
    console.error('Usage: node tools/inspect-eboot.js [--json] EBOOT.PBP');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const fd = fs.openSync(filePath, 'r');

  try {
    const pbp = inspectPbpHeader(fd, fileSize);
    const sfo = inspectSfo(fd, pbp.offsets[0], pbp.offsets[1] - pbp.offsets[0]);

    const dataPspOffset = pbp.offsets[6];
    const dataPspSize = pbp.offsets[7] - dataPspOffset;
    let dataPspSha1 = null;
    if (dataPspSize > 0) {
      const dataPsp = readBytes(fd, dataPspOffset, dataPspSize);
      dataPspSha1 = crypto.createHash('sha1').update(dataPsp).digest('hex');
    }

    const psar = inspectPsar(fd, pbp.offsets[7], fileSize);
    const result = { fileSize, pbp, sfo, dataPspSha1, psar };

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result);
    }
  } finally {
    fs.closeSync(fd);
  }
}

main();
