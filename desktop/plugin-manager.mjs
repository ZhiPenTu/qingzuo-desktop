import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash, verify, createPublicKey } from 'node:crypto';
import AdmZip from 'adm-zip';
import semver from 'semver';
import { validateManifest, safeRelative, confinedPath, TARGET } from './security.mjs';
export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
export function verifyArtifact(bytes, record, publicKey) {
  if (!publicKey || !record?.signature || !record?.sha256 || record.platform !== TARGET) throw new Error('市场制品缺少可信签名或平台信息。');
  if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error('插件包校验失败。');
  const key = typeof publicKey === 'string' || Buffer.isBuffer(publicKey) ? createPublicKey(publicKey) : publicKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('市场签名必须使用 Ed25519。');
  if (!verify(null, bytes, key, Buffer.from(record.signature, 'base64'))) throw new Error('插件签名无效。');
}
const INVALID_PACKAGE_MESSAGE = '插件包格式无效或文件未下载完整，请重新下载或选择有效的 .ecplugin / .zip 插件包。';
function openPackageZip(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  if (!buffer || buffer.length === 0) throw new Error(INVALID_PACKAGE_MESSAGE);
  if (buffer.length > MAX_PACKAGE_BYTES) throw new Error('插件包过大。');
  try { return new AdmZip(buffer, { trailingSpace: true }); }
  catch { throw new Error(INVALID_PACKAGE_MESSAGE); }
}
function readZipEntry(entry) {
  try { return entry.getData(); }
  catch { throw new Error(INVALID_PACKAGE_MESSAGE); }
}
function parseManifestJson(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('插件标识或清单格式无效。'); }
}
function resolvePackagePrefix(zip) {
  if (zip.getEntry('package.json')) return '';
  let entries;
  try { entries = zip.getEntries(); }
  catch { throw new Error(INVALID_PACKAGE_MESSAGE); }
  const roots = new Set();
  for (const entry of entries) {
    const trimmed = entry.entryName.replace(/\/$/, '');
    if (!trimmed) continue;
    roots.add(trimmed.split('/')[0]);
    if (roots.size > 1) return '';
  }
  const [root] = [...roots];
  if (!root || !zip.getEntry(root + '/package.json')) return '';
  safeRelative(root);
  return root + '/';
}
export function inspectPackage(bytes) {
  const zip = openPackageZip(bytes), prefix = resolvePackagePrefix(zip);
  const entry = zip.getEntry(prefix + 'package.json');
  if (!entry || entry.header.size > 65536) throw new Error('插件清单缺失或过大。');
  return validateManifest(parseManifestJson(readZipEntry(entry).toString('utf8')));
}
export async function unpackPackage(bytes, destination) {
  const zip = openPackageZip(bytes), prefix = resolvePackagePrefix(zip);
  const manifestEntry = zip.getEntry(prefix + 'package.json');
  if (!manifestEntry || manifestEntry.header.size > 65536) throw new Error('插件清单缺失或过大。');
  validateManifest(parseManifestJson(readZipEntry(manifestEntry).toString('utf8')));
  let entries;
  try { entries = zip.getEntries(); }
  catch { throw new Error(INVALID_PACKAGE_MESSAGE); }
  const seen = new Set(), items = [];
  if (entries.length > 20000) throw new Error('插件包文件过多。');
  let total = 0;
  for (const e of entries) {
    const rawName = e.entryName.replace(/\/$/, ''); safeRelative(rawName);
    if (prefix && e.isDirectory && rawName === prefix.slice(0, -1)) continue;
    const relativeEntryName = prefix ? e.entryName.slice(prefix.length) : e.entryName;
    const name = relativeEntryName.replace(/\/$/, ''); safeRelative(name);
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) throw new Error('插件包包含重复路径。'); seen.add(normalized);
    const mode = e.header.attr >>> 16;
    if ((mode & 0xf000) === 0xa000 || (mode & 0xf000) !== 0 && ![0x8000, 0x4000].includes(mode & 0xf000)) throw new Error('插件包含不支持的文件类型。');
    total += e.header.size; if (total > 2 * 1024 ** 3) throw new Error('插件包展开后过大。');
    items.push({ entry: e, relativeEntryName });
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const { entry: e, relativeEntryName } of items) {
    const file = path.join(destination, relativeEntryName);
    if (e.isDirectory) await mkdir(file, { recursive: true, mode: 0o700 });
    else { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, readZipEntry(e), { mode: (e.header.attr >>> 16) & 0o111 ? 0o700 : 0o600 }); }
  }
  const pkg = parseManifestJson(await readFile(path.join(destination, 'package.json'), 'utf8'));
  const manifest = validateManifest(pkg);
  await confinedPath(destination, manifest.ui);
  if (manifest.settings) await confinedPath(destination, manifest.settings.entry);
  if (manifest.backend) await confinedPath(destination, manifest.backend.entry[TARGET]);
  return manifest;
}
export class PluginManager {
  constructor(root, bundled, { publicKey, stop = async () => {}, probe = async () => {}, forget = async () => {} } = {}) {
    this.root = root; this.bundled = bundled; this.publicKey = publicKey; this.stop = stop; this.probe = probe; this.forget = forget;
    this.state = { plugins: {} }; this.defaults = new Map(); this.queue = Promise.resolve();
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await readFile(path.join(this.root, 'state.json'), 'utf8')); if (!this.state.plugins || typeof this.state.plugins !== 'object' || Array.isArray(this.state.plugins) || Object.values(this.state.plugins).some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('invalid state'); }
    catch (e) { if (e.code !== 'ENOENT') await rename(path.join(this.root, 'state.json'), path.join(this.root, 'state.corrupt-' + Date.now() + '.json')); this.state = { plugins: {} }; }
    for (const name of await readdir(this.bundled).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      const folder = path.join(this.bundled, name);
      const manifest = validateManifest(JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')));
      this.defaults.set(manifest.id, { ...manifest, folder, source: 'bundled', enabled: true });
    }
    // Staging is never active; discard interrupted transactions on the next boot.
    await rm(path.join(this.root, '.staging'), { recursive: true, force: true });
  }
  transaction(work) { const result = this.queue.then(work); this.queue = result.catch(() => {}); return result; }
  async persist() { const temporary = path.join(this.root, 'state-' + randomUUID() + '.tmp'); await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 }); await rename(temporary, path.join(this.root, 'state.json')); }
  async list() {
    const items = new Map(this.defaults);
    for (const [id, row] of Object.entries(this.state.plugins)) {
      if (row.removed) { items.delete(id); continue; }
      if (row.folder) {
        try { const folder = await confinedPath(this.root, row.folder); const manifest = validateManifest(JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'))); if (manifest.id !== id) throw new Error('invalid identity'); items.set(id, { ...manifest, ...row, folder }); }
        catch (error) { const fallback = this.defaults.get(id); if (fallback) items.set(id, { ...fallback, error: error.message }); }
      } else if (items.has(id)) items.set(id, { ...items.get(id), enabled: row.enabled !== false });
    }
    const providers = new Set([...items.values()].filter(p => p.enabled).flatMap(p => p.services?.provides ?? []));
    return [...items.values()].map(p => ({ ...p, missing: (p.services?.requires ?? []).filter(s => !providers.has(s)) }));
  }
  async get(id) { const p = (await this.list()).find(p => p.id === id); if (!p) throw new Error('插件未安装。'); return p; }
  async install(bytes, { source = 'local', record, enabled } = {}) {
    return this.transaction(async () => {
      if (source === 'market') verifyArtifact(bytes, record, this.publicKey);
      const staged = path.join(this.root, '.staging', randomUUID());
      try {
        const m = await unpackPackage(bytes, staged);
        if (record && (record.id !== m.id || record.version !== m.version)) throw new Error('市场清单与插件包不一致。');
        if (record?.api && record.api !== m.api) throw new Error('市场 API 声明与插件包不一致。');
        const installed = (await this.list()).find(p => p.id === m.id);
        if (source === 'market' && installed && !semver.gt(m.version, installed.version)) throw new Error('市场版本必须高于已安装版本。');
        const conflicts = (await this.list()).filter(p => p.id !== m.id && p.enabled && (p.services?.provides ?? []).some(service => m.services?.provides?.includes(service)));
        if (conflicts.length) throw new Error('服务已由其他插件提供：' + conflicts.map(p => p.title).join('、'));
        const previous = this.state.plugins[m.id] && !this.state.plugins[m.id].removed ? structuredClone(this.state.plugins[m.id]) : null;
        const installationId = Buffer.from(randomUUID().replaceAll('-', ''), 'hex').toString('base64url');
        const relative = 'installed/' + m.id + '/' + installationId;
        const folder = path.join(this.root, relative); await mkdir(path.dirname(folder), { recursive: true }); await rename(staged, folder);
        let activated = false;
        try {
          await this.stop(m.id);
          this.state.plugins[m.id] = { folder: relative, enabled: enabled ?? installed?.enabled ?? previous?.enabled ?? true, source, previous };
          activated = true;
          const item = await this.get(m.id); if (item.enabled && item.missing.length) throw new Error('缺少运行所需的组件：' + item.missing.join('、')); if (item.enabled) await this.probe(item); await this.persist();
        } catch (error) {
          if (activated) {
            if (previous) this.state.plugins[m.id] = previous; else delete this.state.plugins[m.id];
            try { await this.stop(m.id); } catch {}
          }
          await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
          throw error;
        }
        return m;
      } finally { await rm(staged, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); }
    });
  }
  async setEnabled(id, enabled) { return this.transaction(async () => {
    await this.get(id);const previous=this.state.plugins[id];await this.stop(id);
    this.state.plugins[id]={...previous,enabled:Boolean(enabled)};
    try {if(enabled){const item=await this.get(id);if(item.missing.length)throw new Error('缺少运行所需的组件：'+item.missing.join('、'));await this.probe(item);}await this.persist();}
    catch(error){await this.stop(id);if(previous)this.state.plugins[id]=previous;else delete this.state.plugins[id];throw error;}
  }); }
  async uninstall(id) { return this.transaction(async () => { const plugin = await this.get(id); await this.stop(id); await this.forget(plugin); this.state.plugins[id] = { removed: true }; await this.persist(); await rm(path.join(this.root,'installed',id),{recursive:true,force:true,maxRetries:5,retryDelay:100}); }); }
  async rollback(id) { return this.transaction(async () => { const row = this.state.plugins[id]; if (!row?.previous && !this.defaults.has(id)) throw new Error('没有可恢复的版本。'); await this.stop(id); if (row.previous) this.state.plugins[id] = row.previous; else delete this.state.plugins[id];
    try {const target=await this.get(id);if(target.missing.length)throw new Error('恢复版本缺少运行所需的组件。');if(target.enabled)await this.probe(target);await this.persist();}
    catch(error){await this.stop(id);this.state.plugins[id]=row;throw error;} }); }
}
export async function boundedDownload(url, limit = MAX_PACKAGE_BYTES, signal, { onProgress = () => {}, request = fetch, idleTimeoutMs = 120000, totalTimeoutMs = 30 * 60_000 } = {}) {
  const parsed = new URL(url); if (parsed.protocol !== 'https:') throw new Error('下载地址必须使用 HTTPS。');
  if (![idleTimeoutMs, totalTimeoutMs].every(value => Number.isFinite(value) && value > 0)) throw new Error('下载超时设置无效。');
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  let idleTimer, response, reader;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('下载长时间没有响应，请重试。')), idleTimeoutMs);
  };
  const totalTimer = setTimeout(() => controller.abort(new Error('下载超过最长允许时间，请重试。')), totalTimeoutMs);
  resetIdle();
  try {
    let address = parsed;
    for (let hop = 0; hop < 6; hop++) {
      controller.signal.throwIfAborted();
      if (address.protocol !== 'https:' || address.username || address.password) throw new Error('下载地址必须使用 HTTPS。');
      response = await request(address, { signal: controller.signal, redirect: 'manual' });
      resetIdle();
      if (![301,302,303,307,308].includes(response.status)) break;
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || hop === 5) throw new Error('下载重定向无效。');
      address = new URL(location, address);
    }
    if (!response.ok) throw new Error('下载失败（' + response.status + '）。');
    const length = Number(response.headers.get('content-length'));
    if (length > limit) throw new Error('下载内容过大。');
    const total = Number.isFinite(length) && length > 0 ? length : 0;
    const chunks = []; let size = 0, lastProgress = Date.now(), lastTransferred = 0;
    onProgress({ transferred: 0, total });
    reader = response.body?.getReader();
    if (reader) while (true) {
      const { value, done } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      resetIdle();
      size += value.length; if (size > limit) throw new Error('下载内容过大。');
      chunks.push(value);
      if (lastTransferred === 0 || Date.now() - lastProgress >= 250) {
        onProgress({ transferred: size, total }); lastProgress = Date.now(); lastTransferred = size;
      }
    }
    controller.signal.throwIfAborted();
    if (total > 0 && size !== total) throw new Error('下载文件不完整，请重试。');
    if (size !== lastTransferred || size === 0) onProgress({ transferred: size, total });
    return Buffer.concat(chunks);
  } catch (error) {
    if (reader) await reader.cancel().catch(() => {});
    else await response?.body?.cancel().catch(() => {});
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof TypeError && /terminated/i.test(error.message)) throw new Error('下载文件不完整，请重试。', { cause: error });
    throw error;
  } finally {
    clearTimeout(idleTimer); clearTimeout(totalTimer);
    signal?.removeEventListener('abort', cancel);
    reader?.releaseLock();
  }
}
