import { mkdir, readFile, writeFile, copyFile, realpath, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {secureRequest} from './network-transport.mjs';
import { allowedNetwork } from './security.mjs';

export function resolveSaveExtension(name, mime) {
  const mimeMap = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  const mimeExt = (mime && mimeMap[mime.toLowerCase()]) || null;
  const extFromName = path.extname(name || "").toLowerCase().replace(/^\./, "");
  if (mimeExt) {
    if (extFromName === mimeExt) return extFromName;
    if ((mimeExt === "jpg" || mimeExt === "jpeg") && (extFromName === "jpg" || extFromName === "jpeg")) {
      return extFromName;
    }
    return mimeExt;
  }
  return extFromName || null;
}

export function hasValidSaveExtension(filePath, ext) {
  if (!filePath || typeof filePath !== "string" || !ext) return false;
  const lower = filePath.toLowerCase();
  const normalizedExt = ext.toLowerCase();
  if (lower.endsWith("." + normalizedExt)) return true;
  if ((normalizedExt === "jpg" || normalizedExt === "jpeg") && (lower.endsWith(".jpg") || lower.endsWith(".jpeg"))) return true;
  return false;
}

export function ensureSaveExtension(filePath, ext) {
  if (!filePath || typeof filePath !== "string" || !ext) return filePath;
  const trimmed = filePath.trimEnd().replace(/\.+$/, "");
  if (hasValidSaveExtension(trimmed, ext)) return trimmed;
  return trimmed + "." + ext.toLowerCase();
}

export function resolveSaveFilters(extension) {
  if (!extension) return [];
  const ext = extension.toLowerCase();
  if (ext === "pdf") {
    return [
      { name: "PDF 文档 (*.pdf)", extensions: ["pdf"] },
      { name: "所有文件 (*.*)", extensions: ["*"] }
    ];
  }
  if (ext === "png") {
    return [
      { name: "PNG 图片 (*.png)", extensions: ["png"] },
      { name: "所有文件 (*.*)", extensions: ["*"] }
    ];
  }
  if (ext === "jpg" || ext === "jpeg") {
    return [
      { name: "JPEG 图片 (*.jpg;*.jpeg)", extensions: ["jpg", "jpeg"] },
      { name: "所有文件 (*.*)", extensions: ["*"] }
    ];
  }
  if (ext === "webp") {
    return [
      { name: "WebP 图片 (*.webp)", extensions: ["webp"] },
      { name: "所有文件 (*.*)", extensions: ["*"] }
    ];
  }
  return [
    { name: ext.toUpperCase() + " 文件 (*." + ext + ")", extensions: [ext] },
    { name: "所有文件 (*.*)", extensions: ["*"] }
  ];
}
export class FileBroker {
  constructor(root, dialog) { this.root = root; this.dialog = dialog; this.tokens = new Map(); this.epochs = new Map(); this.directories = new Map(); }
  async initialize() { await rm(this.root, { recursive: true, force: true }); }
  async create(plugin, bytes, name, mime = 'application/octet-stream', epoch = this.epochs.get(plugin.id) ?? 0) {
    if (!plugin.permissions.files) throw new Error('插件没有文件权限。');
    if (bytes.length > 64 * 1024 * 1024) throw new Error('文件内容过大。');
    if ((this.epochs.get(plugin.id) ?? 0) !== epoch) throw new Error('文件未授权或已失效。');
    const dir = path.join(this.root, plugin.id); await mkdir(dir, { recursive: true, mode: 0o700 });
    const token = randomUUID(), filename = path.join(await realpath(dir), token); await writeFile(filename, bytes, { mode: 0o600 });
    if ((this.epochs.get(plugin.id) ?? 0) !== epoch) { await rm(filename, { force: true }); throw new Error('文件未授权或已失效。'); }
    const item = { token, name: path.basename(name), size: bytes.length, mime };
    this.tokens.set(token, { ...item, filename, owner: plugin.id }); return item;
  }
  async get(plugin, token) {
    const item = this.tokens.get(token);
    if (!item || item.owner !== plugin.id || !plugin.permissions.files) throw new Error('文件未授权或已失效。');
    if ((await lstat(item.filename)).isSymbolicLink() || await realpath(item.filename) !== item.filename) throw new Error('文件路径已改变。');
    return item;
  }
  async pick(plugin, options = {}) {
    if (!plugin.permissions.files) throw new Error('插件没有文件权限。');
    const epoch = this.epochs.get(plugin.id) ?? 0;
    const extensions = (options.extensions ?? []).filter(s => typeof s === 'string' && /^[a-z0-9]{1,8}$/.test(s)).slice(0, 12);
    const result = await this.dialog.showOpenDialog({ title: plugin.title + ' · 选择文件', properties: ['openFile'], filters: extensions.length ? [{ name: '支持的文件', extensions }] : [] });
    if (result.canceled) return null;
    const filename = result.filePaths[0]; const info = await lstat(filename);
    if (!info.isFile() || info.size > 25 * 1024 * 1024) throw new Error('请选择不超过 25 MB 的文件。');
    const ext = path.extname(filename).toLowerCase();
    return this.create(plugin, await readFile(filename), path.basename(filename), ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' })[ext], epoch);
  }
  async read(plugin, token) { const item = await this.get(plugin, token); return { data: (await readFile(item.filename)).toString('base64'), mime: item.mime }; }
  async pickMany(plugin, options = {}) {
    if (!plugin.permissions.files) throw new Error('插件没有文件权限。');
    const epoch = this.epochs.get(plugin.id) ?? 0;
    const result = await this.dialog.showOpenDialog({ title: plugin.title + ' · 批量选择图片', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled) return [];
    if (result.filePaths.length > 200) throw new Error('每批最多选择 200 张图片。');
    const items = [];
    try {
      for (const filename of result.filePaths) {
        const info = await lstat(filename), mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(filename).toLowerCase()];
        if (!mime || !info.isFile() || info.size > 25 * 1024 ** 2) throw new Error('请选择不超过 25 MB 的 PNG、JPEG 或 WebP 图片。');
        items.push(await this.create(plugin, await readFile(filename), path.basename(filename), mime, epoch));
      }
      return items;
    } catch (error) { await Promise.allSettled(items.map(item => this.release(plugin, item.token))); throw error; }
  }
  async pickDirectory(plugin) {
    if (!plugin.permissions.files) throw new Error('插件没有文件权限。');
    const epoch = this.epochs.get(plugin.id) ?? 0;
    const result = await this.dialog.showOpenDialog({ title: plugin.title + ' · 输出目录', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const filename = await realpath(result.filePaths[0]), info = await lstat(filename);
    if (!info.isDirectory() || (this.epochs.get(plugin.id) ?? 0) !== epoch) throw new Error('目录授权已失效。');
    const token = randomUUID();
    this.directories.set(token, { owner: plugin.id, filename, dev: info.dev, ino: info.ino });
    return { token, name: path.basename(filename) };
  }
  directory(plugin, token) {
    const item = this.directories.get(token);
    if (!plugin.permissions.files || item?.owner !== plugin.id) throw new Error('输出目录未授权。');
    return { ...item };
  }
  async url(plugin, token) {
    await this.get(plugin, token);
    return 'commerce-plugin://' + plugin.id + '/__files/' + encodeURIComponent(token);
  }
  async release(plugin, token) {
    const item = await this.get(plugin, token);
    this.tokens.delete(token);
    await rm(item.filename, { force: true });
  }
  async save(plugin, token, filename) {
    const item = await this.get(plugin, token);
    const candidateName = typeof filename === "string" && filename.trim() ? filename.trim() : item.name;
    const rawName = (candidateName || "file").replace(/\\/g, "/");
    const baseName = path.basename(rawName) || "file";
    const sanitized = baseName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "file";
    const ext = resolveSaveExtension(sanitized, item.mime);
    const defaultPath = ensureSaveExtension(sanitized, ext);
    const filters = resolveSaveFilters(ext);
    const dialogOptions = {
      title: plugin.title + " · 保存文件",
      defaultPath,
      ...(filters.length ? { filters } : {})
    };
    const result = await this.dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return false;
    await this.get(plugin, token);
    const targetPath = ensureSaveExtension(result.filePath, ext);
    await copyFile(item.filename, targetPath);
    return true;
  }
  async revoke(id) { this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1); const pending = []; for (const [key, value] of this.tokens) if (value.owner === id) { this.tokens.delete(key); pending.push(rm(value.filename, { force: true })); } await Promise.all(pending); }
}
export class NetworkBroker {
  constructor(files, credentials, request = secureRequest) { this.files = files; this.credentials = credentials; this.request = request; this.tasks = new Map(); }
  async call(plugin, options) {
    const url = allowedNetwork(plugin, options.url);
    if (url.href !== 'https://api.remove.bg/v1.0/removebg' || !options.fileToken) return this.generic(plugin, options, url);
    // v1's online capability is deliberately bounded to the documented upload API.
    if (url.href !== 'https://api.remove.bg/v1.0/removebg' || !(plugin.permissions.credentials ?? []).includes(options.credential)) throw new Error('服务或凭据未授权。');
    const item = await this.files.get(plugin, options.fileToken);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(item.mime) || item.size > 22 * 1024 * 1024) throw new Error('请选择小于 22 MB 的 JPG、PNG 或 WebP 图片。');
    const secret = await this.credentials.get(plugin.id, options.credential); if (!secret) throw new Error('请先配置 remove.bg API 密钥。');
    const key = plugin.id + ':' + (options.taskId || randomUUID()); if (this.tasks.has(key)) throw new Error('任务已在运行。');
    const controller = new AbortController(); this.tasks.set(key, controller); const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const form = new FormData(); form.append('image_file', new Blob([await readFile(item.filename)], { type: item.mime }), item.name); form.append('size', 'auto'); form.append('format', 'png');
      controller.signal.throwIfAborted();
      const response = await this.request(url.href, { method: 'POST', body: form, headers: { 'X-Api-Key': secret }, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        const message = response.status === 401 || response.status === 403 ? 'API 密钥无效或未授权。' : response.status === 402 ? 'remove.bg 调用额度不足。' : response.status === 429 ? '服务请求过于频繁，请稍后手动重试。' : '抠图服务未完成处理（' + response.status + '）。';
        throw new Error(message);
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 64 * 1024 * 1024) { controller.abort(); throw new Error('服务返回的图片过大。'); } chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('服务没有返回有效的 PNG 图片。');
      controller.signal.throwIfAborted();
      return await this.files.create(plugin, bytes, path.parse(item.name).name + '-透明背景.png', 'image/png');
    } catch (e) { if (controller.signal.aborted) throw new Error('抠图任务已取消或超时；请检查额度后再重试。'); const safe = ['API 密钥无效或未授权。','remove.bg 调用额度不足。','服务请求过于频繁，请稍后手动重试。','服务没有返回有效的 PNG 图片。','服务返回的图片过大。','插件网络代理禁止访问本机和私有网络。','服务重定向被拒绝。']; throw new Error(safe.includes(e.message) || /^抠图服务未完成处理（\d+）。$/.test(e.message) ? e.message : '网络连接失败，请检查连接后手动重试。'); }
    finally { clearTimeout(timer); this.tasks.delete(key); }
  }
  async generic(plugin,options,url) {
    const method=options.method || 'GET';if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))throw new Error('请求方法不受支持。');
    const headers={Accept:'application/json'};let body;
    if (options.responseType !== undefined && !['data', 'file'].includes(options.responseType)) throw new Error('响应类型不受支持。');
    if (options.responseType === 'file' && !plugin.permissions.files) throw new Error('插件没有文件权限。');
    if (options.multipart !== undefined) {
      if (options.json !== undefined || method === 'GET' || !options.multipart || typeof options.multipart !== 'object') throw new Error('上传内容无效。');
      const fields = options.multipart.fields ?? {}, attachments = options.multipart.files ?? [];
      if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 32 || !Array.isArray(attachments) || attachments.length > 16) throw new Error('上传内容无效。');
      const validField = name => typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(name);
      const form = new FormData(); let total = 0;
      for (const [name, value] of Object.entries(fields)) {
        if (!validField(name) || typeof value !== 'string') throw new Error('上传字段无效。');
        total += Buffer.byteLength(value); form.append(name, value);
      }
      const items = [];
      for (const attachment of attachments) {
        if (!attachment || !validField(attachment.field)) throw new Error('上传文件字段无效。');
        const item = await this.files.get(plugin, attachment.token);
        total += item.size; items.push({ field: attachment.field, item });
      }
      if (total > 25 * 1024 ** 2) throw new Error('上传内容不能超过 25 MB。');
      for (const { field, item } of items) form.append(field, new Blob([await readFile(item.filename)], { type: item.mime }), item.name);
      body = form;
    }
    if(options.json!==undefined) {body=JSON.stringify(options.json);if(body.length>4*1024*1024||method==='GET')throw new Error('请求内容无效或过大。');headers['Content-Type']='application/json';}
    if(options.credential) {
      if(!(plugin.permissions.credentials ?? []).includes(options.credential))throw new Error('凭据未授权。');
      const secret=await this.credentials.get(plugin.id,options.credential);if(!secret)throw new Error('请先配置服务凭据。');
      if(options.credentialHeader==='X-Api-Key')headers['X-Api-Key']=secret;else headers.Authorization='Bearer '+secret;
    }
    const key=plugin.id+':'+(options.taskId||randomUUID());if(this.tasks.has(key))throw new Error('任务已在运行。');
    const controller=new AbortController();this.tasks.set(key,controller);const timer=setTimeout(()=>controller.abort(),120000);
    try {
      controller.signal.throwIfAborted();const response=await this.request(url.href,{method,headers,body,redirect:'error',signal:controller.signal});
      const limit = options.responseType === 'file' ? 64 * 1024 ** 2 : 8 * 1024 ** 2;
      const chunks=[];let size=0;if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>limit){controller.abort();throw new Error('服务响应过大。');}chunks.push(chunk);}
      controller.signal.throwIfAborted();
      const bytes = Buffer.concat(chunks), mime = response.headers.get('content-type') || 'application/octet-stream';
      if (options.responseType === 'file') {
        if (options.filename !== undefined && (typeof options.filename !== 'string' || !options.filename || options.filename.length > 240)) throw new Error('文件名无效。');
        return { status: response.status, mime, file: await this.files.create(plugin, bytes, options.filename || 'response', mime) };
      }
      return {status:response.status,mime,data:bytes.toString('base64')};
    }catch(error){if(controller.signal.aborted)throw new Error('网络任务已取消或超时。');throw new Error('网络请求未完成，请检查连接或服务配置。');}finally{clearTimeout(timer);this.tasks.delete(key);}
  }
  cancel(id, task) { this.tasks.get(id + ':' + task)?.abort(); }
  stop(id) { for (const [key, controller] of this.tasks) if (key.startsWith(id + ':')) controller.abort(); }
}
