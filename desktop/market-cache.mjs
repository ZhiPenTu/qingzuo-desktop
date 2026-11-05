import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { validatePluginIcon } from './security.mjs';

export const MARKET_CACHE_VERSION = 1;
export const MARKET_CACHE_MAX_AGE = 10 * 60 * 1000;
const MARKET_CACHE_FILE = 'catalog.json';
const MAX_ENTRIES = 1000;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (typeof entry.id !== 'string' || entry.id.length > 160 || !entry.id) return false;
  if (typeof entry.version !== 'string' || !semver.valid(entry.version)) return false;
  if (typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 80) return false;
  if (typeof entry.description !== 'string' || entry.description.length > 2000) return false;
  if (entry.category !== undefined && (typeof entry.category !== 'string' || !entry.category.trim() || entry.category.length > 40)) return false;
  if (entry.api !== undefined && (typeof entry.api !== 'string' || !semver.validRange(entry.api))) return false;
  if (entry.releaseNotes !== undefined && (typeof entry.releaseNotes !== 'string' || entry.releaseNotes.length > 64000)) return false;
  if (entry.stats !== undefined && (!entry.stats || typeof entry.stats !== 'object' || Array.isArray(entry.stats)
    || (entry.stats.downloads !== undefined && (!Number.isSafeInteger(entry.stats.downloads) || entry.stats.downloads < 0)))) return false;
  if (entry.icon !== undefined) {
    if (typeof entry.icon !== 'string') return false;
    try { validatePluginIcon(entry.icon); } catch { return false; }
  }
  return (entry.tier === undefined || ['platform', 'official', 'community'].includes(entry.tier))
    && (entry.official === undefined || typeof entry.official === 'boolean')
    && (entry.compatible === undefined || typeof entry.compatible === 'boolean')
    && (entry.sourceUnavailable === undefined || typeof entry.sourceUnavailable === 'boolean');
}

export function readMarketCache(value, { catalog, apiVersion, platform } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== MARKET_CACHE_VERSION) return null;
  if (typeof value.catalog !== 'string' || value.catalog !== catalog) return null;
  if (typeof value.apiVersion !== 'string' || value.apiVersion !== apiVersion) return null;
  if (typeof value.platform !== 'string' || value.platform !== platform) return null;
  if (!Number.isFinite(value.fetchedAt) || value.fetchedAt <= 0) return null;
  if (!Array.isArray(value.items) || value.items.length > MAX_ENTRIES || !value.items.every(validEntry)) return null;
  return { items: value.items, fetchedAt: value.fetchedAt };
}

export class MarketCatalogCache {
  constructor({ root, catalog, apiVersion, platform, now = Date.now, maxAge = MARKET_CACHE_MAX_AGE } = {}) {
    this.file = root ? path.join(root, MARKET_CACHE_FILE) : null;
    this.catalog = catalog;
    this.apiVersion = apiVersion;
    this.platform = platform;
    this.now = now;
    this.maxAge = maxAge;
    this.memo = null;
  }

  isFresh(cached) {
    return Boolean(cached) && this.now() - cached.fetchedAt < this.maxAge;
  }

  async read() {
    if (!this.file || typeof this.catalog !== 'string') return null;
    if (this.memo) return this.memo;
    const info = await stat(this.file).catch(() => null);
    if (!info || info.size > MAX_CACHE_BYTES) return null;
    let raw;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this.memo = null;
      return null;
    }
    const cached = readMarketCache(raw, this);
    this.memo = cached;
    return cached;
  }

  async write(items) {
    if (!this.file || typeof this.catalog !== 'string' || !Array.isArray(items)) return null;
    const value = {
      version: MARKET_CACHE_VERSION,
      catalog: this.catalog,
      apiVersion: this.apiVersion,
      platform: this.platform,
      fetchedAt: this.now(),
      items,
    };
    const serialized = JSON.stringify(value);
    // Keep the fetched catalogue in memory even when disk persistence fails.
    this.memo = { items, fetchedAt: value.fetchedAt };
    if (Buffer.byteLength(serialized) > MAX_CACHE_BYTES) {
      return null;
    }
    const directory = path.dirname(this.file);
    const temp = `${this.file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temp, serialized, { mode: 0o600 });
      await rename(temp, this.file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    return this.memo;
  }
}
