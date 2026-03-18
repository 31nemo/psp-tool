// ══════════════════════════════════════════════════════════════════════════════
// EBOOT 탭 — PS1 디스크 이미지 → EBOOT.PBP 빌더
//
// "EBOOT" 탭 UI를 처리합니다: 디스크 이미지 드롭 존, 멀티 디스크 관리,
// CUE/BIN 페어링, 게임 타이틀/디스크 ID 감지, 아트워크 미리보기, 압축
// 설정, 병렬 워커 디스패치, 진행률 표시, ZIP 다운로드.
//
// 빌드 파이프라인:
//   1. 사용자가 BIN/ISO/CUE 파일을 드롭 → 디스크 ID 및 타이틀 자동 감지
//   2. 디스크 이미지를 ISO_BLOCK_SIZE 청크로 읽기
//   3. 청크를 compress-worker.js 인스턴스에 배포 (병렬 deflate)
//   4. 압축된 데이터를 eboot-worker.js로 전송 (PBP 조립)
//   5. ZIP 내에 EBOOT.PBP로 결과 다운로드
// ══════════════════════════════════════════════════════════════════════════════

const ebootDropZone = document.getElementById('ebootDropZone');
const ebootFileInput = document.getElementById('ebootFileInput');
const ebootFileInfo = document.getElementById('ebootFileInfo');
const ebootFileName = document.getElementById('ebootFileName');
const ebootFileMeta = document.getElementById('ebootFileMeta');
const ebootActionsEl = document.getElementById('ebootActions');
const discListEl = document.getElementById('discList');
const addDiscHint = document.getElementById('addDiscHint');
const ebootOpts = document.getElementById('ebootOpts');
const ebootTitle = document.getElementById('ebootTitle');
const ebootDiscId = document.getElementById('ebootDiscId');
const ebootCompression = document.getElementById('ebootCompression');
const ebootCompressionVal = document.getElementById('ebootCompressionVal');
const ebootCompressionLabel = document.getElementById('ebootCompressionLabel');
const ebootThreads = document.getElementById('ebootThreads');
const ebootThreadsVal = document.getElementById('ebootThreadsVal');
const discIdDetected = document.getElementById('discIdDetected');
const ebootProgressArea = document.getElementById('ebootProgressArea');
const ebootProgressFill = document.getElementById('ebootProgressFill');
const ebootProgressLabel = document.getElementById('ebootProgressLabel');
const ebootProgressPct = document.getElementById('ebootProgressPct');
const ebootStatusEl = document.getElementById('ebootStatus');
const artIcon0 = document.getElementById('artIcon0');
const artIcon1 = document.getElementById('artIcon1');
const artPic0 = document.getElementById('artPic0');
const artPic1 = document.getElementById('artPic1');

let ebootFiles = [];
let pendingCues = [];
let ebootWorking = false;
let ebootActiveWorker = null;
let ebootActiveCompressWorkers = [];
const ebootCancelBtn = document.getElementById('ebootCancelBtn');

const ebootParentalLevel = document.getElementById('ebootParentalLevel');
const ebootRegion = document.getElementById('ebootRegion');
const ebootFetchArt = document.getElementById('ebootFetchArt');

// localStorage를 통해 아트워크 가져오기 체크박스 상태 유지
try { ebootFetchArt.checked = localStorage.getItem('fetchArtwork') === 'true'; } catch {}
ebootFetchArt.addEventListener('change', () => {
  try { localStorage.setItem('fetchArtwork', ebootFetchArt.checked); } catch {}
  scheduleArtworkRegenerate();
});

// 빌드 중 비활성화할 요소들
const ebootInputs = [ebootTitle, ebootDiscId, ebootCompression, ebootThreads, ebootParentalLevel, ebootRegion, ebootFetchArt];

function setEbootInputsDisabled(disabled) {
  for (const el of ebootInputs) el.disabled = disabled;
  ebootDropZone.style.pointerEvents = disabled ? 'none' : '';
  ebootDropZone.style.opacity = disabled ? '0.5' : '';
  if (discListEl) {
    discListEl.style.pointerEvents = disabled ? 'none' : '';
    discListEl.style.opacity = disabled ? '0.5' : '';
  }
}

ebootCancelBtn.addEventListener('click', () => {
  if (!ebootWorking) return;
  if (!confirm('Cancel the current build?')) return;
  // 모든 활성 워커 종료
  if (ebootActiveWorker) { ebootActiveWorker.terminate(); ebootActiveWorker = null; }
  for (const w of ebootActiveCompressWorkers) w.terminate();
  ebootActiveCompressWorkers = [];
  ebootWorking = false;
  setEbootInputsDisabled(false);
  for (const btn of ebootActionsEl.querySelectorAll('button')) btn.disabled = false;
  ebootStatusEl.textContent = 'Build cancelled';
  ebootStatusEl.className = 'status';
  ebootProgressArea.style.display = 'none';
});

const compressionLabels = ['None', 'Low', 'Low', 'Medium', 'Medium', 'High', 'High', 'Very high', 'Very high', 'Maximum'];
function updateCompressionLabel() {
  const v = parseInt(ebootCompression.value, 10);
  ebootCompressionVal.textContent = v;
  ebootCompressionLabel.textContent = compressionLabels[v];
}
updateCompressionLabel();
ebootCompression.addEventListener('input', updateCompressionLabel);
ebootThreadsVal.textContent = ebootThreads.value;
ebootThreads.addEventListener('input', () => {
  ebootThreadsVal.textContent = ebootThreads.value;
});

// 아트워크: 미리보기 클릭 → 파일 선택기 열기
artIcon0.addEventListener('click', () => document.getElementById('artIcon0Input').click());
artIcon1.addEventListener('click', () => document.getElementById('artIcon1Input').click());
artPic0.addEventListener('click', () => document.getElementById('artPic0Input').click());
artPic1.addEventListener('click', () => document.getElementById('artPic1Input').click());

document.getElementById('artIcon0Input').addEventListener('change', async function() {
  if (!this.files[0]) return;
  currentIcon0 = new Uint8Array(await this.files[0].arrayBuffer());
  artIcon0.src = URL.createObjectURL(new Blob([currentIcon0]));
  icon0IsCustom = true; icon0Deleted = false;
  document.getElementById('artIcon0Reset').style.display = 'inline';
  document.getElementById('artIcon0Delete').classList.remove('slot-deleted');
  this.value = '';
});
document.getElementById('artPic0Input').addEventListener('change', async function() {
  if (!this.files[0]) return;
  currentPic0 = await resizeImageToUint8Array(this.files[0], 310, 180);
  artPic0.src = URL.createObjectURL(new Blob([currentPic0], { type: 'image/png' }));
  pic0IsCustom = true; pic0Deleted = false;
  document.getElementById('artPic0Reset').style.display = 'inline';
  document.getElementById('artPic0Delete').classList.remove('slot-deleted');
  this.value = '';
});
document.getElementById('artPic1Input').addEventListener('change', async function() {
  if (!this.files[0]) return;
  currentPic1 = await resizeImageToUint8Array(this.files[0], 480, 272);
  artPic1.src = URL.createObjectURL(new Blob([currentPic1], { type: 'image/png' }));
  pic1IsCustom = true; pic1Deleted = false;
  document.getElementById('artPic1Reset').style.display = 'inline';
  document.getElementById('artPic1Delete').classList.remove('slot-deleted');
  this.value = '';
});

document.getElementById('artIcon0Reset').addEventListener('click', async () => {
  icon0IsCustom = false; icon0Deleted = false; currentIcon0 = null;
  document.getElementById('artIcon0Reset').style.display = 'none';
  document.getElementById('artIcon0Delete').classList.remove('slot-deleted');
  await regenerateDefaults();
});
document.getElementById('artPic0Reset').addEventListener('click', async () => {
  pic0IsCustom = false; pic0Deleted = false; currentPic0 = null;
  document.getElementById('artPic0Reset').style.display = 'none';
  document.getElementById('artPic0Delete').classList.remove('slot-deleted');
  await regenerateDefaults();
});
document.getElementById('artPic1Reset').addEventListener('click', async () => {
  pic1IsCustom = false; pic1Deleted = false; currentPic1 = null;
  document.getElementById('artPic1Reset').style.display = 'none';
  document.getElementById('artPic1Delete').classList.remove('slot-deleted');
  await regenerateDefaults();
});

// × 버튼: 해당 슬롯을 PBP에서 완전히 제거. deleted=true로 fetch/regenerate 차단
document.getElementById('artIcon0Delete').addEventListener('click', () => {
  icon0IsCustom = false; icon0Deleted = true; currentIcon0 = null;
  artIcon0.src = '';
  document.getElementById('artIcon0Reset').style.display = 'inline';
  document.getElementById('artIcon0Delete').classList.add('slot-deleted');
});
document.getElementById('artIcon1Delete').addEventListener('click', () => {
  currentIcon1 = null;
  artIcon1.src = '';
  document.getElementById('icon1Dims').textContent = 'PMF/PNG';
  document.getElementById('artIcon1Delete').style.display = 'none';
});
document.getElementById('artPic0Delete').addEventListener('click', () => {
  pic0IsCustom = false; pic0Deleted = true; currentPic0 = null;
  artPic0.src = '';
  document.getElementById('artPic0Reset').style.display = 'inline';
  document.getElementById('artPic0Delete').classList.add('slot-deleted');
});
document.getElementById('artPic1Delete').addEventListener('click', () => {
  pic1IsCustom = false; pic1Deleted = true; currentPic1 = null;
  artPic1.src = '';
  document.getElementById('artPic1Reset').style.display = 'inline';
  document.getElementById('artPic1Delete').classList.add('slot-deleted');
});

// ICON1: 원시 파일 (PMF 애니메이션 아이콘 또는 PNG) — 기본값 없음, 그냥 초기화
document.getElementById('artIcon1Input').addEventListener('change', async function() {
  if (!this.files[0]) return;
  const f = this.files[0];
  currentIcon1 = new Uint8Array(await f.arrayBuffer());
  // PNG이면 이미지 미리보기 표시, 아니면 파일명을 크기 레이블로 표시
  if (currentIcon1[0] === 0x89 && currentIcon1[1] === 0x50) {
    artIcon1.src = URL.createObjectURL(new Blob([currentIcon1], { type: 'image/png' }));
  } else {
    artIcon1.src = '';
  }
  document.getElementById('icon1Dims').textContent = f.name;
  document.getElementById('artIcon1Delete').style.display = 'inline';
  this.value = '';
});


let artworkDebounce = null;
function scheduleArtworkRegenerate() {
  clearTimeout(artworkDebounce);
  artworkDebounce = setTimeout(() => {
    if (ebootOpts.style.display !== 'none') {
      regenerateDefaults();
      const discId = ebootDiscId.value.trim();
      updateCoverImage(discId);
      updateResourceSearch(discId);
    }
  }, 300);
}
ebootTitle.addEventListener('input', scheduleArtworkRegenerate);
ebootDiscId.addEventListener('input', scheduleArtworkRegenerate);

// 드롭 존
ebootDropZone.addEventListener('click', () => ebootFileInput.click());
ebootDropZone.addEventListener('dragover', e => { e.preventDefault(); ebootDropZone.classList.add('dragover'); });
ebootDropZone.addEventListener('dragleave', () => ebootDropZone.classList.remove('dragover'));
ebootDropZone.addEventListener('drop', e => {
  e.preventDefault();
  ebootDropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleEbootDrop(e.dataTransfer.files);
});
ebootFileInput.addEventListener('change', () => {
  if (ebootFileInput.files.length) handleEbootDrop(ebootFileInput.files);
  ebootFileInput.value = '';
});

async function handleEbootDrop(fileList) {
  if (ebootWorking) return;

  const allFiles = Array.from(fileList);

  // 단일 .pbp → 편집 모드
  if (allFiles.length === 1 && allFiles[0].name.toLowerCase().endsWith('.pbp')) {
    await loadExistingPbp(allFiles[0]);
    return;
  }

  const cueFiles = allFiles.filter(f => f.name.toLowerCase().endsWith('.cue'));
  const nonCueFiles = allFiles.filter(f => !f.name.toLowerCase().endsWith('.cue'));

  // 이미 멀티 디스크 모드이고 더 많은 파일이 드롭된 경우, 추가
  if (ebootFiles.length > 0) {
    await addDiscFiles(cueFiles, nonCueFiles);
    return;
  }

  // CUE 파일만 드롭된 경우, 파싱 후 BIN 파일 대기
  if (cueFiles.length > 0 && nonCueFiles.length === 0) {
    await startPS1WithCues(cueFiles);
    return;
  }

  // CUE + BIN이 함께 드롭된 경우, 페어링
  if (cueFiles.length > 0 && nonCueFiles.length > 0) {
    await startPS1WithCuesAndBins(cueFiles, nonCueFiles);
    return;
  }

  // CUE 없음 — BIN 파일만
  resetEbootUI();
  ebootFiles = nonCueFiles.slice(0, 5).map(f => ({ file: f, cueText: null, cueTracks: null }));
  sortEbootFiles();
  renderDiscList();
  addDiscHint.style.display = 'block';

  const file = ebootFiles[0]?.file;
  if (file) {
    ebootFileName.textContent = file.name;
    ebootFileMeta.innerHTML = formatSize(file.size) + ' <span class="format-label format-ps1">PS1 Disc</span>';
    ebootFileInfo.style.display = 'block';

    showEbootActions();

    const detected = await autoDetectDiscId(file);
    if (detected?.discId) {
      ebootDiscId.value = detected.discId;
      discIdDetected.textContent = '(auto-detected)';
    } else {
      ebootDiscId.value = '';
      discIdDetected.textContent = '';
    }
    if (detected?.title) {
      ebootTitle.value = detected.title;
    }
    updateCoverImage(ebootDiscId.value.trim());
    updateResourceSearch(ebootDiscId.value.trim());
    regenerateDefaults();
  }
}

function resetEbootUI() {
  ebootStatusEl.textContent = '';
  ebootStatusEl.className = 'status';
  ebootProgressArea.style.display = 'none';
  ebootOpts.style.display = 'none';
  ebootOpts.classList.remove('cover-visible');
  const coverImg = document.getElementById('ebootCoverImg');
  if (coverImg) coverImg.src = '';
  updateResourceSearch('');
  discListEl.innerHTML = '';
  addDiscHint.style.display = 'none';
  document.getElementById('buildLogArea').style.display = 'none';
  ebootFiles = [];
  pendingCues = [];
  icon0IsCustom = pic0IsCustom = pic1IsCustom = false;
  currentIcon0 = currentIcon1 = currentPic0 = currentPic1 = null;
  icon0Deleted = pic0Deleted = pic1Deleted = false;
  artIcon0.src = '';
  artIcon1.src = '';
  artPic0.src = '';
  artPic1.src = '';
  document.getElementById('artIcon0Reset').style.display = 'none';
  document.getElementById('artPic0Reset').style.display = 'none';
  document.getElementById('artPic1Reset').style.display = 'none';
  document.getElementById('artIcon0Delete').classList.remove('slot-deleted');
  document.getElementById('artIcon1Delete').style.display = 'none';
  document.getElementById('artPic0Delete').classList.remove('slot-deleted');
  document.getElementById('artPic1Delete').classList.remove('slot-deleted');
  document.getElementById('icon1Dims').textContent = 'PMF/PNG';
}

function showEbootActions() {
  ebootActionsEl.innerHTML = '';
  const ebootBtn = document.createElement('button');
  ebootBtn.className = 'btn-eboot';
  ebootBtn.dataset.testid = 'eboot-build-btn';
  ebootBtn.textContent = 'Build EBOOT.PBP';
  ebootBtn.addEventListener('click', startEbootBuild);
  ebootActionsEl.appendChild(ebootBtn);
  ebootActionsEl.style.display = 'flex';
  ebootOpts.style.display = 'block';
  regenerateDefaults();
}

function findBinFile(binName, files) {
  const target = binName.split(/[/\\]/).pop().toLowerCase();
  return files.find(f => f.name.toLowerCase() === target);
}

function sortEbootFiles() {
  ebootFiles.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));
}

async function startPS1WithCues(cueFiles) {
  resetEbootUI();
  pendingCues = [];

  for (const cf of cueFiles) {
    const cueText = await cf.text();
    const binNames = extractBinNames(cueText);
    const tracks = parseCueTracksUI(cueText);
    if (binNames.length === 0) binNames.push(cf.name.replace(/\.cue$/i, '.bin'));
    pendingCues.push({ name: cf.name, cueText, cueTracks: tracks, binNames });
  }

  ebootFileInfo.style.display = 'block';
  ebootFileName.textContent = pendingCues.map(c => c.name).join(', ');
  ebootFileMeta.innerHTML = '<span class="format-label format-ps1">PS1 Disc</span>';

  const allNeeded = pendingCues.flatMap(c => c.binNames);
  ebootStatusEl.textContent = 'Missing: ' + allNeeded.join(', ') + ' \u2014 drop the file(s) to continue';
  ebootStatusEl.className = 'status';

  addDiscHint.style.display = 'block';
  addDiscHint.textContent = 'Drop the BIN file(s) referenced by the CUE sheet(s)';
}

async function startPS1WithCuesAndBins(cueFiles, binFiles) {
  resetEbootUI();

  const consumedBins = new Set();

  for (const cf of cueFiles) {
    const cueText = await cf.text();
    const binNames = extractBinNames(cueText);
    const tracks = parseCueTracksUI(cueText);
    if (binNames.length === 0) binNames.push(cf.name.replace(/\.cue$/i, '.bin'));
    const result = mergeCueBins(binNames, binFiles);

    if (result) {
      if (ebootFiles.length < 5) {
        ebootFiles.push({ file: result.merged, cueText, cueTracks: tracks, fileSizes: result.fileSizes });
      }
      result.matched.forEach(f => consumedBins.add(f));
    } else {
      pendingCues.push({ name: cf.name, cueText, cueTracks: tracks, binNames });
    }
  }

  for (const bf of binFiles) {
    if (!consumedBins.has(bf) && ebootFiles.length < 5) {
      ebootFiles.push({ file: bf, cueText: null, cueTracks: null, fileSizes: null });
    }
  }

  sortEbootFiles();

  const firstFile = ebootFiles[0]?.file;
  if (firstFile) {
    ebootFileInfo.style.display = 'block';
    ebootFileName.textContent = firstFile.name;
    ebootFileMeta.innerHTML = formatSize(firstFile.size) + ' <span class="format-label format-ps1">PS1 Disc</span>';
  }

  renderDiscList();

  if (pendingCues.length > 0) {
    ebootStatusEl.textContent = 'Missing: ' + pendingCues.map(c => c.binName).join(', ') + ' \u2014 drop to continue';
    ebootStatusEl.className = 'status';
    addDiscHint.style.display = 'block';
    addDiscHint.textContent = 'Drop the missing BIN file(s) to continue';
  } else {
    addDiscHint.style.display = 'block';
    addDiscHint.textContent = 'Drop more discs to add them (up to 5)';
    showEbootActions();

    if (firstFile) {
      const detected = await autoDetectDiscId(firstFile);
      if (detected?.discId) {
        ebootDiscId.value = detected.discId;
        discIdDetected.textContent = '(auto-detected)';
      } else {
        ebootDiscId.value = '';
        discIdDetected.textContent = '';
      }
      if (detected?.title) {
        ebootTitle.value = detected.title;
      }
      updateCoverImage(ebootDiscId.value.trim());
      updateResourceSearch(ebootDiscId.value.trim());
      regenerateDefaults();
    }
  }
}

async function addDiscFiles(cueFiles, binFiles) {
  const consumedBins = new Set();

  for (let i = pendingCues.length - 1; i >= 0; i--) {
    const cue = pendingCues[i];
    const result = mergeCueBins(cue.binNames, binFiles);
    if (result) {
      pendingCues.splice(i, 1);
      if (ebootFiles.length < 5) {
        ebootFiles.push({ file: result.merged, cueText: cue.cueText, cueTracks: cue.cueTracks, fileSizes: result.fileSizes });
      }
      result.matched.forEach(f => consumedBins.add(f));
    }
  }

  for (const cf of cueFiles) {
    const cueText = await cf.text();
    const binNames = extractBinNames(cueText);
    const tracks = parseCueTracksUI(cueText);
    if (binNames.length === 0) binNames.push(cf.name.replace(/\.cue$/i, '.bin'));
    const result = mergeCueBins(binNames, binFiles);

    if (result) {
      if (ebootFiles.length < 5) {
        ebootFiles.push({ file: result.merged, cueText, cueTracks: tracks, fileSizes: result.fileSizes });
      }
      result.matched.forEach(f => consumedBins.add(f));
    } else {
      pendingCues.push({ name: cf.name, cueText, cueTracks: tracks, binNames });
    }
  }

  for (const bf of binFiles) {
    if (!consumedBins.has(bf) && ebootFiles.length < 5) {
      ebootFiles.push({ file: bf, cueText: null, cueTracks: null, fileSizes: null });
    }
  }

  sortEbootFiles();
  renderDiscList();

  if (pendingCues.length > 0) {
    const allNeeded = pendingCues.flatMap(c => c.binNames);
    ebootStatusEl.textContent = 'Missing: ' + allNeeded.join(', ') + ' \u2014 drop to continue';
    ebootStatusEl.className = 'status';
    addDiscHint.textContent = 'Drop the missing BIN file(s) to continue';
  } else {
    ebootStatusEl.textContent = '';
    ebootStatusEl.className = 'status';
    addDiscHint.textContent = 'Drop more discs to add them (up to 5)';

    if (!ebootActionsEl.querySelector('.btn-eboot')) {
      showEbootActions();

      const firstFile = ebootFiles[0]?.file;
      if (firstFile) {
        ebootFileInfo.style.display = 'block';
        ebootFileName.textContent = firstFile.name;
        ebootFileMeta.innerHTML = formatSize(firstFile.size) + ' <span class="format-label format-ps1">PS1 Disc</span>';
        const detected = await autoDetectDiscId(firstFile);
        if (detected?.discId) {
          ebootDiscId.value = detected.discId;
          discIdDetected.textContent = '(auto-detected)';
        }
        if (detected?.title) {
          ebootTitle.value = detected.title;
        }
        updateCoverImage(ebootDiscId.value.trim());
        updateResourceSearch(ebootDiscId.value.trim());
        regenerateDefaults();
      }
    }
  }
}

let dragSrcIdx = null;

function renderDiscList() {
  discListEl.innerHTML = '';
  if (ebootFiles.length <= 1 && pendingCues.length === 0) return;
  ebootFiles.forEach((entry, i) => {
    const f = entry.file;
    const item = document.createElement('div');
    item.className = 'disc-item';
    item.draggable = true;
    item.dataset.idx = i;
    const cueLabel = entry.cueText ? ' <span class="detected">(CUE)</span>' : '';
    item.innerHTML = `<span class="disc-num">${i+1}</span><span class="disc-name">${f.name}${cueLabel}</span><span class="disc-size">${formatSize(f.size)}</span>`;

    item.addEventListener('dragstart', (e) => {
      dragSrcIdx = i;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      dragSrcIdx = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (dragSrcIdx !== null && dragSrcIdx !== i) {
        const [moved] = ebootFiles.splice(dragSrcIdx, 1);
        ebootFiles.splice(i, 0, moved);
        renderDiscList();
      }
    });

    const rm = document.createElement('button');
    rm.className = 'disc-remove';
    rm.textContent = '\u00d7';
    rm.addEventListener('click', () => {
      ebootFiles.splice(i, 1);
      renderDiscList();
    });
    item.appendChild(rm);
    discListEl.appendChild(item);
  });
  pendingCues.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'disc-item';
    item.style.opacity = '0.5';
    item.innerHTML = `<span class="disc-num">?</span><span class="disc-name">${c.binName} <span style="color:#ff6b6b">(missing)</span></span><span class="disc-size">${c.name}</span>`;
    discListEl.appendChild(item);
  });
}

function showEbootProgress(pct, label) {
  const p = Math.round(pct * 100);
  ebootProgressFill.style.width = p + '%';
  ebootProgressPct.textContent = p + '%';
  ebootProgressLabel.textContent = label;
}

// ── 빌드 로그 포맷팅 ─────────────────────────────────────────────────────
function formatBuildLog(log) {
  const lines = [];
  lines.push('EBOOT Build Log');
  lines.push('===============');
  lines.push('Date: ' + new Date().toISOString());
  lines.push('Total time: ' + (log.timing.total / 1000).toFixed(1) + 's');
  lines.push('');

  lines.push('Input Files');
  lines.push('-----------');
  for (let i = 0; i < log.inputFiles.length; i++) {
    const f = log.inputFiles[i];
    lines.push('Disc ' + (i + 1) + ': ' + f.filename);
    lines.push('  Size: ' + f.size.toLocaleString() + ' bytes (' + formatSize(f.size) + ')');
    lines.push('  SHA-1: ' + f.sha1);
    lines.push('  Sector size: ' + f.sectorSize + (f.sectorSize === 2352 ? ' (raw)' : ' (ISO)'));
    lines.push('  Disc ID: ' + f.discId);
    lines.push('  CUE: ' + (f.hasCue ? 'yes (' + f.trackCount + ' track' + (f.trackCount > 1 ? 's' : '') + ')' : 'no'));
    lines.push('');
  }

  lines.push('Settings');
  lines.push('--------');
  lines.push('Title: ' + log.sfo.title);
  lines.push('Compression level: ' + log.compressionLevel);
  lines.push('Disc count: ' + log.sfo.discTotal);
  lines.push('');

  lines.push('Compression');
  lines.push('-----------');
  for (let i = 0; i < log.discStats.length; i++) {
    const s = log.discStats[i];
    lines.push('Disc ' + (i + 1) + ': ' + s.totalBlocks.toLocaleString() + ' blocks');
    const compPct = s.totalBlocks > 0 ? (s.compressedCount / s.totalBlocks * 100).toFixed(1) : '0.0';
    const uncompPct = s.totalBlocks > 0 ? (s.uncompressedCount / s.totalBlocks * 100).toFixed(1) : '0.0';
    lines.push('  Compressed: ' + s.compressedCount.toLocaleString() + ' (' + compPct + '%)');
    lines.push('  Uncompressed: ' + s.uncompressedCount.toLocaleString() + ' (' + uncompPct + '%)');
    lines.push('  Input: ' + s.inputSize.toLocaleString() + ' bytes');
    lines.push('  Output: ' + s.outputSize.toLocaleString() + ' bytes');
    const ratio = s.inputSize > 0 ? (s.outputSize / s.inputSize * 100).toFixed(1) : '0.0';
    lines.push('  Ratio: ' + ratio + '%');
    lines.push('');
  }

  lines.push('Timing');
  lines.push('------');
  lines.push('SFO: ' + (log.timing.sfo / 1000).toFixed(3) + 's');
  lines.push('PSAR (compression): ' + (log.timing.psar / 1000).toFixed(1) + 's');
  lines.push('PBP assembly: ' + (log.timing.pbp / 1000).toFixed(3) + 's');
  lines.push('');

  if (log.verification) {
    lines.push('Verification');
    lines.push('------------');
    for (const v of log.verification) {
      lines.push('[' + v.status + '] ' + v.message);
    }
    lines.push('');
  }

  lines.push('Output');
  lines.push('------');
  lines.push('EBOOT.PBP: ' + log.outputSize.toLocaleString() + ' bytes (' + formatSize(log.outputSize) + ')');

  return lines.join('\n');
}

function showBuildLogDownload(log) {
  const text = formatBuildLog(log);
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.getElementById('buildLogLink');
  link.href = url;
  const id = ebootDiscId.value.trim() || 'SLUS00000';
  link.download = `eboot-build-log-${id}.txt`;
  document.getElementById('buildLogArea').style.display = 'block';
}

// ── 병렬 압축 ─────────────────────────────────────────────────────────────
// ISO_BLOCK_SIZE (0x9300)는 shared.js에 선언됨

async function compressDiscParallel(file, compressionLevel, numThreads, onProgress) {
  const fileSize = file.size;
  const totalBlocks = Math.ceil(fileSize / ISO_BLOCK_SIZE);

  // 파일에서 모든 블록 읽기
  onProgress(0, 'Reading disc image...');
  const allBlocks = [];
  for (let i = 0; i < totalBlocks; i++) {
    const start = i * ISO_BLOCK_SIZE;
    const end = Math.min(start + ISO_BLOCK_SIZE, fileSize);
    allBlocks.push(new Uint8Array(await file.slice(start, end).arrayBuffer()));
    if (i % 64 === 0) {
      onProgress(i / totalBlocks * 0.3, `Reading block ${i}/${totalBlocks}`);
    }
  }

  onProgress(0.3, 'Compressing...');

  // 블록을 워커용 범위로 분할
  const blocksPerWorker = Math.ceil(totalBlocks / numThreads);
  const ranges = [];
  for (let i = 0; i < numThreads; i++) {
    const start = i * blocksPerWorker;
    const end = Math.min(start + blocksPerWorker, totalBlocks);
    if (start < totalBlocks) {
      ranges.push(allBlocks.slice(start, end));
    }
  }

  // 워커 생성 및 작업 배분
  const workerResults = new Array(ranges.length);
  const workerProgress = new Array(ranges.length).fill(0);
  let completedWorkers = 0;

  return new Promise((resolve, reject) => {
    for (let r = 0; r < ranges.length; r++) {
      const worker = new Worker('compress-worker.js');
      ebootActiveCompressWorkers.push(worker);
      const blockBuffers = ranges[r].map(b => b.buffer);

      worker.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'progress') {
          workerProgress[msg.rangeIndex] = msg.blockIndex / msg.totalBlocks;
          const avgProgress = workerProgress.reduce((a, b) => a + b, 0) / ranges.length;
          onProgress(0.3 + avgProgress * 0.65, `Compressing... (${numThreads} workers)`);
        } else if (msg.type === 'done') {
          // 전송된 ArrayBuffer를 Uint8Array로 변환
          workerResults[msg.rangeIndex] = {
            parts: msg.parts.map(p => new Uint8Array(p.buffer || p)),
            indexEntries: msg.indexEntries,
            stats: msg.stats,
          };
          worker.terminate();
          completedWorkers++;

          if (completedWorkers === ranges.length) {
            // 결과 조합 — 첫 번째 이후 범위의 오프셋 조정
            const allParts = [];
            const allIndexEntries = [];
            let runningOffset = 0;
            let totalCompressedCount = 0;
            let totalUncompressedCount = 0;
            let totalCompressedBytes = 0;

            for (let i = 0; i < workerResults.length; i++) {
              const wr = workerResults[i];
              for (const part of wr.parts) allParts.push(part);
              for (const entry of wr.indexEntries) {
                allIndexEntries.push({
                  offset: entry.offset + runningOffset,
                  size: entry.size,
                  sha1: entry.sha1,
                });
              }
              runningOffset += wr.stats.totalCompressedBytes;
              totalCompressedCount += wr.stats.compressedCount;
              totalUncompressedCount += wr.stats.uncompressedCount;
              totalCompressedBytes += wr.stats.totalCompressedBytes;
            }

            onProgress(0.95, 'Compression complete');
            resolve({
              parts: allParts,
              indexEntries: allIndexEntries,
              stats: {
                compressedCount: totalCompressedCount,
                uncompressedCount: totalUncompressedCount,
                totalCompressedBytes,
              },
            });
          }
        }
      };

      worker.onerror = function(err) {
        worker.terminate();
        reject(new Error('Compression worker error: ' + (err.message || err)));
      };

      // 블록 ArrayBuffer를 워커로 전송
      worker.postMessage(
        { blocks: ranges[r], compressionLevel, rangeIndex: r },
        blockBuffers
      );
    }
  });
}

// ── EBOOT 빌드 ──────────────────────────────────────────────────────────────
async function startEbootBuild() {
  if (ebootWorking || !ebootFiles.length || pendingCues.length > 0) return;

  const title = ebootTitle.value.trim() || 'Unknown';
  const discId = ebootDiscId.value.trim() || 'SLUS00000';
  const compressionLevel = parseInt(ebootCompression.value, 10);
  const numThreads = parseInt(ebootThreads.value, 10);
  const parentalLevel = parseInt(ebootParentalLevel.value, 10);
  const region = parseInt(ebootRegion.value, 16);

  const discIds = ebootFiles.map((_, i) => {
    if (i === 0) return discId;
    const base = discId.slice(0, -1);
    const last = parseInt(discId.slice(-1), 10);
    return base + ((last + i) % 10);
  });

  const discInfo = ebootFiles.map(entry => {
    if (entry.cueTracks && entry.cueTracks.length > 0) {
      return {
        tracks: entry.cueTracks,
        fileSize: entry.file.size,
        sectorSize: entry.cueTracks[0].sectorSize,
        fileSizes: entry.fileSizes || null,
      };
    }
    return null;
  });

  ebootWorking = true;
  ebootActiveCompressWorkers = [];
  for (const btn of ebootActionsEl.querySelectorAll('button')) btn.disabled = true;
  setEbootInputsDisabled(true);
  ebootProgressArea.style.display = 'block';
  showEbootProgress(0, 'Starting...');
  ebootStatusEl.textContent = '';
  ebootStatusEl.className = 'status';

  const t0 = performance.now();

  // 병렬 압축: 메인 스레드에서 블록을 압축한 후 조립을 위해 eboot-worker로 전송
  let preCompressed = undefined;
  if (numThreads > 1) {
    try {
      preCompressed = [];
      const files = ebootFiles.map(e => e.file);
      for (let d = 0; d < files.length; d++) {
        const discProgress = (pct, label) => {
          const overall = (d + pct) / files.length;
          showEbootProgress(overall * 0.90, `Disc ${d + 1}/${files.length}: ${label}`);
        };
        const result = await compressDiscParallel(files[d], compressionLevel, numThreads, discProgress);
        preCompressed.push(result);
      }
    } catch (err) {
      ebootStatusEl.textContent = `Error: ${err.message}`;
      ebootStatusEl.className = 'status error';
      ebootWorking = false;
      setEbootInputsDisabled(false);
      for (const btn of ebootActionsEl.querySelectorAll('button')) btn.disabled = false;
      return;
    }
  }

  const worker = new Worker('eboot-worker.js');
  ebootActiveWorker = worker;

  worker.onmessage = function(e) {
    const msg = e.data;
    if (msg.type === 'progress') {
      if (preCompressed) {
        const scaled = 0.90 + msg.pct * 0.10;
        showEbootProgress(Math.min(scaled, 1), msg.label);
      } else {
        showEbootProgress(Math.min(msg.pct, 1), msg.label);
      }
    } else if (msg.type === 'done') {
      const ebootResult = new Uint8Array(msg.result);
      const ebootSize = ebootResult.length;
      const baseName = (ebootFiles[0]?.file.name || 'EBOOT').replace(/\.[^.]+$/, '');
      const pbpName = baseName + '.PBP';
      download(ebootResult, pbpName);
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      ebootStatusEl.textContent = `Done in ${elapsed}s \u2014 ${formatSize(ebootSize)} saved as ${pbpName}`;
      showEbootProgress(1, 'Complete');
      if (msg.buildLog) showBuildLogDownload(msg.buildLog);
      finish();
    } else if (msg.type === 'error') {
      ebootStatusEl.textContent = `Error: ${msg.message}`;
      ebootStatusEl.className = 'status error';
      if (msg.buildLog) showBuildLogDownload(msg.buildLog);
      finish();
    }
  };
  worker.onerror = function(err) {
    console.error('EBOOT worker error:', err);
    const detail = err.message || `${err.filename}:${err.lineno} ${err.type}`;
    ebootStatusEl.textContent = `Worker error: ${detail}`;
    ebootStatusEl.className = 'status error';
    finish();
  };
  function finish() {
    ebootWorking = false;
    ebootActiveWorker = null;
    for (const btn of ebootActionsEl.querySelectorAll('button')) btn.disabled = false;
    setEbootInputsDisabled(false);
    worker.terminate();
  }

  const files = ebootFiles.map(e => e.file);
  const icon0 = currentIcon0 || undefined;
  const pic0 = currentPic0 || undefined;
  const pic1 = currentPic1 || undefined;
  const transferables = [];
  if (preCompressed) {
    for (const disc of preCompressed) {
      for (const part of disc.parts) transferables.push(part.buffer);
    }
  }
  worker.postMessage({ files, title, discIds, compressionLevel, parentalLevel, region, discInfo, icon0, pic0, pic1, preCompressed }, transferables);
}
