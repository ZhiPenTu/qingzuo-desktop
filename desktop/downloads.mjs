import { constants as fsConstants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, realpath, rename, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { publicAddress, secureRequest } from './network-transport.mjs';

export const MAX_DOWNLOAD_BYTES = 20 * 1024 ** 3;
export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
export const MIN_SEGMENT_BYTES = 1024 ** 2;
export const DOWNLOAD_STATUSES = ['queued', 'probing', 'downloading', 'paused', 'completed', 'failed', 'canceled'];
export const DOWNLOAD_MODES = ['segmented', 'single'];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const MIME_EXTENSIONS = new Map([
  ['application/pdf', 'pdf'],
  ['application/zip', 'zip'],
  ['application/x-7z-compressed', '7z'],
  ['application/x-rar-compressed', 'rar'],
  ['application/gzip', 'gz'],
  ['application/octet-stream', 'bin'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['text/csv', 'csv'],
  ['text/plain', 'txt'],
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/webm', 'webm'],
]);

export class DownloadError extends Error {
  constructor(message, { retryable = false, pause = false, cause } = {}) {
    super(message, { cause });
    this.name = 'DownloadError';
    this.retryable = retryable;
    this.pause = pause;
  }
}

export class RangeUnavailable extends DownloadError {
  constructor(message = '下载服务器已停止支持分段或续传。') {
    super(message, { retryable: true });
    this.name = 'RangeUnavailable';
  }
}

class RemoteChanged extends DownloadError {
  constructor() {
    super('远程文件已更新，请重新创建下载任务。', { pause: true });
  }
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseLength(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function contentRange(value) {
  const match = typeof value === 'string' && /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!integer(start) || !integer(end) || end < start || total !== null && (!integer(total) || total <= end)) return null;
  return { start, end, total };
}

function unsatisfiedRange(value) {
  const match = typeof value === 'string' && /^bytes\s+\*\/(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const total = Number(match[1]);
  return integer(total) ? total : null;
}

function decodeFilename(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

export function filenameFromDisposition(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8|utf-8)''([^;\r\n]+)/i.exec(value);
  if (extended) return decodeFilename(extended[1].trim().replace(/^"|"$/g, ''));
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"])*)"/i.exec(value);
  if (quoted) return quoted[1].replace(/\\(["\\])/g, '$1');
  const plain = /(?:^|;)\s*filename\s*=\s*([^;\r\n]+)/i.exec(value);
  return plain ? plain[1].trim() : null;
}

export function safeDownloadFilename(value, fallback = 'download') {
  const normalized = typeof value === 'string' ? value.replace(/\\/g, '/') : '';
  let name = path.posix.basename(normalized).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') name = fallback;
  if (RESERVED_WINDOWS_NAMES.test(name)) name = '_' + name;
  if (name.length <= 180) return name;
  const extension = path.extname(name).slice(0, 24);
  return name.slice(0, Math.max(1, 180 - extension.length)) + extension;
}

export function directoryDisplayName(value) {
  const directory = path.resolve(value);
  const name = path.basename(directory);
  if (name) return name;
  return process.platform === 'win32' ? '本地磁盘' : '根目录';
}

export function buildSegments(total, count) {
  if (!integer(total) || total <= 0) return [];
  const size = Math.max(1, Math.min(Math.trunc(count), total));
  const segments = [];
  for (let index = 0; index < size; index++) {
    const start = Math.floor(total * index / size);
    const end = Math.floor(total * (index + 1) / size) - 1;
    if (end >= start) segments.push({ start, end, transferred: 0 });
  }
  return segments;
}

export async function availableDiskSpace(directory) {
  const value = await statfs(directory);
  const available = Number(value.bavail) * Number(value.bsize);
  return Number.isFinite(available) && available >= 0 ? available : 0;
}

function validTaskId(value) {
  return typeof value === 'string' && /^[a-f0-9-]{16,64}$/i.test(value);
}

function validStatus(value) {
  return DOWNLOAD_STATUSES.includes(value);
}

function normalizeError(error, task) {
  if (error instanceof DownloadError) return error;
  const code = error?.code;
  if (/禁止访问本机和私有网络/.test(error?.message ?? '')) return new DownloadError('下载链接不能指向本机或私有网络。', { cause: error });
  if (code === 'ENOSPC') return new DownloadError('下载文件夹空间不足。', { pause: true, cause: error });
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new DownloadError('下载文件夹无法写入，请重新选择。', { pause: true, cause: error });
  if (code === 'ENOENT' || code === 'ENOTDIR') return new DownloadError('下载文件夹不可用，请重新选择。', { pause: true, cause: error });
  if (task?.supportsRange) return new DownloadError('网络连接中断，可稍后继续下载。', { retryable: true, cause: error });
  return new DownloadError('下载未完成，请检查网络后重新下载。', { cause: error });
}

export function publicDownloadUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) throw new DownloadError('下载链接无效。');
  let url;
  try { url = new URL(value); }
  catch { throw new DownloadError('下载链接无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new DownloadError('下载链接必须使用公开的 HTTPS 地址。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || /\.(?:localhost|local|internal)$/i.test(hostname) || isIP(hostname) && !publicAddress(hostname)) {
    throw new DownloadError('下载链接不能指向本机或私有网络。');
  }
  url.hash = '';
  return url;
}

export class Downloads {
  constructor(root, {
    defaultDirectory,
    dialog,
    request = secureRequest,
    shell = null,
    minimumSegmentBytes = MIN_SEGMENT_BYTES,
    freeSpace = availableDiskSpace,
    now = () => Date.now(),
    log = () => {},
    idleTimeoutMs = 60000,
    progressPersistMs = 1000,
  } = {}) {
    if (!root || !defaultDirectory || !dialog || typeof request !== 'function') throw new Error('下载服务初始化参数无效。');
    this.root = root;
    this.defaultDirectory = path.resolve(defaultDirectory);
    this.dialog = dialog;
    this.request = request;
    this.shell = shell;
    this.minimumSegmentBytes = Math.max(1, Number(minimumSegmentBytes) || MIN_SEGMENT_BYTES);
    this.freeSpace = freeSpace;
    this.now = now;
    this.log = log;
    this.idleTimeoutMs = Math.max(1000, Number(idleTimeoutMs) || 60000);
    this.progressPersistMs = Math.max(0, Number(progressPersistMs) || 0);
    this.state = {
      schemaVersion: 1,
      preferences: {
        directoryPath: this.defaultDirectory,
        directoryName: directoryDisplayName(this.defaultDirectory),
        concurrency: DEFAULT_DOWNLOAD_CONCURRENCY,
      },
      tasks: [],
    };
    this.active = new Map();
    this.directories = new Map();
    this.speeds = new Map();
    this.persistQueue = Promise.resolve();
    this.closed = false;
    this.stateFile = path.join(root, 'state.json');
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { this.defaultDirectory = await realpath(this.defaultDirectory); }
    catch {}
    try {
      const value = JSON.parse(await readFile(this.stateFile, 'utf8'));
      const preferences = value?.preferences;
      const tasks = Array.isArray(value?.tasks) ? value.tasks : [];
      if (value?.schemaVersion !== 1 || !preferences || typeof preferences !== 'object') throw new Error('invalid state');
      const directoryPath = typeof preferences.directoryPath === 'string' && path.isAbsolute(preferences.directoryPath)
        ? preferences.directoryPath : this.defaultDirectory;
      let canonicalDirectory = directoryPath;
      try { canonicalDirectory = await realpath(directoryPath); }
      catch {}
      const concurrency = Number.isInteger(preferences.concurrency) && preferences.concurrency >= 1 && preferences.concurrency <= 4
        ? preferences.concurrency : DEFAULT_DOWNLOAD_CONCURRENCY;
      this.state.preferences = {
        directoryPath: canonicalDirectory,
        directoryName: directoryDisplayName(canonicalDirectory),
        concurrency,
      };
      this.state.tasks = tasks.map(task => this.#restoreTask(task)).filter(Boolean);
    } catch (error) {
      if (error.code !== 'ENOENT') await rename(this.stateFile, this.stateFile + '.corrupt-' + this.now()).catch(() => {});
      this.state.tasks = [];
    }
    for (const task of this.state.tasks) {
      if (['queued', 'probing', 'downloading'].includes(task.status)) {
        task.status = 'queued';
        task.error = null;
      }
    }
    await this.#persist();
  }

  #restoreTask(value) {
    if (!value || typeof value !== 'object' || !validTaskId(value.id) || typeof value.ownerId !== 'string' || !value.ownerId
      || typeof value.url !== 'string' || typeof value.directoryPath !== 'string' || !path.isAbsolute(value.directoryPath)
      || !integer(value.directoryDev) || !integer(value.directoryIno)
      || !validStatus(value.status) || !DOWNLOAD_MODES.includes(value.mode)
      || typeof value.filename !== 'string' && value.filename !== null
      || typeof value.requestedFilename !== 'string' && value.requestedFilename !== null
      || !Array.isArray(value.segments) || value.segments.length > 4) return null;
    let url;
    try { url = publicDownloadUrl(value.url); }
    catch { return null; }
    const segments = [];
    for (const segment of value.segments) {
      if (!segment || !integer(segment.start) || !integer(segment.end) || segment.end < segment.start
        || !integer(segment.transferred) || segment.transferred > segment.end - segment.start + 1) return null;
      segments.push({ start: segment.start, end: segment.end, transferred: segment.transferred });
    }
    const transferred = integer(value.transferred) ? value.transferred : 0;
    const total = value.total === null ? null : integer(value.total) ? value.total : null;
    if (total !== null && total > MAX_DOWNLOAD_BYTES) return null;
    if (segments.length && total !== null) {
      let cursor = 0;
      for (const segment of segments) {
        if (segment.start !== cursor || total <= segment.end) return null;
        cursor = segment.end + 1;
      }
      if (cursor !== total) return null;
    }
    return {
      id: value.id,
      ownerId: value.ownerId,
      ownerTitle: typeof value.ownerTitle === 'string' ? value.ownerTitle.slice(0, 200) : value.ownerId,
      url: url.href,
      directoryPath: value.directoryPath,
      directoryName: directoryDisplayName(value.directoryPath),
      directoryDev: value.directoryDev,
      directoryIno: value.directoryIno,
      status: value.status,
      mode: value.mode,
      concurrency: Number.isInteger(value.concurrency) && value.concurrency >= 1 && value.concurrency <= 4
        ? value.concurrency : DEFAULT_DOWNLOAD_CONCURRENCY,
      hostname: url.hostname,
      filename: typeof value.filename === 'string' ? safeDownloadFilename(value.filename) : null,
      requestedFilename: typeof value.requestedFilename === 'string' ? safeDownloadFilename(value.requestedFilename) : null,
      mime: typeof value.mime === 'string' ? value.mime : 'application/octet-stream',
      total,
      transferred,
      segments,
      supportsRange: Boolean(value.supportsRange),
      remoteKnown: Boolean(value.remoteKnown),
      resetRequired: Boolean(value.resetRequired),
      etag: typeof value.etag === 'string' ? value.etag : null,
      lastModified: typeof value.lastModified === 'string' ? value.lastModified : null,
      error: typeof value.error === 'string' ? value.error.slice(0, 1000) : null,
      createdAt: integer(value.createdAt) ? value.createdAt : this.now(),
      updatedAt: integer(value.updatedAt) ? value.updatedAt : this.now(),
      completedAt: integer(value.completedAt) ? value.completedAt : null,
    };
  }

  #persist() {
    const text = JSON.stringify(this.state);
    const operation = this.persistQueue.then(async () => {
      const temporary = this.stateFile + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, this.stateFile);
    });
    this.persistQueue = operation.catch(() => {});
    return operation;
  }

  #canManage(plugin) {
    return plugin?.permissions?.downloads === 'manage' && ['market', 'bundled'].includes(plugin.source);
  }

  #assertUse(plugin) {
    if (!plugin || !['use', 'manage'].includes(plugin.permissions?.downloads)) throw new DownloadError('下载能力未授权。');
    if (typeof plugin.id !== 'string' || !plugin.id) throw new DownloadError('插件身份无效。');
  }

  #assertManage(plugin) {
    this.#assertUse(plugin);
    if (!this.#canManage(plugin)) throw new DownloadError('全局下载设置仅允许官方工具修改。');
  }

  async #directory(directoryPath, expected = null) {
    try {
      const info = await lstat(directoryPath);
      if (info.isSymbolicLink() || !info.isDirectory()) return { ok: false };
      if (expected && (info.dev !== expected.dev || info.ino !== expected.ino)) return { ok: false };
      return { ok: true, dev: info.dev, ino: info.ino, name: directoryDisplayName(directoryPath) };
    } catch {
      return { ok: false };
    }
  }

  async #configuredDirectory() {
    const value = this.state.preferences;
    return this.#directory(value.directoryPath);
  }

  async preferences(plugin) {
    this.#assertUse(plugin);
    const directory = await this.#configuredDirectory();
    return {
      directoryName: this.state.preferences.directoryName,
      directoryAvailable: directory.ok,
      concurrency: this.state.preferences.concurrency,
    };
  }

  async pickDirectory(plugin) {
    this.#assertUse(plugin);
    const result = await this.dialog.showOpenDialog({
      title: '文件下载器 · 选择下载文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    let directoryPath;
    try { directoryPath = await realpath(result.filePaths[0]); }
    catch { throw new DownloadError('下载文件夹不可用，请重新选择。'); }
    const info = await lstat(directoryPath).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new DownloadError('下载文件夹不可用，请重新选择。');
    const token = randomUUID();
    const name = directoryDisplayName(directoryPath);
    this.directories.set(token, { owner: plugin.id, directoryPath, dev: info.dev, ino: info.ino, name });
    return { token, name };
  }

  async configure(plugin, args = {}) {
    this.#assertManage(plugin);
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['directoryToken', 'concurrency'].includes(key))) throw new DownloadError('下载设置无效。');
    if (args.concurrency !== undefined && (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 4)) {
      throw new DownloadError('下载连接数只能设置为 1 到 4。');
    }
    let next = { ...this.state.preferences };
    if (args.directoryToken !== undefined) {
      if (typeof args.directoryToken !== 'string') throw new DownloadError('下载文件夹授权无效。');
      const grant = this.directories.get(args.directoryToken);
      if (!grant || grant.owner !== plugin.id) throw new DownloadError('下载文件夹授权已失效。');
      const directory = await this.#directory(grant.directoryPath, grant);
      if (!directory.ok) throw new DownloadError('下载文件夹不可用，请重新选择。');
      next = { ...next, directoryPath: grant.directoryPath, directoryName: directory.name };
    }
    if (args.concurrency !== undefined) next.concurrency = args.concurrency;
    this.state.preferences = next;
    await this.#persist();
    return this.preferences(plugin);
  }

  async #destination(plugin, token) {
    if (token === undefined || token === null) {
      const directory = await this.#configuredDirectory();
      if (!directory.ok) throw new DownloadError('下载文件夹不可用，请重新选择。');
      return {
        directoryPath: this.state.preferences.directoryPath,
        directoryName: this.state.preferences.directoryName,
        dev: directory.dev,
        ino: directory.ino,
      };
    }
    if (typeof token !== 'string') throw new DownloadError('下载文件夹授权无效。');
    const grant = this.directories.get(token);
    if (!grant || grant.owner !== plugin.id) throw new DownloadError('下载文件夹授权已失效。');
    const directory = await this.#directory(grant.directoryPath, grant);
    if (!directory.ok) throw new DownloadError('下载文件夹不可用，请重新选择。');
    return { directoryPath: grant.directoryPath, directoryName: grant.name, dev: grant.dev, ino: grant.ino };
  }

  async #replaceTaskDirectory(task, token, plugin) {
    if (token === undefined) return false;
    const destination = await this.#destination(plugin, token);
    if (destination.directoryPath === task.directoryPath && !task.resetRequired) {
      task.directoryDev = destination.dev;
      task.directoryIno = destination.ino;
      return false;
    }
    await this.#removePart(task);
    task.directoryPath = destination.directoryPath;
    task.directoryName = destination.directoryName;
    task.directoryDev = destination.dev;
    task.directoryIno = destination.ino;
    task.filename = task.requestedFilename;
    task.segments = [];
    task.transferred = 0;
    task.mode = 'single';
    task.supportsRange = false;
    task.remoteKnown = false;
    task.resetRequired = false;
    task.error = null;
    return true;
  }

  #task(plugin, args = {}, allowed = ['id']) {
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !allowed.includes(key))
      || !validTaskId(args.id)) throw new DownloadError('下载任务不可用。');
    const task = this.state.tasks.find(value => value.id === args.id);
    if (!task || task.ownerId !== plugin.id && !this.#canManage(plugin)) throw new DownloadError('下载任务不可用。');
    return task;
  }

  #snapshot(task) {
    const transferred = task.mode === 'segmented'
      ? task.segments.reduce((sum, segment) => sum + segment.transferred, 0)
      : task.transferred;
    const total = task.total;
    const speed = task.status === 'downloading' ? Math.max(0, Math.round(this.speeds.get(task.id)?.speed || 0)) : 0;
    return {
      id: task.id,
      ownerId: task.ownerId,
      ownerTitle: task.ownerTitle,
      filename: task.filename || task.requestedFilename || null,
      hostname: task.hostname,
      directoryName: task.directoryName,
      status: task.status,
      mode: task.mode,
      progress: statusProgress(task.status, transferred, total),
      transferred,
      total: total ?? 0,
      speed,
      error: task.status === 'completed' || task.status === 'canceled' ? null : task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      canPause: ['queued', 'probing', 'downloading'].includes(task.status),
      canResume: ['paused', 'failed'].includes(task.status) && !task.resetRequired,
      canCancel: ['queued', 'probing', 'downloading', 'paused', 'failed'].includes(task.status),
      canRemove: task.status !== 'downloading' && task.status !== 'probing',
      canReveal: task.status === 'completed',
    };
  }

  async probe(plugin, args = {}) {
    this.#assertUse(plugin);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'url')) throw new DownloadError('下载检测请求无效。');
    const url = publicDownloadUrl(args.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.idleTimeoutMs);
    timer.unref?.();
    try {
      const value = await this.#probeRemote(url, controller.signal);
      return this.#probeSnapshot(value, this.state.preferences.concurrency);
    } catch (error) {
      throw normalizeError(error);
    } finally { clearTimeout(timer); }
  }

  #probeSnapshot(probe, concurrency) {
    return {
      hostname: probe.hostname,
      filename: probe.filename,
      size: probe.total,
      mime: probe.mime,
      supportsRange: probe.supportsRange,
      resumable: probe.supportsRange,
      mode: recommendedMode(probe.total, probe.supportsRange, concurrency, this.minimumSegmentBytes),
    };
  }

  async start(plugin, args = {}) {
    this.#assertUse(plugin);
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['url', 'filename', 'directoryToken', 'concurrency'].includes(key))) throw new DownloadError('下载请求无效。');
    if (args.concurrency !== undefined && (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 4)) {
      throw new DownloadError('下载连接数只能设置为 1 到 4。');
    }
    if (args.filename !== undefined && (typeof args.filename !== 'string' || !args.filename.trim() || args.filename.length > 512)) {
      throw new DownloadError('文件名无效。');
    }
    const url = publicDownloadUrl(args.url);
    const destination = await this.#destination(plugin, args.directoryToken);
    const now = this.now();
    const task = {
      id: randomUUID(),
      ownerId: plugin.id,
      ownerTitle: typeof plugin.title === 'string' && plugin.title ? plugin.title : plugin.id,
      url: url.href,
      directoryPath: destination.directoryPath,
      directoryName: destination.directoryName,
      directoryDev: destination.dev,
      directoryIno: destination.ino,
      status: 'queued',
      mode: 'single',
      concurrency: args.concurrency ?? this.state.preferences.concurrency,
      hostname: url.hostname,
      filename: null,
      requestedFilename: args.filename ? safeDownloadFilename(args.filename) : null,
      mime: 'application/octet-stream',
      total: null,
      transferred: 0,
      segments: [],
      supportsRange: false,
      remoteKnown: false,
      resetRequired: false,
      etag: null,
      lastModified: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.state.tasks.push(task);
    try { await this.#persist(); }
    catch (error) {
      this.state.tasks = this.state.tasks.filter(value => value.id !== task.id);
      throw new DownloadError('无法保存下载任务，请检查磁盘空间。', { cause: error });
    }
    this.#launch(task);
    return this.#snapshot(task);
  }

  async list(plugin, args = {}) {
    this.#assertUse(plugin);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'all')) throw new DownloadError('下载任务查询无效。');
    const all = args.all === true && this.#canManage(plugin);
    return this.state.tasks
      .filter(task => all || task.ownerId === plugin.id)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(task => this.#snapshot(task));
  }

  async get(plugin, args = {}) {
    this.#assertUse(plugin);
    return this.#snapshot(this.#task(plugin, args));
  }

  #launch(task) {
    if (this.closed || this.active.has(task.id) || task.status !== 'queued') return;
    const controller = new AbortController();
    const operation = this.#execute(task, controller);
    const active = { controller, done: operation };
    this.active.set(task.id, active);
    void operation.finally(() => {
      if (this.active.get(task.id) === active) this.active.delete(task.id);
    }).catch(() => {});
  }

  async #settle(id) {
    const active = this.active.get(id);
    if (!active) return;
    active.controller.abort();
    await active.done.catch(() => {});
  }

  async #execute(task, controller) {
    let file = null;
    try {
      task.status = 'probing';
      task.error = null;
      task.updatedAt = this.now();
      await this.#persist();
      const probe = await this.#probeRemote(publicDownloadUrl(task.url), controller.signal);
      controller.signal.throwIfAborted();
      if (task.remoteKnown && changedRemote(task, probe)) {
        task.resetRequired = true;
        throw new RemoteChanged();
      }
      Object.assign(task, {
        hostname: probe.hostname,
        mime: probe.mime,
        total: probe.total,
        etag: probe.etag,
        lastModified: probe.lastModified,
        supportsRange: probe.supportsRange,
        remoteKnown: true,
        updatedAt: this.now(),
      });
      if (!task.supportsRange && task.segments.length) {
        task.segments = [];
        task.transferred = 0;
        task.mode = 'single';
      }
      task.filename = await this.#allocateFilename(task, task.filename || task.requestedFilename || probe.filename);
      if (task.segments.length && task.total !== null) {
        const expected = buildSegments(task.total, task.concurrency);
        const resumable = task.mode === 'segmented' && expected.length === task.segments.length
          && expected.every((segment, index) => segment.start === task.segments[index].start && segment.end === task.segments[index].end);
        if (!resumable) { task.segments = []; task.transferred = 0; task.mode = 'single'; }
      }
      if (!task.segments.length && !task.transferred) {
        task.mode = recommendedMode(task.total, task.supportsRange, task.concurrency, this.minimumSegmentBytes);
      }
      if (task.mode === 'segmented') task.segments = task.segments.length ? task.segments : buildSegments(task.total, task.concurrency);
      if (task.mode === 'single' && probe.supportsRange === false) task.supportsRange = false;
      await this.#assertSpace(task);
      controller.signal.throwIfAborted();
      file = await this.#openPart(task);
      task.status = 'downloading';
      task.updatedAt = this.now();
      await this.#persist();
      try {
        if (task.mode === 'segmented') await this.#segmented(task, file, controller.signal);
        else await this.#single(task, file, controller.signal);
      } catch (error) {
        if (!(error instanceof RangeUnavailable)) throw error;
        this.log('info', task.hostname, '分段下载不可用，改用普通下载。', { taskId: task.id, reason: error.message });
        await file.close(); file = null;
        await this.#resetForSingle(task);
        file = await this.#openPart(task, true);
        task.status = 'downloading';
        await this.#persist();
        await this.#single(task, file, controller.signal);
      }
      controller.signal.throwIfAborted();
      if (task.mode === 'segmented' && task.segments.some(segment => segment.transferred !== segment.end - segment.start + 1)) {
        throw new DownloadError('分段下载不完整，可稍后继续。', { retryable: true });
      }
      if (task.mode === 'single' && task.total !== null && task.transferred !== task.total) {
        throw new DownloadError('下载文件不完整，可稍后继续。', { retryable: true });
      }
      await file.sync();
      await file.close(); file = null;
      controller.signal.throwIfAborted();
      const published = await this.#publish(task, controller.signal);
      if (controller.signal.aborted) {
        await rm(published, { force: true }).catch(() => {});
        controller.signal.throwIfAborted();
      }
      task.status = 'completed';
      task.error = null;
      task.completedAt = this.now();
      task.updatedAt = task.completedAt;
      this.speeds.delete(task.id);
      this.log('info', task.hostname, '下载完成', { taskId: task.id, bytes: task.total });
    } catch (error) {
      await file?.close().catch(() => {});
      file = null;
      if (controller.signal.aborted || ['paused', 'canceled', 'queued'].includes(task.status)) return;
      const normalized = normalizeError(error, task);
      task.status = normalized.pause || task.supportsRange ? 'paused' : 'failed';
      task.error = normalized.message;
      task.updatedAt = this.now();
      if (!task.supportsRange && task.status === 'failed') await this.#removePart(task);
      this.speeds.delete(task.id);
      this.log('warn', task.hostname, normalized.message, { taskId: task.id });
    } finally {
      task.updatedAt = this.now();
      await this.#persist().catch(() => {});
    }
  }

  async #requestHeaders(url, options = {}) {
    const controller = new AbortController();
    const combined = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new DownloadError('连接下载服务器超时。', { retryable: true })), this.idleTimeoutMs);
    timer.unref?.();
    try {
      return await this.request(url.href, { ...options, signal: combined, redirect: 'manual', allowRedirectResponses: true });
    } finally { clearTimeout(timer); }
  }

  async #fetchChecked(url, options = {}) {
    let current = url;
    for (let hop = 0; hop < 8; hop++) {
      const response = await this.#requestHeaders(current, options);
      if (!REDIRECT_STATUSES.has(response.status)) return { response, url: current };
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || hop === 7) throw new DownloadError('下载重定向无效。');
      let next;
      try { next = new URL(location, current); }
      catch { throw new DownloadError('下载重定向无效。'); }
      current = publicDownloadUrl(next.href);
    }
    throw new DownloadError('下载重定向无效。');
  }

  #assertEncoding(response) {
    const encoding = response.headers.get('content-encoding');
    if (encoding && !/^identity$/i.test(encoding.trim())) throw new DownloadError('下载服务器返回了不支持的压缩内容。');
  }

  async #probeRemote(url, signal) {
    let head = null;
    let headMeta = { total: null, mime: null, filename: null, etag: null, lastModified: null };
    try {
      const result = await this.#fetchChecked(url, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' }, signal });
      head = result.response;
      if (head.status >= 200 && head.status < 300) {
        headMeta = {
          total: parseLength(head.headers.get('content-length')),
          mime: mediaType(head.headers.get('content-type')),
          filename: filenameFromDisposition(head.headers.get('content-disposition')),
          etag: head.headers.get('etag'),
          lastModified: head.headers.get('last-modified'),
        };
      }
    } finally { await head?.body?.cancel().catch(() => {}); }

    let range = null;
    try {
      const result = await this.#fetchChecked(url, {
        method: 'GET',
        headers: { 'Accept-Encoding': 'identity', Range: 'bytes=0-0' },
        signal,
      });
      range = result.response;
      this.#assertEncoding(range);
      const responseTotal = parseLength(range.headers.get('content-length'));
      const disposition = filenameFromDisposition(range.headers.get('content-disposition'));
      const mime = mediaType(range.headers.get('content-type'));
      if (range.status === 206) {
        const parsed = contentRange(range.headers.get('content-range'));
        const supportsRange = Boolean(parsed && parsed.start === 0 && parsed.end === 0 && responseTotal === 1 && parsed.total !== null);
        const total = parsed?.total ?? headMeta.total;
        assertDownloadSize(total);
        return {
          hostname: result.url.hostname,
          filename: safeDownloadFilename(disposition || headMeta.filename || filenameFromUrl(result.url), mimeExtensionFallback('download', mime)),
          total,
          mime: mime || headMeta.mime || 'application/octet-stream',
          supportsRange,
          etag: range.headers.get('etag') ?? headMeta.etag,
          lastModified: range.headers.get('last-modified') ?? headMeta.lastModified,
        };
      }
      if (range.status === 200) {
        const total = responseTotal ?? headMeta.total;
        assertDownloadSize(total);
        return {
          hostname: result.url.hostname,
          filename: safeDownloadFilename(disposition || headMeta.filename || filenameFromUrl(result.url), mimeExtensionFallback('download', mime)),
          total,
          mime: mime || headMeta.mime || 'application/octet-stream',
          supportsRange: false,
          etag: range.headers.get('etag') ?? headMeta.etag,
          lastModified: range.headers.get('last-modified') ?? headMeta.lastModified,
        };
      }
      if (range.status === 416) {
        const total = unsatisfiedRange(range.headers.get('content-range')) ?? headMeta.total;
        if (total === 0) {
          return {
            hostname: result.url.hostname,
            filename: safeDownloadFilename(disposition || headMeta.filename || filenameFromUrl(result.url), mimeExtensionFallback('download', mime)),
            total: 0,
            mime: mime || headMeta.mime || 'application/octet-stream',
            supportsRange: true,
            etag: range.headers.get('etag') ?? headMeta.etag,
            lastModified: range.headers.get('last-modified') ?? headMeta.lastModified,
          };
        }
      }
      if (![200, 206, 416].includes(range.status)) throw httpError(range.status);
    } finally { await range?.body?.cancel().catch(() => {}); }

    assertDownloadSize(headMeta.total);
    return {
      hostname: url.hostname,
      filename: safeDownloadFilename(headMeta.filename || filenameFromUrl(url), mimeExtensionFallback('download', headMeta.mime)),
      total: headMeta.total,
      mime: headMeta.mime || 'application/octet-stream',
      supportsRange: false,
      etag: headMeta.etag,
      lastModified: headMeta.lastModified,
    };
  }

  async #assertSpace(task) {
    if (task.total === null) return;
    const completed = task.mode === 'segmented'
      ? task.segments.reduce((sum, segment) => sum + segment.transferred, 0)
      : task.transferred;
    const required = Math.max(0, task.total - completed);
    if (required === 0) return;
    const available = await this.freeSpace(task.directoryPath).catch(() => null);
    if (available === null) return;
    if (available < required) throw new DownloadError('下载文件夹空间不足。', { pause: true });
  }

  async #assertTaskDirectory(task) {
    const directory = await this.#directory(task.directoryPath, { dev: task.directoryDev, ino: task.directoryIno });
    if (!directory.ok) throw new DownloadError('下载文件夹已改变，请重新选择。', { pause: true });
  }

  #partPath(task) {
    return path.join(task.directoryPath, '.' + task.id + '.part');
  }

  async #openPart(task, reset = false) {
    await this.#assertTaskDirectory(task);
    const filename = this.#partPath(task);
    let exists = false;
    try {
      const info = await lstat(filename);
      if (info.isSymbolicLink() || !info.isFile()) throw new DownloadError('下载临时文件不可用。', { pause: true });
      exists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!exists) {
      task.segments = task.segments.map(segment => ({ ...segment, transferred: 0 }));
      task.transferred = 0;
      reset = true;
    }
    let file;
    try { file = await open(filename, reset || !exists ? 'w+' : 'r+', 0o600); }
    catch (error) { throw normalizeError(error, task); }
    if (task.total !== null) await file.truncate(task.total);
    else if (reset || !exists) await file.truncate(0);
    return file;
  }

  #write(file, chunk, position) {
    let offset = 0;
    return (async () => {
      while (offset < chunk.length) {
        const result = await file.write(chunk, offset, chunk.length - offset, position + offset);
        if (!result.bytesWritten) throw new DownloadError('无法写入下载文件。', { pause: true });
        offset += result.bytesWritten;
      }
    })();
  }

  #record(task, bytes) {
    const total = task.mode === 'segmented'
      ? task.segments.reduce((sum, segment) => sum + segment.transferred, 0)
      : task.transferred;
    const now = this.now();
    const previous = this.speeds.get(task.id);
    if (!previous) this.speeds.set(task.id, { time: now, bytes: total, speed: 0 });
    else {
      const elapsed = now - previous.time;
      if (elapsed >= 400) {
        const speed = Math.max(0, (total - previous.bytes) * 1000 / elapsed);
        previous.speed = previous.speed ? previous.speed * 0.65 + speed * 0.35 : speed;
        previous.time = now;
        previous.bytes = total;
      }
    }
    task.updatedAt = now;
  }

  #touchTask(task) {
    const now = this.now();
    const previous = this.touches?.get(task.id) || 0;
    if (this.progressPersistMs === 0 || now - previous >= this.progressPersistMs) {
      if (!this.touches) this.touches = new Map();
      this.touches.set(task.id, now);
      void this.#persist().catch(() => {});
    }
  }

  async #segmented(task, file, signal) {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      await Promise.all(task.segments.map(segment => this.#segment(task, file, segment, combined)));
    } catch (error) {
      controller.abort();
      throw error;
    }
  }

  async #segment(task, file, segment, signal) {
    const expected = segment.end - segment.start + 1;
    if (segment.transferred >= expected) return;
    const initial = segment.transferred;
    const requestController = new AbortController();
    const combined = AbortSignal.any([signal, requestController.signal]);
    let timer;
    const idle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => requestController.abort(new DownloadError('下载长时间没有响应，可稍后继续。', { retryable: true })), this.idleTimeoutMs);
      timer.unref?.();
    };
    let response;
    try {
      idle();
      const start = segment.start + segment.transferred;
      const result = await this.#fetchChecked(publicDownloadUrl(task.url), {
        method: 'GET',
        headers: { 'Accept-Encoding': 'identity', Range: `bytes=${start}-${segment.end}` },
        signal: combined,
      });
      response = result.response;
      this.#assertEncoding(response);
      if (response.status === 200 || response.status === 416) throw new RangeUnavailable('服务器未返回分段响应。');
      if (response.status !== 206 || !response.body) throw new DownloadError('分段下载响应不完整。', { retryable: true });
      const parsed = contentRange(response.headers.get('content-range'));
      if (!parsed || parsed.start !== start || parsed.end !== segment.end || parsed.total !== task.total) {
        throw new RangeUnavailable('服务器返回的分段范围不一致。');
      }
      const length = parseLength(response.headers.get('content-length'));
      if (length !== null && length !== expected - segment.transferred) throw new RangeUnavailable('服务器返回的分段长度不一致。');
      let received = 0;
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        idle();
        if (received + chunk.length > expected - initial) throw new RangeUnavailable('服务器返回了超出范围的数据。');
        await this.#write(file, chunk, start + received);
        received += chunk.length;
        segment.transferred += chunk.length;
        this.#record(task, chunk.length);
        this.#touchTask(task);
      }
      if (received !== expected - initial) throw new DownloadError('网络连接中断，可稍后继续下载。', { retryable: true });
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (requestController.signal.aborted) throw requestController.signal.reason || new DownloadError('下载超时。', { retryable: true });
      throw error;
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => {});
    }
  }

  async #resetForSingle(task) {
    await this.#assertTaskDirectory(task);
    await rm(this.#partPath(task), { force: true }).catch(() => {});
    task.mode = 'single';
    task.segments = [];
    task.transferred = 0;
    task.supportsRange = false;
    task.updatedAt = this.now();
  }

  async #single(task, file, signal) {
    let offset = task.transferred;
    if (task.total !== null && offset > task.total) {
      offset = 0;
      task.transferred = 0;
      await file.truncate(0);
    }
    const requestController = new AbortController();
    const combined = AbortSignal.any([signal, requestController.signal]);
    let timer;
    const idle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => requestController.abort(new DownloadError('下载长时间没有响应，可稍后继续。', { retryable: true })), this.idleTimeoutMs);
      timer.unref?.();
    };
    let response;
    try {
      idle();
      const headers = { 'Accept-Encoding': 'identity' };
      if (offset > 0 && task.supportsRange) headers.Range = `bytes=${offset}-`;
      const result = await this.#fetchChecked(publicDownloadUrl(task.url), { method: 'GET', headers, signal: combined });
      response = result.response;
      this.#assertEncoding(response);
      if (response.status === 416 && task.total !== null && offset === task.total) return;
      if (response.status === 206) {
        const parsed = contentRange(response.headers.get('content-range'));
        if (!parsed || parsed.start !== offset || parsed.total !== task.total) throw new RangeUnavailable();
      } else if (response.status === 200) {
        if (offset > 0) {
          offset = 0;
          task.transferred = 0;
          task.supportsRange = false;
          await file.truncate(0);
        }
        const length = parseLength(response.headers.get('content-length'));
        assertDownloadSize(length);
        if (length !== null) task.total = length;
      } else {
        throw httpError(response.status);
      }
      if (!response.body) {
        if ((task.total ?? 0) === task.transferred) return;
        throw new DownloadError('下载响应不完整。', { retryable: true });
      }
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        idle();
        const next = task.transferred + chunk.length;
        assertDownloadSize(next);
        await this.#write(file, chunk, task.transferred);
        task.transferred = next;
        this.#record(task, chunk.length);
        this.#touchTask(task);
      }
      if (task.total === null) task.total = task.transferred;
      if (task.transferred !== task.total) throw new DownloadError('连接中断，可稍后继续下载。', { retryable: true, pause: task.supportsRange });
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (requestController.signal.aborted) throw requestController.signal.reason || new DownloadError('下载超时。', { retryable: true });
      throw error;
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => {});
    }
  }

  async #publish(task, signal) {
    signal?.throwIfAborted();
    await this.#assertTaskDirectory(task);
    const part = this.#partPath(task);
    const info = await lstat(part);
    if (info.isSymbolicLink() || !info.isFile()) throw new DownloadError('下载临时文件不可用。', { pause: true });
    if (task.total !== null && info.size !== task.total) throw new DownloadError('下载文件大小不正确，请重新下载。', { pause: true });
    task.filename = await this.#allocateFilename(task, task.filename || task.requestedFilename || 'download');
    for (let attempt = 0; attempt < 50; attempt++) {
      signal?.throwIfAborted();
      const destination = path.join(task.directoryPath, task.filename);
      try {
        await link(part, destination);
        await unlink(part).catch(() => {});
        return destination;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          if (['EPERM', 'ENOTSUP', 'EXDEV'].includes(error.code)) {
            try {
              await copyFile(part, destination, fsConstants.COPYFILE_EXCL);
              await unlink(part).catch(() => {});
              return destination;
            } catch (copyError) {
              if (copyError.code === 'EEXIST') {
                task.filename = await this.#allocateFilename(task, task.filename);
                continue;
              }
              await rm(destination, { force: true }).catch(() => {});
              throw copyError;
            }
          }
          throw error;
        }
        task.filename = await this.#allocateFilename(task, task.filename);
      }
    }
    throw new DownloadError('无法确定保存文件名。', { pause: true });
  }

  async #allocateFilename(task, preferred) {
    const safe = safeDownloadFilename(preferred);
    const parsed = path.parse(safe);
    for (let index = 0; index < 10000; index++) {
      const candidate = index === 0
        ? safe
        : safeDownloadFilename(parsed.name + ' (' + index + ')' + parsed.ext);
      const reserved = this.state.tasks.some(other => other.id !== task.id && other.directoryPath === task.directoryPath
        && other.filename === candidate && !['canceled', 'failed'].includes(other.status));
      if (reserved) continue;
      try { await lstat(path.join(task.directoryPath, candidate)); }
      catch (error) {
        if (error.code === 'ENOENT') return candidate;
        throw new DownloadError('下载文件夹不可用，请重新选择。', { pause: true });
      }
    }
    throw new DownloadError('无法确定保存文件名。', { pause: true });
  }

  async #removePart(task) {
    const filename = this.#partPath(task);
    try {
      const info = await lstat(filename);
      if (info.isFile() || info.isSymbolicLink()) await rm(filename, { force: true });
    } catch {}
  }

  async pause(plugin, args = {}) {
    this.#assertUse(plugin);
    const task = this.#task(plugin, args);
    if (!['queued', 'probing', 'downloading'].includes(task.status)) return this.#snapshot(task);
    task.status = 'paused';
    task.error = null;
    task.updatedAt = this.now();
    await this.#settle(task.id);
    await this.#persist();
    return this.#snapshot(task);
  }

  async resume(plugin, args = {}) {
    this.#assertUse(plugin);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['id', 'directoryToken'].includes(key))) {
      throw new DownloadError('继续下载请求无效。');
    }
    const task = this.#task(plugin, args, ['id', 'directoryToken']);
    if (!['paused', 'failed'].includes(task.status)) return this.#snapshot(task);
    if (task.resetRequired && args.directoryToken === undefined) {
      throw new DownloadError('远程文件已更新，请重新创建下载任务。');
    }
    await this.#settle(task.id);
    const replaced = await this.#replaceTaskDirectory(task, args.directoryToken, plugin);
    if (!replaced) {
      const directory = await this.#directory(task.directoryPath, { dev: task.directoryDev, ino: task.directoryIno });
      if (!directory.ok) {
        task.status = 'paused';
        task.error = '下载文件夹不可用，请重新选择。';
        task.updatedAt = this.now();
        await this.#persist();
        return this.#snapshot(task);
      }
    }
    task.status = 'queued';
    task.error = null;
    task.updatedAt = this.now();
    await this.#persist();
    this.#launch(task);
    return this.#snapshot(task);
  }

  async cancel(plugin, args = {}) {
    this.#assertUse(plugin);
    const task = this.#task(plugin, args);
    if (task.status === 'completed') throw new DownloadError('已完成的文件不会被取消。');
    task.status = 'canceled';
    task.error = null;
    task.updatedAt = this.now();
    await this.#settle(task.id);
    await this.#removePart(task);
    task.segments = [];
    task.transferred = 0;
    this.speeds.delete(task.id);
    await this.#persist();
    return this.#snapshot(task);
  }

  async remove(plugin, args = {}) {
    this.#assertUse(plugin);
    const task = this.#task(plugin, args);
    if (['queued', 'probing', 'downloading'].includes(task.status)) {
      task.status = 'canceled';
      await this.#settle(task.id);
    }
    if (task.status !== 'completed') await this.#removePart(task);
    this.state.tasks = this.state.tasks.filter(value => value.id !== task.id);
    this.speeds.delete(task.id);
    await this.#persist();
  }

  async reveal(plugin, args = {}) {
    this.#assertUse(plugin);
    const task = this.#task(plugin, args);
    if (task.status !== 'completed' || !task.filename) return false;
    const filename = path.join(task.directoryPath, task.filename);
    try {
      const info = await lstat(filename);
      if (info.isSymbolicLink() || !info.isFile()) return false;
      if (typeof this.shell?.showItemInFolder !== 'function') return false;
      this.shell.showItemInFolder(filename);
      return true;
    } catch { return false; }
  }

  async stopOwner(id, message = '调用工具已停用，恢复工具后可继续下载。') {
    for (const [token, grant] of this.directories) if (grant.owner === id) this.directories.delete(token);
    const tasks = this.state.tasks.filter(task => task.ownerId === id && ['queued', 'probing', 'downloading'].includes(task.status));
    for (const task of tasks) {
      task.status = 'paused';
      task.error = message;
      task.updatedAt = this.now();
    }
    await Promise.all(tasks.map(task => this.#settle(task.id)));
    if (tasks.length) await this.#persist();
  }

  releaseOwnerTokens(id) {
    for (const [token, grant] of this.directories) if (grant.owner === id) this.directories.delete(token);
  }

  async forget(plugin) {
    const tasks = this.state.tasks.filter(task => task.ownerId === plugin.id);
    for (const task of tasks) {
      if (['queued', 'probing', 'downloading'].includes(task.status)) {
        task.status = 'canceled';
        await this.#settle(task.id);
      }
      if (task.status !== 'completed') await this.#removePart(task);
      this.speeds.delete(task.id);
    }
    this.state.tasks = this.state.tasks.filter(task => task.ownerId !== plugin.id);
    this.releaseOwnerTokens(plugin.id);
    await this.#persist();
  }

  async resumePending(ownerActive = async () => true) {
    const queued = this.state.tasks.filter(task => task.status === 'queued');
    for (const task of queued) {
      if (!await ownerActive(task.ownerId).catch(() => false)) {
        task.status = 'paused';
        task.error = '调用工具已停用，恢复工具后可继续下载。';
        task.updatedAt = this.now();
        continue;
      }
      this.#launch(task);
    }
    if (queued.length) await this.#persist();
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    const active = this.state.tasks.filter(task => ['queued', 'probing', 'downloading'].includes(task.status));
    for (const task of active) {
      task.status = 'queued';
      task.error = null;
      task.updatedAt = this.now();
    }
    await Promise.all(active.map(task => this.#settle(task.id)));
    await this.#persist();
    await this.persistQueue;
    this.releaseOwnerTokens();
  }

  async call(plugin, method, args = {}) {
    if (method === 'probe') return this.probe(plugin, args);
    if (method === 'pickDirectory') return this.pickDirectory(plugin);
    if (method === 'preferences') return this.preferences(plugin);
    if (method === 'configure') return this.configure(plugin, args);
    if (method === 'start') return this.start(plugin, args);
    if (method === 'list') return this.list(plugin, args);
    if (method === 'get') return this.get(plugin, args);
    if (method === 'pause') return this.pause(plugin, args);
    if (method === 'resume') return this.resume(plugin, args);
    if (method === 'cancel') return this.cancel(plugin, args);
    if (method === 'remove') return this.remove(plugin, args);
    if (method === 'reveal') return this.reveal(plugin, args);
    throw new DownloadError('下载接口不受支持。');
  }
}

function changedRemote(task, probe) {
  if (task.total !== null && probe.total !== null && task.total !== probe.total) return true;
  if (task.etag && task.etag !== probe.etag) return true;
  if (task.lastModified && task.lastModified !== probe.lastModified) return true;
  return false;
}

function recommendedMode(total, supportsRange, concurrency, minimumSegmentBytes) {
  return supportsRange && total !== null && total >= Math.max(2, minimumSegmentBytes) && concurrency > 1 ? 'segmented' : 'single';
}

function assertDownloadSize(value) {
  if (value !== null && value !== undefined && value > MAX_DOWNLOAD_BYTES) throw new DownloadError('文件超过 20 GB，暂不支持下载。');
}

function statusProgress(status, transferred, total) {
  if (status === 'completed') return 100;
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(99.9, transferred / total * 100));
}

function mediaType(value) {
  if (typeof value !== 'string') return null;
  return value.split(';', 1)[0].trim().toLowerCase() || null;
}

function mimeExtensionFallback(name, mime) {
  if (path.extname(name)) return name;
  const extension = MIME_EXTENSIONS.get(mime);
  return extension ? name + '.' + extension : name;
}

function filenameFromUrl(url) {
  const name = path.posix.basename(url.pathname);
  return name ? decodeFilename(name) : 'download';
}

function httpError(status) {
  if (status === 401 || status === 403) return new DownloadError('下载链接不可用或需要登录。');
  if (status === 404 || status === 410) return new DownloadError('文件不存在或链接已失效。');
  if (status === 429) return new DownloadError('下载服务器请求过于频繁，请稍后重试。', { retryable: true });
  if (status >= 500) return new DownloadError('下载服务器暂时不可用，请稍后重试。', { retryable: true });
  return new DownloadError('无法获取文件信息（HTTP ' + status + '）。');
}
