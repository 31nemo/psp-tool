// CUE sheet parser
//
// Parses .cue files to extract the track layout needed for TOC generation.
// CUE sheets describe the structure of a CD image — which tracks are data vs
// audio, their sector format, and where each track/index starts.
//
// Supports:
//   - Single-file CUEs (one BIN with all tracks)
//   - Multi-file CUEs (separate BIN per track, common with Redump dumps)
//   - Track types: MODE1/2048, MODE2/2352, MODE2/2336, AUDIO
//   - INDEX directives (INDEX 00 = pregap, INDEX 01 = track start)
//   - PREGAP directives (silence inserted before a track)
//
// CUE sheet format reference: https://www.gnu.org/software/ccd2cue/manual/html_node/CUE-sheet-format.html

/**
 * Parse a .cue file into a structured result.
 *
 * Processes FILE, TRACK, INDEX, and PREGAP directives line by line. Each track
 * records which FILE it belongs to (for multi-file offset calculation in
 * generateTocFromCue).
 *
 * @param {string} text - Raw contents of the .cue file
 * @returns {{files: string[], tracks: Array<{number: number, type: string, sectorSize: number, pregap: number, file: string, indexes: Array<{id: number, msf: [number,number,number]}>}>}}
 */
export function parseCue(text) {
  const tracks = [];
  const files = [];
  let current = null;
  let currentFile = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const fileMatch = line.match(/^FILE\s+"([^"]+)"/i) || line.match(/^FILE\s+(\S+)/i);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!files.includes(currentFile)) files.push(currentFile);
      continue;
    }

    const trackMatch = line.match(/^TRACK\s+(\d+)\s+(\S+)/i);
    if (trackMatch) {
      current = {
        number: parseInt(trackMatch[1], 10),
        type: trackMatch[2].toUpperCase(),
        sectorSize: sectorSizeForType(trackMatch[2].toUpperCase()),
        pregap: 0,
        file: currentFile,
        indexes: [],
      };
      tracks.push(current);
      continue;
    }

    if (!current) continue;

    const indexMatch = line.match(/^INDEX\s+(\d+)\s+(\d+):(\d+):(\d+)/i);
    if (indexMatch) {
      current.indexes.push({
        id: parseInt(indexMatch[1], 10),
        msf: [
          parseInt(indexMatch[2], 10),
          parseInt(indexMatch[3], 10),
          parseInt(indexMatch[4], 10),
        ],
      });
      continue;
    }

    const pregapMatch = line.match(/^PREGAP\s+(\d+):(\d+):(\d+)/i);
    if (pregapMatch) {
      current.pregap = msfToFrames([
        parseInt(pregapMatch[1], 10),
        parseInt(pregapMatch[2], 10),
        parseInt(pregapMatch[3], 10),
      ]);
    }
  }

  return { files, tracks };
}

/** Map CUE track type string to sector size in bytes. */
function sectorSizeForType(type) {
  if (type === 'MODE2/2352' || type === 'AUDIO') return 2352;
  if (type === 'MODE1/2048') return 2048;
  if (type === 'MODE2/2336') return 2336;
  return 2352; // default — most PS1 dumps are MODE2/2352
}

/** Convert [min, sec, frame] to absolute frame count. 1 sec = 75 frames. */
function msfToFrames(msf) {
  return msf[0] * 60 * 75 + msf[1] * 75 + msf[2];
}

/** Convert absolute frame count to [min, sec, frame]. */
function framesToMsf(frames) {
  const m = Math.floor(frames / (60 * 75));
  const s = Math.floor((frames % (60 * 75)) / 75);
  const f = frames % 75;
  return [m, s, f];
}
