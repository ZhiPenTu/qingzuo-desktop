import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MARKET_CACHE_MAX_AGE, MarketCatalogCache, readMarketCache } from '../../desktop/market-cache.mjs';
import { MarketCatalogStore } from '../../desktop/market-store.mjs';

const catalog = 'https://market.example/catalog.json';
const platform = 'darwin-arm64';
const apiVersion = '1.10.0';
const item = { id: 'official.fixture', version: '0.1.0', title: '工具', description: '说明', tier: 'official', official: true, compatible: true };

function cache(root, now) {
  return new MarketCatalogCache({ root, catalog, apiVersion, platform, now });
}

function memoryCache(value = null, { fresh = false, writeAt = 2_000 } = {}) {
  const state = { value, writes: [] };
  return {
    state,
    read: async () => state.value,
    write: async items => { state.value = { items, fetchedAt: writeAt }; state.writes.push(items); return state.value; },
    isFresh: () => fresh,
  };
}

test('persists the market catalogue and serves it after a restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-market-cache-'));
  try {
    const first = cache(root, () => 1_000);
    assert.equal(await first.read(), null);
    await first.write([item]);

    const restarted = cache(root, () => 1_000 + 60_000);
    const cached = await restarted.read();
    assert.deepEqual(cached, { items: [item], fetchedAt: 1_000 });
    assert.equal(restarted.isFresh(cached), true);
    assert.equal(restarted.isFresh({ ...cached, fetchedAt: 1_000 - MARKET_CACHE_MAX_AGE }), false);

    const stored = JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8'));
    assert.equal(stored.version, 1);
    assert.equal(stored.catalog, catalog);
    assert.equal(stored.apiVersion, apiVersion);
    assert.equal(stored.platform, platform);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ignores caches from another catalogue, API version, platform, or corrupted entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-market-cache-'));
  try {
    const service = cache(root, () => 1_000);
    await service.write([item]);

    const identity = { catalog, apiVersion, platform };
    const value = JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8'));
    assert.deepEqual(readMarketCache(value, identity), { items: [item], fetchedAt: 1_000 });
    assert.equal(readMarketCache({ ...value, catalog: 'https://other.example/catalog.json' }, identity), null);
    assert.equal(readMarketCache({ ...value, apiVersion: '1.9.0' }, identity), null);
    assert.equal(readMarketCache({ ...value, platform: 'win32-x64' }, identity), null);
    for (const invalid of [
      { title: 'x'.repeat(81) },
      { version: 1 },
      { version: 'not-semver' },
      { category: { name: '图片处理' } },
      { api: 'invalid-range' },
      { releaseNotes: 'x'.repeat(64_001) },
      { stats: { downloads: -1 } },
      { tier: 'builtin' },
      { icon: 'https://example.com/icon.png' },
      { icon: 'data:image/svg+xml;base64,PHN2Zz4=' },
    ]) {
      assert.equal(readMarketCache({ ...value, items: [{ ...item, ...invalid }] }, identity), null, JSON.stringify(invalid));
    }

    await writeFile(path.join(root, 'catalog.json'), '{not json');
    assert.equal(await cache(root, () => 1_000).read(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replaces the cache atomically and refreshes the in-memory copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-market-cache-'));
  try {
    const service = cache(root, () => 1_000);
    await service.write([item]);
    const next = { ...item, version: '0.2.0', releaseNotes: '新版本' };
    await service.write([next]);

    const cached = await service.read();
    assert.deepEqual(cached.items, [next]);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8')).items, [next]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('store loads, caches, and publishes a cold catalogue once', async () => {
  const cache = memoryCache();
  const published = [];
  let loads = 0;
  const store = new MarketCatalogStore({
    cache,
    load: async () => { loads += 1; return { items: [item], configured: true }; },
    publish: value => published.push(value),
    now: () => 2_000,
  });

  const first = await store.list();
  assert.deepEqual(first, { items: [item], fetchedAt: 2_000, cached: false });
  assert.equal(loads, 1);
  assert.deepEqual(cache.state.writes, [[item]]);
  assert.deepEqual(published, [{ items: [item], fetchedAt: 2_000 }]);
});

test('store serves a warm cache and refreshes it in the background', async () => {
  const old = { ...item, version: '0.1.0' };
  const next = { ...item, version: '0.2.0' };
  const cache = memoryCache({ items: [old], fetchedAt: 1_000 }, { fresh: true });
  const published = [];
  let loads = 0;
  const store = new MarketCatalogStore({
    cache,
    load: async () => { loads += 1; return { items: [next], configured: true }; },
    publish: value => published.push(value),
    now: () => 2_000,
  });

  const result = await store.list({ background: true });
  assert.deepEqual(result, { items: [old], fetchedAt: 1_000, cached: true });
  await store.pending;
  assert.equal(loads, 1);
  assert.deepEqual(published, [{ items: [next], fetchedAt: 2_000 }]);
  assert.deepEqual(await store.list(), { items: [next], fetchedAt: 2_000, cached: true });
});

test('store refreshes stale data without blocking the cached response', async () => {
  const cache = memoryCache({ items: [item], fetchedAt: 1_000 });
  const next = { ...item, version: '0.2.0' };
  const store = new MarketCatalogStore({
    cache,
    load: async () => ({ items: [next], configured: true }),
    now: () => 2_000,
  });

  const result = await store.list();
  assert.deepEqual(result, { items: [item], fetchedAt: 1_000, cached: true });
  await store.pending;
  assert.deepEqual(await store.list(), { items: [next], fetchedAt: 2_000, cached: true });
});

test('store refreshes on demand and deduplicates concurrent loads', async () => {
  const cache = memoryCache({ items: [item], fetchedAt: 1_000 }, { fresh: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let loads = 0;
  const store = new MarketCatalogStore({
    cache,
    load: async () => { loads += 1; await gate; return { items: [item], configured: true }; },
    now: () => 2_000,
  });

  const forced = store.list({ refresh: true });
  const warm = store.list({ background: true });
  release();
  const [fresh, cached] = await Promise.all([forced, warm]);
  assert.equal(loads, 1);
  assert.deepEqual(fresh, { items: [item], fetchedAt: 2_000, cached: false });
  assert.deepEqual(cached, { items: [item], fetchedAt: 1_000, cached: true });
});

test('store keeps cached data and reports a failed background refresh', async () => {
  const cache = memoryCache({ items: [item], fetchedAt: 1_000 });
  const reports = [];
  const store = new MarketCatalogStore({
    cache,
    load: async () => { throw new Error('offline'); },
    report: message => reports.push(message),
    now: () => 2_000,
  });

  assert.deepEqual(await store.list({ background: true }), { items: [item], fetchedAt: 1_000, cached: true });
  await store.pending?.catch(() => {});
  assert.match(reports[0], /插件目录刷新失败：offline/);
});

test('store reports an unpublished catalogue without caching it', async () => {
  const cache = memoryCache();
  const store = new MarketCatalogStore({
    cache,
    load: async () => ({ items: [], configured: false, message: '插件目录尚未发布。' }),
  });

  assert.deepEqual(await store.list(), { items: [], message: '插件目录尚未发布。', configured: false, fetchedAt: null, cached: false });
  assert.deepEqual(cache.state.writes, []);
});
