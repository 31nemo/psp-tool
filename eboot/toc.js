// TOC (Table of Contents) generator for PS1 disc images
//
// Generates the CD-ROM TOC that POPS (the PSP's PS1 emulator) reads to
// understand the disc layout — track count, track types, and start positions.
//
// The TOC mirrors the Q subchannel data from a physical CD's lead-in area.
// Each entry is 10 bytes matching the subchannel Q format:
//
//   [ADR/Control] [TNO] [Point] [AMIN] [ASEC] [AFRAME] [0x00] [PMIN] [PSEC] [PFRAME]
//
// Positions use MSF (Minutes:Seconds:Frames) in BCD encoding, where 1 second
// = 75 frames. Track 1 starts at 00:02:00 (150 frames = 2-second lead-in).
//
// Control byte values:
//   0x41 = data track (bit 6 set)
//   0x01 = audio track (bit 6 clear)
//
// Special point entries in the lead-in:
//   A0 = first track number (PMIN), disc type (PSEC: 0x00=CD-DA, 0x20=CD-ROM XA)
//   A1 = last track number (PMIN)
//   A2 = lead-out start position (PMIN/PSEC/PFRAME)
//
// Spec: https://psx-spx.consoledev.net/cdromformat/ (Subchannel Q during Lead-In)

/**
 * Generate a TOC for a single-track data disc (the common case for PS1 games).
 *
 * Produces 4 entries: A0 (first track), A1 (last track), A2 (lead-out), and
 * track 1. This covers any PS1 disc image without a CUE sheet — assumed to be
 * a single data track (MODE2/2352 or MODE1/2048).
 *
 * @param {number} fileSize - Size of the disc image in bytes
 * @param {number} sectorSize - Bytes per sector (2352 for BIN, 2048 for ISO)
 * @returns {Uint8Array} 40 bytes (4 entries × 10 bytes)
 */
export function generateToc(fileSize, sectorSize) {
  const totalFrames = Math.ceil(fileSize / sectorSize);
  // Add 150 frames (2-second lead-in) for the track start offset
  const endMsf = framesToMsfBcd(totalFrames + 150);
  const entries = [];

  // Entry for point A0: first track number
  entries.push(tocEntry(0x41, 0x00, 0xA0, 0, 0, 0, 0x01, 0x20, 0x00));

  // Entry for point A1: last track number
  entries.push(tocEntry(0x41, 0x00, 0xA1, 0, 0, 0, 0x01, 0x00, 0x00));

  // Entry for point A2: lead-out position
  entries.push(tocEntry(0x41, 0x00, 0xA2, 0, 0, 0, endMsf[0], endMsf[1], endMsf[2]));

  // Entry for track 1: data track starting at 00:02:00 (150 frames = 2 seconds)
  entries.push(tocEntry(0x41, 0x00, 0x01, 0, 0, 0, 0x00, 0x02, 0x00));

  // Concatenate all entries
  const result = new Uint8Array(entries.length * 10);
  for (let i = 0; i < entries.length; i++) {
    result.set(entries[i], i * 10);
  }
  return result;
}

/**
 * Generate a TOC from parsed CUE track data.
 *
 * Handles multi-track discs (data + audio tracks, e.g. games with CD audio)
 * and multi-file CUE sheets (separate BIN per track). Each track gets its own
 * entry with the correct control byte (0x41 for data, 0x01 for audio).
 *
 * For multi-file CUEs, INDEX timestamps are relative to each file's start, so
 * we compute cumulative frame offsets to produce absolute MSF positions.
 *
 * @param {Array} tracks - Parsed tracks from parseCue() with {number, type, indexes, file}
 * @param {number} fileSize - Total disc image size in bytes (merged if multi-file)
 * @param {number} sectorSize - Bytes per sector
 * @param {Array<number>} [fileSizes] - Per-file sizes for multi-file CUE sheets
 * @returns {Uint8Array} (3 + trackCount) entries × 10 bytes
 */
export function generateTocFromCue(tracks, fileSize, sectorSize, fileSizes) {
  const totalFrames = Math.ceil(fileSize / sectorSize);
  const endMsf = framesToMsfBcd(totalFrames + 150);
  const firstTrack = tracks[0].number;
  const lastTrack = tracks[tracks.length - 1].number;
  const entries = [];

  // Build per-file frame offsets for multi-file CUE sheets.
  // When a CUE has multiple FILE directives, INDEX times are relative to each
  // file's start. We need absolute offsets within the concatenated image.
  let fileFrameOffsets = null;
  if (fileSizes && fileSizes.length > 1) {
    const fileNames = [...new Set(tracks.map(t => t.file))];
    fileFrameOffsets = {};
    let cumulative = 0;
    for (let i = 0; i < fileNames.length; i++) {
      fileFrameOffsets[fileNames[i]] = cumulative;
      if (i < fileSizes.length) cumulative += Math.ceil(fileSizes[i] / sectorSize);
    }
  }

  // A0: first track
  const isDataFirst = tracks[0].type.startsWith('MODE');
  const controlFirst = isDataFirst ? 0x41 : 0x01;
  entries.push(tocEntry(controlFirst, 0x00, 0xA0, 0, 0, 0, toBcd(firstTrack), 0x20, 0x00));

  // A1: last track
  entries.push(tocEntry(controlFirst, 0x00, 0xA1, 0, 0, 0, toBcd(lastTrack), 0x00, 0x00));

  // A2: lead-out
  entries.push(tocEntry(controlFirst, 0x00, 0xA2, 0, 0, 0, endMsf[0], endMsf[1], endMsf[2]));

  // Individual track entries
  for (const track of tracks) {
    const isData = track.type.startsWith('MODE');
    const control = isData ? 0x41 : 0x01;
    const idx01 = track.indexes.find(i => i.id === 1);
    let startFrames = idx01 ? msfToFrames(idx01.msf) + 150 : 150;
    // For multi-file CUE: add the file's base offset
    if (fileFrameOffsets && track.file && fileFrameOffsets[track.file]) {
      startFrames += fileFrameOffsets[track.file];
    }
    const msf = framesToMsfBcd(startFrames);
    entries.push(tocEntry(control, 0x00, toBcd(track.number), 0, 0, 0, msf[0], msf[1], msf[2]));
  }

  const result = new Uint8Array(entries.length * 10);
  for (let i = 0; i < entries.length; i++) {
    result.set(entries[i], i * 10);
  }
  return result;
}

/** Build a single 10-byte TOC entry matching the subchannel Q format. */
function tocEntry(addrCtrl, tno, point, amin, asec, aframe, pmin, psec, pframe) {
  return new Uint8Array([addrCtrl, tno, point, amin, asec, aframe, 0, pmin, psec, pframe]);
}

/** Convert a decimal number (0–99) to BCD. E.g. 15 → 0x15. */
export function toBcd(n) {
  return ((Math.floor(n / 10) & 0xF) << 4) | (n % 10 & 0xF);
}

/** Convert a BCD byte back to decimal. E.g. 0x15 → 15. */
function fromBcd(b) {
  return ((b >> 4) & 0xF) * 10 + (b & 0xF);
}

/** Convert [min, sec, frame] (decimal) to absolute frame count. 1 sec = 75 frames. */
function msfToFrames(msf) {
  return msf[0] * 60 * 75 + msf[1] * 75 + msf[2];
}

/** Convert absolute frame count to [min, sec, frame] in BCD. */
export function framesToMsfBcd(frames) {
  const m = Math.floor(frames / (60 * 75));
  const s = Math.floor((frames % (60 * 75)) / 75);
  const f = frames % 75;
  return [toBcd(m), toBcd(s), toBcd(f)];
}
