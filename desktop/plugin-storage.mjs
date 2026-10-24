import { mkdir, readFile, writeFile, readdir, rename, rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const MAX_KEY_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 5000;

function pluginDirectory(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,95}$/.test(id)) throw new Error('插件标识无效。');
  return id;
}

function storageKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new Error('存储键名无效。');
  return key;
}

function tokenValue(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token)) throw new Error('文件未授权或已失效。');
  return token;
}

export class PluginStorage {
  constructor(root) { this.root = root; this.queues = new Map(); }

  async initialize() { await mkdir(this.root, { recursive: true, mode: 0o700 }); }

  directory(plugin) { return path.join(this.root, pluginDirectory(plugin.id)); }
  valuesDirectory(plugin) { return path.join(this.directory(plugin), 'values'); }
  filesDirectory(plugin) { return path.join(this.directory(plugin), 'files'); }
  indexFile(plugin) { return path.join(this.filesDirectory(plugin), 'index.json'); }

  serialize(plugin, operation) {
    const id = plugin.id;
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(id, next.catch(() => {}));
    return next;
  }

  async usage(plugin) {
    let total = 0, entries = 0;
    for (const dir of [this.valuesDirectory(plugin), this.filesDirectory(plugin)]) {
      let items = [];
      try { items = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const item of items) {
        if (!item.isFile()) continue;
        entries += 1;
        if (entries > MAX_ENTRIES) throw new Error('插件存储条目过多。');
        try { total += (await lstat(path.join(dir, item.name))).size; } catch {}
      }
    }
    return { bytes: total, entries };
  }

  async get(plugin, key) {
    storageKey(key);
    try { return JSON.parse(await readFile(path.join(this.valuesDirectory(plugin), key + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('插件存储读取失败。'); }
  }

  async keys(plugin) {
    let items = [];
    try { items = await readdir(this.valuesDirectory(plugin)); } catch { return []; }
    return items.filter(name => name.endsWith('.json') && KEY_PATTERN.test(name.slice(0, -5))).map(name => name.slice(0, -5)).sort();
  }

  set(plugin, key, value) {
    return this.serialize(plugin, async () => {
      storageKey(key);
      if (value === undefined) throw new Error('存储内容无效。');
      let body; try { body = JSON.stringify(value); } catch { throw new Error('存储内容无法保存。'); }
      if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_KEY_BYTES) throw new Error('单个存储内容不能超过 1 MB。');
      const dir = this.valuesDirectory(plugin); await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, key + '.json');
      let previous = 0; try { previous = (await lstat(target)).size; } catch {}
      const usage = await this.usage(plugin);
      if (usage.bytes - previous + Buffer.byteLength(body) > MAX_TOTAL_BYTES) throw new Error('插件存储空间已满，请先清理。');
      const temporary = path.join(dir, '.' + key + '.' + randomUUID() + '.tmp');
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, target);
      return true;
    });
  }

  remove(plugin, key) {
    return this.serialize(plugin, async () => {
      storageKey(key);
      try { await rm(path.join(this.valuesDirectory(plugin), key + '.json')); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw new Error('插件存储删除失败。'); }
    });
  }

  async readIndex(plugin) {
    try {
      const value = JSON.parse(await readFile(this.indexFile(plugin), 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('文件未授权或已失效。'); }
  }

  async writeIndex(plugin, index) {
    const dir = this.filesDirectory(plugin);
    const temporary = path.join(dir, '.index.' + randomUUID() + '.tmp');
    await writeFile(temporary, JSON.stringify(index), { mode: 0o600 });
    await rename(temporary, this.indexFile(plugin));
  }

  saveFile(plugin, { data, filename, mime }) {
    return this.serialize(plugin, async () => {
      if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > 44 * 1024 * 1024) throw new Error('文件内容无效或过大。');
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('文件内容无效或过大。');
      const name = path.basename(typeof filename === 'string' && filename.trim() ? filename.trim() : 'file').slice(0, 240) || 'file';
      const type = typeof mime === 'string' && mime.length <= 100 ? mime : 'application/octet-stream';
      const dir = this.filesDirectory(plugin); await mkdir(dir, { recursive: true, mode: 0o700 });
      const usage = await this.usage(plugin);
      if (usage.bytes + bytes.length > MAX_TOTAL_BYTES) throw new Error('插件存储空间已满，请先清理。');
      const token = randomUUID();
      await writeFile(path.join(dir, token), bytes, { mode: 0o600 });
      const index = await this.readIndex(plugin);
      index[token] = { name, size: bytes.length, mime: type, created: Date.now() };
      await this.writeIndex(plugin, index);
      return { token, name, size: bytes.length, mime: type };
    });
  }

  async resolve(plugin, token) {
    tokenValue(token);
    const index = await this.readIndex(plugin);
    const entry = index[token];
    if (!entry) throw new Error('文件未授权或已失效。');
    const dir = await realpath(this.filesDirectory(plugin)).catch(() => null);
    if (!dir) throw new Error('文件未授权或已失效。');
    const filename = path.join(dir, token);
    const info = await lstat(filename).catch(() => null);
    if (!info || !info.isFile()) throw new Error('文件未授权或已失效。');
    if (await realpath(filename) !== filename) throw new Error('文件路径已改变。');
    return { token, name: entry.name, size: info.size, mime: entry.mime, filename, owner: plugin.id };
  }

  async readFile(plugin, token) {
    const item = await this.resolve(plugin, token);
    return { data: (await readFile(item.filename)).toString('base64'), mime: item.mime };
  }

  removeFile(plugin, token) {
    return this.serialize(plugin, async () => {
      const item = await this.resolve(plugin, token);
      const index = await this.readIndex(plugin); delete index[token];
      await rm(item.filename, { force: true });
      await this.writeIndex(plugin, index);
      return true;
    });
  }

  async clear(id) {
    pluginDirectory(id);
    this.queues.delete(id);
    await rm(path.join(this.root, id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
