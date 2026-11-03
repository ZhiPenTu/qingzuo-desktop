import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIGEST = /^[a-f0-9]{64}$/;
const CAPABILITY = /^[a-z][a-z0-9.-]{1,95}$/;

async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function descriptor(plugin, capability) {
  if (!plugin || typeof plugin.id !== 'string' || typeof plugin.version !== 'string' || typeof plugin.api !== 'string') {
    throw new Error('插件授权信息不完整。');
  }
  if (!DIGEST.test(plugin.artifactSha256 || '')) throw new Error('插件制品摘要不可用，请重新安装。');
  if (!CAPABILITY.test(capability)) throw new Error('插件能力无效。');
  return {
    pluginId: plugin.id,
    version: plugin.version,
    artifactSha256: plugin.artifactSha256,
    apiVersion: plugin.api,
    capability,
  };
}

function sameGrant(left, right) {
  return left.pluginId === right.pluginId
    && left.version === right.version
    && left.artifactSha256 === right.artifactSha256
    && left.apiVersion === right.apiVersion
    && left.capability === right.capability;
}

export class FirstPartyGrants {
  constructor({ root, now = Date.now } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('授权存储目录无效。');
    this.root = root;
    this.file = path.join(root, 'first-party-grants.json');
    this.now = now;
    this.grants = [];
    this.write = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value?.schemaVersion !== 1 || !Array.isArray(value.grants)) throw new Error('授权记录格式无效。');
      this.grants = value.grants.filter(grant => grant
        && typeof grant.pluginId === 'string'
        && typeof grant.version === 'string'
        && DIGEST.test(grant.artifactSha256 || '')
        && typeof grant.apiVersion === 'string'
        && CAPABILITY.test(grant.capability || '')
        && Number.isFinite(grant.grantedAt));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.grants = [];
        await rm(this.file, { force: true }).catch(() => {});
      }
    }
    return this.grants.length;
  }

  status(plugin, capability) {
    const next = descriptor(plugin, capability);
    return this.grants.some(grant => sameGrant(grant, next));
  }

  async ensure(plugin, capability, confirm) {
    const next = descriptor(plugin, capability);
    if (this.grants.some(grant => sameGrant(grant, next))) return true;
    if (typeof confirm !== 'function' || !(await confirm({ ...next }))) return false;
    this.grants = this.grants.filter(grant => !(grant.pluginId === next.pluginId && grant.capability === next.capability));
    this.grants.push({ ...next, grantedAt: this.now() });
    await this.persist();
    return true;
  }

  async revoke(pluginId, capability) {
    if (typeof pluginId !== 'string' || !pluginId) return false;
    const before = this.grants.length;
    this.grants = this.grants.filter(grant => grant.pluginId !== pluginId || (capability !== undefined && grant.capability !== capability));
    if (this.grants.length === before) return false;
    await this.persist();
    return true;
  }

  revokePlugin(pluginId) {
    return this.revoke(pluginId);
  }

  async revokeAll() {
    if (!this.grants.length) return false;
    this.grants = [];
    await this.persist();
    return true;
  }

  persist() {
    const value = structuredClone({ schemaVersion: 1, grants: this.grants });
    this.write = this.write.catch(() => {}).then(() => atomicJson(this.file, value));
    return this.write;
  }
}
