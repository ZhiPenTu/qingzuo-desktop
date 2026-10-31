import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_DEBUG_LOG_BYTES = 50 * 1024 * 1024;
export const MIN_DEBUG_LOG_BYTES = 1024 * 1024;
export const MAX_DEBUG_LOG_BYTES = 1024 * 1024 * 1024;
export const MAX_DEBUG_LOG_ENTRIES = 1200;
export const MAX_DEBUG_LOG_MESSAGE_LENGTH = 32 * 1024;

const SCOPES = new Set(['app', 'plugin', 'browser']);
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const LOG_FILE = /^qingzuo-debug-\d{8}-\d{6}-\d{3}-\d+-\d+\.jsonl$/;
const ACTIVE_FILE_CHUNK = 4 * 1024 * 1024;

function cleanText(value, limit) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .slice(0, limit);
}

function normalizeLevel(value) {
  if (value === 'warning') return 'warn';
  return LEVELS.has(value) ? value : 'info';
}

function normalizeEntry(value = {}) {
  const level = normalizeLevel(value.level);
  return {
    time: Number.isFinite(value.time) ? value.time : Date.now(),
    scope: SCOPES.has(value.scope) ? value.scope : 'app',
    source: cleanText(value.source || 'debug', 160),
    level,
    message: cleanText(value.message, MAX_DEBUG_LOG_MESSAGE_LENGTH),
    ...(Number.isSafeInteger(value.line) && value.line > 0 ? { line: value.line } : {}),
    ...(typeof value.url === 'string' && value.url ? { url: cleanText(value.url, 2048) } : {}),
  };
}

function fileStamp(time) {
  const date = new Date(time);
  const part = (value, length = 2) => String(value).padStart(length, '0');
  return [
    date.getFullYear(),
    part(date.getMonth() + 1),
    part(date.getDate()),
    '-',
    part(date.getHours()),
    part(date.getMinutes()),
    part(date.getSeconds()),
    '-',
    part(date.getMilliseconds(), 3),
  ].join('');
}

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

function validateMaxBytes(value) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < MIN_DEBUG_LOG_BYTES || bytes > MAX_DEBUG_LOG_BYTES) {
    throw new Error('日志保存上限必须为 1 MB 到 1024 MB。');
  }
  return bytes;
}

function validateDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) throw new Error('日志保存目录无效。');
  if (!path.isAbsolute(value)) throw new Error('日志保存目录无效。');
  return path.normalize(value);
}

export class DebugLogService {
  constructor({ root, onEntry = () => {}, onStateChange = () => {}, now = Date.now, activeFileChunk = ACTIVE_FILE_CHUNK } = {}) {
    this.root = root;
    this.settingsFile = path.join(root, 'debug-logging.json');
    this.defaultDirectory = path.join(root, 'logs');
    this.onEntry = onEntry;
    this.onStateChange = onStateChange;
    this.now = now;
    this.activeFileChunk = activeFileChunk;
    this.activeFile = null;
    this.activeBytes = 0;
    this.storedBytes = 0;
    this.fileSequence = 0;
    this.entries = [];
    this.writeQueue = Promise.resolve();
    this.state = {
      enabled: false,
      directory: this.defaultDirectory,
      maxBytes: DEFAULT_DEBUG_LOG_BYTES,
      lastError: null,
    };
  }

  snapshot() {
    return {
      enabled: this.state.enabled,
      directory: this.state.directory,
      maxBytes: this.state.maxBytes,
      currentFile: this.activeFile,
      storedBytes: this.storedBytes,
      lastError: this.state.lastError,
    };
  }

  recent() {
    return [...this.entries];
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.settingsFile, 'utf8'));
      this.state.enabled = saved?.enabled === true;
      if (typeof saved?.directory === 'string') this.state.directory = validateDirectory(saved.directory);
      if (saved?.maxBytes !== undefined) this.state.maxBytes = validateMaxBytes(saved.maxBytes);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        await rm(this.settingsFile, { force: true }).catch(() => {});
      }
    }
    if (this.state.enabled) {
      try {
        await this.ensureDirectory();
        await this.refreshStoredBytes();
        await this.prune(this.state.maxBytes);
      } catch (error) {
        this.setError(error);
      }
    }
    return this.snapshot();
  }

  async configure(options = {}) {
    const previousDirectory = this.state.directory;
    const next = {
      enabled: typeof options.enabled === 'boolean' ? options.enabled : this.state.enabled,
      directory: options.directory === undefined ? this.state.directory : validateDirectory(options.directory),
      maxBytes: options.maxBytes === undefined ? this.state.maxBytes : validateMaxBytes(options.maxBytes),
    };
    if (next.enabled) {
      await mkdir(next.directory, { recursive: true, mode: 0o700 });
    }
    this.state = { ...next, lastError: null };
    if (previousDirectory !== next.directory) {
      this.activeFile = null;
      this.activeBytes = 0;
    }
    await this.persist();
    if (this.state.enabled) {
      await this.acquireWriteQueue(async () => {
        await this.refreshStoredBytes();
        await this.prune(this.state.maxBytes);
      });
    }
    this.onStateChange(this.snapshot());
    return this.snapshot();
  }

  record(value) {
    if (!this.state.enabled) return null;
    const entry = normalizeEntry({ time: this.now(), ...value });
    this.entries.push(entry);
    if (this.entries.length > MAX_DEBUG_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_DEBUG_LOG_ENTRIES);
    }
    try {
      this.onEntry(entry);
    } catch {}
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => this.writeEntry(entry))
      .catch(error => this.setError(error));
    return entry;
  }

  async flush() {
    await this.writeQueue.catch(() => {});
  }

  async persist() {
    await atomicJson(this.settingsFile, {
      schemaVersion: 1,
      enabled: this.state.enabled,
      directory: this.state.directory,
      maxBytes: this.state.maxBytes,
    });
  }

  ensureDirectory() {
    return mkdir(this.state.directory, { recursive: true, mode: 0o700 });
  }

  acquireWriteQueue(operation) {
    const next = this.writeQueue.catch(() => {}).then(operation);
    this.writeQueue = next;
    return next;
  }

  async writeEntry(entry) {
    if (!this.state.enabled) return;
    await this.ensureDirectory();
    const line = Buffer.from(JSON.stringify(entry) + '\n');
    const rotationLimit = Math.min(this.activeFileChunk, Math.max(64 * 1024, Math.floor(this.state.maxBytes / 4)));
    if (this.activeFile && this.activeBytes > 0 && this.activeBytes + line.length > rotationLimit) {
      this.activeFile = null;
      this.activeBytes = 0;
    }
    await this.refreshStoredBytes();
    if (this.storedBytes + line.length > this.state.maxBytes) {
      this.activeFile = null;
      this.activeBytes = 0;
      await this.prune(Math.max(0, this.state.maxBytes - line.length));
    }
    if (!this.activeFile) {
      await this.prune(Math.max(0, this.state.maxBytes - line.length));
      this.activeFile = await this.nextFilename();
      await writeFile(this.activeFile, line, { flag: 'wx', mode: 0o600 });
      this.activeBytes = line.length;
      this.storedBytes += line.length;
    } else {
      await appendFile(this.activeFile, line, { mode: 0o600 });
      this.activeBytes += line.length;
      this.storedBytes += line.length;
    }
    if (this.state.lastError) {
      this.state.lastError = null;
      this.onStateChange(this.snapshot());
    }
  }

  async nextFilename() {
    while (true) {
      const filename = path.join(this.state.directory, `qingzuo-debug-${fileStamp(this.now())}-${process.pid}-${++this.fileSequence}.jsonl`);
      try {
        await stat(filename);
      } catch (error) {
        if (error?.code === 'ENOENT') return filename;
        throw error;
      }
    }
  }

  async logFiles() {
    const values = [];
    for (const name of await readdir(this.state.directory).catch(() => [])) {
      if (!LOG_FILE.test(name)) continue;
      const filename = path.join(this.state.directory, name);
      try {
        const info = await stat(filename);
        if (info.isFile()) values.push({ filename, size: info.size, modified: info.mtimeMs });
      } catch {}
    }
    return values;
  }

  async refreshStoredBytes() {
    this.storedBytes = (await this.logFiles()).reduce((total, file) => total + file.size, 0);
    return this.storedBytes;
  }

  async prune(limit) {
    const files = await this.logFiles();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((left, right) => left.modified - right.modified || left.filename.localeCompare(right.filename));
    for (const file of files) {
      if (total <= limit) break;
      if (file.filename === this.activeFile) {
        this.activeFile = null;
        this.activeBytes = 0;
      }
      await rm(file.filename, { force: true });
      total -= file.size;
    }
    this.storedBytes = total;
    return total;
  }

  setError(error) {
    this.state.lastError = cleanText(error instanceof Error ? error.message : error, 500) || '日志写入失败。';
    this.onStateChange(this.snapshot());
  }
}
