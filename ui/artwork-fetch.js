// ── psx-artwork GitHub 저장소에서 아트워크 가져오기 ─────────────────────────
//
// 선택적 기능: "디스크 ID로 아트워크 가져오기"가 체크되면, GitHub 호스팅
// 아트워크 저장소에서 커버 아트, 타이틀 화면, 스크린샷을 가져옵니다.
// 각 이미지 타입은 자체 백엔드(URL 패턴)를 가지며 이미지가 없는 경우
// 정상적으로 실패합니다 (404 → null, 오류 없음).
//
// 저장소 구조: {category}/{prefix}/{digits}/{serial}.jpg
// 예시: covers/SLUS/008/SLUS-00896.jpg

const ARTWORK_REPO_OWNER = 'jamescook';

/** 압축된 디스크 ID("SLUS00896")를 하이픈 형식("SLUS-00896")으로 변환합니다. */
function formatDiscIdForUrl(discId) {
  if (discId.length >= 5 && discId[4] !== '-') {
    return discId.slice(0, 4) + '-' + discId.slice(4);
  }
  return discId;
}

// psx-artwork 저장소 URL을 빌드합니다. 디렉터리 구조:
//   {category}/{prefix}/{digits}/{serial}.jpg
// 예: covers/SLUS/008/SLUS-00896.jpg
function psxArtworkUrl(category, discId) {
  const serial = formatDiscIdForUrl(discId);
  const [prefix, num] = serial.split('-');
  const digits = num.substring(0, 3);
  return `https://raw.githubusercontent.com/${ARTWORK_REPO_OWNER}/psx-artwork/main/${category}/${prefix}/${digits}/${serial}.jpg`;
}

// 각 이미지 타입은 자체 제공자(URL 패턴)를 가지며 독립적으로 교체할 수 있습니다.
const ARTWORK_BACKENDS = {
  icon0: {
    name: 'PSX Artwork — covers',
    url: (discId) => psxArtworkUrl('covers', discId),
  },
  pic0: {
    name: 'PSX Artwork — titles',
    url: (discId) => psxArtworkUrl('titles', discId),
  },
  pic1: {
    name: 'PSX Artwork — screenshots',
    url: (discId) => psxArtworkUrl('screenshots', discId),
  },
};

let _artworkFetcher = null; // null = 전역 fetch 사용

function setArtworkBackend(imageType, provider) { ARTWORK_BACKENDS[imageType] = provider; }
function setArtworkFetcher(fn) { _artworkFetcher = fn; }

// 단일 이미지 타입을 가져옵니다. Uint8Array 또는 null을 반환합니다.
async function fetchArtworkImage(imageType, discId) {
  if (!discId) return null;
  const backend = ARTWORK_BACKENDS[imageType];
  if (!backend) return null;
  try {
    const doFetch = _artworkFetcher || globalThis.fetch;
    const resp = await doFetch(backend.url(discId));
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

// 세 가지 이미지 타입 모두 병렬로 가져옵니다. { icon0, pic0, pic1 }을 반환하며,
// 각각 Uint8Array 또는 null입니다.
async function fetchAllArtwork(discId) {
  if (!discId) return { icon0: null, pic0: null, pic1: null };
  const [icon0, pic0, pic1] = await Promise.all([
    fetchArtworkImage('icon0', discId),
    fetchArtworkImage('pic0', discId),
    fetchArtworkImage('pic1', discId),
  ]);
  return { icon0, pic0, pic1 };
}
