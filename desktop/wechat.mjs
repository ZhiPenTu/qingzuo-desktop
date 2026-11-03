import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFragment, serialize } from 'parse5';
import { maskAppId } from './credential-policy.mjs';
import { secureRequest } from './network-transport.mjs';

const API_ROOT = 'https://api.weixin.qq.com';
const ACCOUNT_ID = /^wx-[a-f0-9]{12}$/;
const MAX_BODY_IMAGE = 1024 * 1024;
const MAX_COVER_IMAGE = 10 * 1024 * 1024;
const MAX_HTML = 4 * 1024 * 1024;
const TOKEN_EARLY_MS = 5 * 60 * 1000;
const RENEW_CODES = new Set([40001, 40014, 42001]);
const FORBIDDEN_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'textarea', 'select', 'option', 'meta', 'link', 'base', 'frame', 'frameset',
  'source',
]);
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i',
  'img', 'ins', 'kbd', 'li', 'main', 'mark', 'ol', 'p', 'picture', 'pre', 'q',
  's', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var',
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'text', 'tspan',
  'mp-common-profile', 'mpprofile', 'mp-miniprogram', 'mp-common-miniprogram',
]);
const ALLOWED_ATTRS = new Set([
  'style', 'src', 'alt', 'title', 'href', 'target', 'rel', 'width', 'height',
  'colspan', 'rowspan', 'align', 'valign', 'viewBox', 'fill', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'd', 'cx', 'cy', 'r',
  'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'offset', 'stop-color',
  'stop-opacity', 'gradientUnits', 'font-size', 'font-weight', 'text-anchor',
  'class', 'leaf', 'nodeleaf', 'textvalue', 'linktype',
]);

function cleanText(value, max, label) {
  if (typeof value !== 'string') throw new Error(label + '无效。');
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error(label + '无效。');
  return text;
}

function emptyState() {
  return { schemaVersion: 1, accounts: [] };
}

function normalizeState(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.accounts)) return null;
  const accounts = [];
  const ids = new Set();
  for (const entry of value.accounts) {
    if (!entry || !ACCOUNT_ID.test(entry.id) || ids.has(entry.id)) continue;
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80) continue;
    if (typeof entry.appId !== 'string' || !entry.appId.trim() || entry.appId.length > 256) continue;
    if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) continue;
    ids.add(entry.id);
    accounts.push({
      id: entry.id,
      name: entry.name.trim(),
      appId: entry.appId.trim(),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      verifiedAt: Number.isFinite(entry.verifiedAt) ? entry.verifiedAt : null,
    });
  }
  return { schemaVersion: 1, accounts };
}

async function atomicJson(filename, value) {
  const temporary = filename + '.' + randomBytes(5).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, filename);
    if (process.platform !== 'win32') await chmod(filename, 0o600).catch(() => {});
  } finally {
    await rm(temporary, { force: true });
  }
}

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    appIdMasked: maskAppId(account.appId),
    verified: Boolean(account.verifiedAt),
  };
}

export class WechatAccountStore {
  constructor({ root, credentials, now = () => Date.now() }) {
    this.root = root;
    this.credentials = credentials;
    this.now = now;
    this.file = path.join(root, 'wechat-accounts.json');
    this.state = emptyState();
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      const normalized = normalizeState(parsed);
      if (!normalized || parsed?.schemaVersion !== 1) {
        await rename(this.file, this.file + '.corrupt-' + Date.now()).catch(() => {});
        this.state = emptyState();
      } else {
        this.state = normalized;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await rename(this.file, this.file + '.corrupt-' + Date.now()).catch(() => {});
        this.state = emptyState();
      }
    }
  }

  secretName(id) {
    return 'secret-' + id;
  }

  async mutate(change) {
    const execute = async () => {
      const draft = structuredClone(this.state);
      const result = await change(draft);
      await atomicJson(this.file, draft);
      this.state = draft;
      return result;
    };
    const operation = this.queue.then(execute, execute);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  nextId(draft) {
    for (let index = 0; index < 4; index += 1) {
      const id = 'wx-' + randomBytes(6).toString('hex');
      if (!draft.accounts.some(account => account.id === id)) return id;
    }
    throw new Error('无法生成公众号标识。');
  }

  find(id) {
    const account = this.state.accounts.find(item => item.id === id);
    if (!account) throw new Error('公众号账号不存在。');
    return account;
  }

  adminList() {
    return this.state.accounts
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(account => ({ ...publicAccount(account), createdAt: account.createdAt, updatedAt: account.updatedAt }));
  }

  pluginList() {
    return this.state.accounts
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(publicAccount);
  }

  async secret(id) {
    this.find(id);
    const secret = await this.credentials.get('wechat-accounts', this.secretName(id));
    if (!secret) throw new Error('公众号 AppSecret 未配置。');
    return secret;
  }

  async create(input = {}) {
    let created = null;
    return await this.mutate(async draft => {
      const name = cleanText(input.name, 80, '公众号名称');
      const appId = cleanText(input.appId, 256, '微信 AppID');
      const appSecret = cleanText(input.appSecret, 1024, '微信 AppSecret');
      if (draft.accounts.some(account => account.name.toLowerCase() === name.toLowerCase())) throw new Error('已存在同名公众号。');
      if (draft.accounts.some(account => account.appId === appId)) throw new Error('该 AppID 已添加。');
      const id = this.nextId(draft);
      const stamp = this.now();
      created = { id, name, appId, createdAt: stamp, updatedAt: stamp, verifiedAt: null };
      await this.credentials.set('wechat-accounts', this.secretName(id), appSecret);
      draft.accounts.push(created);
      return { ...publicAccount(created), createdAt: stamp, updatedAt: stamp };
    });
  }

  async update(id, patch = {}) {
    return await this.mutate(async draft => {
      const account = draft.accounts.find(item => item.id === id);
      if (!account) throw new Error('公众号账号不存在。');
      if (patch.name !== undefined) {
        const name = cleanText(patch.name, 80, '公众号名称');
        if (draft.accounts.some(item => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw new Error('已存在同名公众号。');
        account.name = name;
      }
      if (patch.appId !== undefined && String(patch.appId).trim()) {
        const appId = cleanText(patch.appId, 256, '微信 AppID');
        if (draft.accounts.some(item => item.id !== id && item.appId === appId)) throw new Error('该 AppID 已添加。');
        account.appId = appId;
      }
      if (typeof patch.appSecret === 'string' && patch.appSecret.trim()) {
        await this.credentials.set('wechat-accounts', this.secretName(id), cleanText(patch.appSecret, 1024, '微信 AppSecret'));
      }
      account.updatedAt = this.now();
      account.verifiedAt = null;
      return { ...publicAccount(account), createdAt: account.createdAt, updatedAt: account.updatedAt };
    });
  }

  async markVerified(id) {
    await this.mutate(draft => {
      const account = draft.accounts.find(item => item.id === id);
      if (!account) throw new Error('公众号账号不存在。');
      account.verifiedAt = this.now();
      account.updatedAt = account.verifiedAt;
    });
  }

  async remove(id) {
    this.find(id);
    await this.mutate(draft => {
      draft.accounts = draft.accounts.filter(item => item.id !== id);
    });
    await this.credentials.clear('wechat-accounts', this.secretName(id)).catch(() => {});
  }

  async imported(accounts = []) {
    const result = [];
    for (const input of accounts) {
      const appId = cleanText(input.appId, 256, '微信 AppID');
      const appSecret = cleanText(input.appSecret, 1024, '微信 AppSecret');
      const name = cleanText(input.name || ('公众号 ' + maskAppId(appId)), 80, '公众号名称');
      const existing = this.state.accounts.find(account => account.appId === appId);
      if (existing) {
        if (input.action === 'keep') {
          result.push({ ...publicAccount(existing), action: 'kept' });
          continue;
        }
        await this.update(existing.id, { name, appId, appSecret });
        result.push({ ...publicAccount(this.find(existing.id)), action: 'updated' });
        continue;
      }
      const created = await this.create({ name, appId, appSecret });
      result.push({ ...created, action: 'added' });
    }
    return result;
  }

  async forgetPlugin() {
    return;
  }
}

function sanitizeStyle(value) {
  if (typeof value !== 'string' || value.length > 12000) return null;
  const text = value.trim();
  if (!text || /(?:expression\s*\(|javascript\s*:|url\s*\(|@import|behavior\s*:|-moz-binding|position\s*:\s*fixed)/i.test(text)) return null;
  return text;
}

function safeHref(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  if (value.startsWith('#')) return value;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
}

function sanitizeAttributes(node, onImage) {
  const attrs = [];
  for (const attr of node.attrs || []) {
    const name = attr.name;
    if (/^on/i.test(name) || name === 'srcdoc') continue;
    if (name === 'style') {
      const value = sanitizeStyle(attr.value);
      if (value) attrs.push({ name, value });
      continue;
    }
    if (name === 'href') {
      const value = safeHref(attr.value);
      if (value) attrs.push({ name, value });
      continue;
    }
    if (name === 'src') {
      if (node.tagName !== 'img') throw new Error('公众号正文包含不支持的资源标签。');
      onImage(attr.value);
      attrs.push({ name, value: attr.value });
      continue;
    }
    if (name === 'srcset' || name === 'poster' || name === 'background') throw new Error('公众号正文包含不支持的外部资源。');
    if (!ALLOWED_ATTRS.has(name) && !/^data-[a-z0-9_-]{1,64}$/i.test(name)) continue;
    if (typeof attr.value !== 'string' || attr.value.length > 12000) continue;
    attrs.push({ name, value: attr.value });
  }
  node.attrs = attrs;
}

export function sanitizeWechatHtml(html, placeholders = new Map()) {
  if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html) > MAX_HTML) throw new Error('文章 HTML 无效或过大。');
  const fragment = parseFragment(html);
  const used = new Set();
  const visit = node => {
    if (!Array.isArray(node.childNodes)) return;
    const kept = [];
    for (const child of node.childNodes) {
      if (!child.tagName) {
        if (child.nodeName === '#text') kept.push(child);
        continue;
      }
      if (child.tagName === 'source') throw new Error('公众号正文包含不支持的资源标签。');
      if (FORBIDDEN_TAGS.has(child.tagName)) continue;
      if (!ALLOWED_TAGS.has(child.tagName)) {
        visit(child);
        kept.push(...(child.childNodes || []));
        continue;
      }
      sanitizeAttributes(child, value => {
        const prefix = 'qingzuo-asset:';
        if (!value.startsWith(prefix)) throw new Error('正文图片必须使用工作区资产占位符。');
        const id = value.slice(prefix.length);
        if (!placeholders.has(id)) throw new Error('正文引用了不存在的本地图片。');
        used.add(id);
      });
      visit(child);
      kept.push(child);
    }
    node.childNodes = kept;
  };
  visit(fragment);
  return { html: serialize(fragment), used };
}

function wechatError(payload, fallback) {
  const code = Number(payload?.errcode);
  const message = payload?.errmsg || '';
  const hints = {
    40001: '公众号访问令牌失效，请重试。',
    40013: '微信 AppID 无效，请检查公众号设置。',
    40007: '微信素材无效，请重新生成图片。',
    40125: '微信 AppSecret 无效，请重新填写。',
    40164: '当前网络地址不在公众号 IP 白名单。',
    45009: '微信接口调用次数已达上限，请稍后重试。',
    45028: '公众号素材上传次数已达上限，请稍后重试。',
    48001: '公众号未开通当前接口权限。',
    53404: '公众号账号未认证，无法直接发布。',
    53500: '公众号发布失败，请检查内容或账号权限。',
  };
  const error = new Error(hints[code] || (fallback + (code ? '（' + code + '）' : '')));
  error.code = code;
  error.wechatMessage = message;
  return error;
}

async function boundedJson(response, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('微信响应过大。');
      chunks.push(chunk);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('微信服务返回了无法识别的响应。');
  }
}

export class WechatRuntime {
  constructor({ store, workspace, files, confirm, request = secureRequest, root, log = () => {}, now = () => Date.now() }) {
    this.store = store;
    this.workspace = workspace;
    this.files = files;
    this.confirm = confirm;
    this.request = request;
    this.root = root;
    this.log = log;
    this.now = now;
    this.tokens = new Map();
    this.drafts = new Map();
    this.receipts = new Map();
    this.receiptsFile = path.join(root, 'wechat-publish-receipts.json');
    this.draftsFile = path.join(root, 'wechat-drafts.json');
    this.receiptWrites = Promise.resolve();
    this.draftWrites = Promise.resolve();
    this.publishLocks = new Map();
    this.receiptsCorrupt = false;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(this.receiptsFile, 'utf8'));
      if (value?.schemaVersion !== 1 || !Array.isArray(value.receipts)) throw new Error('公众号发布回执格式不兼容。');
      for (const receipt of value.receipts) {
        if (!receipt || typeof receipt.key !== 'string' || typeof receipt.accountId !== 'string') continue;
        if (receipt.state === 'submitting') {
          receipt.state = 'unknown';
          receipt.error = '上次提交在完成前中断，请先在公众号后台核对。';
        }
        this.receipts.set(receipt.key, receipt);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.receiptsCorrupt = true;
        await rename(this.receiptsFile, this.receiptsFile + '.corrupt-' + Date.now()).catch(() => {});
        this.log('公众号发布回执索引无法读取，已保留原文件并停止自动重试。');
      }
    }
    try {
      const value = JSON.parse(await readFile(this.draftsFile, 'utf8'));
      if (value?.schemaVersion !== 1 || !Array.isArray(value.drafts)) throw new Error('公众号草稿索引格式不兼容。');
      for (const draft of value.drafts) {
        if (!draft || typeof draft.mediaId !== 'string' || typeof draft.accountId !== 'string' || typeof draft.title !== 'string') continue;
        this.drafts.set(draft.mediaId, draft);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await rename(this.draftsFile, this.draftsFile + '.corrupt-' + Date.now()).catch(() => {});
        this.log('公众号草稿索引无法读取，已保留原文件并拒绝使用无标题草稿。');
      }
    }
  }

  receiptKey(accountId, mediaId) {
    return accountId + ':' + mediaId;
  }

  async persistReceipts() {
    const content = JSON.stringify({ schemaVersion: 1, receipts: [...this.receipts.values()] }, null, 2) + '\n';
    const operation = this.receiptWrites.catch(() => {}).then(async () => {
      const temporary = this.receiptsFile + '.' + randomBytes(5).toString('hex') + '.tmp';
      try {
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, this.receiptsFile);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.receiptWrites = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async persistDrafts() {
    const content = JSON.stringify({ schemaVersion: 1, drafts: [...this.drafts.values()] }, null, 2) + '\n';
    const operation = this.draftWrites.catch(() => {}).then(async () => {
      const temporary = this.draftsFile + '.' + randomBytes(5).toString('hex') + '.tmp';
      try {
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, this.draftsFile);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.draftWrites = operation.then(() => undefined, () => undefined);
    return operation;
  }

  permitted(plugin, value) {
    if (!(plugin.permissions.wechat ?? []).includes(value)) throw new Error('微信能力未授权。');
  }

  async requestJson(pathname, { method = 'POST', body, query = {} } = {}) {
    const url = new URL(pathname, API_ROOT);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const response = await this.request(url.href, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await boundedJson(response);
    if (!response.ok) throw wechatError(payload, '微信服务请求失败。');
    if (payload?.errcode) throw wechatError(payload, '微信服务请求失败。');
    return payload;
  }

  async token(accountId, force = false) {
    const account = this.store.find(accountId);
    const cached = this.tokens.get(accountId);
    if (!force && cached && cached.appId === account.appId && cached.expiresAt > this.now()) return cached.value;
    if (cached && cached.appId !== account.appId) this.tokens.delete(accountId);
    const secret = await this.store.secret(accountId);
    const payload = await this.requestJson('/cgi-bin/token', {
      method: 'GET',
      query: { grant_type: 'client_credential', appid: account.appId, secret },
    });
    if (typeof payload.access_token !== 'string' || !payload.access_token) throw wechatError(payload, '微信访问令牌获取失败。');
    const expiresIn = Math.max(60, Number(payload.expires_in) || 7200);
    const value = payload.access_token;
    this.tokens.set(accountId, { value, appId: account.appId, expiresAt: this.now() + Math.max(60_000, expiresIn * 1000 - TOKEN_EARLY_MS) });
    return value;
  }

  async withToken(accountId, operation) {
    let token = await this.token(accountId);
    try {
      return await operation(token);
    } catch (error) {
      if (!RENEW_CODES.has(error.code)) throw error;
      token = await this.token(accountId, true);
      return await operation(token);
    }
  }

  async verify(plugin, { accountId }) {
    this.permitted(plugin, 'draft');
    return this.verifyAccount(accountId);
  }

  async verifyAccount(accountId) {
    await this.token(accountId, true);
    await this.store.markVerified(accountId);
    return { ok: true };
  }

  async upload(token, endpoint, filename, mime, bytes, query = {}) {
    const url = new URL(endpoint, API_ROOT);
    url.searchParams.set('access_token', token);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const form = new FormData();
    form.append('media', new Blob([bytes], { type: mime }), filename);
    const response = await this.request(url.href, {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    const payload = await boundedJson(response);
    if (!response.ok || payload?.errcode) throw wechatError(payload, '微信素材上传失败。');
    return payload;
  }

  assertArticlePath(articleDir, assetPath) {
    if (typeof assetPath !== 'string' || !assetPath.startsWith(articleDir + '/')) throw new Error('公众号图片必须位于当前文章目录。');
  }

  async imageFile(plugin, articleDir, assetPath, maxBytes) {
    this.assertArticlePath(articleDir, assetPath);
    const item = await this.workspace.resolveExisting(plugin, assetPath);
    if (!item.info.isFile() || item.info.size > maxBytes) throw new Error('公众号图片过大或不存在。');
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[path.extname(item.filename).toLowerCase()];
    if (!mime) throw new Error('公众号图片仅支持 PNG 或 JPEG。');
    return { filename: path.basename(item.filename), mime, bytes: await readFile(item.filename) };
  }

  async createDraft(plugin, { accountId, article } = {}) {
    this.permitted(plugin, 'draft');
    if (!article || typeof article !== 'object') throw new Error('文章内容无效。');
    const articleDir = cleanText(article.articleDir, 512, '文章目录');
    if (!articleDir.startsWith('drafts/')) throw new Error('文章目录无效。');
    const title = cleanText(article.title, 64, '文章标题');
    const author = typeof article.author === 'string' ? article.author.trim() : '';
    if (author.length > 32) throw new Error('作者名称过长。');
    const digest = typeof article.digest === 'string' ? article.digest.trim() : '';
    if (digest.length > 120) throw new Error('摘要不能超过 120 字。');
    if (!article.cover || typeof article.cover !== 'object') throw new Error('文章封面无效。');
    if (!Array.isArray(article.assets) || article.assets.length > 20) throw new Error('正文图片数量无效。');

    const directory = await this.workspace.resolveExisting(plugin, articleDir);
    if (!directory.info.isDirectory()) throw new Error('文章目录不存在。');
    const placeholderMap = new Map();
    for (const asset of article.assets) {
      if (!asset || typeof asset.placeholder !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(asset.placeholder)) throw new Error('正文图片占位符无效。');
      if (placeholderMap.has(asset.placeholder)) throw new Error('正文图片占位符重复。');
      this.assertArticlePath(articleDir, asset.path);
      placeholderMap.set(asset.placeholder, asset.path);
    }
    const sanitized = sanitizeWechatHtml(article.html, placeholderMap);
    const cover = await this.imageFile(plugin, articleDir, article.cover.path, MAX_COVER_IMAGE);

    const bodyImages = new Map();
    for (const id of sanitized.used) {
      bodyImages.set(id, await this.imageFile(plugin, articleDir, placeholderMap.get(id), MAX_BODY_IMAGE));
    }
    const payload = await this.withToken(accountId, async token => {
      const coverResult = await this.upload(token, '/cgi-bin/material/add_material', cover.filename, cover.mime, cover.bytes, { type: 'image' });
      const thumbMediaId = coverResult.media_id;
      if (typeof thumbMediaId !== 'string' || !thumbMediaId) throw new Error('微信封面素材上传失败。');
      const uploaded = new Map();
      for (const [id, image] of bodyImages) {
        const result = await this.upload(token, '/cgi-bin/media/uploadimg', image.filename, image.mime, image.bytes);
        if (typeof result.url !== 'string' || !/^https:\/\//.test(result.url)) throw new Error('微信正文图片上传失败。');
        uploaded.set(id, result.url);
      }
      let content = sanitized.html;
      for (const [id, url] of uploaded) content = content.split('qingzuo-asset:' + id).join(url);
      if (content.includes('qingzuo-asset:')) throw new Error('文章仍有未上传的本地图片。');
      const result = await this.requestJson('/cgi-bin/draft/add', {
        query: { access_token: token },
        body: {
          articles: [{
            title,
            author,
            digest,
            content,
            content_source_url: typeof article.contentSourceUrl === 'string' ? article.contentSourceUrl : '',
            thumb_media_id: thumbMediaId,
            need_open_comment: article.needOpenComment ? 1 : 0,
            only_fans_can_comment: article.onlyFansCanComment ? 1 : 0,
          }],
        },
      });
      return { result, uploadedCount: uploaded.size };
    });
    if (typeof payload.result.media_id !== 'string' || !payload.result.media_id) throw new Error('微信草稿创建失败。');
    this.drafts.set(payload.result.media_id, { mediaId: payload.result.media_id, accountId, title, createdAt: this.now() });
    await this.persistDrafts().catch(() => {
      throw new Error('草稿已创建，但宿主无法保存草稿回执。请在公众号后台核对，不要重复创建。');
    });
    this.log('公众号草稿已创建：' + title + '，正文图片 ' + payload.uploadedCount + ' 张。');
    return { mediaId: payload.result.media_id };
  }

  async withPublishLock(key, operation) {
    const previous = this.publishLocks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(operation);
    this.publishLocks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.publishLocks.get(key) === run) this.publishLocks.delete(key);
    }
  }

  async publish(plugin, { accountId, mediaId } = {}) {
    this.permitted(plugin, 'publish');
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) throw new Error('公众号账号无效。');
    if (typeof mediaId !== 'string' || !mediaId) throw new Error('草稿标识无效。');
    const key = this.receiptKey(accountId, mediaId);
    return await this.withPublishLock(key, async () => {
      if (this.receiptsCorrupt) throw new Error('发布回执索引不可用，请先在公众号后台核对，避免重复发布。');
      const metadata = this.drafts.get(mediaId);
      if (!metadata || metadata.accountId !== accountId) throw new Error('草稿回执不属于当前公众号，请重新创建草稿。');
      const existing = this.receipts.get(key);
      if (existing?.publishId) return { publishId: existing.publishId };
      if (['unknown', 'submitting'].includes(existing?.state)) throw new Error('上次发布结果未知，请先在公众号后台核对，避免重复发布。');
      const account = this.store.find(accountId);
      const approved = await this.confirm({
        accountName: account.name,
        appIdMasked: maskAppId(account.appId),
        title: metadata.title,
        mode: 'publish',
      });
      if (!approved) throw new Error('发布已取消。');
      const submitting = { key, accountId, mediaId, title: metadata.title, state: 'submitting', publishId: null, createdAt: this.now() };
      this.receipts.set(key, submitting);
      try {
        await this.persistReceipts();
      } catch {
        this.receipts.delete(key);
        throw new Error('无法保存发布意图，已停止提交。');
      }
      let payload;
      try {
        payload = await this.withToken(accountId, token => this.requestJson('/cgi-bin/freepublish/submit', {
          query: { access_token: token },
          body: { media_id: mediaId },
        }));
      } catch (error) {
        const receipt = this.receipts.get(key);
        if (receipt) {
          const businessError = Number.isInteger(error.code) && error.code > 0;
          receipt.state = businessError ? 'failed' : 'unknown';
          receipt.error = businessError ? '微信错误码 ' + error.code : '网络中断或结果未知';
          await this.persistReceipts().catch(() => {});
        }
        throw error;
      }
      if (typeof payload.publish_id !== 'string' || !payload.publish_id) {
        this.receipts.set(key, { key, accountId, mediaId, title: metadata.title, state: 'unknown', publishId: null, createdAt: this.now() });
        await this.persistReceipts().catch(() => {});
        throw new Error('微信发布提交结果未知，请先在公众号后台核对。');
      }
      const submitted = { key, accountId, mediaId, title: metadata.title, state: 'submitted', publishId: payload.publish_id, createdAt: this.now() };
      this.receipts.set(key, submitted);
      try {
        await this.persistReceipts();
      } catch {
        submitted.state = 'unknown';
        submitted.error = '发布已提交，但回执写入失败。';
        throw new Error('发布已提交，但宿主无法保存回执。请先查询状态，不要重复发布。');
      }
      this.log('公众号发布已提交：' + metadata.title + '。');
      return { publishId: payload.publish_id };
    });
  }

  async publishStatus(plugin, { accountId, publishId, mediaId } = {}) {
    this.permitted(plugin, 'list');
    if ((typeof publishId !== 'string' || !publishId) && typeof mediaId === 'string' && mediaId && typeof accountId === 'string') {
      const receipt = this.receipts.get(this.receiptKey(accountId, mediaId));
      if (!receipt) throw new Error('没有找到该草稿的发布回执，请先在公众号后台核对。');
      if (!receipt.publishId) return { publishId: null, status: 'unknown', error: '上次提交结果未知，请先在公众号后台核对。' };
      publishId = receipt.publishId;
    }
    if (typeof publishId !== 'string' || !publishId) throw new Error('发布标识无效。');
    const payload = await this.withToken(accountId, token => this.requestJson('/cgi-bin/freepublish/get', {
      query: { access_token: token },
      body: { publish_id: publishId },
    }));
    const code = Number(payload.publish_status);
    const status = code === 0 ? 'success' : code === 1 ? 'pending' : code >= 2 ? 'failed' : 'unknown';
    const item = payload.article_detail?.item?.[0];
    const result = {
      publishId,
      status,
      ...(Number.isFinite(Number(payload.fail_idx)) ? { failIdx: Number(payload.fail_idx) } : {}),
      ...(typeof item?.article_url === 'string' ? { articleUrl: item.article_url } : {}),
      ...(status === 'failed' ? { error: '微信发布未成功，请检查公众号后台。' } : {}),
    };
    for (const receipt of this.receipts.values()) {
      if (receipt.publishId !== publishId) continue;
      receipt.state = status;
      if (result.articleUrl) receipt.articleUrl = result.articleUrl;
      await this.persistReceipts().catch(() => {});
      break;
    }
    return result;
  }

  async list(plugin, { accountId, type, offset = 0, count = 20 } = {}) {
    this.permitted(plugin, 'list');
    if (!['draft', 'published'].includes(type)) throw new Error('列表类型无效。');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(count) || count < 1 || count > 50) throw new Error('列表范围无效。');
    const endpoint = type === 'draft' ? '/cgi-bin/draft/batchget' : '/cgi-bin/freepublish/batchget';
    const payload = await this.withToken(accountId, token => this.requestJson(endpoint, {
      query: { access_token: token },
      body: { offset, count, no_content: 1 },
    }));
    const items = Array.isArray(payload.item) ? payload.item : [];
    return {
      total: Number(payload.total_count) || 0,
      items: items.map(item => {
        const news = item.content?.news_item?.[0] || {};
        const status = type === 'draft'
          ? 'draft'
          : Number(item.publish_status) === 0 ? 'published' : Number(item.publish_status) === 1 ? 'unknown' : 'failed';
        return {
          mediaId: String(item.media_id || item.article_id || ''),
          title: String(news.title || '未命名文章'),
          status,
          ...(Number.isFinite(Number(item.update_time)) ? { updatedAt: Number(item.update_time) * 1000 } : {}),
          ...(typeof news.url === 'string' ? { articleUrl: news.url } : {}),
        };
      }).filter(item => item.mediaId),
    };
  }
}
