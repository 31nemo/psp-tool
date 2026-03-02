# EBOOT.PBP Format Reference

A byte-level reference for building PS1-on-PSP EBOOT.PBP files. Derived from
pop-fe (Python), popstationr (C), beetle-psx-libretro (C++ reader), PSXPackager
(C#), PSDevWiki documentation, and binary analysis of Sony PSN EBOOTs.

---

## 1. High-Level Overview

An EBOOT.PBP is a PBP container holding a compressed PS1 disc image that Sony's
**POPS** (PlayStation One PS Portable Station) emulator can boot on PSP hardware.

The pipeline is:

```
PS1 disc image (.bin/.iso)
  -> compress into PSISOIMG0000 section (one per disc)
  -> wrap in PSTITLEIMG0000 if multi-disc (or single-disc, pop-fe does both)
  -> embed in PBP container with SFO metadata + DATA.PSP firmware blob
  -> output EBOOT.PBP
```

---

## 2. PSISOIMG Layout Variants

**Two known PSISOIMG layout variants exist.** This is the most important thing
to understand. Using the wrong one will produce EBOOTs that fail to boot.

### pop-fe / Sony PSN variant (RECOMMENDED)

Used by: pop-fe, Sony PlayStation Store downloads, PSX2PSP
Tested with: ARK-4 CFW (recommended by ARK-4 wiki), official firmware

The header is organized as **1024-byte blocks**:

```
Offset      Size        Content
------      ----        -------
Block 1 (0x000 - 0x3FF):
  0x0000    12          Magic "PSISOIMG0000"
  0x000C    4           p1_offset (LE uint32) — see below
  0x0010    0x3F0       zeros (reserved)

Block 2 (0x400 - 0x7FF):
  0x0400    11          Disc ID string: "_SLUS_00896" format
  0x0420    variable    POPS config data (optional, for per-game fixes)
  rest                  zeros

Block 3 (0x800 - 0xBFF):
  0x0800    variable    TOC data (see Section 6)
  0x0BFC    4           Disc start offset = 0x100000 (LE uint32)

Block 4 (0xC00 - 0x11FF):
  0x0C00    1568        Audio tracks table (for CDDA/AT3 tracks, or zeros)

Block 5 (~0x1200 - ~0x13FF):
  +0x0000   4           p2_offset (LE uint32) — see below
  +0x0008   2           bytes 0xFF 0x07
  +0x000C   128         Game title string (UTF-8, null-terminated)
  +0x0090   4           Magic word (optional, for copy protection)

Blocks 6-16:
  ~0x1400   11264       zeros (padding)

Index table:
  variable  32*N        Index entries (one per block, see Section 7)

Padding:
  ...       ...         zeros up to 0x100000

ISO data:
  0x100000  variable    Compressed blocks (deflate-raw)

After ISO data:
  variable              STARTDAT section (header + footer)
```

### popstationr variant (NOT RECOMMENDED)

Used by: popstationr, copstation
**Not tested with ARK-4.** May work on older CFW (PRO, ME) but not reliable.

Uses fixed binary templates (data1/data2) from popstationr source:

```
Offset      Size        Content
------      ----        -------
0x0000      0xE20       data1 template (3616 bytes)
  [0x0000]  12            overwritten: Magic "PSISOIMG0000"
  [0x000C]  4             overwritten: p1_offset
  [0x0010]  0x3F0         zeros (reserved)
  [0x0400]  ~40           TOC data (NOTE: different offset than pop-fe!)
0x0E20      4           p2_offset
0x0E24      0x2DDC      data2 template (11740 bytes)
  +0x0008                 Game title string
0x3C00      variable    Index table (32 bytes per block)
...         ...         zero padding to 0x100000
0x100000    variable    Compressed blocks
after ISO   variable    STARTDAT section
```

### Key Differences Summary

| Feature          | pop-fe (recommended)       | popstationr               |
|------------------|---------------------------|---------------------------|
| Disc ID location | +0x400                    | Not written (template)    |
| TOC location     | +0x800                    | +0x400                    |
| Index location   | Dynamic (after block 16)  | Fixed at 0x3C00           |
| Index size field | uint16 at bytes 4-5       | uint32 at bytes 4-7       |
| Index SHA-1      | 16 bytes at bytes 8-23    | zeros                     |
| p1 value         | compressedTotal + 0x100000 (single-disc) or uncompressedTotal + 0x100000 (multi-disc) | compressedTotal + 0x100000 |
| p2 value         | 0 (always)                | 0 (always)                |
| Title location   | Block 5 at +0x0C          | data2 at +0x08            |
| Audio track tbl  | Block 4 (0xC00)           | Not present               |
| Config injection | Block 2 at +0x20          | Not supported             |

---

## 3. PBP Container

### Header (0x28 = 40 bytes)

| Offset | Size | Field          | Value                       |
|--------|------|----------------|-----------------------------|
| 0x00   | 4    | Magic          | `\x00PBP`                   |
| 0x04   | 4    | Version        | `0x00010000` (1.0)          |
| 0x08   | 4    | PARAM.SFO off  | Always 0x28                 |
| 0x0C   | 4    | ICON0.PNG off  |                             |
| 0x10   | 4    | ICON1.PMF off  |                             |
| 0x14   | 4    | PIC0.PNG off   |                             |
| 0x18   | 4    | PIC1.PNG off   |                             |
| 0x1C   | 4    | SND0.AT3 off   |                             |
| 0x20   | 4    | DATA.PSP off   |                             |
| 0x24   | 4    | DATA.PSAR off  | **Must be 0x10000-aligned** |

All offsets are absolute from file start, little-endian uint32. Sections with
no data have the same offset as the next section (zero-length).

### PSAR Alignment

DATA.PSAR **must** start on a 0x10000 (64 KB) boundary. The gap between
DATA.PSP's end and this boundary is zero-padded. This alignment is critical
for PSP firmware to locate the PSAR correctly.

---

## 4. PARAM.SFO

Standard PSF (PlayStation Format) key-value store.

### Header (20 bytes)

| Offset | Size | Field            | Value            |
|--------|------|------------------|------------------|
| 0x00   | 4    | Magic            | `\x00PSF`        |
| 0x04   | 4    | Version          | `0x00000101`     |
| 0x08   | 4    | Key table offset |                  |
| 0x0C   | 4    | Data table offset|                  |
| 0x10   | 4    | Entry count      |                  |

### Index Entry (16 bytes each)

| Offset | Size | Field          |
|--------|------|----------------|
| 0x00   | 2    | Key offset     |
| 0x02   | 2    | Data type      |
| 0x04   | 4    | Data used size |
| 0x08   | 4    | Data max size  |
| 0x0C   | 4    | Data offset    |

Data types: `0x0004` = UTF8S (null-terminated string, no padding),
`0x0204` = UTF8 (padded to max size with zeros), `0x0404` = INT32.

### Required Fields for PS1 EBOOT

| Key             | Type   | Value                | Max Size | Notes                        |
|-----------------|--------|----------------------|----------|------------------------------|
| BOOTABLE        | INT32  | 1                    | 4        |                              |
| CATEGORY        | UTF8   | `ME`                 | 4        | "ME" = PS1 game (POPS)       |
| DISC_ID         | UTF8   | e.g. `SCUS94163`    | 16       | No underscore formatting     |
| DISC_VERSION    | UTF8   | `1.00`               | 8        |                              |
| DISC_TOTAL      | INT32  | n                    | 4        | Only if multi-disc           |
| LICENSE         | UTF8   | (see below)          | 512      | Copyright string             |
| PARENTAL_LEVEL  | INT32  | 3                    | 4        | PSN store attribute          |
| PSP_SYSTEM_VER  | UTF8   | `3.01`               | 8        | Minimum FW version           |
| REGION          | INT32  | `0x8000`             | 4        | 0x8000 = worldwide           |
| TITLE           | UTF8   | Game title           | 128      |                              |

**LICENSE string:** `Copyright(C) Sony Computer Entertainment America Inc.`

**All string fields use type UTF8 (0x0204)**, which pads to max size with
zeros. This matches Sony PSN and pop-fe output. Using UTF8S (0x0004) for
string fields produces non-standard SFO that may cause compatibility issues.

Keys must be in **alphabetical order** per PSF spec.

---

## 5. PSISOIMG0000 — pop-fe Layout (Detailed)

This section documents the pop-fe layout which is what we implement.

### Critical Constants

| Name          | Value      | Meaning                                      |
|---------------|------------|----------------------------------------------|
| ISO_DATA_BASE | 0x100000   | Compressed ISO blocks always start here       |
| BLOCK_SIZE    | 0x9300     | 37,632 bytes per uncompressed block           |
| INDEX_ENTRY   | 32 bytes   | Per-block index entry                         |

### p1_offset (offset 0x0C, 4 bytes LE)

For single-disc EBOOTs: `compressedTotal + 0x100000` — the end of compressed
ISO data relative to PSISOIMG start. Points to where STARTDAT begins.

For multi-disc EBOOTs: `uncompressedTotal + 0x100000` — as if the data were
uncompressed. This is the convention used by Sony PSN multi-disc releases.

Some tools (e.g. pop-fe) may 16-byte align this value. The PSP firmware does
not appear to use this field for block decompression (the index table is used
instead), so either convention works.

### p2_offset (Block 5, byte 0, 4 bytes LE)

Always 0 in all Sony PSN reference EBOOTs examined (single and multi-disc).
The `p1 + 0x2D31` formula found in some tools (popstationr) does not match
real-world Sony output.

### Disc ID (Block 2, offset 0x400)

Formatted as `_SLUS_00896` — underscore prefix, underscore between region
code and number. 11 bytes, null-terminated.

### TOC (Block 3, offset 0x800)

See Section 6 for the entry format. Additionally, at offset 0xBFC within
PSISOIMG (end of block 3), a uint32 LE value of 0x100000 is written as the
disc start offset.

### Index Table

Starts after block 16 (after all header padding). Position is dynamic based
on header size. Each entry is 32 bytes:

| Entry Offset | Size | Field       | Notes                                    |
|-------------|------|-------------|------------------------------------------|
| 0x00        | 4    | offset      | Relative to ISO_DATA_BASE (0x100000)     |
| 0x04        | 2    | length      | **uint16 LE** — compressed block size    |
| 0x06        | 2    | flags       | 0x01 for uncompressed (PS3), else 0x00   |
| 0x08        | 16   | SHA-1       | First 16 bytes of SHA-1 of uncompressed block |
| 0x18        | 8    | padding     | zeros                                    |

**Important:** The size field is **uint16**, not uint32. This limits the max
compressed block size to 65535, which is always sufficient since blocks are
0x9300 (37,632) bytes uncompressed and compression only makes them smaller.

If `length == 0x9300`, the block is stored uncompressed.

### ISO Data (offset 0x100000)

All compressed/uncompressed block data starts at this fixed offset. The gap
between the end of the index table and 0x100000 is zero-padded.

### STARTDAT (after ISO data)

Immediately follows the last compressed block:
- 80-byte header (`STARTDAT` magic at offset 0)
- Footer blob (variable size, ~5KB from popstationr)

The p1_offset at 0x000C points to the start of STARTDAT relative to PSISOIMG.

---

## 6. PSTITLEIMG0000 (Multi-Disc Wrapper)

Used when the game has multiple discs (e.g., Final Fantasy VII = 3 discs).
pop-fe also wraps single-disc games in PSTITLEIMG.

### Header (0x400 = 1024 bytes)

| Offset | Size | Field             |
|--------|------|-------------------|
| 0x000  | 14   | Magic: `PSTITLEIMG0000` |
| 0x00E  | 0x1F2| Reserved zeros    |
| 0x200  | 4    | Disc 1 offset     |
| 0x204  | 4    | Disc 2 offset     |
| 0x208  | 4    | Disc 3 offset     |
| ...    | 4    | Up to 5 discs     |

Offsets are relative to the start of PSTITLEIMG (i.e., start of DATA.PSAR).
Each points to the beginning of a PSISOIMG0000 section.

First disc offset is always 0x400 (immediately after the PSTITLEIMG header).
Subsequent disc offsets = previous offset + previous PSISOIMG section size.

The offset table is zero-terminated (a 0x00000000 entry after the last disc).

---

## 7. TOC Format

In the pop-fe layout, the TOC lives at offset **0x0800** within PSISOIMG
(Block 3).

### Entry Format (10 bytes each)

| Byte | Field     | Notes                              |
|------|-----------|------------------------------------|
| 0    | ADR/Ctrl  | 0x41 = data track, 0x01 = audio    |
| 1    | TNO       | Always 0x00                        |
| 2    | Point     | Track number or special (A0/A1/A2) |
| 3    | AMin      | 0 (for single-session)             |
| 4    | ASec      | 0                                  |
| 5    | AFrame    | 0                                  |
| 6    | Reserved  | 0                                  |
| 7    | PMin      | BCD minute                         |
| 8    | PSec      | BCD second                         |
| 9    | PFrame    | BCD frame (1/75th sec)             |

### Special Entries

| Point | Meaning     | PMIN             | PSEC  | PFRAME |
|-------|-------------|------------------|-------|--------|
| 0xA0  | First track | BCD track number | **0x20** | 0x00   |
| 0xA1  | Last track  | BCD track number | 0x00  | 0x00   |
| 0xA2  | Lead-out    | BCD M            | BCD S | BCD F  |

**A0 PSEC = 0x20:** This indicates Mode 2 (XA). This is a raw constant, **not
a BCD value**. 0x20 means Mode 2; 0x00 means Mode 1. PS1 games are Mode 2.

### Track Entries

Each track gets one entry with Point = BCD track number, PMIN/PSEC/PFRAME =
BCD MSF of the track start (including 150-frame / 2-second lead-in offset).

### MSF to Frames Conversion

```
frames = minutes * 60 * 75 + seconds * 75 + frame_number
```

Track 1 data starts at MSF 00:02:00 (= 150 frames, the standard lead-in).

---

## 8. Compression

Each ISO block (0x9300 = 37,632 bytes) is independently compressed using
**raw deflate** (RFC 1951, no zlib/gzip wrapper — no header, no checksum).

The deflate implementation must produce **valid RFC 1951 output** that any
standard inflate can decompress. POPS (Sony's PS1 emulator on PSP) uses a
standard zlib-compatible inflate internally. Any conformant deflate encoder
works — fixed Huffman (BTYPE=1), dynamic Huffman (BTYPE=2), and stored blocks
(BTYPE=0) are all valid.

This project uses **pako 2.1.0** (a faithful JS port of zlib) for both
deflateRaw and inflateRaw. The pako source lives in `vendor/pako/` and is
bundled by esbuild into a self-contained IIFE at build time.

### Raw Deflate from zlib-Wrapped Output

pop-fe and other Python implementations use `zlib.compress()` and then strip
the 2-byte zlib header and 4-byte Adler-32 trailer to get raw deflate:

```python
compressed = zlib.compress(block, level)
raw_deflate = compressed[2:-4]  # strip zlib header + checksum
```

Equivalently, `deflateRaw()` from pako/zlib produces raw deflate directly
without the wrapper.

### Block Storage

If compression does not reduce the block size (compressed >= 0x9300), the
block is stored uncompressed and the index entry's length field is set to
0x9300. In practice, a conformant zlib encoder at level 6+ compresses all
real disc data — uncompressed blocks should not occur with well-formed input.

### Offset Calculation

Offsets in the index table are cumulative from 0:

```
block[0].offset = 0
block[1].offset = block[0].length
block[2].offset = block[0].length + block[1].length
...
```

The POPS emulator computes absolute position as:
`psisoimg_base + 0x100000 + index_entry.offset`

---

## Sources

- **pop-fe**: https://github.com/sahlberg/pop-fe
  - Python implementation. Recommended by ARK-4 CFW wiki. Uses 1024-byte
    block layout with disc ID at +0x400, TOC at +0x800, uint16 index sizes,
    SHA-1 hashes in index entries.
  - `popstation.py`: complete PSISOIMG assembly logic.
- **ARK-4 Wiki**: https://github.com/PSP-Archive/ARK-4/wiki/PS1-Playback
  - Confirms pop-fe as the recommended tool for PS1 EBOOT creation.
- **popstationr** (GPL-2.0): https://github.com/pseiler/popstationr
  - Older C implementation. Uses data1/data2 binary templates, different
    offsets. Not recommended for modern CFW.
- **copstation**: https://github.com/PSP-Tools/copstation
  - C implementation, ancestor of popstationr. Same layout.
- **beetle-psx-libretro**: `mednafen/cdrom/CDAccess_PBP.cpp`
  - Reference reader. Confirms 0x100000 ISO data base, index semantics.
- **PSXPackager**: https://github.com/RupertAvery/PSXPackager
  - C# implementation for cross-reference.
- **PSDevWiki**:
  - POPS: https://psdevwiki.com/psp/POPS (compatibility flags)
  - Eboot.PBP: https://psdevwiki.com/ps3/Eboot.PBP (PBP container format)
- **GBAtemp POPS Research**: https://gbatemp.net/threads/607286/
  - Community research on POPS config injection offsets.
