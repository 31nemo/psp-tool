#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const OURS = path.resolve(process.env.HOME, 'Downloads/SLUS00896/EBOOT.PBP');
const POPFE = '/tmp/pop-fe-test-eboot.pbp';
const WORKING = path.resolve(process.env.HOME, 'Downloads/Misadventures of Tron Bonne, The [NTSC-U] [SLUS-00896]/SLUS00896/EBOOT.PBP');

const files = {
  ours: { label: 'OURS', path: OURS },
  popfe: { label: 'POP-FE', path: POPFE },
  working: { label: 'WORKING', path: WORKING },
};

function readPBPHeader(buf) {
  const magic = buf.toString('ascii', 0, 4);
  const version = buf.readUInt32LE(4);
  const offsets = [];
  for (let i = 0; i < 8; i++) {
    offsets.push(buf.readUInt32LE(8 + i * 4));
  }
  return { magic, version, offsets };
}

const sectionNames = ['PARAM.SFO', 'ICON0.PNG', 'ICON1.PMF', 'PIC0.PNG', 'PIC1.PNG', 'SND0.AT3', 'DATA.PSP', 'DATA.PSAR'];

function hexDump(buf, offset, len, label) {
  const lines = [];
  for (let i = 0; i < len; i += 16) {
    const addr = (offset + i).toString(16).padStart(8, '0');
    const hex = [];
    const ascii = [];
    for (let j = 0; j < 16 && i + j < len; j++) {
      const b = buf[i + j];
      hex.push(b.toString(16).padStart(2, '0'));
      ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
    }
    lines.push(`  ${addr}: ${hex.join(' ').padEnd(48)} ${ascii.join('')}`);
  }
  return lines.join('\n');
}

function findMagic(buf, magic, startOffset = 0) {
  const magicBuf = Buffer.from(magic, 'ascii');
  for (let i = startOffset; i < buf.length - magicBuf.length; i++) {
    if (buf.compare(magicBuf, 0, magicBuf.length, i, i + magicBuf.length) === 0) {
      return i;
    }
  }
  return -1;
}

// ─── Main ───
console.log('='.repeat(100));
console.log('EBOOT BYTE-LEVEL COMPARISON');
console.log('='.repeat(100));

const bufs = {};
for (const [key, info] of Object.entries(files)) {
  bufs[key] = fs.readFileSync(info.path);
  console.log(`\n${info.label}: ${info.path}`);
  console.log(`  File size: ${bufs[key].length} (0x${bufs[key].length.toString(16)})`);
}

// ─── 1. PBP Headers ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 1: PBP HEADERS');
console.log('='.repeat(100));

const headers = {};
for (const [key, info] of Object.entries(files)) {
  headers[key] = readPBPHeader(bufs[key]);
  const h = headers[key];
  console.log(`\n${info.label}:`);
  console.log(`  Magic: ${h.magic}  Version: 0x${h.version.toString(16).padStart(8, '0')}`);
  for (let i = 0; i < 8; i++) {
    const size = i < 7 ? h.offsets[i + 1] - h.offsets[i] : bufs[key].length - h.offsets[i];
    console.log(`  ${sectionNames[i].padEnd(12)} offset=0x${h.offsets[i].toString(16).padStart(8, '0')}  size=0x${size.toString(16).padStart(8, '0')} (${size})`);
  }
}

// ─── 2. Find PSAR and detect wrapper ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 2: DATA.PSAR STRUCTURE DETECTION');
console.log('='.repeat(100));

const psarInfo = {};
for (const [key, info] of Object.entries(files)) {
  const psarOffset = headers[key].offsets[7];
  const psar = bufs[key].slice(psarOffset);
  const psarMagic = psar.toString('ascii', 0, 12);
  console.log(`\n${info.label}: PSAR at 0x${psarOffset.toString(16)}, magic="${psarMagic}"`);

  let psisoimgOffset = 0; // relative to PSAR start
  if (psarMagic.startsWith('PSTITLEIMG')) {
    console.log(`  => Has PSTITLEIMG wrapper`);
    // Look for disc entries
    const disc1Magic = psar.toString('ascii', 0x200, 0x200 + 10);
    console.log(`  Offset 0x200: "${disc1Magic}"`);
    // Check 0x400 for disc info
    const at400 = psar.toString('ascii', 0x400, 0x410);
    console.log(`  Offset 0x400: "${at400}"`);
    // Look for PSISOIMG at 0x8000
    const at8000 = psar.toString('ascii', 0x8000, 0x8000 + 10);
    console.log(`  Offset 0x8000: "${at8000}"`);
    if (at8000.startsWith('PSISOIMG')) {
      psisoimgOffset = 0x8000;
      console.log(`  => PSISOIMG found at PSAR + 0x8000`);
    }
    // Also check 0x400
    const at400m = psar.toString('ascii', 0x400, 0x400 + 10);
    if (at400m.startsWith('PSISOIMG')) {
      console.log(`  => PSISOIMG also at PSAR + 0x400`);
    }
  } else if (psarMagic.startsWith('PSISOIMG')) {
    console.log(`  => Direct PSISOIMG (no PSTITLEIMG wrapper)`);
    psisoimgOffset = 0;
  }

  psarInfo[key] = { psarOffset, psisoimgOffset, psar };
}

// ─── 3. Compare PSISOIMG headers ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 3: PSISOIMG HEADER COMPARISON (first 0x1400 bytes)');
console.log('='.repeat(100));

// Extract PSISOIMG header from each
const psisoHeaders = {};
for (const [key, info] of Object.entries(files)) {
  const { psar, psisoimgOffset } = psarInfo[key];
  const headerLen = Math.min(0x5000, psar.length - psisoimgOffset);
  psisoHeaders[key] = psar.slice(psisoimgOffset, psisoimgOffset + headerLen);
  console.log(`\n${info.label}: PSISOIMG at PSAR+0x${psisoimgOffset.toString(16)}`);
  console.log(`  First 16 bytes: ${psisoHeaders[key].slice(0, 16).toString('hex').match(/../g).join(' ')}`);
}

// Pairwise comparison function
function compareBuffers(label, bufA, nameA, bufB, nameB, regionStart, regionLen) {
  const diffs = [];
  const len = Math.min(regionLen, bufA.length - regionStart, bufB.length - regionStart);
  for (let i = 0; i < len; i++) {
    const a = bufA[regionStart + i];
    const b = bufB[regionStart + i];
    if (a !== b) {
      diffs.push({ offset: regionStart + i, a, b });
    }
  }
  if (diffs.length === 0) {
    console.log(`\n  ${label}: IDENTICAL (${len} bytes compared)`);
    return;
  }
  console.log(`\n  ${label}: ${diffs.length} byte differences found in ${len} bytes`);

  // Group consecutive diffs into ranges
  let rangeStart = diffs[0].offset;
  let rangeEnd = diffs[0].offset;
  const ranges = [];
  for (let i = 1; i < diffs.length; i++) {
    if (diffs[i].offset <= rangeEnd + 4) {
      rangeEnd = diffs[i].offset;
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = diffs[i].offset;
      rangeEnd = diffs[i].offset;
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  for (const [rs, re] of ranges) {
    const contextBefore = 0;
    const contextAfter = 0;
    const start = Math.max(0, rs - contextBefore);
    const end = Math.min(len, re + contextAfter + 1);
    const dumpLen = Math.min(end - start, 64);

    console.log(`\n  --- Diff range: 0x${rs.toString(16)} - 0x${re.toString(16)} (${re - rs + 1} bytes) ---`);

    // Show each differing byte with interpretation
    for (const d of diffs.filter(d => d.offset >= rs && d.offset <= re)) {
      const off = d.offset;
      console.log(`    0x${off.toString(16).padStart(6, '0')}: ${nameA}=0x${d.a.toString(16).padStart(2, '0')}  ${nameB}=0x${d.b.toString(16).padStart(2, '0')}`);
    }
  }
}

// Compare OURS vs POP-FE
console.log('\n' + '-'.repeat(80));
console.log('OURS vs POP-FE: PSISOIMG header region 0x0000 - 0x1400');
console.log('-'.repeat(80));
compareBuffers('Header 0x0000-0x1400', psisoHeaders.ours, 'OURS', psisoHeaders.popfe, 'POPFE', 0, 0x1400);

// Compare OURS vs WORKING
console.log('\n' + '-'.repeat(80));
console.log('OURS vs WORKING: PSISOIMG header region 0x0000 - 0x1400');
console.log('-'.repeat(80));
compareBuffers('Header 0x0000-0x1400', psisoHeaders.ours, 'OURS', psisoHeaders.working, 'WORKING', 0, 0x1400);

// Compare POP-FE vs WORKING
console.log('\n' + '-'.repeat(80));
console.log('POP-FE vs WORKING: PSISOIMG header region 0x0000 - 0x1400');
console.log('-'.repeat(80));
compareBuffers('Header 0x0000-0x1400', psisoHeaders.popfe, 'POPFE', psisoHeaders.working, 'WORKING', 0, 0x1400);

// ─── 3b. Annotated header fields ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 3b: ANNOTATED PSISOIMG HEADER FIELDS');
console.log('='.repeat(100));

function readPSISOIMGFields(buf, label) {
  console.log(`\n${label}:`);
  console.log(`  0x0000 magic:       ${buf.toString('ascii', 0, 8)}`);
  // Read key 32-bit LE fields
  const fields = [
    [0x08, 'field_08'],
    [0x0C, 'p1_offset (STARTDAT ptr or ISO size)'],
    [0x10, 'field_10'],
    [0x14, 'field_14'],
    [0x18, 'field_18'],
    [0x1C, 'field_1C'],
  ];
  for (const [off, name] of fields) {
    if (off + 4 <= buf.length) {
      const val = buf.readUInt32LE(off);
      console.log(`  0x${off.toString(16).padStart(4, '0')} ${name.padEnd(40)}: 0x${val.toString(16).padStart(8, '0')} (${val})`);
    }
  }

  // Show data1 region (0x00 - 0x400)
  console.log(`\n  data1 region (0x00-0x20):`);
  console.log(hexDump(buf, 0, 0x40, ''));

  // Show region around 0x400 (TOC or discID)
  console.log(`\n  region 0x400-0x440:`);
  console.log(hexDump(buf.slice(0x400), 0x400, 0x40, ''));

  // Show region around 0x800
  console.log(`\n  region 0x800-0x840:`);
  console.log(hexDump(buf.slice(0x800), 0x800, 0x40, ''));

  // Show region around 0xE00-0xE40
  console.log(`\n  region 0xE00-0xE40:`);
  console.log(hexDump(buf.slice(0xE00), 0xE00, 0x40, ''));

  return buf;
}

for (const [key, info] of Object.entries(files)) {
  readPSISOIMGFields(psisoHeaders[key], info.label);
}

// ─── 4. Index table comparison ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 4: INDEX TABLE (first 10 entries)');
console.log('='.repeat(100));

// Index at different offsets depending on format
// Our format: index at 0x3C00
// Sony/pop-fe format: index at 0x4000
const INDEX_ENTRY_SIZE = 32;

function readIndexEntries(buf, indexOffset, count, label) {
  console.log(`\n${label} (index at PSISOIMG+0x${indexOffset.toString(16)}):`);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const base = indexOffset + i * INDEX_ENTRY_SIZE;
    if (base + INDEX_ENTRY_SIZE > buf.length) break;
    const entry = buf.slice(base, base + INDEX_ENTRY_SIZE);
    const offset = entry.readUInt32LE(0);
    const size = entry.readUInt16LE(4);    // uint16, not uint32!
    const flags = entry.readUInt16LE(6);   // flags byte
    const hash = entry.slice(8, 24).toString('hex');
    const pad = entry.slice(24, 32).toString('hex');
    const compressed = size < 0x9300 ? 'compressed' : 'raw';
    console.log(`  [${i.toString().padStart(3)}] offset=0x${offset.toString(16).padStart(8, '0')} size=0x${size.toString(16).padStart(4, '0')} flags=0x${flags.toString(16).padStart(4, '0')} (${compressed}) hash=${hash}`);
    entries.push({ offset, size, flags, hash });
  }
  return entries;
}

// Try both offsets for each
for (const [key, info] of Object.entries(files)) {
  const buf = psisoHeaders[key];
  // Check which offset has valid-looking data
  for (const tryOffset of [0x3C00, 0x4000]) {
    if (tryOffset + 32 <= buf.length) {
      const firstEntry = buf.readUInt32LE(tryOffset);
      if (firstEntry !== 0) {
        readIndexEntries(buf, tryOffset, 10, `${info.label} @ 0x${tryOffset.toString(16)}`);
      } else {
        // Check if all zeros
        const chunk = buf.slice(tryOffset, tryOffset + 32);
        const allZero = chunk.every(b => b === 0);
        if (!allZero) {
          readIndexEntries(buf, tryOffset, 10, `${info.label} @ 0x${tryOffset.toString(16)}`);
        } else {
          console.log(`\n${info.label} @ 0x${tryOffset.toString(16)}: all zeros (no index here)`);
        }
      }
    }
  }
}

// ─── 5. PSTITLEIMG wrapper check ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 5: PSTITLEIMG WRAPPER DETAILS');
console.log('='.repeat(100));

for (const [key, info] of Object.entries(files)) {
  const { psar } = psarInfo[key];
  const psarMagic = psar.toString('ascii', 0, 10);
  console.log(`\n${info.label}: PSAR magic = "${psarMagic}"`);

  if (psarMagic.startsWith('PSTITLEIMG')) {
    console.log('  Has PSTITLEIMG wrapper. Header dump (0x00-0x200):');
    console.log(hexDump(psar, 0, 0x200, ''));
    console.log('\n  Disc table area (0x200-0x400):');
    console.log(hexDump(psar.slice(0x200), 0x200, 0x200, ''));
    // Look for disc1 pointer at various locations
    for (const off of [0x200, 0x204, 0x208, 0x20C, 0x210]) {
      const val = psar.readUInt32LE(off);
      if (val > 0) console.log(`  0x${off.toString(16)}: 0x${val.toString(16).padStart(8, '0')}`);
    }
  } else {
    console.log('  No PSTITLEIMG wrapper (direct PSISOIMG)');
  }
}

// ─── 6. STARTDAT comparison ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 6: STARTDAT / p1_offset REGION');
console.log('='.repeat(100));

for (const [key, info] of Object.entries(files)) {
  const fullBuf = bufs[key];
  const { psisoimgOffset } = psarInfo[key];
  const psisoBase = headers[key].offsets[7] + psisoimgOffset;
  const p1_offset = fullBuf.readUInt32LE(psisoBase + 0x0C);
  const p2_value = fullBuf.readUInt32LE(psisoBase + 0x1220);
  console.log(`\n${info.label}:`);
  console.log(`  p1_offset (at 0x0C): 0x${p1_offset.toString(16)} (${p1_offset})`);
  console.log(`  p2_value  (at 0x1220): 0x${p2_value.toString(16)}`);
  console.log(`  p2 - p1: 0x${(p2_value - p1_offset).toString(16)} (expected 0x2D31)`);

  // p1_offset points to STARTDAT relative to PSISOIMG start
  const startdatAbsOff = psisoBase + p1_offset;
  if (startdatAbsOff + 80 < fullBuf.length) {
    const sdMagic = fullBuf.toString('ascii', startdatAbsOff, startdatAbsOff + 8);
    console.log(`  STARTDAT at file offset 0x${startdatAbsOff.toString(16)}: magic="${sdMagic}"`);

    const logoSize = fullBuf.readUInt32LE(startdatAbsOff + 20);
    console.log(`  Logo size (at hdr+20): ${logoSize}`);

    // Check first 4 bytes after 80-byte header (should be PNG: 89 50 4E 47)
    if (startdatAbsOff + 84 < fullBuf.length) {
      const afterHdr = fullBuf.slice(startdatAbsOff + 80, startdatAbsOff + 84);
      const isPNG = afterHdr[0] === 0x89 && afterHdr[1] === 0x50;
      console.log(`  After header: ${afterHdr.toString('hex')} (${isPNG ? 'PNG' : 'NOT PNG'})`);
    }

    // Footer position
    const footerOff = startdatAbsOff + 80 + logoSize;
    if (footerOff + 4 < fullBuf.length) {
      const footer4 = fullBuf.slice(footerOff, footerOff + 4);
      console.log(`  Footer starts at file+0x${footerOff.toString(16)}: ${footer4.toString('hex')}`);
      const totalSD = fullBuf.length - startdatAbsOff;
      const footerSize = totalSD - 80 - logoSize;
      console.log(`  Total STARTDAT: ${totalSD} (hdr=80 + logo=${logoSize} + footer=${footerSize})`);
    }
  } else {
    console.log(`  STARTDAT at 0x${startdatAbsOff.toString(16)} — beyond file end (${fullBuf.length})`);
  }
}

// ─── 6b. TOC interpretation ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 6b: TOC INTERPRETATION (Block 3 at 0x800)');
console.log('='.repeat(100));

for (const [key, info] of Object.entries(files)) {
  const { psar, psisoimgOffset } = psarInfo[key];
  const tocBase = psisoimgOffset + 0x800;
  console.log(`\n${info.label}:`);

  // TOC entries are 10 bytes: ctrl(1) trackno(1) point(1) amin(1) asec(1) aframe(1) zero(1) pmin(1) psec(1) pframe(1)
  let entryCount = 0;
  for (let i = 0; i < 100; i++) {
    const off = tocBase + i * 10;
    if (off + 10 > psar.length) break;
    const ctrl = psar[off];
    const trackno = psar[off + 1];
    const point = psar[off + 2];
    if (ctrl === 0 && trackno === 0 && point === 0) break;

    const pmin = psar[off + 7];
    const psec = psar[off + 8];
    const pframe = psar[off + 9];

    const ctrlStr = (ctrl & 0x40) ? 'DATA ' : 'AUDIO';
    let pointStr;
    if (point === 0xA0) pointStr = 'first-trk';
    else if (point === 0xA1) pointStr = 'last-trk ';
    else if (point === 0xA2) pointStr = 'leadout  ';
    else pointStr = 'Track ' + ((point >> 4) * 10 + (point & 0xF)).toString().padStart(2, '0');

    console.log(`  [${i.toString().padStart(2)}] ctrl=0x${ctrl.toString(16).padStart(2,'0')}(${ctrlStr}) pt=0x${point.toString(16).padStart(2,'0')}(${pointStr}) P=${pmin.toString(16)}:${psec.toString(16).padStart(2,'0')}:${pframe.toString(16).padStart(2,'0')} raw=${psar.slice(off, off + 10).toString('hex')}`);
    entryCount++;
  }
  console.log(`  Total TOC entries: ${entryCount}`);

  // Disc start at 0xBFC
  const discStart = psar.readUInt32LE(psisoimgOffset + 0x800 + 0x3FC);
  console.log(`  Disc start offset (at 0xBFC): 0x${discStart.toString(16)}`);
}

// ─── 7. First compressed block comparison ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 7: FIRST COMPRESSED BLOCK (at PSISOIMG + 0x100000)');
console.log('='.repeat(100));

const ISO_DATA_BASE = 0x100000;

for (const [key, info] of Object.entries(files)) {
  const { psar, psisoimgOffset } = psarInfo[key];
  const blockOff = psisoimgOffset + ISO_DATA_BASE;
  if (blockOff + 64 <= psar.length) {
    console.log(`\n${info.label}: First block at PSAR+0x${blockOff.toString(16)}`);
    console.log(`  First 64 bytes:`);
    console.log(hexDump(psar.slice(blockOff, blockOff + 64), blockOff, 64, ''));
  } else {
    console.log(`\n${info.label}: Block offset 0x${blockOff.toString(16)} beyond file`);
  }
}

// Compare first block bytes
console.log('\n' + '-'.repeat(80));
console.log('OURS vs POP-FE: First 256 bytes of compressed data');
console.log('-'.repeat(80));
{
  const oursBlock = psarInfo.ours.psar.slice(psarInfo.ours.psisoimgOffset + ISO_DATA_BASE);
  const popfeBlock = psarInfo.popfe.psar.slice(psarInfo.popfe.psisoimgOffset + ISO_DATA_BASE);
  compareBuffers('Compressed block', oursBlock, 'OURS', popfeBlock, 'POPFE', 0, 256);
}

console.log('\n' + '-'.repeat(80));
console.log('OURS vs WORKING: First 256 bytes of compressed data');
console.log('-'.repeat(80));
{
  const oursBlock = psarInfo.ours.psar.slice(psarInfo.ours.psisoimgOffset + ISO_DATA_BASE);
  const workingBlock = psarInfo.working.psar.slice(psarInfo.working.psisoimgOffset + ISO_DATA_BASE);
  compareBuffers('Compressed block', oursBlock, 'OURS', workingBlock, 'WORKING', 0, 256);
}

console.log('\n' + '-'.repeat(80));
console.log('POP-FE vs WORKING: First 256 bytes of compressed data');
console.log('-'.repeat(80));
{
  const popfeBlock = psarInfo.popfe.psar.slice(psarInfo.popfe.psisoimgOffset + ISO_DATA_BASE);
  const workingBlock = psarInfo.working.psar.slice(psarInfo.working.psisoimgOffset + ISO_DATA_BASE);
  compareBuffers('Compressed block', popfeBlock, 'POPFE', workingBlock, 'WORKING', 0, 256);
}

// ─── 8. Extended header comparison 0x1400 - 0x4200 ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 8: EXTENDED HEADER REGION 0x1400 - 0x4200');
console.log('='.repeat(100));

console.log('\n' + '-'.repeat(80));
console.log('OURS vs POP-FE: 0x1400 - 0x4200');
console.log('-'.repeat(80));
compareBuffers('Region 0x1400-0x4200', psisoHeaders.ours, 'OURS', psisoHeaders.popfe, 'POPFE', 0x1400, 0x4200 - 0x1400);

console.log('\n' + '-'.repeat(80));
console.log('OURS vs WORKING: 0x1400 - 0x4200');
console.log('-'.repeat(80));
compareBuffers('Region 0x1400-0x4200', psisoHeaders.ours, 'OURS', psisoHeaders.working, 'WORKING', 0x1400, 0x4200 - 0x1400);

// ─── 9. Key field summary ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 9: KEY FIELD SUMMARY TABLE');
console.log('='.repeat(100));

const keyOffsets = [
  [0x00, 8, 'magic'],
  [0x08, 4, 'field_08 (?)'],
  [0x0C, 4, 'p1_offset'],
  [0x10, 4, 'field_10 (p2_offset?)'],
  [0x14, 4, 'field_14'],
  [0x18, 4, 'field_18'],
  [0x1C, 4, 'field_1C'],
  [0x20, 4, 'field_20'],
  [0x24, 4, 'field_24'],
  [0x28, 4, 'field_28'],
  [0x2C, 4, 'field_2C'],
  [0x30, 4, 'field_30'],
  [0x34, 4, 'field_34'],
  [0x38, 4, 'field_38'],
  [0x3C, 4, 'field_3C'],
];

console.log(`${'Offset'.padEnd(8)} ${'Field'.padEnd(44)} ${'OURS'.padEnd(14)} ${'POP-FE'.padEnd(14)} ${'WORKING'.padEnd(14)}`);
console.log('-'.repeat(94));
for (const [off, size, name] of keyOffsets) {
  const vals = {};
  for (const key of ['ours', 'popfe', 'working']) {
    if (size === 4) {
      vals[key] = psisoHeaders[key].readUInt32LE(off);
    } else {
      vals[key] = psisoHeaders[key].slice(off, off + size).toString('ascii');
    }
  }
  const fmt = (v) => typeof v === 'number' ? `0x${v.toString(16).padStart(8, '0')}` : `"${v}"`;
  const match = vals.ours === vals.popfe && vals.popfe === vals.working;
  const marker = match ? '  ' : '**';
  console.log(`${marker}0x${off.toString(16).padStart(4, '0')} ${name.padEnd(44)} ${fmt(vals.ours).padEnd(14)} ${fmt(vals.popfe).padEnd(14)} ${fmt(vals.working).padEnd(14)}`);
}

console.log('\n** = differs between files');

// ─── 10. PARAM.SFO comparison ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 10: PARAM.SFO COMPARISON');
console.log('='.repeat(100));

function parseSFO(buf, offset, size) {
  const sfo = buf.slice(offset, offset + size);
  const magic = sfo.toString('ascii', 0, 4);
  if (magic !== '\x00PSF') return [];
  const keyTableStart = sfo.readUInt32LE(8);
  const dataTableStart = sfo.readUInt32LE(12);
  const numEntries = sfo.readUInt32LE(16);
  const entries = [];
  for (let i = 0; i < numEntries; i++) {
    const entryOff = 20 + i * 16;
    const keyOff = sfo.readUInt16LE(entryOff);
    const dataFmt = sfo.readUInt16LE(entryOff + 2);
    const dataLen = sfo.readUInt32LE(entryOff + 4);
    const dataMaxLen = sfo.readUInt32LE(entryOff + 8);
    const dataOff = sfo.readUInt32LE(entryOff + 12);
    let keyEnd = keyTableStart + keyOff;
    while (keyEnd < sfo.length && sfo[keyEnd] !== 0) keyEnd++;
    const key = sfo.toString('ascii', keyTableStart + keyOff, keyEnd);
    const dataStart = dataTableStart + dataOff;
    let value;
    if (dataFmt === 0x0204) {
      value = sfo.toString('utf8', dataStart, dataStart + dataLen).replace(/\0+$/, '');
    } else if (dataFmt === 0x0404) {
      value = '0x' + sfo.readUInt32LE(dataStart).toString(16);
    } else {
      value = sfo.slice(dataStart, dataStart + dataLen).toString('hex').slice(0, 40);
    }
    entries.push({ key, fmt: dataFmt, len: dataLen, maxLen: dataMaxLen, value });
  }
  return entries;
}

for (const [key, info] of Object.entries(files)) {
  const h = headers[key];
  const sfoOff = h.offsets[0];
  const sfoSize = h.offsets[1] - sfoOff;
  console.log(`\n${info.label}: SFO size=${sfoSize}`);
  const entries = parseSFO(bufs[key], sfoOff, sfoSize);
  for (const e of entries) {
    const fmtStr = e.fmt === 0x0204 ? 'str' : e.fmt === 0x0404 ? 'u32' : '0x' + e.fmt.toString(16);
    console.log(`  ${e.key.padEnd(20)} fmt=${fmtStr.padEnd(5)} ${e.len}/${e.maxLen}\t= ${e.value}`);
  }
}

// ─── 11. DATA.PSP comparison ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 11: DATA.PSP COMPARISON');
console.log('='.repeat(100));

const crypto = require('crypto');

for (const [key, info] of Object.entries(files)) {
  const h = headers[key];
  const dataPspOff = h.offsets[6];
  const dataPsarOff = h.offsets[7];
  const dataPspSize = dataPsarOff - dataPspOff;
  const dataPsp = bufs[key].slice(dataPspOff, dataPspOff + dataPspSize);
  // Find last non-zero byte for trimmed size
  let lastNZ = dataPsp.length - 1;
  while (lastNZ > 0 && dataPsp[lastNZ] === 0) lastNZ--;
  const sha1 = crypto.createHash('sha1').update(dataPsp.slice(0, lastNZ + 1)).digest('hex');
  console.log(`\n${info.label}: section=${dataPspSize} trimmed=${lastNZ + 1} sha1=${sha1}`);
}

// Pairwise DATA.PSP diff (trimmed)
{
  const trimmed = {};
  for (const [key, info] of Object.entries(files)) {
    const h = headers[key];
    const raw = bufs[key].slice(h.offsets[6], h.offsets[7]);
    let lastNZ = raw.length - 1;
    while (lastNZ > 0 && raw[lastNZ] === 0) lastNZ--;
    trimmed[key] = raw.slice(0, lastNZ + 1);
  }
  const pairs = [['ours', 'popfe'], ['ours', 'working'], ['popfe', 'working']];
  for (const [a, b] of pairs) {
    const minLen = Math.min(trimmed[a].length, trimmed[b].length);
    let diffs = 0;
    for (let i = 0; i < minLen; i++) {
      if (trimmed[a][i] !== trimmed[b][i]) diffs++;
    }
    const sizeDiff = Math.abs(trimmed[a].length - trimmed[b].length);
    console.log(`\n${files[a].label} vs ${files[b].label}: ${diffs} byte diffs in ${minLen} common bytes, size diff=${sizeDiff}`);
  }
}

// ─── 12. Index validation ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 12: INDEX VALIDATION (all blocks)');
console.log('='.repeat(100));

for (const [key, info] of Object.entries(files)) {
  const fullBuf = bufs[key];
  const { psisoimgOffset } = psarInfo[key];
  const psisoBase = headers[key].offsets[7] + psisoimgOffset;
  const indexBase = psisoBase + 0x4000;
  const isoBase = psisoBase + 0x100000;

  let blockCount = 0, compressedCount = 0, rawCount = 0;
  let zeroSizeCount = 0, overflowCount = 0;
  let maxDataEnd = 0, prevEnd = 0, gapCount = 0, overlapCount = 0;
  let hasHashCount = 0;

  for (let i = 0; i < 20000; i++) {
    const entryOff = indexBase + i * 32;
    if (entryOff + 32 > fullBuf.length) break;
    const offset = fullBuf.readUInt32LE(entryOff);
    const size = fullBuf.readUInt16LE(entryOff + 4);
    if (i > 0 && size === 0 && offset === 0) break;
    blockCount++;
    if (size === 0) zeroSizeCount++;
    if (size > 0x9300) overflowCount++;
    if (size < 0x9300) compressedCount++; else rawCount++;
    if (i > 0 && offset < prevEnd) overlapCount++;
    if (i > 0 && offset > prevEnd + 0x100) gapCount++;
    const hash = fullBuf.slice(entryOff + 8, entryOff + 24);
    if (!hash.every(b => b === 0)) hasHashCount++;
    prevEnd = offset + size;
    if (prevEnd > maxDataEnd) maxDataEnd = prevEnd;
  }

  const p1 = fullBuf.readUInt32LE(psisoBase + 0x0C);
  const expectedEnd = maxDataEnd + 0x100000;
  const p1Match = p1 >= expectedEnd;

  console.log(`\n${info.label}:`);
  console.log(`  Blocks: ${blockCount} (${compressedCount} compressed, ${rawCount} raw)`);
  console.log(`  Zero-size: ${zeroSizeCount}  Overflow: ${overflowCount}`);
  console.log(`  Overlaps: ${overlapCount}  Gaps: ${gapCount}`);
  console.log(`  Blocks with hash: ${hasHashCount}/${blockCount}`);
  console.log(`  Max data end: 0x${maxDataEnd.toString(16)}  p1_offset: 0x${p1.toString(16)}  valid: ${p1Match}`);
}

// ─── 13. Compressed block analysis (BTYPE + decompress verification) ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 13: COMPRESSED BLOCK ANALYSIS');
console.log('='.repeat(100));

const zlib = require('zlib');

for (const [key, info] of Object.entries(files)) {
  const fullBuf = bufs[key];
  const { psisoimgOffset } = psarInfo[key];
  const psisoBase = headers[key].offsets[7] + psisoimgOffset;
  const indexBase = psisoBase + 0x4000;
  const isoBase = psisoBase + 0x100000;

  // Read all index entries
  const entries = [];
  for (let i = 0; i < 20000; i++) {
    const entryOff = indexBase + i * 32;
    if (entryOff + 32 > fullBuf.length) break;
    const offset = fullBuf.readUInt32LE(entryOff);
    const size = fullBuf.readUInt16LE(entryOff + 4);
    if (i > 0 && size === 0 && offset === 0) break;
    entries.push({ offset, size });
  }

  // Analyze BTYPE of first 200 compressed blocks + all blocks for errors
  let fixedCount = 0, dynamicCount = 0, storedCount = 0, rawCount = 0;
  let decompressErrors = 0;
  let firstError = null;
  const SAMPLE = 200; // detailed reporting for first N

  console.log(`\n${info.label}: ${entries.length} blocks`);
  console.log(`  First ${Math.min(SAMPLE, entries.length)} block BTYPEs:`);

  const btypeStr = [];
  for (let i = 0; i < entries.length; i++) {
    const { offset, size } = entries[i];
    const absOff = isoBase + offset;
    if (absOff + size > fullBuf.length) {
      if (!firstError) firstError = { block: i, reason: 'beyond file end' };
      break;
    }

    if (size === 0x9300) {
      // Uncompressed (raw) block
      rawCount++;
      if (i < SAMPLE) btypeStr.push('R');
      continue;
    }

    const blockData = fullBuf.slice(absOff, absOff + size);
    const firstByte = blockData[0];
    const btype = (firstByte >> 1) & 3;

    if (btype === 0) { storedCount++; if (i < SAMPLE) btypeStr.push('S'); }
    else if (btype === 1) { fixedCount++; if (i < SAMPLE) btypeStr.push('F'); }
    else if (btype === 2) { dynamicCount++; if (i < SAMPLE) btypeStr.push('D'); }
    else { if (i < SAMPLE) btypeStr.push('?'); }

    // Try decompressing
    try {
      const decompressed = zlib.inflateRawSync(blockData);
      if (decompressed.length !== 0x9300) {
        if (!firstError) firstError = { block: i, reason: `decompressed to ${decompressed.length} bytes (expected ${0x9300})` };
        decompressErrors++;
      }
    } catch (e) {
      if (!firstError) firstError = { block: i, reason: e.message };
      decompressErrors++;
    }
  }

  // Print BTYPE map in rows of 80
  for (let i = 0; i < btypeStr.length; i += 80) {
    console.log(`  ${btypeStr.slice(i, i + 80).join('')}`);
  }
  console.log(`\n  BTYPE summary: fixed=${fixedCount} dynamic=${dynamicCount} stored=${storedCount} raw(uncompressed)=${rawCount}`);
  console.log(`  Decompress errors: ${decompressErrors}/${entries.length}`);
  if (firstError) {
    console.log(`  First error at block ${firstError.block}: ${firstError.reason}`);
  }
}

// ─── 13b. Cross-EBOOT decompressed block comparison ───
console.log('\n' + '='.repeat(100));
console.log('SECTION 13b: DECOMPRESSED BLOCK COMPARISON (first 100 blocks)');
console.log('='.repeat(100));

function getDecompressedBlock(key, blockIdx) {
  const fullBuf = bufs[key];
  const { psisoimgOffset } = psarInfo[key];
  const psisoBase = headers[key].offsets[7] + psisoimgOffset;
  const indexBase = psisoBase + 0x4000;
  const isoBase = psisoBase + 0x100000;
  const entryOff = indexBase + blockIdx * 32;
  if (entryOff + 32 > fullBuf.length) return null;
  const offset = fullBuf.readUInt32LE(entryOff);
  const size = fullBuf.readUInt16LE(entryOff + 4);
  const absOff = isoBase + offset;
  if (absOff + size > fullBuf.length) return null;
  const blockData = fullBuf.slice(absOff, absOff + size);
  if (size === 0x9300) return blockData;
  try {
    return zlib.inflateRawSync(blockData);
  } catch (e) {
    return null;
  }
}

// Compare OURS vs WORKING decompressed blocks
{
  const COMPARE_BLOCKS = 100;
  let matchCount = 0, diffCount = 0, errorCount = 0;
  let firstDiff = null;
  for (let i = 0; i < COMPARE_BLOCKS; i++) {
    const ours = getDecompressedBlock('ours', i);
    const working = getDecompressedBlock('working', i);
    if (!ours || !working) { errorCount++; continue; }
    if (Buffer.compare(ours, working) === 0) {
      matchCount++;
    } else {
      diffCount++;
      if (!firstDiff) {
        // Find first differing byte
        let diffByte = -1;
        for (let j = 0; j < Math.min(ours.length, working.length); j++) {
          if (ours[j] !== working[j]) { diffByte = j; break; }
        }
        firstDiff = { block: i, byte: diffByte, oursLen: ours.length, workingLen: working.length };
      }
    }
  }
  console.log(`\nOURS vs WORKING (first ${COMPARE_BLOCKS} decompressed blocks):`);
  console.log(`  Match: ${matchCount}  Differ: ${diffCount}  Error: ${errorCount}`);
  if (firstDiff) {
    console.log(`  First diff: block ${firstDiff.block}, byte offset 0x${firstDiff.byte.toString(16)} (ours=${firstDiff.oursLen}, working=${firstDiff.workingLen})`);
  }
}

// Compare OURS vs POP-FE decompressed blocks
{
  const COMPARE_BLOCKS = 100;
  let matchCount = 0, diffCount = 0, errorCount = 0;
  for (let i = 0; i < COMPARE_BLOCKS; i++) {
    const ours = getDecompressedBlock('ours', i);
    const popfe = getDecompressedBlock('popfe', i);
    if (!ours || !popfe) { errorCount++; continue; }
    if (Buffer.compare(ours, popfe) === 0) matchCount++; else diffCount++;
  }
  console.log(`\nOURS vs POP-FE (first ${COMPARE_BLOCKS} decompressed blocks):`);
  console.log(`  Match: ${matchCount}  Differ: ${diffCount}  Error: ${errorCount}`);
}

console.log('\nDone.');
