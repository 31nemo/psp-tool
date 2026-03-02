// ── Artwork fetching from psx-artwork GitHub repo ───────────────────────────
//
// Opt-in feature: when "Fetch artwork by disc ID" is checked, fetches cover
// art, title screens, and screenshots from a GitHub-hosted artwork repository.
// Each image type has its own backend (URL pattern) and fails gracefully if
// the image doesn't exist (404 → null, no error).
//
// Repository structure: {category}/{prefix}/{digits}/{serial}.jpg
// Example: covers/SLUS/008/SLUS-00896.jpg

const ARTWORK_REPO_OWNER = 'jamescook';

/** Convert compact disc ID ("SLUS00896") to hyphenated form ("SLUS-00896"). */
function formatDiscIdForUrl(discId) {
  if (discId.length >= 5 && discId[4] !== '-') {
    return discId.slice(0, 4) + '-' + discId.slice(4);
  }
  return discId;
}

// Build a psx-artwork repo URL. Directory structure:
//   {category}/{prefix}/{digits}/{serial}.jpg
// e.g. covers/SLUS/008/SLUS-00896.jpg
function psxArtworkUrl(category, discId) {
  const serial = formatDiscIdForUrl(discId);
  const [prefix, num] = serial.split('-');
  const digits = num.substring(0, 3);
  return `https://raw.githubusercontent.com/${ARTWORK_REPO_OWNER}/psx-artwork/main/${category}/${prefix}/${digits}/${serial}.jpg`;
}

// Each image type has its own provider (URL pattern) and can be swapped independently.
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

let _artworkFetcher = null; // null = use global fetch

function setArtworkBackend(imageType, provider) { ARTWORK_BACKENDS[imageType] = provider; }
function setArtworkFetcher(fn) { _artworkFetcher = fn; }

// Fetch a single image type. Returns Uint8Array or null.
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

// Fetch all three image types in parallel. Returns { icon0, pic0, pic1 },
// each either Uint8Array or null.
async function fetchAllArtwork(discId) {
  if (!discId) return { icon0: null, pic0: null, pic1: null };
  const [icon0, pic0, pic1] = await Promise.all([
    fetchArtworkImage('icon0', discId),
    fetchArtworkImage('pic0', discId),
    fetchArtworkImage('pic1', discId),
  ]);
  return { icon0, pic0, pic1 };
}
