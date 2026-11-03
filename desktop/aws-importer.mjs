import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import YAML from 'yaml';
import { maskAppId } from './credential-policy.mjs';
import { secureRequest } from './network-transport.mjs';

const PRESET_SUBDIRS = [
  'closing-blocks',
  'components',
  'cover-styles',
  'formatting',
  'image-styles',
  'sticker-styles',
  'structures',
  'title-styles',
];
const MAX_FILES = 3000;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const MAX_BUNDLE = 25 * 1024 * 1024;
const SKIP = new Set(['__MACOSX', '.DS_Store']);
const SENSITIVE_KEYS = new Set([
  'wechatappid',
  'wechatappsecret',
  'wechatsecret',
  'wechataccounts',
  'appid',
  'appsecret',
  'apikey',
  'baseurl',
  'endpoint',
  'writingmodel',
  'imagemodel',
  'secret',
  'secretkey',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'oauthtoken',
  'bearertoken',
  'authorization',
  'password',
  'passwd',
]);

function normalizedKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(value) {
  const key = normalizedKey(value);
  return SENSITIVE_KEYS.has(key)
    || key.endsWith('apikey')
    || key.endsWith('appsecret')
    || key.endsWith('accesstoken')
    || key.endsWith('refreshtoken')
    || key.endsWith('clientsecret')
    || key.endsWith('secretkey');
}

function safeEntryName(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes('\0')) throw new Error('预设包包含无效路径。');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error('预设包包含绝对路径。');
  const parts = value.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..' || /[. ]$/.test(part) || /[\u0000-\u001f]/.test(part))) throw new Error('预设包包含越界路径。');
  return parts.join('/');
}

function isSymlink(entry) {
  const mode = (Number(entry.attr) >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function shouldSkip(name) {
  return name.split('/').some(part => SKIP.has(part));
}

function normalizeBundle(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > MAX_BUNDLE) throw new Error('预设包无效或过大。');
  let zip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    throw new Error('预设包不是有效的 ZIP 文件。');
  }
  const entries = zip.getEntries();
  if (!entries.length || entries.length > MAX_FILES) throw new Error('预设包文件数量无效。');
  const files = new Map();
  const seen = new Set();
  let total = 0;
  for (const entry of entries) {
    if (isSymlink(entry)) throw new Error('预设包不能包含符号链接。');
    const name = safeEntryName(entry.entryName);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error('预设包包含重复路径。');
    seen.add(key);
    if (entry.isDirectory || shouldSkip(name)) continue;
    const size = Number(entry.header?.size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) throw new Error('预设包单个文件过大。');
    total += size;
    if (total > MAX_TOTAL) throw new Error('预设包解压后过大。');
    files.set(name, {
      name,
      size,
      bytes: entry.getData(),
    });
  }
  if (!files.size) throw new Error('预设包为空。');
  return files;
}

function packageRoot(files) {
  const names = [...files.keys()];
  const first = names[0].split('/')[0];
  if (first && names.every(name => name.startsWith(first + '/'))) {
    const prefix = first + '/';
    const hasRootContent = ['config.yaml', 'writing-spec.md', ...PRESET_SUBDIRS.map(name => name + '/'), 'presets/']
      .some(name => names.some(value => value === prefix + name || value.startsWith(prefix + name)));
    if (hasRootContent) return prefix;
  }
  return '';
}

function pickFile(files, root, name) {
  return files.get(root + name) ?? files.get(root + 'presets/' + name);
}

function pickPreset(files, root, name) {
  const candidates = [root + name + '/', root + 'presets/' + name + '/'];
  for (const prefix of candidates) {
    const matching = [...files.values()].filter(file => file.name.startsWith(prefix) && file.name.length > prefix.length);
    if (matching.length) return { prefix, files: matching };
  }
  return null;
}

function parseConfig(file) {
  if (!file) return null;
  let value;
  try {
    value = YAML.parse(file.bytes.toString('utf8'));
  } catch {
    throw new Error('包内 config.yaml 无法解析。');
  }
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('包内 config.yaml 根节点必须是对象。');
  return value;
}

function sanitizeConfig(value) {
  const clone = structuredClone(value);
  const removed = [];
  const walk = (node, prefix = '') => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, prefix + '[' + index + ']'));
      return;
    }
    for (const key of Object.keys(node)) {
      const dotted = prefix ? prefix + '.' + key : key;
      if (isSensitiveKey(key)) {
        delete node[key];
        removed.push(dotted);
      } else {
        walk(node[key], dotted);
      }
    }
  };
  walk(clone);
  return { value: clone, removed };
}

function flatten(value, prefix = '', output = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? prefix + '.' + key : key, output);
  } else {
    output.set(prefix, value);
  }
  return output;
}

function configDiff(local, incoming) {
  const left = flatten(local);
  const right = flatten(incoming);
  const added = [];
  const changed = [];
  for (const [key, value] of right) {
    if (!left.has(key)) added.push(key);
    else if (JSON.stringify(left.get(key)) !== JSON.stringify(value)) changed.push(key);
  }
  return { added: added.sort(), changed: changed.sort() };
}

function packageAccounts(config) {
  const accounts = [];
  if (!config || typeof config !== 'object') return accounts;
  if (Array.isArray(config.wechat_accounts)) {
    for (const item of config.wechat_accounts) {
      if (!item || typeof item !== 'object') continue;
      accounts.push({
        name: item.name || item.account_name,
        appId: item.appid || item.app_id || item.wechat_appid,
        appSecret: item.appsecret || item.app_secret || item.wechat_appsecret,
      });
    }
  }
  if (config.wechat_appid || config.wechat_appsecret) {
    accounts.push({
      name: config.wechat_name || config.wechat_account_name,
      appId: config.wechat_appid,
      appSecret: config.wechat_appsecret,
    });
  }
  const seen = new Set();
  return accounts.filter(account => {
    if (typeof account.appId !== 'string' || !account.appId.trim()) return false;
    if (seen.has(account.appId)) return false;
    seen.add(account.appId);
    return true;
  });
}

function accountPreview(store, accounts) {
  const result = [];
  const warnings = [];
  const actions = new Map();
  for (const account of accounts) {
    const appId = String(account.appId).trim();
    const existing = store.state.accounts.find(item => item.appId === appId);
    const name = typeof account.name === 'string' && account.name.trim() ? account.name.trim().slice(0, 80) : '公众号 ' + maskAppId(appId);
    const nameConflict = store.state.accounts.some(item => item.appId !== appId && item.name.toLowerCase() === name.toLowerCase());
    if (typeof account.appSecret !== 'string' || !account.appSecret.trim()) {
      warnings.push('公众号 ' + maskAppId(appId) + ' 缺少 AppSecret，未导入。');
      result.push({ name, appIdMasked: maskAppId(appId), action: 'conflict' });
      actions.set(appId, 'conflict');
    } else if (nameConflict) {
      warnings.push('公众号名称「' + name + '」已被其他账号使用，请先调整名称。');
      result.push({ name, appIdMasked: maskAppId(appId), action: 'conflict' });
      actions.set(appId, 'conflict');
    } else {
      const action = existing ? 'update' : 'add';
      result.push({ name, appIdMasked: maskAppId(appId), action });
      actions.set(appId, action);
    }
  }
  return { result, warnings, actions };
}

function ignoredEntries(files, root, presetPrefixes) {
  const ignored = new Set();
  for (const file of files.values()) {
    if (!file.name.startsWith(root)) continue;
    const relative = file.name.slice(root.length);
    const top = relative.split('/')[0];
    if (relative === 'config.yaml' || relative === 'writing-spec.md') continue;
    if (top === 'presets') {
      const nested = relative.split('/')[1];
      if (presetPrefixes.has('presets/' + nested + '/')) continue;
      ignored.add(relative.split('/').slice(0, 2).join('/'));
      continue;
    }
    if (presetPrefixes.has(top + '/')) continue;
    ignored.add(top);
  }
  return [...ignored].sort();
}

async function readBundle(plugin, options, files, request) {
  if (options.fileToken !== undefined) {
    if (!plugin.permissions.files) throw new Error('插件没有文件权限。');
    const item = await files.get(plugin, options.fileToken);
    if (item.size > MAX_BUNDLE) throw new Error('预设包过大。');
    return await readFile(item.filename);
  }
  if (options.url !== undefined) {
    let url;
    try {
      url = new URL(options.url);
    } catch {
      throw new Error('预设包地址无效。');
    }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('预设包地址必须为 HTTPS 地址。');
    const response = await request(url.href, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('预设包下载失败。');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BUNDLE) throw new Error('预设包过大。');
    const chunks = [];
    let total = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_BUNDLE) throw new Error('预设包过大。');
        chunks.push(chunk);
      }
    }
    return Buffer.concat(chunks);
  }
  throw new Error('请选择预设包或填写下载地址。');
}

export class AwsImporter {
  constructor({ workspace, files, accounts, confirmImport, log = () => {}, request = secureRequest }) {
    this.workspace = workspace;
    this.files = files;
    this.accounts = accounts;
    this.confirmImport = confirmImport;
    this.log = log;
    this.request = request;
    this.queue = Promise.resolve();
  }

  async analyze(plugin, options = {}) {
    const bytes = await readBundle(plugin, options, this.files, this.request);
    const files = normalizeBundle(bytes);
    const root = packageRoot(files);
    const configFile = pickFile(files, root, 'config.yaml');
    const writingFile = pickFile(files, root, 'writing-spec.md');
    const config = parseConfig(configFile);
    const sanitized = config ? sanitizeConfig(config) : null;
    const presets = [];
    const presetPrefixes = new Set();
    for (const name of PRESET_SUBDIRS) {
      const found = pickPreset(files, root, name);
      if (!found) continue;
      presetPrefixes.add(found.prefix.slice(root.length));
      const local = await this.workspace.list(plugin, { path: '.aws-article/presets/' + name }).catch(() => []);
      presets.push({
        name,
        path: '.aws-article/presets/' + name,
        action: local.length ? 'replace' : 'add',
        files: found.files.map(file => file.name.slice(found.prefix.length)),
        source: found,
      });
    }
    if (!config && !writingFile && !presets.length) throw new Error('包内未找到配置、写作规范或可用预设。');
    let configPreview = { action: 'preserve-local', added: [], changed: [] };
    if (config) {
      let localConfig = null;
      const localText = await this.workspace.readText(plugin, { path: '.aws-article/config.yaml' }).catch(() => null);
      if (localText !== null) {
        try {
          localConfig = YAML.parse(localText);
        } catch {
          throw new Error('本地 config.yaml 无法解析，请先修复后再导入。');
        }
      }
      if (localText === null) {
        configPreview = { action: 'missing-local', added: [...flatten(sanitized.value).keys()].sort(), changed: [] };
      } else {
        const diff = configDiff(localConfig, sanitized.value);
        configPreview = { action: 'preserve-local', ...diff };
      }
    }
    const accounts = packageAccounts(config);
    const accountInfo = accountPreview(this.accounts, accounts);
    const warnings = [...accountInfo.warnings];
    if (sanitized?.removed.length) warnings.push('已从配置中移除密钥和模型端点：' + sanitized.removed.join('、'));
    const ignored = ignoredEntries(files, root, presetPrefixes);
    if (ignored.length) warnings.push('有 ' + ignored.length + ' 项不在预设白名单，未导入。');
    let writingSpec = 'add';
    if (writingFile) {
      const existingWriting = await this.workspace.readText(plugin, { path: '.aws-article/writing-spec.md' }).catch(() => null);
      writingSpec = existingWriting === null ? 'add' : 'replace';
    }
    return {
      preview: {
        presets: presets.map(({ source, ...value }) => value),
        config: configPreview,
        writingSpec,
        accounts: accountInfo.result,
        ignored,
        warnings,
      },
      internal: { root, configFile, writingFile, config, sanitized, presets, accounts, accountActions: accountInfo.actions },
    };
  }

  async import(plugin, options = {}) {
    const operation = this.queue.then(() => this.importOne(plugin, options), () => this.importOne(plugin, options));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async importOne(plugin, options = {}) {
    if (!plugin.permissions.workspace) throw new Error('工作区未授权。');
    const { preview, internal } = await this.analyze(plugin, options);
    if (options.dryRun !== false) return preview;
    const importableAccounts = internal.accounts.filter(account => typeof account.appSecret === 'string'
      && account.appSecret.trim()
      && internal.accountActions.get(String(account.appId).trim()) !== 'conflict');
    if (importableAccounts.length && !(plugin.permissions.wechat ?? []).includes('draft')) throw new Error('导入公众号账号需要微信公众号草稿能力。');
    if (importableAccounts.length && options.confirmSecrets !== true) throw new Error('导入公众号账号前需要确认保存到系统凭据库。');
    if (importableAccounts.length) {
      if (typeof this.confirmImport !== 'function') throw new Error('公众号账号导入需要宿主确认。');
      const approved = await this.confirmImport(plugin, preview);
      if (!approved) throw new Error('预设包导入已取消。');
    }
    const stamp = randomUUID();
    const stage = '.aws-article/.import-' + stamp;
    const backupRoot = stage + '/backup';
    const changes = [];
    try {
      await this.workspace.mkdir(plugin, { path: stage });
      for (const preset of internal.presets) {
        for (const file of preset.source.files) {
          const relative = file.name.slice(preset.source.prefix.length);
          await this.workspace.writeBase64(plugin, {
            path: stage + '/' + preset.name + '/' + relative,
            data: file.bytes.toString('base64'),
            mime: 'application/octet-stream',
            overwrite: true,
          });
        }
      }
      if (internal.writingFile) {
        await this.workspace.writeBase64(plugin, {
          path: stage + '/writing-spec.md',
          data: internal.writingFile.bytes.toString('base64'),
          mime: 'text/markdown',
          overwrite: false,
        });
      }
      if (internal.config && preview.config.action === 'missing-local') {
        await this.workspace.writeText(plugin, {
          path: stage + '/config.yaml',
          text: YAML.stringify(internal.sanitized.value),
          overwrite: false,
        });
      }
      for (const preset of internal.presets) {
        const destination = preset.path;
        const backup = backupRoot + '/' + preset.name;
        const existing = await this.workspace.list(plugin, { path: destination }).catch(() => []);
        if (existing.length) {
          await this.workspace.rename(plugin, { from: destination, to: backup });
          changes.push({ destination, backup });
        } else {
          changes.push({ destination, backup: null });
        }
        await this.workspace.rename(plugin, { from: stage + '/' + preset.name, to: destination });
      }
      if (internal.writingFile) {
        const destination = '.aws-article/writing-spec.md';
        const existing = await this.workspace.readText(plugin, { path: destination }).then(() => true).catch(() => false);
        const backup = backupRoot + '/writing-spec.md';
        if (existing) {
          await this.workspace.rename(plugin, { from: destination, to: backup });
          changes.push({ destination, backup });
        } else {
          changes.push({ destination, backup: null });
        }
        await this.workspace.rename(plugin, { from: stage + '/writing-spec.md', to: destination });
      }
      if (internal.config && preview.config.action === 'missing-local') {
        const destination = '.aws-article/config.yaml';
        changes.push({ destination, backup: null });
        await this.workspace.rename(plugin, { from: stage + '/config.yaml', to: destination });
      }
      let importedAccounts = 0;
      if (importableAccounts.length) {
        const results = await this.accounts.imported(importableAccounts.map(account => ({
          name: account.name,
          appId: account.appId,
          appSecret: account.appSecret,
        })));
        importedAccounts = results.filter(item => item.action !== 'kept').length;
      }
      await this.workspace.remove(plugin, { path: stage, recursive: true }).catch(() => {});
      this.log('已导入预设包：' + internal.presets.length + ' 组预设，' + importedAccounts + ' 个公众号账号。');
      return { applied: true, preview, importedAccounts };
    } catch (error) {
      for (const { destination, backup } of changes.reverse()) {
        await this.workspace.remove(plugin, { path: destination, recursive: true }).catch(() => {});
        if (backup) await this.workspace.rename(plugin, { from: backup, to: destination }).catch(() => {});
      }
      await this.workspace.remove(plugin, { path: stage, recursive: true }).catch(() => {});
      throw error;
    }
  }
}
