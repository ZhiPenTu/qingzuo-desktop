import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { safeRelative } from '../packages/plugin-sdk/manifest.mjs';

const ALLOWED_ROOTS = new Set(['.aws-article', 'drafts', 'posts', 'series']);
const MAX_PATH = 512;
const MAX_LIST_ENTRIES = 5000;
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const SENSITIVE_PARTS = /^(?:\.env(?:\.|$)|aws\.env$|\.git$|\.ssh$|\.gnupg$|\.npmrc$|\.netrc$|\.pypirc$|\.git-credentials$|credentials(?:\.|$)|known_hosts$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|.*\.(?:pem|key|p12|pfx|kdbx|keychain|jks)$)/i;
const INTERNAL_IMPORT_PART = /^\.(?:import|backup)-[a-f0-9-]+$/i;
const MIME = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
};

const PUBLIC_ERRORS = {
  EACCES: '没有权限访问该文件或目录。',
  EEXIST: '目标已存在。',
  EISDIR: '该路径是目录。',
  ENOENT: '文件或目录不存在。',
  ENOSPC: '磁盘空间不足。',
  ENOTDIR: '该路径不是目录。',
  EPERM: '没有权限访问该文件或目录。',
};
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|var|tmp|Volumes)\/)[^\s'"<>|]*/g;

export function publicWorkspaceError(error) {
  if (PUBLIC_ERRORS[error?.code]) return new Error(PUBLIC_ERRORS[error.code]);
  const message = error instanceof Error ? error.message : String(error || '');
  return new Error(message.replace(ABSOLUTE_PATH, '[工作区路径]') || '工作区操作失败。');
}

function mimeOf(filename) {
  return MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function isSensitiveItemPath(relative) {
  return relative.split('/').some(part => SENSITIVE_PARTS.test(part));
}

function emptyState() {
  return { schemaVersion: 1, plugins: {} };
}

function normalizeState(value) {
  if (value?.schemaVersion !== 1 || !value.plugins || typeof value.plugins !== 'object' || Array.isArray(value.plugins)) return null;
  const plugins = {};
  for (const [pluginId, entry] of Object.entries(value.plugins)) {
    if (!/^[a-z][a-z0-9.-]{1,95}$/.test(pluginId)) continue;
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.filename !== 'string' || !path.isAbsolute(entry.filename) || entry.filename.length > 4096) continue;
    if (typeof entry.name !== 'string' || !entry.name || entry.name.length > 255) continue;
    if (!Number.isInteger(entry.dev) || !Number.isInteger(entry.ino) || entry.ino <= 0) continue;
    plugins[pluginId] = { filename: entry.filename, name: entry.name, dev: entry.dev, ino: entry.ino };
  }
  return { schemaVersion: 1, plugins };
}

function assertRelative(value, allowEmpty = false) {
  if (allowEmpty && value === '') return '';
  if (typeof value !== 'string' || !value || value.length > MAX_PATH) throw new Error('工作区路径无效。');
  const normalized = safeRelative(value);
  const parts = normalized.split('/');
  if (parts.some(part => SENSITIVE_PARTS.test(part))) throw new Error('该工作区路径不可访问。');
  if (!ALLOWED_ROOTS.has(parts[0])) throw new Error('该工作区路径不可访问。');
  return normalized;
}

function assertPlugin(plugin, permission) {
  if (!plugin?.id || !plugin.permissions?.[permission]) throw new Error(permission === 'workspace' ? '工作区未授权。' : '插件没有文件权限。');
}

function samePrefix(filename, root) {
  return filename === root || filename.startsWith(root + path.sep);
}

async function atomicJson(filename, value) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try {
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class WorkspaceRuntime {
  constructor({ root, dialog, files, log = () => {}, importBundle = null }) {
    this.root = root;
    this.dialog = dialog;
    this.files = files;
    this.log = log;
    this.importBundle = importBundle;
    this.metadata = path.join(root, 'workspaces.json');
    this.state = emptyState();
    this.urls = new Map();
    this.queue = Promise.resolve();
    this.fileQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const normalized = normalizeState(JSON.parse(await readFile(this.metadata, 'utf8')));
      if (!normalized) {
        await rename(this.metadata, this.metadata + '.corrupt-' + Date.now()).catch(() => {});
        this.state = emptyState();
        this.log('工作区索引格式不兼容，已保留原文件并停止使用旧授权。');
      } else {
        this.state = normalized;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await rename(this.metadata, this.metadata + '.corrupt-' + Date.now()).catch(() => {});
        this.log('工作区索引无法读取，已重建。');
      }
    }
  }

  setImporter(importer) {
    this.importBundle = importer;
  }

  async mutate(change) {
    const execute = async () => {
      const previous = this.state;
      const draft = structuredClone(previous);
      const result = await change(draft);
      await atomicJson(this.metadata, draft);
      this.state = draft;
      return result;
    };
    const operation = this.queue.then(execute, execute);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async pick(plugin) {
    assertPlugin(plugin, 'workspace');
    const result = await this.dialog.showOpenDialog({
      title: plugin.title + ' · 选择工作文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    const filename = await realpath(result.filePaths[0]);
    const info = await lstat(filename);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('请选择普通文件夹。');
    if (path.dirname(filename) === filename) throw new Error('请选择一个具体的文件夹，不要选择文件系统根目录。');
    const name = path.basename(filename);
    await this.mutate(draft => {
      draft.plugins[plugin.id] = { filename, name, dev: info.dev, ino: info.ino };
    });
    this.releaseUrls(plugin.id);
    return { name };
  }

  async current(plugin) {
    assertPlugin(plugin, 'workspace');
    const entry = this.state.plugins[plugin.id];
    if (!entry) return { entry: null, reason: 'not-picked' };
    try {
      const info = await lstat(entry.filename);
      if (!info.isDirectory() || info.isSymbolicLink()) return { entry: null, reason: 'moved' };
      const canonical = await realpath(entry.filename);
      if (canonical !== entry.filename || info.dev !== entry.dev || info.ino !== entry.ino) return { entry: null, reason: 'moved' };
      return { entry, reason: null };
    } catch (error) {
      return { entry: null, reason: error.code === 'ENOENT' ? 'missing' : 'denied' };
    }
  }

  async status(plugin) {
    assertPlugin(plugin, 'workspace');
    const current = await this.current(plugin);
    return current.entry
      ? { name: current.entry.name, available: true }
      : { name: this.state.plugins[plugin.id]?.name || '', available: false, reason: current.reason };
  }

  async revoke(plugin) {
    assertPlugin(plugin, 'workspace');
    this.releaseUrls(plugin.id);
    await this.mutate(draft => {
      delete draft.plugins[plugin.id];
    });
  }

  async assertNoSymlink(filename, root) {
    let cursor = root;
    const relative = path.relative(root, filename);
    if (relative === '') return;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      const info = await lstat(cursor).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) break;
      if (info.isSymbolicLink()) throw new Error('工作区不允许符号链接。');
    }
    const resolved = await realpath(filename).catch(() => null);
    if (resolved && !samePrefix(resolved, root)) throw new Error('工作区路径越过根目录。');
  }

  async resolveExisting(plugin, relative) {
    const current = await this.current(plugin);
    if (!current.entry) throw new Error(current.reason === 'not-picked' ? '请先选择工作文件夹。' : '工作文件夹不可用，请重新授权。');
    const normalized = assertRelative(relative);
    const root = current.entry.filename;
    const filename = path.join(root, ...normalized.split('/'));
    if (!samePrefix(filename, root)) throw new Error('工作区路径越过根目录。');
    await this.assertNoSymlink(filename, root);
    const info = await lstat(filename);
    const canonical = await realpath(filename);
    if (!samePrefix(canonical, root)) throw new Error('工作区路径越过根目录。');
    return { entry: current.entry, root, normalized, filename: canonical, info };
  }

  async ensureParent(plugin, relative) {
    const current = await this.current(plugin);
    if (!current.entry) throw new Error(current.reason === 'not-picked' ? '请先选择工作文件夹。' : '工作文件夹不可用，请重新授权。');
    const normalized = assertRelative(relative);
    const root = current.entry.filename;
    const parts = normalized.split('/');
    parts.pop();
    let cursor = root;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      const info = await lstat(cursor).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) {
        await mkdir(cursor, { mode: 0o700 });
      } else {
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('工作区目录无效。');
      }
    }
    await this.assertNoSymlink(cursor, root);
    const filename = path.join(root, ...normalized.split('/'));
    const parent = path.dirname(filename);
    if (!samePrefix(parent, root)) throw new Error('工作区路径越过根目录。');
    const parentCanonical = await realpath(parent);
    if (!samePrefix(parentCanonical, root)) throw new Error('工作区路径越过根目录。');
    return { entry: current.entry, root, normalized, filename: path.join(parentCanonical, path.basename(filename)), parent };
  }

  async list(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    const current = await this.current(plugin);
    if (!current.entry) throw new Error(current.reason === 'not-picked' ? '请先选择工作文件夹。' : '工作文件夹不可用，请重新授权。');
    const root = current.entry.filename;
    const requested = options.path === undefined ? '' : options.path;
    const startRelative = assertRelative(requested, true);
    const start = startRelative ? await this.resolveExisting(plugin, startRelative) : null;
    const startPath = start?.filename || root;
    const entries = [];
    const walk = async (filename, relative) => {
      const items = await readdir(filename, { withFileTypes: true });
      for (const item of items) {
        if (entries.length >= MAX_LIST_ENTRIES) throw new Error('目录内容过多。');
        const itemRelative = relative ? relative + '/' + item.name : item.name;
        if (!relative && !ALLOWED_ROOTS.has(item.name)) continue;
        if (isSensitiveItemPath(itemRelative) || itemRelative.split('/').some(part => INTERNAL_IMPORT_PART.test(part))) continue;
        const itemPath = path.join(filename, item.name);
        const info = await lstat(itemPath);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          entries.push({ path: itemRelative, name: item.name, kind: 'directory', mtime: info.mtimeMs });
          if (options.recursive) await walk(itemPath, itemRelative);
        } else if (info.isFile()) {
          entries.push({ path: itemRelative, name: item.name, kind: 'file', size: info.size, mtime: info.mtimeMs });
        }
      }
    };
    await walk(startPath, startRelative);
    return entries.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
  }

  async readText(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    const limit = options.maxBytes === undefined ? MAX_TEXT : Math.min(Number(options.maxBytes), MAX_TEXT);
    if (!Number.isInteger(limit) || limit < 1) throw new Error('读取上限无效。');
    const item = await this.resolveExisting(plugin, options.path);
    if (!item.info.isFile() || item.info.size > limit) throw new Error('文件过大。');
    return await readFile(item.filename, 'utf8');
  }

  async readFile(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    const limit = options.maxBytes === undefined ? MAX_FILE : Math.min(Number(options.maxBytes), MAX_FILE);
    if (!Number.isInteger(limit) || limit < 1) throw new Error('读取上限无效。');
    const item = await this.resolveExisting(plugin, options.path);
    if (!item.info.isFile() || item.info.size > limit) throw new Error('文件过大。');
    return { data: (await readFile(item.filename)).toString('base64'), mime: mimeOf(item.filename), size: item.info.size };
  }

  async serializeFile(operation) {
    const next = this.fileQueue.then(operation, operation);
    this.fileQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async stableParent(root, filename) {
    const canonicalRoot = await realpath(root);
    const parent = await realpath(path.dirname(filename));
    if (!samePrefix(parent, canonicalRoot)) throw new Error('工作区路径越过根目录。');
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('工作区目录无效。');
    return path.join(parent, path.basename(filename));
  }

  async atomicWrite(filename, bytes, overwrite, root) {
    return await this.serializeFile(async () => {
      const target = await this.stableParent(root, filename);
      if (!overwrite) {
        const existing = await lstat(target).catch(() => null);
        if (existing) throw new Error('文件已存在。');
      }
      const temporary = path.join(path.dirname(target), '.qingzuo-' + randomUUID() + '.tmp');
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
        await this.stableParent(root, target);
        if (overwrite) {
          const existing = await lstat(target).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (existing?.isSymbolicLink()) throw new Error('工作区目标不能是符号链接。');
          await rename(temporary, target);
        } else {
          await link(temporary, target);
        }
        if (process.platform !== 'win32') await chmod(target, 0o600).catch(() => {});
        return (await lstat(target)).size;
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async writeText(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    if (typeof options.text !== 'string' || Buffer.byteLength(options.text) > MAX_TEXT) throw new Error('文件内容无效或过大。');
    const target = await this.ensureParent(plugin, options.path);
    const size = await this.atomicWrite(target.filename, options.text, Boolean(options.overwrite), target.root);
    return { path: target.normalized, size };
  }

  async writeFile(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    assertPlugin(plugin, 'files');
    const item = await this.files.get(plugin, options.token);
    if (item.size > MAX_FILE) throw new Error('文件过大。');
    const target = await this.ensureParent(plugin, options.path);
    const size = await this.atomicWrite(target.filename, await readFile(item.filename), Boolean(options.overwrite), target.root);
    return { path: target.normalized, size };
  }

  async writeBase64(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    if (typeof options.data !== 'string' || !options.data || options.data.length > Math.ceil(MAX_FILE * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(options.data)) throw new Error('文件内容无效或过大。');
    if (typeof options.mime !== 'string' || options.mime.length > 100) throw new Error('文件类型无效。');
    const bytes = Buffer.from(options.data, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE) throw new Error('文件内容无效或过大。');
    const target = await this.ensureParent(plugin, options.path);
    const size = await this.atomicWrite(target.filename, bytes, Boolean(options.overwrite), target.root);
    return { path: target.normalized, size };
  }

  async mkdir(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    const target = await this.ensureParent(plugin, options.path + '/.qingzuo-directory');
    await mkdir(target.parent, { recursive: true, mode: 0o700 });
  }

  async rename(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    return await this.serializeFile(async () => {
      const source = await this.resolveExisting(plugin, options.from);
      const target = await this.ensureParent(plugin, options.to);
      if (source.filename === target.filename) return;
      if (await lstat(target.filename).catch(() => null)) throw new Error('目标文件已存在。');
      await rename(source.filename, target.filename);
    });
  }

  async remove(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    return await this.serializeFile(async () => {
      const item = await this.resolveExisting(plugin, options.path);
      if (item.info.isDirectory() && !options.recursive) throw new Error('删除目录需要递归确认。');
      await rm(item.filename, { recursive: Boolean(options.recursive), force: false });
    });
  }

  async url(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    const item = await this.resolveExisting(plugin, options.path);
    if (!item.info.isFile()) throw new Error('只能预览文件。');
    const token = randomUUID();
    this.urls.set(token, { pluginId: plugin.id, path: item.normalized });
    return 'commerce-plugin://' + plugin.id + '/__workspace/' + encodeURIComponent(token);
  }

  async urlFile(plugin, token) {
    assertPlugin(plugin, 'workspace');
    const item = this.urls.get(token);
    if (!item || item.pluginId !== plugin.id) throw new Error('工作区文件未授权或已失效。');
    const resolved = await this.resolveExisting(plugin, item.path);
    if (!resolved.info.isFile()) throw new Error('工作区文件不存在。');
    return { filename: resolved.filename, mime: mimeOf(resolved.filename) };
  }

  releaseUrls(pluginId) {
    for (const [token, value] of this.urls) if (!pluginId || value.pluginId === pluginId) this.urls.delete(token);
  }

  async importBundle(plugin, options = {}) {
    assertPlugin(plugin, 'workspace');
    if (!this.importBundle) throw new Error('预设包导入不可用。');
    return await this.importBundle.import(plugin, options);
  }

  async forget(pluginId) {
    this.releaseUrls(pluginId);
    if (!this.state.plugins[pluginId]) return;
    await this.mutate(draft => {
      delete draft.plugins[pluginId];
    });
  }
}
