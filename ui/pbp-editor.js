// ══════════════════════════════════════════════════════════════════════════════
// PBP 편집기 — 기존 EBOOT.PBP 읽기 및 재패킹
//
// 사용자가 EBOOT 탭에 .pbp 파일을 드롭하면, loadExistingPbp()가 헤더를 읽고
// PARAM.SFO + 아트워크 섹션을 추출하여 기존 EBOOT 폼 필드와 아트워크
// 미리보기를 채웁니다. 그런 다음 사용자는 타이틀, 디스크 ID, 자녀보호 등급,
// 지역, 아트워크 이미지를 변경하고 "Save EBOOT.PBP"를 클릭하여 해당 섹션만
// 교체된 패치된 PBP를 다운로드할 수 있습니다 — DATA.PSAR(압축된 디스크 이미지)는
// 재압축이 필요 없도록 원본 그대로 유지됩니다.
//
// 모든 함수는 전역(모듈 시스템 없음 — build.js에 의해 연결됨).
// buildSFO_ui / buildPBP_ui는 UI용 두 번째 esbuild 패스를 피하기 위해
// eboot/sfo.js와 eboot/pbp.js의 로컬 복사본입니다.
// ══════════════════════════════════════════════════════════════════════════════

// ── PBP / SFO 상수 ───────────────────────────────────────────────────────────
const _PBP_MAGIC_0 = 0x00;
const _PBP_MAGIC_1 = 0x50; // 'P'
const _PBP_MAGIC_2 = 0x42; // 'B'
const _PBP_MAGIC_3 = 0x50; // 'P'
const _PBP_HEADER_SIZE = 0x28;
const _PBP_VERSION = 0x00010000;

const _SFO_MAGIC = 0x46535000;
const _SFO_VERSION = 0x00000101;
const _SFO_UTF8 = 0x0204;
const _SFO_INT32 = 0x0404;

// ── 저수준 파일 헬퍼 ────────────────────────────────────────────────────────

/** `file`에서 `offset`부터 `length` 바이트를 읽습니다. */
async function pbpReadBytes(file, offset, length) {
  const buf = await file.slice(offset, offset + length).arrayBuffer();
  return new Uint8Array(buf);
}

// ── PBP 헤더 파서 ─────────────────────────────────────────────────────────

/**
 * 40바이트 PBP 헤더를 파싱합니다.
 * { offsets[8] }을 반환하거나 매직이 잘못된 경우 예외를 던집니다.
 */
async function pbpParseHeader(file) {
  if (file.size < _PBP_HEADER_SIZE) throw new Error('File too small to be a PBP');
  const h = await pbpReadBytes(file, 0, _PBP_HEADER_SIZE);
  if (h[0] !== _PBP_MAGIC_0 || h[1] !== _PBP_MAGIC_1 ||
      h[2] !== _PBP_MAGIC_2 || h[3] !== _PBP_MAGIC_3) {
    throw new Error('Not a valid PBP file (bad magic)');
  }
  const dv = new DataView(h.buffer);
  const offsets = [];
  for (let i = 0; i < 8; i++) offsets.push(dv.getUint32(8 + i * 4, true));
  return { offsets };
}

// ── PARAM.SFO 파서 ──────────────────────────────────────────────────────────

/**
 * PARAM.SFO 바이너리 블롭을 파싱합니다.
 * { title, discId, parentalLevel, region }을 반환합니다.
 */
function pbpParseSFO(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.byteLength < 20 || dv.getUint32(0, true) !== _SFO_MAGIC) {
    throw new Error('Invalid PARAM.SFO');
  }
  const keyTableOff  = dv.getUint32(8, true);
  const dataTableOff = dv.getUint32(12, true);
  const entryCount   = dv.getUint32(16, true);
  const result = {};
  for (let i = 0; i < entryCount; i++) {
    const base     = 20 + i * 16;
    const keyOff   = dv.getUint16(base,      true);
    const dataType = dv.getUint16(base + 2,  true);
    const dataUsed = dv.getUint32(base + 4,  true);
    const dataOff  = dv.getUint32(base + 12, true);
    // 키 문자열
    let ke = keyTableOff + keyOff;
    while (ke < bytes.length && bytes[ke] !== 0) ke++;
    const key = new TextDecoder().decode(bytes.slice(keyTableOff + keyOff, ke));
    // 값
    const vs = dataTableOff + dataOff;
    let value;
    if (dataType === _SFO_INT32) {
      value = dv.getUint32(vs, true);
    } else {
      let ve = vs + dataUsed;
      while (ve > vs && bytes[ve - 1] === 0) ve--;
      value = new TextDecoder().decode(bytes.slice(vs, ve));
    }
    result[key] = value;
  }
  return {
    title:         result['TITLE']          || '',
    discId:        result['DISC_ID']        || '',
    parentalLevel: result['PARENTAL_LEVEL'] ?? 3,
    region:        result['REGION']         ?? 0x8000,
  };
}

// ── SFO 빌더 (eboot/sfo.js의 인라인 복사본 — UI를 독립적으로 유지) ──────

function _sfoAlign4(n) { return (n + 3) & ~3; }

function pbpBuildSFO(opts) {
  const title        = opts.title        || 'Unknown';
  const discId       = opts.discId       || 'SLUS00000';
  const parentalLevel= opts.parentalLevel|| 3;
  const region       = opts.region       || 0x8000;

  const entries = [
    ['BOOTABLE',       _SFO_INT32, 1,             4],
    ['CATEGORY',       _SFO_UTF8,  'ME',           4],
    ['DISC_ID',        _SFO_UTF8,  discId,         16],
    ['DISC_VERSION',   _SFO_UTF8,  '1.00',         8],
    ['LICENSE',        _SFO_UTF8,  'Copyright(C) Sony Computer Entertainment America Inc.', 512],
    ['PARENTAL_LEVEL', _SFO_INT32, parentalLevel,  4],
    ['PSP_SYSTEM_VER', _SFO_UTF8,  '3.01',         8],
    ['REGION',         _SFO_INT32, region,         4],
    ['TITLE',          _SFO_UTF8,  title,          128],
  ];
  const count = entries.length;

  const keyParts = [], keyOffsets = [];
  let keyTableSize = 0;
  for (const [key] of entries) {
    keyOffsets.push(keyTableSize);
    const enc = new TextEncoder().encode(key + '\0');
    keyParts.push(enc);
    keyTableSize += enc.length;
  }
  const keyTablePadded = _sfoAlign4(keyTableSize);

  const dataParts = [], dataLens = [], dataMaxes = [];
  for (const [, type, value, maxSize] of entries) {
    let buf, len;
    if (type === _SFO_INT32) {
      buf = new Uint8Array(4);
      new DataView(buf.buffer).setUint32(0, value, true);
      len = 4;
    } else {
      const enc = new TextEncoder().encode(value + '\0');
      len = enc.length;
      buf = new Uint8Array(maxSize);
      buf.set(enc);
    }
    dataParts.push(buf); dataLens.push(len); dataMaxes.push(maxSize);
  }

  const indexSize     = count * 16;
  const headerSize    = 20;
  const keyTableOffset  = headerSize + indexSize;
  const dataTableOffset = keyTableOffset + keyTablePadded;
  const totalSize = dataTableOffset + dataMaxes.reduce((a, b) => a + b, 0);

  const result = new Uint8Array(totalSize);
  const dv = new DataView(result.buffer);
  dv.setUint32(0,  _SFO_MAGIC,   true);
  dv.setUint32(4,  _SFO_VERSION, true);
  dv.setUint32(8,  keyTableOffset,  true);
  dv.setUint32(12, dataTableOffset, true);
  dv.setUint32(16, count, true);

  let dataOffset = 0;
  for (let i = 0; i < count; i++) {
    const base = headerSize + i * 16;
    dv.setUint16(base,      keyOffsets[i],   true);
    dv.setUint16(base + 2,  entries[i][1],   true);
    dv.setUint32(base + 4,  dataLens[i],     true);
    dv.setUint32(base + 8,  dataMaxes[i],    true);
    dv.setUint32(base + 12, dataOffset,      true);
    dataOffset += dataMaxes[i];
  }
  let pos = keyTableOffset;
  for (const p of keyParts) { result.set(p, pos); pos += p.length; }
  pos = dataTableOffset;
  for (let i = 0; i < count; i++) { result.set(dataParts[i], pos); pos += dataMaxes[i]; }
  return result;
}

// ── PBP 빌더 (eboot/pbp.js의 인라인 복사본) ─────────────────────────────────

function pbpBuildPBP(sections) {
  const PBP_MAGIC_BYTES = new Uint8Array([0x00, 0x50, 0x42, 0x50]);
  const parts = [
    sections.paramSfo,
    sections.icon0  || new Uint8Array(0),
    sections.icon1  || new Uint8Array(0),
    sections.pic0   || new Uint8Array(0),
    sections.pic1   || new Uint8Array(0),
    sections.snd0   || new Uint8Array(0),
    sections.dataPsp,
    sections.dataPsar,
  ];
  const offsets = new Array(8);
  let p = _PBP_HEADER_SIZE;
  for (let i = 0; i < 8; i++) { offsets[i] = p; p += parts[i].length; }
  const psarAlign = 0x10000;
  const alignedPsarOffset = Math.ceil(offsets[7] / psarAlign) * psarAlign;
  offsets[7] = alignedPsarOffset;
  const totalSize = alignedPsarOffset + parts[7].length;
  const result = new Uint8Array(totalSize);
  const dv = new DataView(result.buffer);
  result.set(PBP_MAGIC_BYTES, 0);
  dv.setUint32(4, _PBP_VERSION, true);
  for (let i = 0; i < 8; i++) dv.setUint32(8 + i * 4, offsets[i], true);
  let wp = _PBP_HEADER_SIZE;
  for (let i = 0; i < 7; i++) { result.set(parts[i], wp); wp += parts[i].length; }
  result.set(parts[7], alignedPsarOffset);
  return result;
}

// ── PNG 인코더 헬퍼 ────────────────────────────────────────────────────────

function _pngAdler32(data) {
  let s1 = 1, s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return (s2 << 16 | s1) >>> 0;
}

/** PNG 청크: 길이(4) + 타입(4) + 데이터 + CRC32(4) */
function _pngChunk(type, data) {
  const t = new Uint8Array([...type].map(c => c.charCodeAt(0)));
  const crcBuf = new Uint8Array(4 + data.length);
  crcBuf.set(t); crcBuf.set(data, 4);
  const c = new Uint8Array(4 + 4 + data.length + 4);
  const dv = new DataView(c.buffer);
  dv.setUint32(0, data.length, false);
  c.set(t, 4); c.set(data, 8);
  dv.setUint32(8 + data.length, crc32(crcBuf), false); // crc32는 shared.js에서 가져옴
  return c;
}

/** 원시 스캔라인 데이터를 압축하고 PNG IDAT용 zlib RFC 1950 헤더로 감쌉니다. */
function _pngIdat(raw, level = 9) {
  const deflated = deflateRaw(raw, { level });
  const idat = new Uint8Array(2 + deflated.length + 4);
  // zlib 헤더: CMF=0x78, FLG는 압축 레벨에 따라 결정
  idat[0] = 0x78;
  idat[1] = level >= 8 ? 0xDA : level >= 6 ? 0x9C : 0x5E;
  idat.set(deflated, 2);
  new DataView(idat.buffer).setUint32(2 + deflated.length, _pngAdler32(raw), false);
  return idat;
}

function _pngAssemble(ihdrData, extraChunks, idat) {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [_pngChunk('IHDR', ihdrData), ...extraChunks,
                  _pngChunk('IDAT', idat), _pngChunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(sig.length + chunks.reduce((s, c) => s + c.length, 0));
  let p = 0;
  [sig, ...chunks].forEach(b => { out.set(b, p); p += b.length; });
  return out;
}

function _pngIHDR(w, h, bitDepth, colorType) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, w, false); dv.setUint32(4, h, false);
  d[8] = bitDepth; d[9] = colorType;
  return d;
}

// ── 24비트 RGB PNG 인코더 ────────────────────────────────────────────────────

function encodeRgbPng(canvas) {
  const w = canvas.width, h = canvas.height;
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const stride = 1 + w * 3;
  const raw = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = y * stride + 1 + x * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
  }
  return _pngAssemble(_pngIHDR(w, h, 8, 2), [], _pngIdat(raw, 6));
}

// ── 8비트 인덱스 PNG 인코더 — 3:3:2 팔레트 + Floyd-Steinberg 디더링 ─────
// 팔레트: 256색 (R=3비트, G=3비트, B=2비트, 균일 분포).
// 디더링: 양자화 오차를 표준 7/16–3/16–5/16–1/16 가중치를 사용하여
// 4개의 인접 픽셀(오른쪽, 왼쪽 아래, 아래, 오른쪽 아래)에 분산합니다.
// 이를 통해 색상 밴딩이 줄어들고 훨씬 부드러운 그라데이션이 생성됩니다.
// 압축 레벨 6(9 아님)으로 압축률을 더 낮춥니다 → 파일 크기는 커지지만
// 동일한 품질 보장.

function encodeIdx8Png(canvas) {
  const w = canvas.width, h = canvas.height;
  const src = canvas.getContext('2d').getImageData(0, 0, w, h).data;

  // 3:3:2 균일 RGB 팔레트 (256색)
  const palette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    palette[i * 3]     = Math.round(((i >> 5) & 7) * 255 / 7);
    palette[i * 3 + 1] = Math.round(((i >> 2) & 7) * 255 / 7);
    palette[i * 3 + 2] = Math.round((i & 3)         * 255 / 3);
  }

  // 디더링 오차 누적을 위한 부동소수점 픽셀 버퍼
  const buf = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3]     = src[i * 4];
    buf[i * 3 + 1] = src[i * 4 + 1];
    buf[i * 3 + 2] = src[i * 4 + 2];
  }

  const stride = 1 + w;
  const raw = new Uint8Array(h * stride);

  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // 필터: None
    for (let x = 0; x < w; x++) {
      const pi = (y * w + x) * 3;
      const r = Math.max(0, Math.min(255, Math.round(buf[pi])));
      const g = Math.max(0, Math.min(255, Math.round(buf[pi + 1])));
      const b = Math.max(0, Math.min(255, Math.round(buf[pi + 2])));

      // 가장 가까운 팔레트 인덱스 (3:3:2)
      const ri = Math.min(7, Math.round(r * 7 / 255));
      const gi = Math.min(7, Math.round(g * 7 / 255));
      const bi = Math.min(3, Math.round(b * 3 / 255));
      const idx = (ri << 5) | (gi << 2) | bi;
      raw[y * stride + 1 + x] = idx;

      // 양자화 오차
      const er = r - palette[idx * 3];
      const eg = g - palette[idx * 3 + 1];
      const eb = b - palette[idx * 3 + 2];

      // Floyd-Steinberg 오차 확산 (오른쪽 / 왼쪽 아래 / 아래 / 오른쪽 아래)
      const spread = (nx, ny, f) => {
        if (nx < 0 || nx >= w || ny >= h) return;
        const ni = (ny * w + nx) * 3;
        buf[ni]     += er * f;
        buf[ni + 1] += eg * f;
        buf[ni + 2] += eb * f;
      };
      spread(x + 1, y,     7 / 16);
      spread(x - 1, y + 1, 3 / 16);
      spread(x,     y + 1, 5 / 16);
      spread(x + 1, y + 1, 1 / 16);
    }
  }

  return _pngAssemble(_pngIHDR(w, h, 8, 3), [_pngChunk('PLTE', palette)], _pngIdat(raw, 3));
}

// ── 커버 이미지 (우측 패널) ─────────────────────────────────────────────────

/**
 * 디스크 ID로 커버 이미지를 가져와 우측 패널에 표시합니다.
 * 아트워크 가져오기 기능과 동일한 psx-artwork 저장소를 사용합니다.
 * 커버 발견 여부에 따라 패널을 표시하거나 숨깁니다.
 */
async function updateCoverImage(discId) {
  const img = document.getElementById('ebootCoverImg');
  const dlRow = document.getElementById('coverDlRow');
  const snapPanel = document.getElementById('snapshotPanel');
  const snapImg   = document.getElementById('ebootSnapshotImg');
  if (!img) return;

  if (!discId) {
    img.src = ''; _coverImageData = null;
    if (dlRow) dlRow.style.display = 'none';
    if (snapPanel) snapPanel.style.display = 'none';
    _snapshotImageData = null;
    ebootOpts.classList.remove('cover-visible');
    return;
  }

  // 커버와 스냅샷을 병렬로 가져옴
  const [coverData, snapData] = await Promise.all([
    fetchArtworkImage('icon0', discId),
    fetchArtworkImage('pic1',  discId),
  ]);

  if (coverData) {
    _coverImageData = coverData;
    img.src = URL.createObjectURL(new Blob([coverData], { type: 'image/jpeg' }));
    if (dlRow) dlRow.style.display = 'flex';
    ebootOpts.classList.add('cover-visible');
  } else {
    _coverImageData = null;
    img.src = '';
    if (dlRow) dlRow.style.display = 'none';
    ebootOpts.classList.remove('cover-visible');
  }

  if (snapData && snapPanel && snapImg) {
    _snapshotImageData = snapData;
    snapImg.src = URL.createObjectURL(new Blob([snapData], { type: 'image/jpeg' }));
    snapPanel.style.display = 'block';
  } else {
    _snapshotImageData = null;
    if (snapPanel) snapPanel.style.display = 'none';
  }
}

/** 스냅샷 이미지를 320×240 8-bit indexed PNG로 다운로드합니다. */
async function snapshotDownloadPng() {
  if (!_snapshotImageData) return;
  const mime = (_snapshotImageData[0] === 0x89 && _snapshotImageData[1] === 0x50) ? 'image/png' : 'image/jpeg';
  const blob = new Blob([_snapshotImageData], { type: mime });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 320, 240);
  // 원본 비율 유지하며 320×240 안에 맞춤
  const scale = Math.min(320 / img.naturalWidth, 240 / img.naturalHeight);
  const sw = Math.round(img.naturalWidth * scale);
  const sh = Math.round(img.naturalHeight * scale);
  ctx.drawImage(img, Math.round((320 - sw) / 2), Math.round((240 - sh) / 2), sw, sh);
  URL.revokeObjectURL(url);
  const title = (typeof ebootTitle !== 'undefined' && ebootTitle.value.trim())
    || (typeof ebootDiscId !== 'undefined' && ebootDiscId.value.trim()) || 'snapshot';
  download(encodeIdx8Png(canvas), `${title} (320x240).png`);
}

/** 원본 포맷(JPEG/PNG)으로 그대로 다운로드 (변환 없음). */
function coverDownloadOriginal() {
  if (!_coverImageData) return;
  // 매직 바이트로 포맷 감지
  const ext = (_coverImageData[0] === 0xFF && _coverImageData[1] === 0xD8) ? 'jpg'
            : (_coverImageData[0] === 0x89 && _coverImageData[1] === 0x50) ? 'png'
            : 'bin';
  const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'application/octet-stream';
  const title = (typeof ebootTitle !== 'undefined' && ebootTitle.value.trim())
    || (typeof ebootDiscId !== 'undefined' && ebootDiscId.value.trim()) || 'cover';
  const blob = new Blob([_coverImageData], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${title}.${ext}`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** 지정 크기로 리사이즈 후 8-bit indexed PNG로 다운로드. */
async function coverDownloadPng(w, h, suffix) {
  if (!_coverImageData) return;
  const mime = (_coverImageData[0] === 0x89 && _coverImageData[1] === 0x50) ? 'image/png' : 'image/jpeg';
  const blob = new Blob([_coverImageData], { type: mime });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  const title = (typeof ebootTitle !== 'undefined' && ebootTitle.value.trim())
    || (typeof ebootDiscId !== 'undefined' && ebootDiscId.value.trim()) || 'cover';
  download(encodeIdx8Png(canvas), `${title} ${suffix}.png`);
}

// ── 게임 리소스 자동 검색 ─────────────────────────────────────────────────────

function updateResourceSearch(discId) {
  const sec = document.getElementById('resourceSearchSection');
  if (!sec) return;
  if (!discId || discId.length < 5) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  const lnk = document.getElementById('rsLinkPsxdata');
  if (lnk) lnk.href = `https://psxdatacenter.com/search.html?q=${discId}`;
  const unlucky = document.getElementById('rsLinkUnlucky');
  if (unlucky) unlucky.href = `https://unluckyforsome.github.io/PSX1G1B1C1D/?search=${discId}`;
}

// ── 상태 ─────────────────────────────────────────────────────────────────────

let _pbpDataPsp  = null; // 원본 DATA.PSP  (Uint8Array)
let _pbpDataPsar = null; // 원본 DATA.PSAR (Uint8Array)
let _coverImageData    = null; // 커버 이미지 바이트 (Uint8Array)
let _snapshotImageData = null; // 스냅샷 이미지 바이트 (Uint8Array)

// ── 진입점: 편집을 위해 PBP 로드 ───────────────────────────────────────────

async function loadExistingPbp(file) {
  try {
    resetEbootUI();

    ebootFileName.textContent = file.name;
    ebootFileMeta.innerHTML = formatSize(file.size) +
      ' <span class="format-label format-ps1">EBOOT.PBP</span>';
    ebootFileInfo.style.display = 'block';

    // 헤더 파싱
    const { offsets } = await pbpParseHeader(file);
    // 섹션 크기는 연속된 오프셋에서 도출; PSAR 크기 = file.size - offset
    const secSize = (i) => (i < 7 ? offsets[i + 1] : file.size) - offsets[i];

    // --- PARAM.SFO 파싱 ---
    const sfoBytes = await pbpReadBytes(file, offsets[0], secSize(0));
    const sfo = pbpParseSFO(sfoBytes);
    ebootTitle.value       = sfo.title;
    ebootDiscId.value      = sfo.discId;
    ebootParentalLevel.value = sfo.parentalLevel;
    // <select> 옵션 값 형식 "0x8000"에 맞춤
    const regionHex = '0x' + sfo.region.toString(16).toUpperCase();
    if ([...ebootRegion.options].some(o => o.value === regionHex)) {
      ebootRegion.value = regionHex;
    }

    // --- 아트워크 ---
    // keepOriginal=true: 바이트를 그대로 저장 (리사이즈 없음) — 원본 크기 보존
    async function loadArt(idx, w, h, current, isCustomFlag, imgEl, resetBtnId, contain = false, keepOriginal = false) {
      const size = secSize(idx);
      if (size <= 0) return current;
      const bytes = await pbpReadBytes(file, offsets[idx], size);
      try {
        let finalBytes;
        if (keepOriginal) {
          finalBytes = bytes;
        } else {
          const blob = new Blob([bytes], { type: 'image/png' });
          finalBytes = contain
            ? await containImageToUint8Array(blob, w, h)
            : await resizeImageToUint8Array(blob, w, h);
        }
        imgEl.src = URL.createObjectURL(new Blob([finalBytes], { type: 'image/png' }));
        document.getElementById(resetBtnId).style.display = 'inline';
        return { data: finalBytes, custom: true };
      } catch { return current; }
    }

    // ICON0: 원본 바이트 유지 — 80×80 아이콘을 144×80으로 재인코딩하는 것 방지
    const r0 = await loadArt(1, 144,  80, null, false, artIcon0, 'artIcon0Reset', false, true);
    const r3 = await loadArt(3, 310, 180, null, false, artPic0,  'artPic0Reset');
    const r4 = await loadArt(4, 480, 272, null, false, artPic1,  'artPic1Reset');

    if (r0) { currentIcon0 = r0.data; icon0IsCustom = true; }
    if (r3) { currentPic0  = r3.data; pic0IsCustom  = true; }
    if (r4) { currentPic1  = r4.data; pic1IsCustom  = true; }

    // --- ICON1 (애니메이션 아이콘: PMF 또는 PNG) ---
    const icon1Size = secSize(2);
    if (icon1Size > 0) {
      const bytes = await pbpReadBytes(file, offsets[2], icon1Size);
      currentIcon1 = bytes;
      if (bytes[0] === 0x89 && bytes[1] === 0x50) {
        artIcon1.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      } else {
        artIcon1.src = '';
        document.getElementById('icon1Dims').textContent = 'PMF (' + formatSize(icon1Size) + ')';
      }
      document.getElementById('artIcon1Delete').style.display = 'inline';
    }

    // --- DATA.PSP + DATA.PSAR 원본 보존 ---
    _pbpDataPsp  = await pbpReadBytes(file, offsets[6], secSize(6));
    _pbpDataPsar = await pbpReadBytes(file, offsets[7], secSize(7));

    // --- UI 표시 ---
    ebootOpts.style.display = 'block';
    _showPbpEditActions();

    // 디스크 ID로 커버 및 리소스 검색 가져오기 (BIN/CUE 모드와 동일)
    updateCoverImage(sfo.discId);
    updateResourceSearch(sfo.discId);
    ebootStatusEl.textContent = 'PBP loaded — edit and save below';
    ebootStatusEl.className   = 'status';

  } catch (e) {
    ebootStatusEl.textContent = 'Error loading PBP: ' + e.message;
    ebootStatusEl.className   = 'status error';
    console.error(e);
  }
}

function _showPbpEditActions() {
  ebootActionsEl.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'btn-eboot';
  btn.textContent = 'Save EBOOT.PBP';
  btn.onclick = _savePbp;
  ebootActionsEl.appendChild(btn);
  ebootActionsEl.style.display = 'flex';
}

async function _savePbp() {
  if (!_pbpDataPsp || !_pbpDataPsar) {
    ebootStatusEl.textContent = 'No PBP loaded';
    ebootStatusEl.className = 'status error';
    return;
  }
  try {
    ebootStatusEl.textContent = 'Saving…';
    ebootStatusEl.className = 'status';

    const title        = ebootTitle.value        || 'Unknown';
    const discId       = ebootDiscId.value        || 'SLUS00000';
    const parentalLevel= parseInt(ebootParentalLevel.value, 10) || 3;
    const region       = parseInt(ebootRegion.value) || 0x8000;

    const paramSfo = pbpBuildSFO({ title, discId, parentalLevel, region });
    const pbpBytes = pbpBuildPBP({
      paramSfo,
      icon0:    currentIcon0 || undefined,
      icon1:    currentIcon1 || undefined,
      pic0:     currentPic0  || undefined,
      pic1:     currentPic1  || undefined,
      dataPsp:  _pbpDataPsp,
      dataPsar: _pbpDataPsar,
    });

    download(pbpBytes, (title || discId || 'EBOOT') + '.PBP');
    ebootStatusEl.textContent = 'Saved!';
    ebootStatusEl.className = 'status';
  } catch (e) {
    ebootStatusEl.textContent = 'Save error: ' + e.message;
    ebootStatusEl.className = 'status error';
    console.error(e);
  }
}
