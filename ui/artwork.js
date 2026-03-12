// ── EBOOT 아트워크 생성 ──────────────────────────────────────────────────────
//
// Canvas 2D를 사용하여 기본 ICON0, PIC0, PIC1 PNG 이미지를 생성합니다.
// 이는 PSP XMB가 표시하는 PBP 컨테이너의 아트워크 슬롯입니다:
//   ICON0: 144×80  — 게임 목록에 표시되는 작은 아이콘
//   PIC0:  310×180 — 게임 상세 화면의 정보 오버레이
//   PIC1:  480×272 — PIC0 뒤의 전체 화면 배경
//
// 기본값은 어두운 배경에 게임 타이틀과 디스크 ID를 렌더링합니다.
// 사용자는 UI를 통해 아무 슬롯이나 커스텀 아트워크로 교체할 수 있습니다.

/** maxWidth 안에 텍스트가 들어가는 가장 큰 폰트 크기(maxSize와 minSize 사이)를 찾습니다. */
function fitText(ctx, text, maxWidth, maxSize, minSize) {
  for (let size = maxSize; size >= minSize; size--) {
    ctx.font = `bold ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return size;
  }
  return minSize;
}

/** 텍스트를 maxWidth 안에 들어가는 최대 maxLines 줄로 줄바꿈합니다. */
function wrapText(ctx, text, maxWidth, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  else if (line && lines.length >= maxLines) {
    lines[lines.length - 1] = lines[lines.length - 1] + ' ' + line;
  }
  return lines;
}

/** 줄바꿈된 텍스트가 maxWidth × maxLines 안에 들어가는 가장 큰 폰트 크기를 찾습니다. */
function fitTextWrapped(ctx, text, maxWidth, maxSize, minSize, maxLines) {
  for (let sz = maxSize; sz >= minSize; sz--) {
    ctx.font = `bold ${sz}px sans-serif`;
    const wrapped = wrapText(ctx, text, maxWidth, maxLines);
    if (wrapped.every(l => ctx.measureText(l).width <= maxWidth)) {
      return { fontSize: sz, lines: wrapped };
    }
  }
  ctx.font = `bold ${minSize}px sans-serif`;
  return { fontSize: minSize, lines: wrapText(ctx, text, maxWidth, maxLines) };
}

function drawTitleBlock(ctx, text, opts) {
  const { centerX, maxWidth, maxSize, minSize, maxLines } = opts;
  // 먼저 한 줄로 시도
  let fontSize = fitText(ctx, text, maxWidth, maxSize, minSize);
  ctx.font = `bold ${fontSize}px sans-serif`;
  let lines;
  if (ctx.measureText(text).width > maxWidth) {
    // 더 큰 크기로 여러 줄에 걸쳐 줄바꿈
    const result = fitTextWrapped(ctx, text, maxWidth, maxSize, minSize, maxLines);
    fontSize = result.fontSize;
    lines = result.lines;
  } else {
    lines = [text];
  }
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  const lineH = fontSize * 1.3;
  const titleY = opts.baseY - ((lines.length - 1) * lineH) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], centerX, titleY + i * lineH);
  }
  return titleY + (lines.length - 1) * lineH;
}

function drawAccentLine(ctx, centerX, y, halfWidth) {
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(centerX - halfWidth, y);
  ctx.lineTo(centerX + halfWidth, y);
  ctx.stroke();
}

/** 어두운 배경에 게임 타이틀이 있는 80×80 ICON0 PNG를 생성합니다. */
function generateDefaultIcon0(title) {
  const c = document.createElement('canvas');
  c.width = 80; c.height = 80;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 80, 80);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const displayTitle = (title || 'PS1 Game').length > 30
    ? (title || 'PS1 Game').slice(0, 30) + '...' : (title || 'PS1 Game');
  const fontSize = fitText(ctx, displayTitle, 70, 16, 7);
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.fillText(displayTitle, 40, 30);
  drawAccentLine(ctx, 40, 48, 28);
  ctx.fillStyle = '#666';
  ctx.font = '7px sans-serif';
  ctx.fillText('PlayStation', 40, 60);
  return canvasToUint8Array(c);
}

/** 게임 타이틀과 디스크 ID가 있는 310×180 PIC0 PNG를 생성합니다. */
function generateDefaultPic0(title, discId) {
  const c = document.createElement('canvas');
  c.width = 310; c.height = 180;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 310, 180);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawTitleBlock(ctx, title || 'PS1 Game', {
    centerX: 155, maxWidth: 280, maxSize: 28, minSize: 12, maxLines: 2, baseY: 65,
  });
  if (discId) {
    ctx.fillStyle = '#888';
    ctx.font = '12px monospace';
    ctx.fillText(discId, 155, 120);
  }
  drawAccentLine(ctx, 155, 145, 75);
  ctx.fillStyle = '#666';
  ctx.font = '11px sans-serif';
  ctx.fillText('PlayStation', 155, 162);
  return canvasToUint8Array(c);
}

/** 그라데이션 배경에 게임 타이틀이 있는 480×272 PIC1 PNG를 생성합니다. */
function generateDefaultPic1(title) {
  const c = document.createElement('canvas');
  c.width = 480; c.height = 272;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 480, 272);
  grad.addColorStop(0, '#1a1a2e');
  grad.addColorStop(1, '#252545');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 480, 272);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawTitleBlock(ctx, title || 'PS1 Game', {
    centerX: 240, maxWidth: 440, maxSize: 40, minSize: 16, maxLines: 2, baseY: 120,
  });
  drawAccentLine(ctx, 240, 165, 100);
  ctx.fillStyle = '#555';
  ctx.font = '14px sans-serif';
  ctx.fillText('PlayStation', 240, 185);
  return canvasToUint8Array(c);
}
