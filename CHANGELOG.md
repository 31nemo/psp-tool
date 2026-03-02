# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-07

### Added

- CSO/ZSO/ISO conversion with all 6 paths (CSO↔ISO, ZSO↔ISO, CSO↔ZSO)
- Multi-threaded compression via Web Workers
- PS1 EBOOT.PBP builder with PSISOIMG0000 format
- Multi-disc support (up to 5 discs) with PSTITLEIMG wrapper
- CUE/BIN pairing and auto-detection
- Disc ID auto-detection from SYSTEM.CNF
- Title auto-detection from ISO volume ID with filename fallback
- Configurable compression level (0–9)
- Custom artwork support (ICON0/PIC0/PIC1) with click-to-upload
- Auto-generated title artwork
- Optional artwork auto-fetch from community covers database
- Single-file production build (dist/index.html, no server needed)
- E2E tests with Playwright (Chromium + Firefox) and visual regression
- Docker-based CI test pipeline
