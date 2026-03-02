// ══════════════════════════════════════════════════════════════════════════════
// DIAGNOSE TAB — EBOOT.PBP structural inspector
//
// Browser port of tools/inspect-eboot.js. Drop an EBOOT.PBP to view its
// internal structure: PBP header offsets, SFO metadata, PSAR layout variant,
// PSISOIMG header fields, TOC entries, index table stats, and block hashes.
//
// Useful for debugging EBOOTs that fail to boot — compare against known-good
// Sony PSN EBOOTs to spot structural differences.
// ══════════════════════════════════════════════════════════════════════════════

const diagnoseDropZone = document.getElementById('diagnoseDropZone');
const diagnoseFileInput = document.getElementById('diagnoseFileInput');
const diagnoseFileInfo = document.getElementById('diagnoseFileInfo');
const diagnoseFileName = document.getElementById('diagnoseFileName');
const diagnoseFileMeta = document.getElementById('diagnoseFileMeta');
const diagnoseProgressArea = document.getElementById('diagnoseProgressArea');
const diagnoseProgressFill = document.getElementById('diagnoseProgressFill');
const diagnoseProgressLabel = document.getElementById('diagnoseProgressLabel');
const diagnoseProgressPct = document.getElementById('diagnoseProgressPct');
const diagnoseStatus = document.getElementById('diagnoseStatus');
const diagnoseResults = document.getElementById('diagnoseResults');

let diagnoseWorking = false;

diagnoseDropZone.addEventListener('click', () => diagnoseFileInput.click());
diagnoseDropZone.addEventListener('dragover', e => { e.preventDefault(); diagnoseDropZone.classList.add('dragover'); });
diagnoseDropZone.addEventListener('dragleave', () => diagnoseDropZone.classList.remove('dragover'));
diagnoseDropZone.addEventListener('drop', e => {
  e.preventDefault();
  diagnoseDropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleDiagnoseDrop(e.dataTransfer.files);
});
diagnoseFileInput.addEventListener('change', () => {
  if (diagnoseFileInput.files.length) handleDiagnoseDrop(diagnoseFileInput.files);
  diagnoseFileInput.value = '';
});

async function handleDiagnoseDrop(fileList) {
  if (diagnoseWorking) return;
  const file = fileList[0];

  diagnoseResults.innerHTML = '';
  diagnoseStatus.textContent = '';
  diagnoseStatus.className = 'status';
  diagnoseProgressArea.style.display = 'none';

  diagnoseFileName.textContent = file.name;
  diagnoseFileMeta.innerHTML = formatSize(file.size);
  diagnoseFileInfo.style.display = 'block';

  diagnoseWorking = true;
  diagnoseProgressArea.style.display = 'block';
  showDiagnoseProgress(0, 'Reading PBP header...');

  try {
    const result = await inspectEboot(file);
    diagnoseResults.innerHTML = renderInspectResults(result);
    initCollapsibles();
    diagnoseStatus.textContent = 'Inspection complete';
  } catch (e) {
    diagnoseStatus.textContent = 'Error: ' + e.message;
    diagnoseStatus.className = 'status error';
  } finally {
    diagnoseWorking = false;
    diagnoseProgressArea.style.display = 'none';
  }
}

function showDiagnoseProgress(pct, label) {
  const p = Math.round(pct * 100);
  diagnoseProgressFill.style.width = p + '%';
  diagnoseProgressPct.textContent = p + '%';
  diagnoseProgressLabel.textContent = label;
}

// ── Inspector engine (ported from tools/inspect-eboot.js) ────────────────────

const PBP_HEADER_SIZE = 0x28;
const PBP_SECTION_NAMES = [
  'PARAM.SFO', 'ICON0.PNG', 'ICON1.PMF', 'PIC0.PNG',
  'PIC1.PNG', 'SND0.AT3', 'DATA.PSP', 'DATA.PSAR',
];
const SFO_MAGIC = 0x46535000;
const SFO_UTF8S = 0x0004;
const SFO_UTF8 = 0x0204;
const SFO_INT32 = 0x0404;
// ISO_BLOCK_SIZE declared in shared.js
const INDEX_ENTRY_SIZE = 32;
const ISO_DATA_BASE = 0x100000;
const STARTDAT_CONST = 0x2D31;

async function readBytes(file, offset, length) {
  const buf = await file.slice(offset, offset + length).arrayBuffer();
  return new Uint8Array(buf);
}

async function readU32(file, offset) {
  const b = await readBytes(file, offset, 4);
  return b[0] | (b[1] << 8) | (b[2] << 16) | ((b[3] << 24) >>> 0);
}

function hex(n) {
  return '0x' + n.toString(16).toUpperCase();
}

function fromBcd(b) {
  return ((b >> 4) & 0xF) * 10 + (b & 0xF);
}

async function readNullString(file, offset, maxLen) {
  const buf = await readBytes(file, offset, maxLen);
  let end = 0;
  while (end < maxLen && buf[end] !== 0) end++;
  return new TextDecoder('utf-8').decode(buf.slice(0, end));
}

async function inspectPbpHeader(file) {
  const header = await readBytes(file, 0, PBP_HEADER_SIZE);
  const dv = new DataView(header.buffer);
  const magic = new TextDecoder('ascii').decode(header.slice(0, 4));
  const version = dv.getUint32(4, true);

  const offsets = [];
  for (let i = 0; i < 8; i++) {
    offsets.push(dv.getUint32(8 + i * 4, true));
  }

  const sections = offsets.map((offset, i) => {
    const end = i < 7 ? offsets[i + 1] : file.size;
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

async function inspectSfo(file, offset, size) {
  if (size < 20) return { error: 'SFO too small' };

  const sfo = await readBytes(file, offset, size);
  const dv = new DataView(sfo.buffer);
  const magic = dv.getUint32(0, true);
  if (magic !== SFO_MAGIC) return { error: `Bad SFO magic: ${hex(magic)}` };

  const version = dv.getUint32(4, true);
  const keyTableOff = dv.getUint32(8, true);
  const dataTableOff = dv.getUint32(12, true);
  const entryCount = dv.getUint32(16, true);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const base = 20 + i * 16;
    const keyOff = dv.getUint16(base, true);
    const dataType = dv.getUint16(base + 2, true);
    const dataUsed = dv.getUint32(base + 4, true);
    const dataMax = dv.getUint32(base + 8, true);
    const dataOff = dv.getUint32(base + 12, true);

    let keyEnd = keyTableOff + keyOff;
    while (keyEnd < size && sfo[keyEnd] !== 0) keyEnd++;
    const key = new TextDecoder('utf-8').decode(sfo.slice(keyTableOff + keyOff, keyEnd));

    let value;
    const valStart = dataTableOff + dataOff;
    if (dataType === SFO_INT32) {
      value = dv.getUint32(valStart, true);
    } else {
      let valEnd = valStart + dataUsed;
      while (valEnd > valStart && sfo[valEnd - 1] === 0) valEnd--;
      value = new TextDecoder('utf-8').decode(sfo.slice(valStart, valEnd));
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

async function isTocAt(file, absOffset) {
  const first = await readBytes(file, absOffset, 3);
  return (first[0] === 0x41 || first[0] === 0x01) && first[1] === 0x00 && first[2] === 0xA0;
}

async function inspectToc(file, absOffset) {
  const maxTocBytes = 102 * 10;
  const tocBuf = await readBytes(file, absOffset, maxTocBytes);
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

async function probeIndexAt(file, absOffset, fileSize) {
  if (absOffset + INDEX_ENTRY_SIZE > fileSize) return false;
  const first = await readBytes(file, absOffset, 8);
  const dv = new DataView(first.buffer);
  const offset = dv.getUint32(0, true);
  const length = dv.getUint32(4, true);
  return offset === 0 && length > 0 && length <= ISO_BLOCK_SIZE;
}

async function inspectIndexTable(file, absOffset, fileSize) {
  const maxEntries = Math.min(500000, Math.floor((fileSize - absOffset) / INDEX_ENTRY_SIZE));
  let numEntries = 0;
  let minLen = Infinity, maxLen = 0;
  let firstOffset = 0, firstLength = 0;
  let lastOffset = 0, lastLength = 0;
  let prevEnd = 0, gaps = 0, overlaps = 0, hashedEntries = 0;

  const chunkSize = 1024;
  for (let chunk = 0; chunk < maxEntries; chunk += chunkSize) {
    const count = Math.min(chunkSize, maxEntries - chunk);
    const buf = await readBytes(file, absOffset + chunk * INDEX_ENTRY_SIZE, count * INDEX_ENTRY_SIZE);
    const dv = new DataView(buf.buffer);

    for (let i = 0; i < count; i++) {
      const base = i * INDEX_ENTRY_SIZE;
      const offset = dv.getUint32(base, true);
      const length = dv.getUint32(base + 4, true);

      if (length === 0 || length > ISO_BLOCK_SIZE) return buildResult();

      if (numEntries === 0) {
        firstOffset = offset;
        firstLength = length;
      } else {
        if (offset < prevEnd) overlaps++;
        else if (offset > prevEnd) gaps++;
      }
      // Check for non-zero SHA-1 hash at bytes 8-28
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

async function sampleDecompress(file, psisoAbsOffset, indexAbsOffset, indexInfo) {
  if (indexInfo.entryCount === 0) return [];
  if (typeof inflateRaw === 'undefined') return [{ block: 0, error: 'inflateRaw not available' }];

  const results = [];
  const indices = [0, indexInfo.entryCount - 1];

  for (const idx of indices) {
    const entryBuf = await readBytes(file, indexAbsOffset + idx * INDEX_ENTRY_SIZE, 8);
    const dv = new DataView(entryBuf.buffer);
    const offset = dv.getUint32(0, true);
    const length = dv.getUint32(4, true);
    const absDataOffset = psisoAbsOffset + ISO_DATA_BASE + offset;

    const sample = { block: idx, compressedSize: length };

    if (length === ISO_BLOCK_SIZE) {
      sample.stored = 'uncompressed';
      sample.decompressedSize = ISO_BLOCK_SIZE;
    } else {
      try {
        const blockData = await readBytes(file, absDataOffset, length);
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

async function analyzeBtypes(file, psisoAbsOffset, indexAbsOffset, indexInfo) {
  if (indexInfo.entryCount === 0) return { fixed: 0, dynamic: 0, stored: 0, raw: 0 };
  let fixed = 0, dynamic = 0, stored = 0, raw = 0;
  for (let i = 0; i < indexInfo.entryCount; i++) {
    const entryBuf = await readBytes(file, indexAbsOffset + i * INDEX_ENTRY_SIZE, 8);
    const dv = new DataView(entryBuf.buffer);
    const length = dv.getUint32(4, true);
    if (length === ISO_BLOCK_SIZE) { raw++; continue; }
    const absDataOffset = psisoAbsOffset + ISO_DATA_BASE + dv.getUint32(0, true);
    const firstByte = (await readBytes(file, absDataOffset, 1))[0];
    const btype = (firstByte >> 1) & 3;
    if (btype === 0) stored++;
    else if (btype === 1) fixed++;
    else if (btype === 2) dynamic++;
  }
  return { fixed, dynamic, stored, raw };
}

async function detectVariant(file, absOffset) {
  const probe = await readBytes(file, absOffset + 0x400, 4);
  if (probe[0] === 0x5F) return 'sony';
  if (await isTocAt(file, absOffset + 0x400)) return 'popstationr';
  if (await probeIndexAt(file, absOffset + 0x4000, file.size)) return 'sony';
  if (await probeIndexAt(file, absOffset + 0x3C00, file.size)) return 'popstationr';
  return 'unknown';
}

async function inspectPsisoimg(file, absOffset, label) {
  const magicBuf = await readBytes(file, absOffset, 12);
  const magic = new TextDecoder('ascii').decode(magicBuf);
  if (magic !== 'PSISOIMG0000') {
    return { error: `Bad PSISOIMG magic: "${magic}"`, label };
  }

  const p1_offset = await readU32(file, absOffset + 0x0C);
  const variant = await detectVariant(file, absOffset);

  const tocOffset = variant === 'sony' ? 0x800 : 0x400;
  const indexOffset = variant === 'sony' ? 0x4000 : 0x3C00;

  const reserved = await readBytes(file, absOffset + 0x10, 0x3F0);
  let nonZeroCount = 0;
  for (let i = 0; i < reserved.length; i++) {
    if (reserved[i] !== 0) nonZeroCount++;
  }

  let discIdAt400 = null;
  if (variant === 'sony') {
    discIdAt400 = await readNullString(file, absOffset + 0x400, 16);
  }

  let toc = { entryCount: 0, entries: [] };
  if (await isTocAt(file, absOffset + tocOffset)) {
    toc = await inspectToc(file, absOffset + tocOffset);
  }

  const p2_offset = await readU32(file, absOffset + 0x0E20);

  let title = '';
  if (variant === 'popstationr') {
    title = await readNullString(file, absOffset + 0x0E24 + 8, 128);
  } else {
    for (const probe of [0x0E24 + 8, 0x1218, 0x1220, 0x1228, 0x1008]) {
      const s = await readNullString(file, absOffset + probe, 128);
      if (s.length >= 3 && /^[\x20-\x7E]+$/.test(s)) {
        title = s;
        break;
      }
    }
  }

  const indexAbsOffset = absOffset + indexOffset;
  const indexInfo = await inspectIndexTable(file, indexAbsOffset, file.size);

  let startdatMagic = null;
  let startdatRelOffset = null;
  if (indexInfo.compressedTotal > 0) {
    const sdAbsOffset = absOffset + ISO_DATA_BASE + indexInfo.compressedTotal;
    startdatRelOffset = ISO_DATA_BASE + indexInfo.compressedTotal;
    if (sdAbsOffset + 8 <= file.size) {
      const sdBuf = await readBytes(file, sdAbsOffset, 8);
      startdatMagic = new TextDecoder('ascii').decode(sdBuf).replace(/\0/g, '');
    }
  }

  const btypes = await analyzeBtypes(file, absOffset, indexAbsOffset, indexInfo);
  const samples = await sampleDecompress(file, absOffset, indexAbsOffset, indexInfo);

  const compressedTotal = indexInfo.compressedTotal;
  const uncompressedTotal = indexInfo.entryCount * ISO_BLOCK_SIZE;
  const expectedP1_compressed = compressedTotal + ISO_DATA_BASE;
  const expectedP1_aligned = (expectedP1_compressed + 0xF) & ~0xF;
  const expectedP1_uncompressed = uncompressedTotal + ISO_DATA_BASE;
  const p1_ok = p1_offset === expectedP1_compressed || p1_offset === expectedP1_aligned || p1_offset === expectedP1_uncompressed;
  const checks = {
    p1_matches: p1_ok,
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

async function inspectPsar(file, psarOffset) {
  const magicBuf = await readBytes(file, psarOffset, 14);
  const magic = new TextDecoder('ascii').decode(magicBuf).replace(/\0/g, '');

  if (magic.startsWith('PSTITLEIMG')) {
    showDiagnoseProgress(0.3, 'Reading multi-disc structure...');
    const discOffsets = [];
    for (let i = 0; i < 5; i++) {
      const off = await readU32(file, psarOffset + 0x200 + i * 4);
      if (off === 0 && i > 0) break;
      discOffsets.push(off);
    }

    const discs = [];
    for (let i = 0; i < discOffsets.length; i++) {
      showDiagnoseProgress(0.3 + 0.6 * (i / discOffsets.length), `Inspecting disc ${i + 1}...`);
      discs.push(await inspectPsisoimg(file, psarOffset + discOffsets[i], `Disc ${i + 1}`));
    }

    return { type: 'PSTITLEIMG', discCount: discOffsets.length, discOffsets, discs };
  } else if (magic.startsWith('PSISOIMG')) {
    showDiagnoseProgress(0.3, 'Inspecting PSISOIMG...');
    const disc = await inspectPsisoimg(file, psarOffset, 'Single disc');
    return { type: 'PSISOIMG', discCount: 1, discs: [disc] };
  } else {
    return { type: 'unknown', magic };
  }
}

async function sha1Hex(data) {
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function inspectEboot(file) {
  showDiagnoseProgress(0.1, 'Reading PBP header...');
  const pbp = await inspectPbpHeader(file);

  showDiagnoseProgress(0.2, 'Reading PARAM.SFO...');
  const sfo = await inspectSfo(file, pbp.offsets[0], pbp.offsets[1] - pbp.offsets[0]);

  // DATA.PSP SHA-1
  const dataPspOffset = pbp.offsets[6];
  const dataPspSize = pbp.offsets[7] - dataPspOffset;
  let dataPspSha1 = null;
  if (dataPspSize > 0) {
    const dataPsp = await readBytes(file, dataPspOffset, dataPspSize);
    dataPspSha1 = await sha1Hex(dataPsp);
  }

  const psar = await inspectPsar(file, pbp.offsets[7]);
  showDiagnoseProgress(1, 'Done');

  return { fileSize: file.size, pbp, sfo, dataPspSha1, psar };
}

// ── Render inspect results as HTML ───────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function badge(pass, text) {
  const cls = pass ? 'check-pass' : 'check-fail';
  return `<span class="${cls}">${pass ? 'PASS' : 'FAIL'}</span> ${esc(text)}`;
}

function collapsibleSection(title, bodyHTML, startOpen) {
  const arrowCls = startOpen ? 'arrow' : 'arrow collapsed';
  const bodyCls = startOpen ? 'section-body' : 'section-body collapsed';
  return `<div class="section">
    <div class="section-header"><span class="${arrowCls}">&#9660;</span> ${esc(title)}</div>
    <div class="${bodyCls}">${bodyHTML}</div>
  </div>`;
}

function renderInspectResults(result) {
  const { pbp, sfo, psar } = result;
  let html = '';

  // PBP Header
  let pbpBody = '<table>';
  pbpBody += `<tr><td>Magic</td><td>${esc(pbp.magic)}</td></tr>`;
  pbpBody += `<tr><td>Version</td><td>${esc(pbp.version)}</td></tr>`;
  pbpBody += `<tr><td>File size</td><td>${formatSize(result.fileSize)}</td></tr>`;
  pbpBody += '</table><table style="margin-top:0.4rem">';
  for (const s of pbp.sections) {
    const status = s.empty ? '<span style="color:#666">(empty)</span>' : formatSize(s.size);
    pbpBody += `<tr><td>${esc(s.name)}</td><td><span class="hex">${hex(s.offset)}</span></td><td>${status}</td></tr>`;
  }
  pbpBody += '</table>';
  if (result.dataPspSha1) {
    pbpBody += `<div style="margin-top:0.3rem;font-size:0.75rem;color:#888">DATA.PSP SHA-1: <span class="hex">${esc(result.dataPspSha1)}</span></div>`;
  }
  html += collapsibleSection('PBP Header', pbpBody, true);

  // PARAM.SFO
  let sfoBody = '';
  if (sfo.error) {
    sfoBody = `<span class="check-fail">ERROR: ${esc(sfo.error)}</span>`;
  } else {
    sfoBody = '<table>';
    for (const e of sfo.entries) {
      const val = typeof e.value === 'number'
        ? `${e.value} (<span class="hex">${hex(e.value)}</span>)`
        : `"${esc(e.value)}"`;
      sfoBody += `<tr><td>${esc(e.key)}</td><td style="color:#888">[${esc(e.type)}]</td><td>${val}</td></tr>`;
    }
    sfoBody += '</table>';
  }
  html += collapsibleSection('PARAM.SFO', sfoBody, true);

  // DATA.PSAR
  let psarBody = `<table>`;
  psarBody += `<tr><td>Type</td><td>${esc(psar.type)}</td></tr>`;
  psarBody += `<tr><td>Discs</td><td>${psar.discCount}</td></tr>`;
  if (psar.discOffsets) {
    psarBody += `<tr><td>Offsets</td><td>${psar.discOffsets.map(hex).join(', ')}</td></tr>`;
  }
  psarBody += '</table>';

  for (const disc of psar.discs) {
    psarBody += `<div class="disc-separator">${esc(disc.label)}</div>`;
    if (disc.error) {
      psarBody += `<span class="check-fail">ERROR: ${esc(disc.error)}</span>`;
      continue;
    }

    psarBody += '<table>';
    psarBody += `<tr><td>Variant</td><td>${esc(disc.variant)}</td></tr>`;
    psarBody += `<tr><td>p1_offset</td><td><span class="hex">${hex(disc.p1_offset)}</span></td></tr>`;
    psarBody += `<tr><td>p2_offset</td><td><span class="hex">${hex(disc.p2_offset)}</span></td></tr>`;
    if (disc.discIdAt400) {
      psarBody += `<tr><td>Disc ID</td><td>"${esc(disc.discIdAt400)}"</td></tr>`;
    }
    psarBody += `<tr><td>Reserved</td><td>${disc.reservedAreaClean ? '<span class="check-pass">clean</span>' : `<span class="check-warn">${disc.reservedNonZeroBytes} non-zero bytes</span>`}</td></tr>`;
    psarBody += `<tr><td>Title</td><td>"${esc(disc.title)}"</td></tr>`;
    psarBody += '</table>';

    // TOC
    if (disc.toc.entryCount > 0) {
      psarBody += `<div style="margin-top:0.3rem;color:#999;font-size:0.75rem">TOC at +${hex(disc.tocOffset)}: ${disc.toc.entryCount} entries</div>`;
      psarBody += '<table>';
      for (const t of disc.toc.entries) {
        psarBody += `<tr><td>${esc(t.pointLabel)}</td><td>${esc(t.type)}</td><td>P=${esc(t.pmsf)}</td></tr>`;
      }
      psarBody += '</table>';
    }

    // Index table
    const idx = disc.indexTable;
    psarBody += `<div style="margin-top:0.3rem;color:#999;font-size:0.75rem">Index at +${hex(disc.indexOffset)}: ${idx.entryCount} blocks</div>`;
    if (idx.entryCount > 0) {
      psarBody += '<table>';
      psarBody += `<tr><td>First</td><td>offset=<span class="hex">${hex(idx.firstEntry.offset)}</span> len=${idx.firstEntry.length}</td></tr>`;
      psarBody += `<tr><td>Last</td><td>offset=<span class="hex">${hex(idx.lastEntry.offset)}</span> len=${idx.lastEntry.length}</td></tr>`;
      psarBody += `<tr><td>Block sizes</td><td>min=${idx.minBlockSize} max=${idx.maxBlockSize} (limit=<span class="hex">${hex(ISO_BLOCK_SIZE)}</span>)</td></tr>`;
      psarBody += `<tr><td>Compressed</td><td>${formatSize(idx.compressedTotal)}</td></tr>`;
      psarBody += `<tr><td>Uncompressed</td><td>${formatSize(idx.uncompressedTotal)}</td></tr>`;
      psarBody += `<tr><td>Ratio</td><td>${idx.ratio}</td></tr>`;
      psarBody += `<tr><td>Continuity</td><td>${idx.gaps === 0 && idx.overlaps === 0 ? '<span class="check-pass">contiguous</span>' : `<span class="check-warn">${idx.gaps} gaps, ${idx.overlaps} overlaps</span>`}</td></tr>`;
      psarBody += `<tr><td>Block hashes</td><td>${idx.hashedEntries}/${idx.entryCount}</td></tr>`;
      psarBody += '</table>';
    }

    // BTYPE breakdown
    if (disc.btypes) {
      const bt = disc.btypes;
      const total = bt.fixed + bt.dynamic + bt.stored + bt.raw;
      if (total > 0) {
        psarBody += '<div style="margin-top:0.3rem;color:#999;font-size:0.75rem">Compression BTYPE</div><table>';
        psarBody += `<tr><td>Dynamic Huffman</td><td>${bt.dynamic}</td></tr>`;
        psarBody += `<tr><td>Fixed Huffman</td><td>${bt.fixed}</td></tr>`;
        psarBody += `<tr><td>Stored (deflate)</td><td>${bt.stored}</td></tr>`;
        psarBody += `<tr><td>Uncompressed (raw)</td><td>${bt.raw}</td></tr>`;
        psarBody += '</table>';
      }
    }

    // STARTDAT
    if (disc.startdatOffset != null) {
      psarBody += `<div style="margin-top:0.3rem"><span style="color:#999;font-size:0.75rem">STARTDAT at +${hex(disc.startdatOffset)}</span> magic="${esc(disc.startdatMagic || 'N/A')}"</div>`;
    }

    // Sample decompress
    if (disc.samples.length > 0) {
      psarBody += '<div style="margin-top:0.3rem;color:#999;font-size:0.75rem">Sample decompress</div><table>';
      for (const s of disc.samples) {
        if (s.error) {
          psarBody += `<tr><td>Block ${s.block}</td><td><span class="check-fail">FAIL</span> ${esc(s.error)}</td></tr>`;
        } else {
          const sizeOk = s.ok !== false;
          psarBody += `<tr><td>Block ${s.block}</td><td>${esc(s.stored)} ${s.compressedSize} &rarr; ${s.decompressedSize}${sizeOk ? '' : ' <span class="check-fail">WRONG SIZE</span>'}</td></tr>`;
        }
      }
      psarBody += '</table>';
    }

    // Sanity checks
    const c = disc.sanityChecks;
    psarBody += '<div style="margin-top:0.4rem;color:#999;font-size:0.75rem">Sanity checks</div><table>';
    psarBody += `<tr><td>p1</td><td>${badge(c.p1_matches, c.p1_matches ? 'OK' : `got ${hex(disc.p1_offset)}, expected ${hex(c.p1_compressed)} or ${hex(c.p1_uncompressed)}`)}</td></tr>`;
    psarBody += `<tr><td>p2</td><td>${badge(c.p2_matches, c.p2_matches ? '0' : `got ${hex(disc.p2_offset)}`)}</td></tr>`;
    psarBody += `<tr><td>First idx</td><td>${badge(c.firstIndexOffsetZero, 'offset == 0')}</td></tr>`;
    psarBody += `<tr><td>Block range</td><td>${badge(c.allBlocksInRange, 'all <= 0x9300')}</td></tr>`;
    psarBody += '</table>';
  }

  html += collapsibleSection('DATA.PSAR', psarBody, true);

  return html;
}

function initCollapsibles() {
  for (const header of diagnoseResults.querySelectorAll('.section-header')) {
    header.addEventListener('click', () => {
      const arrow = header.querySelector('.arrow');
      const body = header.nextElementSibling;
      arrow.classList.toggle('collapsed');
      body.classList.toggle('collapsed');
    });
  }
}
