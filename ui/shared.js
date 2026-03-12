// 공유 UI 유틸리티 및 헬퍼
//
// 이 파일은 가장 먼저 로드되며 (convert.js, eboot-ui.js, diagnose.js 이전)
// 모든 탭에서 사용되는 공통 함수를 제공합니다: 파일 크기 포맷팅, 다운로드
// 트리거, 포맷 감지, 디스크 ID 자동 감지, CUE 파싱, 아트워크
// 관리, 탭 전환, EBOOT 다운로드용 최소 ZIP 생성기.
//
// 모든 함수는 전역(모듈 시스템 없음 — UI 스크립트는 build.js에 의해
// 단일 <script> 블록으로 연결됨).

// ── 상수 ────────────────────────────────────────────────────────────────────
const ISO_BLOCK_SIZE = 0x9300; // PSISOIMG 블록당 37,632 바이트

// ── 유틸리티 ────────────────────────────────────────────────────────────────

/** 바이트 수를 사람이 읽기 쉬운 문자열로 포맷합니다 (예: 1.23 GB). */
function formatSize(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n + ' B';
}

/** Uint8Array를 지정된 파일명으로 브라우저 다운로드를 트리거합니다. */
function download(data, filename) {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ── 최소 ZIP 생성기 (단일 저장 파일, 압축 없음) ─────────────────────────────
// EBOOT.PBP를 파일명을 보존하면서 다운로드용 ZIP으로 감싸는 데 사용합니다.
// PKZIP APPNOTE 스펙의 최소 구현: 로컬 파일 헤더 하나,
// 중앙 디렉터리 항목 하나, 중앙 디렉터리 끝 레코드 하나.

/** CRC-32 (ISO 3309), 지연 테이블 초기화 방식. */
function crc32(data) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** 하나 이상의 저장(비압축) 파일을 포함하는 ZIP 아카이브를 생성합니다.
 *  @param {Array<{name: string, data: Uint8Array}>} entries */
function createZip(entries) {
  const enc = new TextEncoder();

  // 항목별 메타데이터 사전 계산
  const meta = entries.map(e => {
    const nameBytes = enc.encode(e.name);
    return { nameBytes, crc: crc32(e.data), size: e.data.length, nameLen: nameBytes.length };
  });

  // 전체 크기: 로컬 헤더 + 데이터 + 중앙 디렉터리 + EOCD
  const localSize = meta.reduce((sum, m) => sum + 30 + m.nameLen + m.size, 0);
  const cdSize = meta.reduce((sum, m) => sum + 46 + m.nameLen, 0);
  const totalSize = localSize + cdSize + 22;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let off = 0;

  // 중앙 디렉터리를 위한 로컬 헤더 오프셋 추적
  const localOffsets = [];

  // 로컬 파일 헤더 + 데이터
  for (let i = 0; i < entries.length; i++) {
    const m = meta[i];
    localOffsets.push(off);
    view.setUint32(off, 0x04034B50, true); off += 4;
    view.setUint16(off, 20, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint32(off, m.crc, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint16(off, m.nameLen, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    bytes.set(m.nameBytes, off); off += m.nameLen;
    bytes.set(entries[i].data, off); off += m.size;
  }

  // 중앙 디렉터리
  const cdOffset = off;
  for (let i = 0; i < entries.length; i++) {
    const m = meta[i];
    view.setUint32(off, 0x02014B50, true); off += 4;
    view.setUint16(off, 20, true); off += 2;
    view.setUint16(off, 20, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint32(off, m.crc, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint16(off, m.nameLen, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint32(off, 0, true); off += 4;
    view.setUint32(off, localOffsets[i], true); off += 4;
    bytes.set(m.nameBytes, off); off += m.nameLen;
  }

  // 중앙 디렉터리 끝
  const cdLen = off - cdOffset;
  view.setUint32(off, 0x06054B50, true); off += 4;
  view.setUint16(off, 0, true); off += 2;
  view.setUint16(off, 0, true); off += 2;
  view.setUint16(off, entries.length, true); off += 2;
  view.setUint16(off, entries.length, true); off += 2;
  view.setUint32(off, cdLen, true); off += 4;
  view.setUint32(off, cdOffset, true); off += 4;
  view.setUint16(off, 0, true); off += 2;

  return new Uint8Array(buf);
}

/** Web Worker에서 ZIP 아카이브를 생성합니다 (메인 스레드 외부).
 *  @param {Array<{name: string, data: Uint8Array}>} entries
 *  @param {function(string, number, number): void} [onProgress] - (phase, index, total)로 호출됨
 *  @returns {Promise<Uint8Array>} */
function createZipInWorker(entries, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('zip-worker.js');
    const transferList = entries.map(e => e.data.buffer);
    worker.onmessage = function(e) {
      const msg = e.data;
      if (msg.type === 'progress') {
        if (onProgress) onProgress(msg.phase, msg.index, msg.total);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(new Uint8Array(msg.result));
      }
    };
    worker.onerror = function(err) {
      worker.terminate();
      reject(new Error(err.message || String(err)));
    };
    worker.postMessage(
      { entries: entries.map(e => ({ name: e.name, data: e.data.buffer })) },
      transferList
    );
  });
}

// ── 탭 전환 ──────────────────────────────────────────────────────────────────
function switchTab(tabId) {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('active', panel.id === 'panel-' + tabId);
  }
}

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

// ── 아트워크 상태 ────────────────────────────────────────────────────────────
// 현재 아트워크 PNG와 각각이 사용자가 제공한 것(커스텀)인지
// 자동 생성된 것인지를 추적합니다. 커스텀 아트워크는 타이틀/디스크ID가 변경되어도
// 보존되며, 자동 생성된 아트워크는 재생성됩니다.
let currentIcon0 = null;
let currentIcon1 = null; // ICON1 원본 바이트 (PMF 또는 PNG) — 애니메이션 아이콘
let currentPic0 = null;
let currentPic1 = null;
let icon0IsCustom = false;
let pic0IsCustom = false;
let pic1IsCustom = false;
// × 버튼으로 명시적으로 제거한 슬롯 — isCustom과 별개로 regenerate를 막음
let icon0Deleted = false;
let pic0Deleted  = false;
let pic1Deleted  = false;

function canvasToUint8Array(canvas) {
  return new Promise(resolve => {
    canvas.toBlob(blob => {
      blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
    }, 'image/png');
  });
}


/**
 * 사용자가 재정의하지 않은 슬롯의 기본 아트워크를 재생성합니다.
 * 선택적으로 디스크 ID로 psx-artwork 저장소에서 아트워크를 가져옵니다.
 */
async function regenerateDefaults() {
  const title = ebootTitle.value.trim();
  const discId = ebootDiscId.value.trim();
  const fetchCb = document.getElementById('ebootFetchArt');
  const shouldFetch = fetchCb && fetchCb.checked && discId;

  // 세 가지 타입 모두 병렬로 가져오기 (각각 독립적으로 404가 될 수 있음)
  const fetched = shouldFetch
    ? await fetchAllArtwork(discId)
    : { icon0: null, pic0: null, pic1: null };

  if (!icon0IsCustom && !icon0Deleted) {
    if (fetched.icon0) {
      currentIcon0 = await resizeImageToUint8Array(
        new Blob([fetched.icon0], { type: 'image/jpeg' }), 80, 80);
    } else {
      currentIcon0 = await generateDefaultIcon0(title);
    }
    artIcon0.src = URL.createObjectURL(new Blob([currentIcon0], { type: 'image/png' }));
  }
  if (!pic0IsCustom && !pic0Deleted) {
    if (fetched.pic0) {
      currentPic0 = await resizeImageToUint8Array(
        new Blob([fetched.pic0], { type: 'image/jpeg' }), 310, 180);
    } else {
      currentPic0 = await generateDefaultPic0(title, discId);
    }
    artPic0.src = URL.createObjectURL(new Blob([currentPic0], { type: 'image/png' }));
  }
  if (!pic1IsCustom && !pic1Deleted) {
    if (fetched.pic1) {
      currentPic1 = await resizeImageToUint8Array(
        new Blob([fetched.pic1], { type: 'image/jpeg' }), 480, 272);
    } else {
      currentPic1 = await generateDefaultPic1(title);
    }
    artPic1.src = URL.createObjectURL(new Blob([currentPic1], { type: 'image/png' }));
  }
}

/**
 * 이미지 파일을 로드하여 targetW×targetH에 레터박스 방식으로 맞춥니다 (종횡비 보존,
 * 나머지 공간은 어두운 배경으로 채움). PNG Uint8Array를 반환합니다.
 * 정사각형 커버 이미지가 144×80으로 왜곡되지 않도록 ICON0에 사용됩니다.
 */
function containImageToUint8Array(file, targetW, targetH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = targetW; c.height = targetH;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, targetW, targetH);
      const scale = Math.min(targetW / img.naturalWidth, targetH / img.naturalHeight);
      const sw = Math.round(img.naturalWidth * scale);
      const sh = Math.round(img.naturalHeight * scale);
      ctx.drawImage(img, Math.round((targetW - sw) / 2), Math.round((targetH - sh) / 2), sw, sh);
      c.toBlob(blob => {
        blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
      }, 'image/png');
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Failed to load image')); };
    img.src = URL.createObjectURL(file);
  });
}

/** 이미지 파일을 로드하여 targetW×targetH로 리사이즈하고 PNG Uint8Array로 반환합니다. */
function resizeImageToUint8Array(file, targetW, targetH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = targetW;
      c.height = targetH;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, targetW, targetH);
      c.toBlob(blob => {
        blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
      }, 'image/png');
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Failed to load image')); };
    img.src = URL.createObjectURL(file);
  });
}

// ── 포맷 감지 ─────────────────────────────────────────────────────────────

/** 4바이트 매직을 읽어 디스크 이미지 포맷을 감지합니다: CISO, ZISO, 또는 ISO. */
async function detectConvertFormat(file) {
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const magic = String.fromCharCode(header[0], header[1], header[2], header[3]);
  if (magic === 'CISO') return 'CSO';
  if (magic === 'ZISO') return 'ZSO';
  return 'ISO';
}

function parseCsoHeader(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    uncompressedSize: Number(dv.getBigUint64(8, true)),
    blockSize: dv.getUint32(16, true),
  };
}

// ── PS1 디스크 ID 자동 감지 ─────────────────────────────────────────────────
// UI 스레드에서 사용하기 위해 eboot/discid.js의 일부 로직을 복제합니다
// (eboot/ 모듈은 워커에서 실행되어 여기서는 사용할 수 없음).

/** 확장자와 태그를 제거하여 파일명에서 깨끗한 게임 타이틀을 추출합니다. */
function titleFromFilename(name) {
  return name
    .replace(/\.(bin|img|iso|cue)$/i, '')
    .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ')  // remove (Disc 1), [NTSC-U], etc.
    .replace(/\s*-?\s*disc\s*\d+/i, '')
    .trim();
}

/**
 * SYSTEM.CNF를 읽어 PS1 BIN/ISO에서 디스크 ID와 타이틀을 자동 감지합니다.
 * 최선 시도 방식 — 실패 시 예외 없이 null을 반환합니다.
 */
async function autoDetectDiscId(file) {
  try {
    const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const isRaw = header[0] === 0x00 && header[1] === 0xFF && header[2] === 0xFF
               && header[3] === 0xFF && header[11] === 0x00;
    const sectorSize = isRaw ? 2352 : 2048;
    const dataOffset = isRaw ? 24 : 0;

    const pvdStart = 16 * sectorSize + dataOffset;
    const pvdBuf = new Uint8Array(await file.slice(pvdStart, pvdStart + 2048).arrayBuffer());
    if (pvdBuf[0] !== 1 || String.fromCharCode(...pvdBuf.slice(1, 6)) !== 'CD001') return null;

    const rawVolumeId = String.fromCharCode(...pvdBuf.slice(40, 72)).trim();
    let title;
    if (rawVolumeId) {
      title = rawVolumeId.replace(/_/g, ' ').replace(/[A-Z]+/g, w => w[0] + w.slice(1).toLowerCase());
      console.log('[detect] Volume ID: "' + rawVolumeId + '" → title: "' + title + '"');
    } else {
      title = titleFromFilename(file.name);
      console.warn('[detect] Empty volume ID in ' + file.name + ', using filename → "' + title + '"');
    }

    const rootLba = pvdBuf[156+2]|(pvdBuf[156+3]<<8)|(pvdBuf[156+4]<<16)|(pvdBuf[156+5]<<24);
    const rootBuf = new Uint8Array(await file.slice(rootLba*sectorSize+dataOffset, rootLba*sectorSize+dataOffset+4096).arrayBuffer());

    let pos = 0;
    while (pos < rootBuf.length) {
      const recLen = rootBuf[pos];
      if (recLen === 0) break;
      const nameLen = rootBuf[pos + 32];
      const name = String.fromCharCode(...rootBuf.slice(pos+33, pos+33+nameLen)).split(';')[0].toUpperCase();
      if (name === 'SYSTEM.CNF') {
        const cnfLba = rootBuf[pos+2]|(rootBuf[pos+3]<<8)|(rootBuf[pos+4]<<16)|(rootBuf[pos+5]<<24);
        const cnfSize = rootBuf[pos+10]|(rootBuf[pos+11]<<8)|(rootBuf[pos+12]<<16)|(rootBuf[pos+13]<<24);
        const cnfBuf = new Uint8Array(await file.slice(cnfLba*sectorSize+dataOffset, cnfLba*sectorSize+dataOffset+Math.min(cnfSize,2048)).arrayBuffer());
        const cnfText = new TextDecoder('ascii').decode(cnfBuf);
        const m = cnfText.match(/BOOT\s*=\s*cdrom[:\d]*\\?\\?([A-Z]{4}_\d{3}\.\d{2})/i);
        if (m) return { discId: m[1].replace(/[_.]/g, ''), title };
      }
      pos += recLen;
    }
    if (title) return { discId: null, title };
  } catch (e) { /* 최선 시도 */ }
  return null;
}

// ── CUE 헬퍼 ────────────────────────────────────────────────────────────────
// UI 레이어를 위한 경량 CUE 파싱 — FILE 참조와 트랙 정보를 추출하여
// CUE 시트를 BIN 파일과 페어링하고 디스크 메타데이터를 빌드합니다.

/** CUE 시트의 FILE 지시문에서 참조하는 BIN 파일명을 추출합니다. */
function extractBinNames(cueText) {
  const names = [];
  for (const line of cueText.split('\n')) {
    const m = line.trim().match(/^FILE\s+"([^"]+)"/i) || line.trim().match(/^FILE\s+(\S+)/i);
    if (m) names.push(m[1]);
  }
  return names;
}

/** CUE의 BIN 파일명을 사용 가능한 File 객체와 매칭합니다; 멀티 BIN은 하나로 병합합니다. */
function mergeCueBins(binNames, availableBins) {
  if (binNames.length === 0) return null;
  const matched = [];
  const parts = [];
  for (const name of binNames) {
    const found = findBinFile(name, availableBins);
    if (!found && matched.length === 0) return null;
    if (found) {
      matched.push(found);
      parts.push(found);
    }
  }
  if (matched.length === 0) return null;
  if (matched.length === 1) return { merged: matched[0], matched, fileSizes: [matched[0].size] };
  const merged = new File(parts, matched[0].name, { type: matched[0].type });
  return { merged, matched, fileSizes: matched.map(f => f.size) };
}

/** UI 표시 및 TOC 생성을 위해 CUE 트랙 데이터를 파싱합니다 (eboot/cue.js와 동일). */
function parseCueTracksUI(cueText) {
  const tracks = [];
  let current = null;
  let currentFile = null;
  for (const rawLine of cueText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const fm = line.match(/^FILE\s+"([^"]+)"/i) || line.match(/^FILE\s+(\S+)/i);
    if (fm) { currentFile = fm[1]; continue; }
    const tm = line.match(/^TRACK\s+(\d+)\s+(\S+)/i);
    if (tm) {
      const type = tm[2].toUpperCase();
      let ss = 2352;
      if (type === 'MODE1/2048') ss = 2048;
      else if (type === 'MODE2/2336') ss = 2336;
      current = { number: parseInt(tm[1],10), type, sectorSize: ss, pregap: 0, file: currentFile, indexes: [] };
      tracks.push(current);
      continue;
    }
    if (!current) continue;
    const im = line.match(/^INDEX\s+(\d+)\s+(\d+):(\d+):(\d+)/i);
    if (im) {
      current.indexes.push({ id: parseInt(im[1],10), msf: [parseInt(im[2],10), parseInt(im[3],10), parseInt(im[4],10)] });
      continue;
    }
    const pm = line.match(/^PREGAP\s+(\d+):(\d+):(\d+)/i);
    if (pm) {
      current.pregap = parseInt(pm[1],10)*60*75 + parseInt(pm[2],10)*75 + parseInt(pm[3],10);
    }
  }
  return tracks;
}
