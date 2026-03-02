// EBOOT assembler — top-level orchestrator for PBP construction
//
// Ties together all the eboot/ modules to produce a complete EBOOT.PBP:
//   1. Build PARAM.SFO metadata (sfo.js)
//   2. Attach artwork PNGs (ICON0, PIC0, PIC1)
//   3. Load DATA.PSP ELF blob (assets.js)
//   4. Generate TOC per disc (toc.js, using CUE data if available)
//   5. Compress disc images into DATA.PSAR (pstitleimg.js → psisoimg.js)
//   6. Pack everything into a PBP container (pbp.js)
//
// Also produces a build log with timing, SHA-1 hashes, and compression stats
// for diagnostic/debugging purposes.

import { ASSETS } from './assets.js';
import { buildSFO } from './sfo.js';
import { buildPBP } from './pbp.js';
import { generateToc, generateTocFromCue } from './toc.js';
import { isRawImage } from './discid.js';
import { buildPsar } from './pstitleimg.js';

/** Compute hex SHA-1 of a File using Web Crypto (for build log diagnostics). */
async function computeSha1Hex(file) {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a complete EBOOT.PBP from one or more PS1 disc images.
 *
 * This is the main entry point called by eboot-worker.js. It coordinates all
 * sub-modules and reports progress back to the UI via opts.onProgress.
 *
 * @param {Object} opts
 * @param {Array<File>} opts.files           - Disc image files in play order (1–5)
 * @param {string} opts.title                - Game title for SFO and PSAR header
 * @param {Array<string>} opts.discIds       - Disc ID per file (e.g. ["SCUS94163"])
 * @param {number} [opts.compressionLevel=5] - deflate level (0–9)
 * @param {number} [opts.parentalLevel]      - SFO parental control level
 * @param {number} [opts.region]             - SFO region bitmask
 * @param {Uint8Array} [opts.icon0]          - Custom 144×80 PNG icon
 * @param {Uint8Array} [opts.pic0]           - Custom 310×180 PNG info overlay
 * @param {Uint8Array} [opts.pic1]           - Custom 480×272 PNG background
 * @param {Array<Object>} [opts.discInfo]    - CUE-parsed track info per disc
 * @param {Array<Object>} [opts.preCompressed] - Pre-compressed blocks from parallel workers
 * @param {function} [opts.onProgress]       - Progress callback(fraction, label)
 * @returns {Promise<{pbp: Uint8Array, buildLog: Object}>}
 */
export async function buildEboot(opts) {
  const onProgress = opts.onProgress || (() => {});
  const numDiscs = opts.files.length;
  const compressionLevel = opts.compressionLevel ?? 5;
  const buildLog = { inputFiles: [], timing: {} };
  const t0 = performance.now();

  onProgress(0, 'Building PARAM.SFO...');

  // Compute SHA-1 for each input file (in parallel)
  const sha1Promises = opts.files.map(f => computeSha1Hex(f));

  // 1. PARAM.SFO
  const sfoStart = performance.now();
  const paramSfo = buildSFO({
    title: opts.title,
    discId: opts.discIds[0],
    discTotal: numDiscs,
    parentalLevel: opts.parentalLevel,
    region: opts.region,
  });
  buildLog.timing.sfo = performance.now() - sfoStart;

  buildLog.sfo = {
    title: opts.title,
    discId: opts.discIds[0],
    category: 'ME',
    discTotal: numDiscs,
  };

  // 2. Artwork — use provided or empty
  const icon0 = opts.icon0 || new Uint8Array(0);
  const pic0 = opts.pic0 || new Uint8Array(0);
  const pic1 = opts.pic1 || new Uint8Array(0);

  // 3. DATA.PSP
  const dataPsp = ASSETS.dataPsp;

  // 4. Generate TOCs for each disc
  const tocs = [];
  const tocInfos = [];
  for (let i = 0; i < numDiscs; i++) {
    const file = opts.files[i];
    const info = opts.discInfo?.[i];

    if (info?.tracks) {
      const toc = generateTocFromCue(info.tracks, info.fileSize, info.sectorSize, info.fileSizes);
      tocs.push(toc);
      tocInfos.push({ trackCount: info.tracks.length, sectorSize: info.sectorSize, hasCue: true });
    } else {
      const isRaw = await isRawImage(file);
      const sectorSize = isRaw ? 2352 : 2048;
      tocs.push(generateToc(file.size, sectorSize));
      tocInfos.push({ trackCount: 1, sectorSize, hasCue: false });
    }
  }

  // Await SHA-1 results
  const sha1s = await Promise.all(sha1Promises);

  // Build input file info for log
  for (let i = 0; i < numDiscs; i++) {
    const file = opts.files[i];
    const info = opts.discInfo?.[i];
    buildLog.inputFiles.push({
      filename: file.name,
      size: file.size,
      sha1: sha1s[i],
      sectorSize: tocInfos[i].sectorSize,
      discId: opts.discIds[i],
      hasCue: tocInfos[i].hasCue,
      trackCount: tocInfos[i].trackCount,
    });
  }

  buildLog.compressionLevel = compressionLevel;

  // 5. Build DATA.PSAR (all disc images compressed)
  const psarStart = performance.now();
  const psarProgress = (pct, label) => {
    // PSAR is ~95% of the work
    onProgress(0.05 + pct * 0.90, label);
  };

  const psarResult = await buildPsar(opts.files, {
    title: opts.title,
    discIds: opts.discIds,
    compressionLevel,
    tocs,
    preCompressed: opts.preCompressed || undefined,
    onProgress: psarProgress,
  });
  buildLog.timing.psar = performance.now() - psarStart;
  buildLog.discStats = psarResult.discStats;

  // 6. Assemble PBP
  onProgress(0.96, 'Building PBP container...');
  const pbpStart = performance.now();
  const pbp = buildPBP({
    paramSfo,
    icon0,
    // TODO: ICON1.PMF (animated icon, replaces ICON0 on XMB hover) and SND0.AT3
    // (audio preview) are supported by the PBP format but not yet exposed in the UI.
    // Combined size of icon1 + snd0 must be under 500KB or neither plays.
    // icon1: opts.icon1 || null,
    // snd0: opts.snd0 || null,
    pic0,
    pic1,
    dataPsp,
    dataPsar: psarResult.data,
  });
  buildLog.timing.pbp = performance.now() - pbpStart;
  buildLog.timing.total = performance.now() - t0;
  buildLog.outputSize = pbp.length;

  onProgress(1, 'EBOOT.PBP complete');
  return { pbp, buildLog };
}
