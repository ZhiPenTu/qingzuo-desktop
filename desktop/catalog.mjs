import semver from 'semver';
import { API_VERSION, validatePluginIcon } from './security.mjs';

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PLATFORMS = new Set(['darwin-arm64', 'win32-x64']);
export const RELEASE_FRAGMENT_BYTES = 256 * 1024;

function validRepository(value) {
  if (typeof value !== 'string' || value.length > 160 || !REPOSITORY.test(value)) return false;
  return value.split('/').every(part => part.length <= 100 && part !== '.' && part !== '..');
}

function stableVersion(value) {
  return semver.valid(value) !== null && semver.prerelease(value) === null;
}

function validateText(entry) {
  if (typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 80
    || typeof entry.description !== 'string' || entry.description.length > 2000
    || entry.category !== undefined && (typeof entry.category !== 'string' || !entry.category.trim() || entry.category.length > 40)
    || entry.releaseNotes !== undefined && (typeof entry.releaseNotes !== 'string' || entry.releaseNotes.length > 64000)) {
    throw new Error('市场插件条目无效。');
  }
  if (entry.icon !== undefined) validatePluginIcon(entry.icon);
  if (entry.api !== undefined && (typeof entry.api !== 'string' || !semver.validRange(entry.api))) {
    throw new Error('市场 API 范围无效。');
  }
  if (entry.stats !== undefined && (!entry.stats || typeof entry.stats !== 'object' || Array.isArray(entry.stats)
    || entry.stats.downloads !== undefined && (!Number.isSafeInteger(entry.stats.downloads) || entry.stats.downloads < 0))) {
    throw new Error('市场插件统计无效。');
  }
}

function validateSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || source.type !== 'github-release' || !validRepository(source.repository)) {
    throw new Error('市场插件来源无效。');
  }
}

function validateArtifact(platform, artifact) {
  if (!PLATFORMS.has(platform) || !artifact || typeof artifact !== 'object' || Array.isArray(artifact)
    || typeof artifact.signature !== 'string' || artifact.signature.length > 128
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error('市场制品信息无效。');
  }
  if (artifact.size !== undefined && (!Number.isSafeInteger(artifact.size) || artifact.size < 1)) {
    throw new Error('市场制品信息无效。');
  }
  const url = new URL(artifact.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('市场下载地址无效。');
}

export function validateCatalog(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.plugins) || value.plugins.length > 1000) {
    throw new Error('市场目录格式无效。');
  }
  const identities = new Set();
  for (const item of value.plugins) {
    if (!PLUGIN_ID.test(item.id) || item.id.startsWith('system.') || identities.has(item.id)
      || !stableVersion(item.version)) {
      throw new Error('市场插件条目无效。');
    }
    validateText(item);
    if (item.source !== undefined) validateSource(item.source);
    if (!item.source && !item.artifacts) throw new Error('市场插件条目缺少来源或制品。');
    if (item.artifacts !== undefined) {
      if (!item.artifacts || typeof item.artifacts !== 'object' || Array.isArray(item.artifacts)) {
        throw new Error('市场制品信息无效。');
      }
      for (const [platform, artifact] of Object.entries(item.artifacts)) validateArtifact(platform, artifact);
    }
    identities.add(item.id);
  }
  return value.plugins.map(item => {
    const { verification: _verification, sourceUnavailable: _sourceUnavailable, ...entry } = item;
    return {
      ...entry,
      compatible: semver.satisfies(API_VERSION, entry.api ?? '^1.0.0'),
    };
  });
}

export function releaseFragmentUrl(repository, platform) {
  if (!validRepository(repository) || !PLATFORMS.has(platform)) throw new Error('插件发布来源无效。');
  return `https://github.com/${repository}/releases/latest/download/catalog-${platform}.json`;
}

export function expectedReleaseArtifactUrl(repository, id, version, platform) {
  return `https://github.com/${repository}/releases/download/v${version}/${id}-${version}-${platform}.ecplugin`;
}

function validateReleaseFragment(value, entry, platform) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.plugins) || value.plugins.length !== 1) {
    throw new Error('插件发布清单格式无效。');
  }
  const item = value.plugins[0];
  if (item?.id !== entry.id || !PLUGIN_ID.test(item.id) || !stableVersion(item.version)) {
    throw new Error('插件发布清单与市场收录不一致。');
  }
  validateText(item);
  const artifact = item.artifacts?.[platform];
  if (!artifact || !Number.isSafeInteger(artifact.size) || artifact.size < 1
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error('插件发布制品信息无效。');
  }
  const expected = expectedReleaseArtifactUrl(entry.source.repository, entry.id, item.version, platform);
  if (artifact.url !== expected) throw new Error('插件发布制品地址无效。');
  return {
    ...item,
    artifacts: { [platform]: { url: artifact.url, size: artifact.size, sha256: artifact.sha256 } },
    compatible: semver.satisfies(API_VERSION, item.api ?? '^1.0.0'),
  };
}

export async function resolveMarketEntries(value, {
  platform,
  load,
  signal,
  id,
} = {}) {
  if (!PLATFORMS.has(platform)) throw new Error('当前平台不支持插件市场。');
  if (typeof load !== 'function') throw new Error('插件市场加载器无效。');
  const entries = validateCatalog(value).filter(entry => id === undefined || entry.id === id);
  return Promise.all(entries.map(async entry => {
    if (!entry.source) return entry;
    try {
      const bytes = await load(releaseFragmentUrl(entry.source.repository, platform), RELEASE_FRAGMENT_BYTES);
      signal?.throwIfAborted();
      if (!bytes || bytes.length > RELEASE_FRAGMENT_BYTES) throw new Error('插件发布清单过大。');
      const release = validateReleaseFragment(JSON.parse(bytes.toString()), entry, platform);
      return {
        ...entry,
        ...release,
        category: release.category ?? entry.category,
        icon: release.icon ?? entry.icon,
        source: entry.source,
        stats: entry.stats,
        verification: 'github-release',
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return { ...entry, sourceUnavailable: true };
    }
  }));
}
