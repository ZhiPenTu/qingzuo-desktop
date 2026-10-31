import { createPublicKey, sign, verify } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from './update-fs.mjs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { downloadArtifact, fileDigest, matchesArtifact, cachedFile, pruneCache, validateArtifact, withNoAsar } from './update-download.mjs';

const DOMAIN = Buffer.from('Qingzuo desktop component update v2\0');
const LEGACY_DOMAIN = Buffer.from('Qingzuo desktop component update v1\0');
const IDS = new Set(['core', 'electron', 'dependencies', 'ocr-runtime', 'ocr-models', 'plugin-code']);
const MAX_MANIFEST = 16 * 1024 ** 2;
const MAX_FILES = 50000;
const MAX_EXPANDED = 4 * 1024 ** 3;
const hashPattern = /^[a-f0-9]{64}$/;
export const componentManifestName = version => `CommerceTools-${version}-mac-arm64.components.json`;

export function componentID(filename) {
  // Helpers and the main executable carry the application version/resource
  // seal. Keep them in core so a patch does not invalidate the 120 MB framework.
  if (filename.startsWith('Contents/Frameworks/Electron Framework.framework/')) return 'electron';
  if (filename.startsWith('Contents/Resources/app.asar.unpacked/')) return 'dependencies';
  const plugin = 'Contents/Resources/commerce/plugins/official.labeledit/';
  if (filename === plugin + 'backend/label-edit-backend/label-edit-backend') return 'plugin-code';
  if (filename.startsWith(plugin + 'backend/')) return filename.includes('/.models/') ? 'ocr-models' : 'ocr-runtime';
  if (filename.startsWith(plugin)) return 'plugin-code';
  return 'core';
}

function safePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..') || (value !== 'Contents' && !value.startsWith('Contents/'))) throw new Error('组件路径无效。');
}

function resolveManifestLink(entries, filename) {
  for (let step = 0; step < 32; step++) {
    safePath(filename);
    const parts = filename.split('/'); let rewritten = false;
    for (let index = 0; index < parts.length; index++) {
      const prefix = parts.slice(0, index + 1).join('/'), entry = entries.get(prefix);
      if (!entry) throw new Error('组件链接目标缺失。');
      if (entry.type === 'symlink') {
        filename = path.posix.normalize(path.posix.join(path.posix.dirname(prefix), entry.target, ...parts.slice(index + 1)));
        rewritten = true; break;
      }
      if (index < parts.length - 1 && entry.type !== 'directory') throw new Error('组件链接父路径无效。');
    }
    if (!rewritten) return;
  }
  throw new Error('组件链接存在循环或层级过深。');
}

// Inventories never traverse links. The signed manifest carries links and modes;
// archives contain only flat, content-addressed regular-file payloads.
export async function inventoryBundle(bundle, signal) {
  return withNoAsar(async () => {
    const files = [];
    async function walk(relative) {
      for (const name of (await readdir(path.join(bundle, relative))).sort()) {
        signal?.throwIfAborted();
        const filename = path.posix.join(relative, name), info = await lstat(path.join(bundle, filename));
        const common = { path: filename, mode: info.mode & 0o777 };
        if (info.isDirectory()) { files.push({ ...common, type: 'directory' }); await walk(filename); }
        else if (info.isSymbolicLink()) files.push({ ...common, type: 'symlink', component: componentID(filename), target: await readlink(path.join(bundle, filename)) });
        else if (info.isFile()) files.push({ ...common, type: 'file', component: componentID(filename), size: info.size, sha256: await fileDigest(path.join(bundle, filename)) });
        else throw new Error('应用包含不支持的文件类型。');
      }
    }
    await walk(''); return files;
  });
}

export function validateComponentManifest(value, version) {
  if (!value || value.schemaVersion !== 1 || value.product !== 'com.commerce.tools.desktop' || value.platform !== 'darwin-arm64'
    || value.version !== version || !/^\d+\.\d+\.\d+$/.test(version) || value.bundle !== 'Qingzuo.app'
    || !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES
    || !Array.isArray(value.components) || !value.components.length || value.components.length > IDS.size) throw new Error('组件更新清单与应用不匹配。');
  const groups = new Map();
  for (const component of value.components) {
    if (!IDS.has(component?.id) || groups.has(component.id)) throw new Error('组件标识无效或重复。');
    validateArtifact(component.artifact);
    const expected = repo => `https://github.com/ZhiPenTu/${repo}/releases/download/v${version}/CommerceTools-${version}-mac-arm64.${component.id}.zip`;
    if (component.artifact.url !== expected('qingzuo-desktop') && component.artifact.url !== expected('LabelEdit')) throw new Error('组件下载地址与版本不匹配。');
    groups.set(component.id, []);
  }
  const entries = new Map(), seen = new Set(); let total = 0;
  for (const file of value.files) {
    safePath(file?.path);
    const normalized = file.path.normalize('NFC').toLowerCase();
    if (seen.has(normalized) || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error('组件路径重复或权限无效。');
    seen.add(normalized); entries.set(file.path, file);
    if (file.type === 'directory') continue;
    if (!groups.has(file.component) || file.component !== componentID(file.path)) throw new Error('组件文件缺少下载信息。');
    groups.get(file.component).push(file);
    if (file.type === 'file') {
      if (!hashPattern.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 1024 ** 3) throw new Error('组件文件校验信息无效。');
      total += file.size; if (total > MAX_EXPANDED) throw new Error('组件应用展开后过大。');
    } else if (file.type === 'symlink') {
      if (typeof file.target !== 'string' || !file.target || file.target.length > 1024 || /[\\\x00-\x1f\x7f]/.test(file.target) || path.posix.isAbsolute(file.target)) throw new Error('组件链接无效。');
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), file.target)); safePath(target);
    } else throw new Error('组件文件类型无效。');
  }
  if (!entries.has('Contents/Info.plist')) throw new Error('组件应用缺少标识文件。');
  for (const file of value.files) {
    const parent = path.posix.dirname(file.path);
    if (file.path !== 'Contents' && entries.get(parent)?.type !== 'directory') throw new Error('组件路径父目录无效。');
    if (file.type === 'symlink') {
      const target = path.posix.normalize(path.posix.join(parent, file.target));
      resolveManifestLink(entries, target);
    }
  }
  for (const group of groups.values()) if (!group.length) throw new Error('组件清单包含空组件。');
  return value;
}

export function signComponentManifest(manifest, privateKey) {
  validateComponentManifest(manifest, manifest.version);
  const payload = Buffer.from(JSON.stringify(manifest));
  return Buffer.from(JSON.stringify({ signatureVersion: 2, payload: payload.toString('base64'), signature: sign(null, Buffer.concat([DOMAIN, payload]), privateKey).toString('base64') }));
}

export function readComponentManifest(bytes, publicKey, version) {
  if (!publicKey || bytes.length > MAX_MANIFEST) throw new Error('组件清单缺少可信密钥或过大。');
  const envelope = JSON.parse(bytes.toString('utf8'));
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload)
    || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new Error('组件清单签名格式无效。');
  const payload = Buffer.from(envelope.payload, 'base64'), key = createPublicKey(publicKey);
  if (![undefined, 1, 2].includes(envelope.signatureVersion)) throw new Error('组件签名版本不受支持。');
  const domain = envelope.signatureVersion === 2 ? DOMAIN : LEGACY_DOMAIN;
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.concat([domain, payload]), key, Buffer.from(envelope.signature, 'base64'))) throw new Error('组件更新签名验证失败。');
  return validateComponentManifest(JSON.parse(payload.toString('utf8')), version);
}

async function installedMatches(bundle, file) {
  return withNoAsar(async () => {
    try {
      // A parent link must never redirect a reusable file outside the application.
      let parent = path.dirname(file.path);
      while (parent !== '.') {
        if (!(await lstat(path.join(bundle, parent))).isDirectory()) return false;
        parent = path.dirname(parent);
      }
      const filename = path.join(bundle, file.path), info = await lstat(filename);
      if ((info.mode & 0o777) !== file.mode) return false;
      if (file.type === 'symlink') return info.isSymbolicLink() && await readlink(filename) === file.target;
      return info.isFile() && await matchesArtifact(filename, file);
    } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  });
}

async function unpackComponent(archive, files, destination, signal) {
  return withNoAsar(async () => {
    const expected = new Map(files.filter(f => f.type === 'file').map(f => [f.sha256, f.size]));
    let zip, entries;
    try { zip = new AdmZip(archive, { trailingSpace: true }); entries = zip.getEntries(); }
    catch { throw new Error('组件压缩包格式无效或已损坏。'); }
    const seen = new Set();
    for (const entry of entries) {
      signal?.throwIfAborted();
      const type = (entry.header.attr >>> 16) & 0xf000;
      if (seen.has(entry.entryName) || !expected.has(entry.entryName) || entry.isDirectory || ![0, 0x8000].includes(type)
        || entry.header.size !== expected.get(entry.entryName)) throw new Error('组件压缩包包含非法文件。');
      seen.add(entry.entryName);
    }
    if (seen.size !== expected.size) throw new Error('组件压缩包缺少文件。');
    for (const file of files.filter(f => f.type === 'file')) {
      signal?.throwIfAborted();
      const filename = path.join(destination, file.path);
      let data;
      try { data = zip.getEntry(file.sha256).getData(); }
      catch { throw new Error('组件压缩包格式无效或已损坏。'); }
      await writeFile(filename, data, { mode: file.mode, flag: 'wx' });
      await chmod(filename, file.mode);
      if (!await matchesArtifact(filename, file)) throw new Error('组件文件完整性校验失败。');
    }
  });
}

export async function verifyBundleInventory(bundle, expected, signal) {
  return withNoAsar(async () => {
    const actual = await inventoryBundle(bundle, signal);
    const canonical = files => files.map(file => JSON.stringify([file.path, file.type, file.mode, file.component, file.size, file.sha256, file.target])).sort();
    if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) throw new Error('重建应用的文件或权限不匹配。');
    const root = await realpath(bundle);
    for (const file of expected.filter(f => f.type === 'symlink')) {
      const target = await realpath(path.join(bundle, file.path));
      if (!target.startsWith(root + path.sep)) throw new Error('组件链接超出应用范围。');
    }
  });
}

export async function prepareComponentUpdate({ manifestArtifact, publicKey, version, installed, staging, cache, notify = () => {}, options = {} }) {
  return withNoAsar(async () => {
  validateArtifact(manifestArtifact, MAX_MANIFEST);
  const manifestFile = await downloadArtifact(manifestArtifact, cache, () => {}, options);
  const manifest = readComponentManifest(await readFile(manifestFile), publicKey, version);
  const groups = manifest.components.map(component => ({ ...component, files: manifest.files.filter(f => f.component === component.id) }));
  const reusable = new Set(); let reusedBytes = 0, total = 0;
  notify({ mode: 'components', progress: 0, transferred: 0, total: 0, reusedBytes: 0 });
  for (const group of groups) {
    let matches = true;
    for (const file of group.files) { options.signal?.throwIfAborted(); if (!await installedMatches(installed, file)) { matches = false; break; } }
    if (matches) { reusable.add(group.id); reusedBytes += group.files.reduce((sum, f) => sum + (f.size || 0), 0); }
    else if (!await matchesArtifact(cachedFile(cache, group.artifact), group.artifact)) total += group.artifact.size;
  }
  let transferred = 0;
  const emit = value => notify({ mode: 'components', progress: total ? transferred / total * 100 : 100, total, transferred, reusedBytes, ...value });
  emit();
  const bundle = path.join(staging, manifest.bundle); await mkdir(bundle, { mode: 0o755 });
  await mkdir(path.join(bundle, 'Contents'), { mode: 0o755 });
  for (const directory of manifest.files.filter(f => f.type === 'directory')) await mkdir(path.join(bundle, directory.path), { recursive: true });
  for (const group of groups) {
    options.signal?.throwIfAborted();
    if (reusable.has(group.id)) {
      for (const file of group.files.filter(f => f.type === 'file')) {
        options.signal?.throwIfAborted(); await copyFile(path.join(installed, file.path), path.join(bundle, file.path)); await chmod(path.join(bundle, file.path), file.mode);
      }
    } else {
      const before = transferred;
      const archive = await downloadArtifact(group.artifact, cache, state => {
        transferred = before + state.transferred; emit(state.fallbackReason ? { fallbackReason: state.fallbackReason } : {});
      }, options);
      emit({ status: 'extracting' });
      await unpackComponent(archive, group.files, bundle, options.signal);
      emit({ status: 'downloading' });
    }
  }
  for (const file of manifest.files.filter(f => f.type === 'symlink')) await symlink(file.target, path.join(bundle, file.path));
  for (const directory of manifest.files.filter(f => f.type === 'directory')) await chmod(path.join(bundle, directory.path), directory.mode);
  emit({ status: 'extracting' });
  await verifyBundleInventory(bundle, manifest.files, options.signal);
  await pruneCache(cache, [manifestArtifact.sha256, ...groups.map(g => g.artifact.sha256)]);
  return bundle;
  });
}
