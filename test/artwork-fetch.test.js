import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'artwork-fetch.js'), 'utf8');

const FIXTURE_JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02, 0xFF, 0xD9]);
const FIXTURE_PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function createContext() {
  const ctx = vm.createContext({ globalThis: {}, Uint8Array, Promise, console });
  vm.runInContext(src, ctx);
  return ctx;
}

function mockFetcher(ctx, responseMap) {
  ctx._responseMap = responseMap;
  vm.runInContext(`
    setArtworkFetcher(async (url) => {
      const entry = _responseMap[url];
      if (!entry) return { ok: false, status: 404 };
      return {
        ok: true,
        arrayBuffer: async () => entry.buffer.slice(
          entry.byteOffset, entry.byteOffset + entry.byteLength
        ),
      };
    });
  `, ctx);
}

describe('formatDiscIdForUrl', () => {
  it('inserts hyphen into unhyphenated disc ID', () => {
    const ctx = createContext();
    assert.equal(vm.runInContext('formatDiscIdForUrl("SLUS00896")', ctx), 'SLUS-00896');
  });

  it('leaves already-hyphenated disc ID unchanged', () => {
    const ctx = createContext();
    assert.equal(vm.runInContext('formatDiscIdForUrl("SLUS-00896")', ctx), 'SLUS-00896');
  });

  it('handles SCUS prefix', () => {
    const ctx = createContext();
    assert.equal(vm.runInContext('formatDiscIdForUrl("SCUS94163")', ctx), 'SCUS-94163');
  });
});

describe('psxArtworkUrl', () => {
  let ctx;
  beforeEach(() => { ctx = createContext(); });

  it('builds sharded path from unhyphenated serial', () => {
    const url = vm.runInContext('psxArtworkUrl("covers", "SLUS00896")', ctx);
    assert.ok(url.endsWith('/covers/SLUS/008/SLUS-00896.jpg'));
  });

  it('builds sharded path from hyphenated serial', () => {
    const url = vm.runInContext('psxArtworkUrl("screenshots", "SCES-00344")', ctx);
    assert.ok(url.endsWith('/screenshots/SCES/003/SCES-00344.jpg'));
  });

  it('handles SCUS serial', () => {
    const url = vm.runInContext('psxArtworkUrl("titles", "SCUS94163")', ctx);
    assert.ok(url.endsWith('/titles/SCUS/941/SCUS-94163.jpg'));
  });
});

describe('fetchArtworkImage', () => {
  let ctx;
  beforeEach(() => { ctx = createContext(); });

  it('returns null for empty discId', async () => {
    assert.equal(await vm.runInContext('fetchArtworkImage("icon0", "")', ctx), null);
  });

  it('returns null for unknown image type', async () => {
    assert.equal(await vm.runInContext('fetchArtworkImage("bogus", "SLUS00896")', ctx), null);
  });

  it('fetches icon0 from covers backend with sharded path', async () => {
    ctx._capturedUrl = '';
    vm.runInContext(`
      setArtworkFetcher(async (url) => { _capturedUrl = url; return { ok: false }; });
    `, ctx);
    await vm.runInContext('fetchArtworkImage("icon0", "SLUS00896")', ctx);
    assert.ok(ctx._capturedUrl.includes('/covers/SLUS/008/SLUS-00896.jpg'),
      `Expected sharded covers path, got: ${ctx._capturedUrl}`);
  });

  it('fetches pic0 from titles backend with sharded path', async () => {
    ctx._capturedUrl = '';
    vm.runInContext(`
      setArtworkFetcher(async (url) => { _capturedUrl = url; return { ok: false }; });
    `, ctx);
    await vm.runInContext('fetchArtworkImage("pic0", "SLUS00896")', ctx);
    assert.ok(ctx._capturedUrl.includes('/titles/SLUS/008/SLUS-00896.jpg'),
      `Expected sharded titles path, got: ${ctx._capturedUrl}`);
  });

  it('fetches pic1 from screenshots backend with sharded path', async () => {
    ctx._capturedUrl = '';
    vm.runInContext(`
      setArtworkFetcher(async (url) => { _capturedUrl = url; return { ok: false }; });
    `, ctx);
    await vm.runInContext('fetchArtworkImage("pic1", "SLUS00896")', ctx);
    assert.ok(ctx._capturedUrl.includes('/screenshots/SLUS/008/SLUS-00896.jpg'),
      `Expected sharded screenshots path, got: ${ctx._capturedUrl}`);
  });

  it('returns Uint8Array on success', async () => {
    ctx._fixture = FIXTURE_JPEG;
    vm.runInContext(`
      setArtworkFetcher(async () => ({
        ok: true,
        arrayBuffer: async () => _fixture.buffer.slice(
          _fixture.byteOffset, _fixture.byteOffset + _fixture.byteLength
        ),
      }));
    `, ctx);
    const result = await vm.runInContext('fetchArtworkImage("icon0", "SCUS94163")', ctx);
    assert.ok(result instanceof Uint8Array);
    assert.equal(result.length, FIXTURE_JPEG.length);
  });

  it('returns null on 404', async () => {
    vm.runInContext('setArtworkFetcher(async () => ({ ok: false, status: 404 }));', ctx);
    assert.equal(await vm.runInContext('fetchArtworkImage("icon0", "XXXX99999")', ctx), null);
  });

  it('returns null on network error', async () => {
    vm.runInContext('setArtworkFetcher(async () => { throw new Error("fail"); });', ctx);
    assert.equal(await vm.runInContext('fetchArtworkImage("icon0", "SCUS94163")', ctx), null);
  });
});

describe('setArtworkBackend', () => {
  it('overrides a single image type backend', async () => {
    const ctx = createContext();
    ctx._capturedUrl = '';
    vm.runInContext(`
      setArtworkBackend('icon0', {
        name: 'Custom',
        url: (id) => 'https://custom.example/' + id + '.webp',
      });
      setArtworkFetcher(async (url) => { _capturedUrl = url; return { ok: false }; });
    `, ctx);
    await vm.runInContext('fetchArtworkImage("icon0", "SLUS00896")', ctx);
    assert.equal(ctx._capturedUrl, 'https://custom.example/SLUS00896.webp');
  });

  it('does not affect other image types', async () => {
    const ctx = createContext();
    ctx._capturedUrl = '';
    vm.runInContext(`
      setArtworkBackend('icon0', {
        name: 'Custom',
        url: (id) => 'https://custom.example/' + id,
      });
      setArtworkFetcher(async (url) => { _capturedUrl = url; return { ok: false }; });
    `, ctx);
    await vm.runInContext('fetchArtworkImage("pic1", "SLUS00896")', ctx);
    assert.ok(ctx._capturedUrl.includes('/screenshots/SLUS/008/SLUS-00896.jpg'),
      'pic1 should still use default backend');
  });
});

describe('fetchAllArtwork', () => {
  it('returns all nulls for empty discId', async () => {
    const ctx = createContext();
    const result = await vm.runInContext('fetchAllArtwork("")', ctx);
    assert.equal(result.icon0, null);
    assert.equal(result.pic0, null);
    assert.equal(result.pic1, null);
  });

  it('fetches all three types in parallel', async () => {
    const ctx = createContext();
    ctx._urls = [];
    ctx._fixture = FIXTURE_JPEG;
    vm.runInContext(`
      setArtworkFetcher(async (url) => {
        _urls.push(url);
        return {
          ok: true,
          arrayBuffer: async () => _fixture.buffer.slice(
            _fixture.byteOffset, _fixture.byteOffset + _fixture.byteLength
          ),
        };
      });
    `, ctx);
    const result = await vm.runInContext('fetchAllArtwork("SLUS00896")', ctx);
    assert.ok(result.icon0 instanceof Uint8Array);
    assert.ok(result.pic0 instanceof Uint8Array);
    assert.ok(result.pic1 instanceof Uint8Array);
    assert.equal(ctx._urls.length, 3);
  });

  it('returns null per-type on individual 404s', async () => {
    const ctx = createContext();
    ctx._fixture = FIXTURE_JPEG;
    vm.runInContext(`
      setArtworkFetcher(async (url) => {
        if (url.includes('/titles/')) return { ok: false, status: 404 };
        return {
          ok: true,
          arrayBuffer: async () => _fixture.buffer.slice(
            _fixture.byteOffset, _fixture.byteOffset + _fixture.byteLength
          ),
        };
      });
    `, ctx);
    const result = await vm.runInContext('fetchAllArtwork("SLUS00896")', ctx);
    assert.ok(result.icon0 instanceof Uint8Array, 'icon0 should succeed');
    assert.equal(result.pic0, null, 'pic0 (titles) should be null on 404');
    assert.ok(result.pic1 instanceof Uint8Array, 'pic1 should succeed');
  });
});
