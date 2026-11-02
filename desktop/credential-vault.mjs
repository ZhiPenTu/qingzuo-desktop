import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { CREDENTIAL_RECORD_MISSING, CREDENTIAL_SECRET_MISSING, maskAppId } from './credential-policy.mjs';

export const VAULT_OWNER = 'vault';
export const MAX_RECORDS = 64;
export const MAX_GRANTS = 64;
export const RECORD_ID = /^rec-[a-f0-9]{12}$/;

const ENVIRONMENTS = new Set(['production', 'sandbox']);

function emptyState() {
  return { schemaVersion: 1, records: [], grants: {} };
}

function textOf(value, max, label) {
  if (typeof value !== 'string') throw new Error(label + '格式无效。');
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(label + '格式无效。');
  return text;
}

function secretOf(value) {
  if (typeof value !== 'string') throw new Error('密钥格式无效。');
  const text = value.trim();
  if (!text || text.length > 1024 || /[\u0000\r\n]/.test(text)) throw new Error('密钥格式无效。');
  return text;
}

function environmentOf(value) {
  if (value === undefined) return 'production';
  if (!ENVIRONMENTS.has(value)) throw new Error('凭证环境无效。');
  return value;
}

function secretName(id) {
  return 'record-' + id;
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || !RECORD_ID.test(value.id)) return null;
  try {
    const label = textOf(value.label, 64, '凭证别名');
    const appId = textOf(value.appId, 256, 'AppID');
    const environment = environmentOf(value.environment);
    const createdAt = Number(value.createdAt), updatedAt = Number(value.updatedAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    return { id: value.id, label, appId, environment, createdAt, updatedAt, hasSecret: value.hasSecret !== false };
  } catch {
    return null;
  }
}

function normalizeState(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.records)) return null;
  const records = [], ids = new Set(), labels = new Set();
  for (const item of value.records) {
    if (records.length >= MAX_RECORDS) break;
    const record = normalizeRecord(item);
    if (!record || ids.has(record.id) || labels.has(record.label.toLowerCase())) continue;
    ids.add(record.id);
    labels.add(record.label.toLowerCase());
    records.push(record);
  }
  const grants = {};
  if (value.grants && typeof value.grants === 'object' && !Array.isArray(value.grants)) {
    const recordGrants = new Map();
    for (const [pluginId, entries] of Object.entries(value.grants)) {
      if (!/^[a-z0-9.-]{1,96}$/.test(pluginId) || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      const allowed = {};
      for (const [recordId, stamp] of Object.entries(entries)) {
        const count = recordGrants.get(recordId) ?? 0;
        if (!ids.has(recordId) || !Number.isFinite(stamp) || stamp <= 0 || count >= MAX_GRANTS) continue;
        allowed[recordId] = stamp;
        recordGrants.set(recordId, count + 1);
      }
      if (Object.keys(allowed).length) grants[pluginId] = allowed;
    }
  }
  return { schemaVersion: 1, records, grants };
}

export class CredentialVault {
  constructor({ root, credentials, now = () => Date.now(), log = () => {} }) {
    if (!root || !credentials) throw new Error('凭证库初始化参数无效。');
    this.root = root;
    this.credentials = credentials;
    this.now = now;
    this.log = log;
    this.file = path.join(root, 'credential-records.json');
    this.state = emptyState();
    this.ready = null;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    this.ready = this.load();
    await this.ready;
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    try {
      const value = JSON.parse(raw);
      const state = normalizeState(value);
      if (!state) throw new Error('invalid schema');
      this.state = state;
    } catch {
      this.log('凭证索引无法读取，已备份并重建。');
      await rename(this.file, this.file + '.corrupt-' + Date.now()).catch(() => {});
      this.state = emptyState();
    }
  }

  async write(value) {
    const temporary = this.file + '.' + process.pid + '.' + Date.now() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, this.file);
      if (process.platform !== 'win32') await chmod(this.file, 0o600).catch(() => {});
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async mutate(change, rollback) {
    const execute = async () => {
      await this.ready;
      const previous = this.state;
      const draft = structuredClone(previous);
      try {
        const result = await change(draft);
        await this.write(draft);
        this.state = draft;
        return result;
      } catch (error) {
        if (rollback) await rollback().catch(() => {});
        throw error;
      }
    };
    const operation = this.queue.then(execute, execute);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async settled() {
    await this.ready;
    await this.queue;
  }

  record(draft, id) {
    if (typeof id !== 'string' || !RECORD_ID.test(id)) throw new Error(CREDENTIAL_RECORD_MISSING);
    const record = draft.records.find(item => item.id === id);
    if (!record) throw new Error(CREDENTIAL_RECORD_MISSING);
    return record;
  }

  nextId(draft) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = 'rec-' + randomBytes(6).toString('hex');
      if (!draft.records.some(item => item.id === id)) return id;
    }
    throw new Error('无法生成凭证标识，请重试。');
  }

  publicRecord(record, grants) {
    return { id: record.id, label: record.label, appId: record.appId, environment: record.environment, createdAt: record.createdAt, updatedAt: record.updatedAt, hasSecret: record.hasSecret, ...(grants === undefined ? {} : { grants }) };
  }

  access(record) {
    return { id: record.id, label: record.label, appId: record.appId, environment: record.environment };
  }

  async list() {
    await this.settled();
    return [...this.state.records]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(record => this.publicRecord(record, Object.values(this.state.grants).filter(entries => entries[record.id]).length));
  }

  async listGranted(pluginId) {
    await this.settled();
    const granted = this.state.grants[pluginId] ?? {};
    return this.state.records
      .filter(record => Boolean(granted[record.id]))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(record => this.publicRecord(record));
  }

  async browse(pluginId) {
    await this.settled();
    const granted = this.state.grants[pluginId] ?? {};
    return [...this.state.records]
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
      .map(record => ({ id: record.id, label: record.label, environment: record.environment, appIdMasked: maskAppId(record.appId), granted: Boolean(granted[record.id]) }));
  }

  async get(id) {
    await this.settled();
    return this.publicRecord(this.record(this.state, id), Object.values(this.state.grants).filter(entries => entries[id]).length);
  }

  async accessOf(id) {
    await this.settled();
    return this.access(this.record(this.state, id));
  }

  isGranted(pluginId, id) {
    return Boolean(this.state.grants[pluginId]?.[id]);
  }

  async secret(id) {
    await this.settled();
    this.record(this.state, id);
    const value = await this.credentials.get(VAULT_OWNER, secretName(id));
    if (!value) throw new Error(CREDENTIAL_SECRET_MISSING);
    return value;
  }

  async create(input = {}) {
    let created = null;
    return this.mutate(async draft => {
      if (draft.records.length >= MAX_RECORDS) throw new Error('最多保存 64 条凭证。');
      const label = textOf(input.label, 64, '凭证别名');
      const appId = textOf(input.appId, 256, 'AppID');
      const environment = environmentOf(input.environment);
      const secret = secretOf(input.secretKey);
      if (draft.records.some(record => record.label.toLowerCase() === label.toLowerCase())) throw new Error('已存在同名凭证。');
      const id = this.nextId(draft), stamp = this.now();
      created = { id, label, appId, environment, createdAt: stamp, updatedAt: stamp, hasSecret: true };
      await this.credentials.set(VAULT_OWNER, secretName(id), secret);
      draft.records.push(created);
      return this.publicRecord(created, 0);
    }, async () => { if (created) await this.credentials.clear(VAULT_OWNER, secretName(created.id)); });
  }

  async update(id, patch = {}) {
    let previousSecret = null, secretChanged = false;
    return this.mutate(async draft => {
      const record = this.record(draft, id);
      const next = { ...record };
      if (patch.label !== undefined) {
        const label = textOf(patch.label, 64, '凭证别名');
        if (draft.records.some(item => item.id !== id && item.label.toLowerCase() === label.toLowerCase())) throw new Error('已存在同名凭证。');
        next.label = label;
      }
      if (patch.appId !== undefined) next.appId = textOf(patch.appId, 256, 'AppID');
      if (patch.environment !== undefined) next.environment = environmentOf(patch.environment);
      if (patch.secretKey !== undefined && !(typeof patch.secretKey === 'string' && !patch.secretKey.trim())) {
        const secret = secretOf(patch.secretKey);
        previousSecret = await this.credentials.get(VAULT_OWNER, secretName(id)).catch(() => null);
        await this.credentials.set(VAULT_OWNER, secretName(id), secret);
        secretChanged = true;
        next.hasSecret = true;
      }
      next.updatedAt = this.now();
      draft.records[draft.records.findIndex(item => item.id === id)] = next;
      return this.publicRecord(next, Object.values(draft.grants).filter(entries => entries[id]).length);
    }, async () => {
      if (!secretChanged) return;
      if (previousSecret) await this.credentials.set(VAULT_OWNER, secretName(id), previousSecret);
      else await this.credentials.clear(VAULT_OWNER, secretName(id));
    });
  }

  async remove(id) {
    const record = await this.mutate(draft => {
      const target = this.record(draft, id);
      draft.records = draft.records.filter(item => item.id !== id);
      for (const entries of Object.values(draft.grants)) delete entries[id];
      return target;
    });
    await this.credentials.clear(VAULT_OWNER, secretName(record.id)).catch(() => {});
  }

  async grant(pluginId, id) {
    return this.mutate(draft => {
      const record = this.record(draft, id);
      const entries = draft.grants[pluginId] ?? {};
      const grantCount = Object.values(draft.grants).filter(value => value?.[id]).length;
      if (!entries[id] && grantCount >= MAX_GRANTS) throw new Error('这条凭证的授权数量已达上限。');
      entries[id] ||= this.now();
      draft.grants[pluginId] = entries;
      return this.access(record);
    });
  }

  async revoke(pluginId, id) {
    return this.mutate(draft => {
      const entries = draft.grants[pluginId];
      if (!entries?.[id]) return;
      delete entries[id];
      if (!Object.keys(entries).length) delete draft.grants[pluginId];
    });
  }

  async revokePlugin(pluginId) {
    return this.mutate(draft => {
      delete draft.grants[pluginId];
    });
  }

  async grants(id) {
    await this.settled();
    this.record(this.state, id);
    const result = [];
    for (const [pluginId, entries] of Object.entries(this.state.grants)) {
      if (entries[id]) result.push({ pluginId, confirmedAt: entries[id] });
    }
    return result.sort((left, right) => left.confirmedAt - right.confirmedAt);
  }

  async revokeGrant(id, pluginId) {
    return this.mutate(draft => {
      this.record(draft, id);
      const entries = draft.grants[pluginId];
      if (!entries?.[id]) return;
      delete entries[id];
      if (!Object.keys(entries).length) delete draft.grants[pluginId];
    });
  }
}
