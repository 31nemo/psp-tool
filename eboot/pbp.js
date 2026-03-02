// PBP (PlayStation Portable Binary Package) container writer
//
// PBP is an uncompressed archive format that bundles game metadata, artwork,
// audio, and data into a single EBOOT.PBP file. The PSP XMB reads it to
// display game entries.
//
// Format spec: https://www.psdevwiki.com/ps3/Eboot.PBP
//              https://www.psdevwiki.com/psp/PBP
//
// Layout:
//   [header 0x28 bytes] [PARAM.SFO] [ICON0] [ICON1] [PIC0] [PIC1] [SND0] [DATA.PSP] [padding] [DATA.PSAR]
//
// The header contains the magic, version, and 8 absolute offsets — one for each
// section. A section's size is implied by the gap to the next offset (or EOF
// for DATA.PSAR). Empty sections have the same offset as the next section.
//
// DATA.PSAR is aligned to a 0x10000 boundary, matching Sony PSN EBOOT layout.

const PBP_MAGIC = new Uint8Array([0x00, 0x50, 0x42, 0x50]); // "\0PBP"
const PBP_VERSION = 0x00010000; // Version 1.0
const PBP_HEADER_SIZE = 0x28; // 40 bytes: 4 magic + 4 version + 8×4 offsets

// Section indices in the offset table (order is fixed by the format)
const PBP_SECTIONS = {
  PARAM_SFO: 0, // Game metadata (title, disc ID, region, etc.)
  ICON0_PNG: 1, // 144×80 PNG icon shown on XMB
  ICON1_PMF: 2, // Animated icon (PMF video), replaces ICON0 on hover
  PIC0_PNG:  3, // 310×180 info overlay shown on game details screen
  PIC1_PNG:  4, // 480×272 background image behind PIC0
  SND0_AT3:  5, // ATRAC3 audio preview, plays on hover
  DATA_PSP:  6, // PSP ELF loader (boots the POPS PS1 emulator)
  DATA_PSAR: 7, // PlayStation ARchive — compressed PS1 disc image (PSISOIMG/PSTITLEIMG)
};

/**
 * Build a complete PBP file from its sections.
 *
 * Assembles the 40-byte header (magic + version + 8 offsets), then concatenates
 * all sections in order. Sections 1–5 (artwork/audio) are optional and default
 * to empty. DATA.PSAR is padded to a 0x10000-byte boundary.
 *
 * @param {Object} sections
 * @param {Uint8Array} sections.paramSfo  - PARAM.SFO metadata (from buildSFO)
 * @param {Uint8Array} [sections.icon0]   - 144×80 PNG icon
 * @param {Uint8Array} [sections.icon1]   - ICON1.PMF animated icon
 * @param {Uint8Array} [sections.pic0]    - 310×180 PNG info overlay
 * @param {Uint8Array} [sections.pic1]    - 480×272 PNG background
 * @param {Uint8Array} [sections.snd0]    - SND0.AT3 audio preview
 * @param {Uint8Array} sections.dataPsp   - DATA.PSP ELF (POPS loader)
 * @param {Uint8Array} sections.dataPsar  - DATA.PSAR (compressed disc image)
 * @returns {Uint8Array} Complete PBP file ready to write as EBOOT.PBP
 */
export function buildPBP(sections) {
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

  // Calculate offsets — each section starts immediately after the previous
  const offsets = new Array(8);
  let pos = PBP_HEADER_SIZE;
  for (let i = 0; i < 8; i++) {
    offsets[i] = pos;
    pos += parts[i].length;
  }

  // DATA.PSAR must be aligned to 0x10000 (64K) boundary.
  // Sony PSN EBOOTs always place PSAR at an aligned offset; firmware may
  // depend on this for DMA or sector-aligned reads.
  const psarAlign = 0x10000;
  const currentPsarOffset = offsets[7];
  const alignedPsarOffset = Math.ceil(currentPsarOffset / psarAlign) * psarAlign;
  const padding = alignedPsarOffset - currentPsarOffset;
  offsets[7] = alignedPsarOffset;

  const totalSize = alignedPsarOffset + parts[7].length;

  // Write header
  const result = new Uint8Array(totalSize);
  const dv = new DataView(result.buffer);

  result.set(PBP_MAGIC, 0);
  dv.setUint32(4, PBP_VERSION, true);
  for (let i = 0; i < 8; i++) {
    dv.setUint32(8 + i * 4, offsets[i], true);
  }

  // Write sections
  let writePos = PBP_HEADER_SIZE;
  for (let i = 0; i < 7; i++) {
    result.set(parts[i], writePos);
    writePos += parts[i].length;
  }
  // Skip padding, write PSAR at aligned offset
  result.set(parts[7], alignedPsarOffset);

  return result;
}
