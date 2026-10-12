import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { atomicJson } from './ai-batches.mjs';
import { inspectCliProxyRelease, verifiedCliProxyDownload, validateCliProxyManifest, validateCliProxyCompatibility } from '../scripts/update-cli-proxy.mjs';

const execute = promisify(execFile);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const targets = new Set(['darwin-arm64', 'win32-x64']);

export const CLI_PROXY_UPDATE_STATES = Object.freeze({
  IDLE: 'idle', CHECKING: 'checking', AVAILABLE: 'available', CURRENT: 'current',
  DOWNLOADING: 'downloading', INSTALLING: 'installing', STOPPING: 'stopping',
  STARTING: 'starting', READY: 'ready', ROLLING_BACK: 'rolling-back', ERROR: 'error',
});

const binaryName = target => target === 'win32-x64' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async filename => hash(await readFile(filename));
function archiveMember(name) {
  const value = String(name).replaceAll('\\', '/');
  const normalized = path.posix.normalize(value);
  if (!value || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) throw new Error('CLIProxyAPI 制品包含越界文件路径。');
  return normalized.replace(/^\.\//, '');
}

function targetFor(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!targets.has(target)) throw new Error(`当前系统不支持 CLIProxyAPI 更新：${target}`);
  return target;
}

function exactVersion(value) {
  if (typeof value !== 'string' || !versionPattern.test(value)) throw new Error('CLIProxyAPI 版本无效。');
  return value;
}
function newerVersion(candidate, current) {
  const left = candidate.split('.').map(Number), right = current.split('.').map(Number);
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index] > right[index];
  return false;
}

async function regularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error('CLIProxyAPI 制品缺少有效的可执行文件。');
  return info;
}

// The archive is first unpacked outside the active version directory. Only a
// regular expected binary and license are copied into the staged directory.
export async function extractCliProxyArchive(bytes, target, destination, { extractor } = {}) {
  targetFor(...target.split('-'));
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('CLIProxyAPI 下载制品为空。');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-cli-proxy-'));
  try {
    const unpack = extractor ?? (async (output) => {
      if (target === 'win32-x64') {
        const zip = new AdmZip(bytes);
        for (const entry of zip.getEntries()) {
          archiveMember(entry.entryName);
          if (!entry.isDirectory) zip.extractEntryTo(entry, output, true, true);
        }
      } else {
        const archive = path.join(output, 'archive.tar.gz');
        await writeFile(archive, bytes, { mode: 0o600 });
        const listing = await execute('tar', ['-tzf', archive], { timeout: 120000 });
        for (const member of listing.stdout.split(/\r?\n/).filter(Boolean)) archiveMember(member);
        await execute('tar', ['-xzf', archive, '--no-same-owner', '-C', output], { timeout: 120000 });
      }
    });
    await unpack(temporary);
    const executable = path.join(temporary, binaryName(target));
    await regularFile(executable);
    const destinationBinary = path.join(destination, binaryName(target));
    await copyFile(executable, destinationBinary);
    await chmod(destinationBinary, 0o755);
    const license = path.join(temporary, 'LICENSE');
    try { if ((await lstat(license)).isFile()) await copyFile(license, path.join(destination, 'CLIProxyAPI-LICENSE')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { binary: destinationBinary, sha256: await fileHash(destinationBinary) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function activeRecord(value, target) {
  if (!value || value.schemaVersion !== 1 || value.target !== target) throw new Error('CLIProxyAPI active 版本记录无效。');
  const version = exactVersion(value.version), expected = path.posix.join('versions', version, binaryName(target));
  if (value.binary !== expected) throw new Error('CLIProxyAPI active 路径无效。');
  return { ...value, version };
}

export class CliProxyUpdateService {
  constructor({ proxy, root, target = targetFor(), request = fetch, cacheDirectory, changed = () => {}, inspect = inspectCliProxyRelease, download = verifiedCliProxyDownload, extract = extractCliProxyArchive } = {}) {
    if (!proxy || typeof proxy.status !== 'function' || typeof proxy.setBinary !== 'function') throw new Error('CLIProxyAPI 更新器缺少运行时。');
    this.proxy = proxy; this.root = root; this.target = targetFor(...target.split('-')); this.request = request; this.changed = changed;
    this.cacheDirectory = cacheDirectory ?? path.join(root, 'updates'); this.inspect = inspect; this.download = download; this.extract = extract;
    this.activeFile = path.join(root, 'active.json'); this.versions = path.join(root, 'versions'); this.pending = null; this.controller = null; this.candidate = null;
    const current = proxy.status();
    this.state = { status: CLI_PROXY_UPDATE_STATES.IDLE, currentVersion: current.version, candidateVersion: null, updateAvailable: false, canUpdate: false, progress: 0, transferred: 0, total: 0, error: null, compatibility: 'unverified' };
  }
  set(value) { Object.assign(this.state, value); this.changed(); }
  fail(error) { this.set({ status: CLI_PROXY_UPDATE_STATES.ERROR, error: error?.message || String(error), progress: 0, transferred: 0, total: 0, canUpdate: false }); }
  cancel(reason = new Error('CLIProxyAPI 更新已取消。')) { this.controller?.abort(reason); }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let raw;
    try { raw = JSON.parse(await readFile(this.activeFile, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return this.state;
      await rm(this.activeFile, { force: true });
      this.fail(new Error('CLIProxyAPI active 版本读取失败。'));
      return this.state;
    }
    try {
      const record = activeRecord(raw, this.target), binary = path.join(this.root, record.binary);
      await regularFile(binary);
      if (record.binarySha256 && record.binarySha256 !== await fileHash(binary)) throw new Error('CLIProxyAPI active 文件校验失败。');
      await this.proxy.setBinary(binary, record.version, { resetVerification: false });
      this.set({ currentVersion: record.version });
    } catch (error) {
      // A damaged pointer must never prevent the bundled binary from starting.
      // Remove only the pointer; versioned files remain available for later
      // forensic cleanup or a fresh, verified install.
      await rm(this.activeFile, { force: true });
      this.fail(error);
    }
    return this.state;
  }
  start(task) {
    const controller = new AbortController(); this.controller = controller;
    this.pending = Promise.resolve().then(task).catch(error => { this.fail(error); return this.state; }).finally(() => { if (this.controller === controller) this.controller = null; this.pending = null; });
    return this.pending;
  }
  requestWithCancellation(url, options = {}) {
    const signal = this.controller?.signal;
    return this.request(url, { ...options, ...(signal ? { signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal } : {}) });
  }
  check() {
    if (this.pending) return this.pending;
    this.set({ status: CLI_PROXY_UPDATE_STATES.CHECKING, candidateVersion: null, updateAvailable: false, canUpdate: false, error: null, progress: 0, compatibility: 'unverified' });
    return this.start(async () => {
      const current = this.proxy.status().version, manifest = await this.inspect({ request: this.requestWithCancellation.bind(this) });
      validateCliProxyManifest(manifest);
      const available = newerVersion(manifest.version, current);
      this.candidate = manifest;
      this.set({ status: available ? CLI_PROXY_UPDATE_STATES.AVAILABLE : CLI_PROXY_UPDATE_STATES.CURRENT, currentVersion: current, candidateVersion: available ? manifest.version : null, updateAvailable: available, canUpdate: false, compatibility: 'unverified' });
      return this.state;
    });
  }
  approveCandidate(evidence) {
    if (!this.candidate || !this.state.updateAvailable) throw new Error('没有待验收的 CLIProxyAPI 候选。');
    // This method is intentionally not exposed through renderer IPC. A trusted
    // release/validation workflow must supply both platform smoke results and
    // matching artifact hashes before the UI can offer an install action.
    validateCliProxyCompatibility(evidence, this.candidate);
    this.set({ compatibility: 'passed', canUpdate: true });
    return this.state;
  }
  update() {
    if (this.pending) return this.pending;
    if (!this.candidate || this.state.status !== CLI_PROXY_UPDATE_STATES.AVAILABLE) throw new Error('请先检查 CLIProxyAPI 更新。');
    if (this.state.compatibility !== 'passed' || this.state.canUpdate !== true) throw new Error('CLIProxyAPI 候选尚未完成双平台兼容性验收。');
    if (this.proxy.status().mode !== 'builtin') throw new Error('外部 CLIProxyAPI 不由轻作更新。');
    const candidate = this.candidate;
    return this.start(async () => {
      const confirmed = await this.inspect({ version: candidate.version, request: this.requestWithCancellation.bind(this) });
      if (JSON.stringify(confirmed) !== JSON.stringify(candidate)) throw new Error('CLIProxyAPI 更新清单已变化，请重新检查。');
      this.set({ status: CLI_PROXY_UPDATE_STATES.DOWNLOADING, error: null, progress: 0, transferred: 0, total: 0 });
      const downloaded = await this.download(confirmed, this.target, { request: this.requestWithCancellation.bind(this), cacheDirectory: this.cacheDirectory,
        onProgress: value => { const total = value.total || this.state.total || 0; this.set({ status: CLI_PROXY_UPDATE_STATES.DOWNLOADING, progress: total ? Math.min(100, value.transferred / total * 100) : 0, transferred: value.transferred, total }); } });
      this.set({ progress: 100, transferred: downloaded.bytes.length, total: downloaded.bytes.length, status: CLI_PROXY_UPDATE_STATES.INSTALLING });
      await mkdir(this.versions, { recursive: true, mode: 0o700 });
      const stage = await mkdtemp(path.join(this.versions, '.staging-'));
      const versionDirectory = path.join(this.versions, candidate.version);
      const previousStatus = this.proxy.status();
      let previous = { binary: this.proxy.binary, version: previousStatus.version, running: previousStatus.running === true, verified: [...(this.proxy.settings?.verified ?? [])] };
      let previousActive;
      try { previousActive = JSON.parse(await readFile(this.activeFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try {
        const installed = await this.extract(downloaded.bytes, this.target, stage);
        const binaryRelative = path.posix.join('versions', candidate.version, binaryName(this.target));
        await atomicJson(path.join(stage, 'version.json'), { schemaVersion: 1, version: candidate.version, target: this.target, artifactSha256: confirmed.artifacts[this.target].sha256, binarySha256: installed.sha256 });
        await rm(versionDirectory, { recursive: true, force: true });
        await rename(stage, versionDirectory);
        this.set({ status: CLI_PROXY_UPDATE_STATES.STOPPING });
        await this.proxy.stop();
        await this.proxy.setBinary(path.join(this.root, binaryRelative), candidate.version);
        await atomicJson(this.activeFile, { schemaVersion: 1, version: candidate.version, target: this.target, binary: binaryRelative, binarySha256: installed.sha256 });
        this.set({ status: CLI_PROXY_UPDATE_STATES.STARTING });
        await this.proxy.start();
        if (!previous.running) await this.proxy.stop();
        this.set({ status: CLI_PROXY_UPDATE_STATES.READY, currentVersion: candidate.version, candidateVersion: null, updateAvailable: false, canUpdate: false, compatibility: 'passed', error: null });
        this.candidate = null;
        return this.state;
      } catch (error) {
        this.set({ status: CLI_PROXY_UPDATE_STATES.ROLLING_BACK });
        await this.proxy.stop().catch(() => {});
        await this.proxy.setBinary(previous.binary, previous.version, { resetVerification: false }).catch(() => {});
        if (Array.isArray(this.proxy.settings?.verified)) {
          this.proxy.settings.verified = previous.verified;
          await atomicJson(path.join(this.root, 'settings.json'), this.proxy.settings).catch(() => {});
        }
        if (previousActive) await atomicJson(this.activeFile, previousActive).catch(() => {});
        else await rm(this.activeFile, { force: true }).catch(() => {});
        if (previous.running) await this.proxy.start().catch(() => {});
        throw error;
      } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
    });
  }
}

