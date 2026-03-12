# PSP Toolkit

PSP 및 PS1 디스크 이미지를 변환하는 브라우저 기반 도구입니다. 모든 처리는 클라이언트에서 실행되며, 서버나 업로드가 없어 파일이 내 컴퓨터 밖으로 나가지 않습니다.

## 기능

### CSO / ZSO / ISO 변환
PSP 디스크 이미지를 드래그하여 포맷 간 변환:
- **CSO** — deflate 압축 (용량 작음, PSP에서 로딩 속도 느림)
- **ZSO** — LZ4 압축 (용량 약간 크지만 PSP에서 로딩 속도 빠름)
- **ISO** — 비압축 (용량 가장 큼, 압축 해제 오버헤드 없음)

6가지 변환 경로 모두 지원: CSO↔ISO, ZSO↔ISO, CSO↔ZSO

### PS1 → EBOOT.PBP
PS1 디스크 이미지(.bin/.iso, .cue 유무 무관)를 드래그하여 PSP 호환 EBOOT.PBP 생성:
- SYSTEM.CNF에서 디스크 ID, ISO 볼륨 ID에서 타이틀 자동 감지 (없으면 파일명 사용)
- 멀티 디스크 지원 (최대 5장)
- CUE/BIN 페어링 — CUE+BIN 파일을 함께 드래그하거나, CUE 먼저 BIN 나중에 드래그 가능
- 압축 레벨 설정 (0–9)
- 커스텀 아트워크 — ICON0/PIC0/PIC1 미리보기를 클릭하여 직접 이미지 업로드, 또는 자동 생성 타이틀 아트 사용
- 디스크 ID가 감지되면 커뮤니티 커버 데이터베이스에서 아트워크 자동 가져오기 (네트워크 필요, 기본 OFF)
- PSP-3000 + ARK-4 커스텀 펌웨어 환경에서 테스트 완료

## 사용법

[최신 릴리즈](../../releases/latest)에서 `index.html`을 다운로드하여 브라우저로 열기만 하면 됩니다. 단일 파일, 설치 불필요, 서버 불필요.

### 소스에서 빌드

```sh
npm install
node build.js
open dist/index.html
```

### 테스트

```sh
npm test                    # 유닛 테스트 (node:test)
npm run test:e2e            # Playwright E2E 테스트 (로컬 Chromium + Firefox)
npm run test:e2e:docker     # Docker에서 E2E 테스트 (CI 환경과 동일)
npm run test:e2e:update     # 스크린샷 기준선 업데이트
```

## 동작 원리

- **Web Worker**가 모든 압축을 메인 스레드 밖에서 처리하므로 1GB 이상의 파일에서도 UI가 멈추지 않음
- **pako 2.1.0** — deflateRaw / inflateRaw 처리
- **LZ4** 블록 압축/해제를 JS로 직접 구현
- PS1 EBOOT 구성은 PSISOIMG0000 포맷을 따름: 디스크 이미지의 0x9300바이트 블록을 각각 독립적으로 deflate 압축하고, 랜덤 접근을 위한 인덱스 테이블 포함

## 파일 구조

```
app.html                — 메인 HTML 셸
style.css               — 다크 테마 스타일
build.js                — dist/index.html 생성 (단일 파일 빌드)
worker.js               — CSO/ZSO/ISO 변환용 Web Worker
cso-compress-worker.js  — CSO/ZSO 병렬 압축용 Web Worker
eboot-worker.js         — EBOOT.PBP 생성용 Web Worker
compress-worker.js      — EBOOT 병렬 압축용 Web Worker
Dockerfile.test         — CI/E2E 테스트용 Docker 이미지
playwright.config.js    — Playwright E2E 설정
ui/
  artwork.js            — EBOOT 아트워크 생성 (ICON0/PIC0/PIC1)
  shared.js             — 공통 유틸리티, 디스크 감지, CUE 파싱
  convert.js            — CSO/ZSO/ISO 변환 UI
  eboot-ui.js           — EBOOT 빌더 UI
  diagnose.js           — EBOOT 진단/검사 UI
  pbp-editor.js         — PBP 편집기 UI
eboot/
  assembler.js          — PBP 생성 오케스트레이터
  pbp.js                — PBP 컨테이너 헤더 생성
  sfo.js                — PARAM.SFO 빌더
  psisoimg.js           — 단일 디스크 PSAR 압축
  pstitleimg.js         — 멀티 디스크 PSAR 래퍼
  toc.js                — CD 목차(TOC) 생성
  cue.js                — CUE 시트 파서
  discid.js             — ISO9660에서 디스크 ID 자동 감지
  assets.js             — 정적 펌웨어 블롭 (DATA.PSP ELF, STARTDAT)
vendor/
  zlib.cjs              — deflateRaw + inflateRaw (pako 2.1.0, esbuild 번들)
test/
  e2e/convert.spec.js   — 변환 탭 Playwright E2E 테스트
  fixtures/test.iso     — 공용 합성 ISO 픽스처 (64KB)
scripts/
  generate-e2e-fixture.js   — test/fixtures/test.iso 생성
  compare-eboots.cjs        — 진단: EBOOT 구조 비교
tools/
  inspect-eboot.js      — EBOOT 구조 검사 도구
```

## 참고 프로젝트

이 프로젝트의 EBOOT 포맷 구현은 여러 오픈소스 프로젝트를 참고했습니다. 자세한 내용은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참조하세요.

## 라이선스

MIT
