# Third-Party Notices & Prior Art

This project's PS1-to-EBOOT (PBP) conversion is informed by the following
open-source projects and community documentation. No code is copied; these
serve as format references for a clean-room JavaScript implementation.

## Reference Implementations

### popstationr
- **Repository:** https://github.com/pseiler/popstationr
- **Language:** C
- **License:** GPL-2.0
- **Relevance:** Primary reference for PSISOIMG0000 header layout, ISO block
  compression (0x9300-byte deflate blocks), index table format, STARTDAT
  structure, and PARAM.SFO construction. Only dependency is zlib.

### PSXPackager
- **Repository:** https://github.com/RupertAvery/PSXPackager
- **Language:** C#
- **License:** MIT
- **Relevance:** Reference for multi-disc PBP support via PSTITLEIMG0000
  wrapper, .m3u playlist handling, and PBP extraction/round-trip.

### iPoPS
- **Repository:** https://github.com/julianxhokaxhiu/iPoPS
- **Language:** Objective-C
- **License:** MIT
- **Relevance:** macOS native converter with clean structure for understanding
  the overall PBP construction flow.

### copstation
- **Repository:** https://github.com/PSP-Tools/copstation
- **Language:** C
- **Relevance:** Additional reference for the popstation format.

## Format Documentation

### PSDevWiki
- **PBP format:** https://www.psdevwiki.com/ps3/Eboot.PBP
- **PSISOIMG0000:** https://www.psdevwiki.com/ps3/PSISOIMG0000
- **POPS (PS1 emulator on PSP):** https://www.psdevwiki.com/psp/POPS

## Libraries Used

### pako
- **Version:** 2.1.0
- **Vendored:** Readable source in `vendor/pako/`, entry point `vendor/zlib.cjs`
- **Repository:** https://github.com/nodeca/pako
- **License:** MIT AND Zlib
- **Usage:** RFC 1951 raw deflate and inflate for PSISOIMG block compression,
  CSO block compression, and decompression. Bundled and minified at build time
  by esbuild.

## LZ4 Block Format
The LZ4 block compress/decompress in this project is a clean-room
implementation based on the public LZ4 block format specification:
https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
