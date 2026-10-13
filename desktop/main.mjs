import { app, BrowserWindow, WebContentsView, dialog, ipcMain, protocol, session, utilityProcess, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { PluginManager, boundedDownload, inspectPackage } from './plugin-manager.mjs';
import { confinedPath } from './security.mjs';
import { Workers } from './workers.mjs';
import { FileBroker, NetworkBroker, resolveSaveExtension, ensureSaveExtension, resolveSaveFilters } from './brokers.mjs';
import { Credentials } from './credentials.mjs';
import updater from 'electron-updater';
const { autoUpdater } = updater;
import {validateCatalog} from './catalog.mjs';
import { UpdateService, nativeUpdateAdapter } from './update-service.mjs';
import { PluginInstallService } from './plugin-install-service.mjs';
import { macUpdateAdapter, previousUpdateError } from './mac-update.mjs';
import {desktopSigningMode} from './distribution.mjs';
import { preparePluginMigration } from './plugin-migration.mjs';
import { ImageEditor } from './ai-images.mjs';
import { BatchRuntime } from './ai-batches.mjs';
import { ProxyRuntime } from './ai-proxy.mjs';
import { DownloadSourceService } from './download-sources.mjs';
import { HARNESS_VERSION } from './harness-version.mjs';
import { HOST_CHAT_PREFIX, isHostChat, pluginToolCatalog, PluginApprovals } from './ai-plugin-tools.mjs';
// Resolve the established profile before changing the display name. This also
// preserves an explicit --user-data-dir supplied by integration tests/users.
app.setName('Commerce Tools');
const establishedUserData = app.getPath('userData');
app.setName('Qingzuo');
const previewDistribution = app.isPackaged ? JSON.parse(readFileSync(path.join(process.resourcesPath, 'commerce/distribution.json'), 'utf8')) : null;
app.setPath('userData', previewDistribution?.preview && !app.commandLine.hasSwitch('user-data-dir') ? path.join(app.getPath('appData'), 'Qingzuo Local Preview') : establishedUserData);
const primary = app.requestSingleInstanceLock();
const root = fileURLToPath(new URL('../', import.meta.url));
protocol.registerSchemesAsPrivileged([{ scheme: 'commerce', privileges: { standard: true, secure: true, supportFetchAPI: true } }, { scheme: 'commerce-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window, manager, workers, files, credentials, network, host, quitting = false, quitReady = false, shutdownPromise, hostReady;
const views = new Map(), owners = new Map(), kernelRequests = new Map(); let kernelCounter = 0; let visible = null, systems = [], kernelError = null;
const pluginSessions = new Map();
const viewQueues = new Map(), viewEpochs = new Map();
let updateService, pluginInstallService;
let localPreview = false;
let migration;
let batches, proxy, imageEditor, approvals, downloadSources;
const generated = app.isPackaged ? path.join(process.resourcesPath, 'commerce') : path.join(root, 'resources/generated');
const launcher = path.join(generated, 'commerce-sandbox' + (process.platform === 'win32' ? '.exe' : ''));
function changed() { if (window && !window.isDestroyed()) window.webContents.send('commerce:changed'); }
function aiChanged(id, event) { if (isHostChat(id)) { if (window && !window.isDestroyed()) window.webContents.send('commerce:ai', { ...event, chatId: id.slice(HOST_CHAT_PREFIX.length) }); return; } const view = views.get(id); if (view && !view.webContents.isDestroyed()) view.webContents.send('commerce:ai', event); }
async function stopPlugin(id) {
  approvals?.cancelPlugin(id);
  const plugin = await manager.get(id).catch(() => null);
  if (plugin && batches) await batches.stopPlugin(plugin);
  if (host && systems.length === 7) await kernelRequest({ type: 'call', kind: 'ai', method: 'assistant.dispose', caller: id }).catch(() => {});
  for (const [token, directory] of files?.directories || []) if (directory.owner === id) files.directories.delete(token);
  await closeView(id);
}
function sanitizePlugin(p) { const { folder, backend, ...publicValue } = p; return { ...publicValue, local: Boolean(backend) }; }
function assertFrame(event, shellOnly = false) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('未授权的框架请求。');
  if (shellOnly) { if (event.sender !== window?.webContents) throw new Error('未授权的平台请求。'); return; }
  const id = owners.get(event.sender.id);
  if (!id || new URL(event.senderFrame.url).hostname !== id) throw new Error('插件身份校验失败。');
  return id;
}
function validateCall(method, args) { if (typeof method !== 'string' || method.length > 80 || (JSON.stringify(args) ?? '').length > 38_000_000) throw new Error('请求无效或过大。'); }
function hideViews() { for (const v of views.values()) v.setVisible(false); visible = null; }
async function closeView(id) {
  viewEpochs.set(id,(viewEpochs.get(id) ?? 0)+1);
  const view = views.get(id); if (view) { views.delete(id); if (!view.webContents.isDestroyed()) { view.webContents.send('commerce:dispose'); owners.delete(view.webContents.id); if (window && !window.isDestroyed()) window.contentView.removeChildView(view); view.webContents.close(); } }
  if (visible === id) visible = null; network?.stop(id); await files?.revoke(id); await workers?.stop(id);
}
async function resourceResponse(filename) {
  // Read through the trusted broker. Chromium's file/network service does not
  // need access to private plugin directories or another session's policies.
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }[path.extname(filename).toLowerCase()] || 'application/octet-stream';
  return new Response(await readFile(filename), { headers: { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' } });
}
async function servePlugin(request, id) {
  try { const url = new URL(request.url); if (url.hostname !== id || url.protocol !== 'commerce-plugin:') return new Response('Forbidden', { status: 403 });
    const plugin = await manager.get(id); if (!plugin.enabled) return new Response('Disabled', { status: 403 });
    const token = url.pathname.match(/^\/__files\/([a-f0-9-]{36})$/);
    if (token) {
      const item = await files.get(plugin, token[1]);
      return new Response(await readFile(item.filename), { headers: { 'Content-Type': item.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox" } });
    }
    const image = url.pathname.match(/^\/api\/documents\/([a-f0-9]{32})\/pages\/(\d{1,2})\/image$/);
    if (image && plugin.id === 'official.labeledit') { const value = await (await workers.start(plugin)).call('image', { id: image[1], page: Number(image[2]) }); return new Response(Buffer.from(value.data, 'base64'), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } }); }
    const filename = await confinedPath(plugin.folder, decodeURIComponent(url.pathname.slice(1)));
    const response = await resourceResponse(filename);
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    return response;
  } catch (error) { console.error('Plugin resource failed:', id, request.url, error.message); return new Response('Not found', { status: 404 }); }
}
function openView(id, settings = false) {
  const epoch=viewEpochs.get(id) ?? 0;
  const operation=(viewQueues.get(id) ?? Promise.resolve()).catch(()=>{}).then(()=>loadView(id,settings,epoch));
  viewQueues.set(id,operation);
  const clear=()=>{if(viewQueues.get(id)===operation)viewQueues.delete(id);};
  void operation.then(clear,clear);return operation;
}
function assertViewEpoch(id,epoch) {if(quitting || (viewEpochs.get(id) ?? 0)!==epoch)throw new Error('工具打开已取消。');}
async function loadView(id, settings, epoch) {
  while (toolSyncPromise) await toolSyncPromise;
  const plugin = await manager.get(id); if (!plugin.enabled || plugin.missing.length) throw new Error('插件已停用或缺少依赖。');
  pluginInstallService.assertAvailable(id);
  assertViewEpoch(id,epoch);
  if (!views.has(id)) {
    let ses = pluginSessions.get(id);
    if (!ses) {
      ses = session.fromPartition('persist:commerce-' + id);
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); ses.setPermissionCheckHandler(() => false);
      // HTTP interception alone does not cover WebRTC sockets. Require the
      // browser network stack to use an unreachable proxy, including loopback;
      // local schemes still resolve through the identity-bound handlers below.
      await ses.setProxy({mode:'fixed_servers',proxyRules:'socks5://127.0.0.1:0',proxyBypassRules:'<-loopback>'});
      await ses.closeAllConnections();
      for (const target of ['https://example.com','http://127.0.0.1','http://[::1]']) {
        if (await ses.resolveProxy(target) !== 'SOCKS5 127.0.0.1:0') throw new Error('插件网络隔离不可用。');
      }
      // Register in each storage partition explicitly. A scheme being handled
      // elsewhere does not install an identity-bound handler in this session.
      ses.protocol.handle('commerce-plugin', request => servePlugin(request, id));
      ses.webRequest.onBeforeRequest((details, callback) => { const url = new URL(details.url); const cancel = !(['data:', 'blob:'].includes(url.protocol) || url.protocol === 'commerce-plugin:' && url.hostname === id); if(cancel)console.log('Plugin request blocked:',id,url.origin); callback({ cancel }); });
      ses.on('will-download', async (event, item) => {
        item.pause();
        try {
          const current = await manager.get(id);
          if (!current.enabled || !current.permissions.files) { item.cancel(); return; }
          const rawName = (item.getFilename() || '').replace(/\\/g, '/');
          const baseName = path.basename(rawName) || 'download';
          const sanitized = baseName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
          const ext = resolveSaveExtension(sanitized, item.getMimeType());
          const defaultPath = ensureSaveExtension(sanitized, ext);
          const filters = resolveSaveFilters(ext);
          const result = await dialog.showSaveDialog(window, {
            defaultPath,
            ...(filters.length ? { filters } : {})
          });
          if (result.canceled || !result.filePath) item.cancel();
          else {
            const targetPath = ensureSaveExtension(result.filePath, ext);
            item.setSavePath(targetPath);
            item.resume();
          }
        } catch (error) {
          console.error('Plugin download failed:', id, error.message);
          item.cancel();
        }
      });
      pluginSessions.set(id, ses);
    }
    pluginInstallService.assertAvailable(id);
    assertViewEpoch(id,epoch);
    const view = new WebContentsView({ webPreferences: { session: ses, preload: path.join(root, 'desktop/plugin-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck:false, additionalArguments: ['--commerce-plugin=' + id] } });
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('commerce-plugin://' + id + '/')) event.preventDefault(); });
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.on('did-fail-load', (_event, code, description) => console.error('Plugin view failed:', id, code, description));
    view.webContents.on('render-process-gone', (_event, details) => console.error('Plugin renderer gone:', id, details));
    // Create the native view with a real viewport before navigation. Inactive
    // tools stay hidden until the shell supplies their final surface bounds.
    const {width,height} = window.getContentBounds();
    view.setBounds({x:0,y:0,width,height}); view.setVisible(false);
    window.contentView.addChildView(view); views.set(id, view); owners.set(view.webContents.id, id);
    try { await view.webContents.loadURL('commerce-plugin://' + id + '/' + (settings ? plugin.settings?.entry || plugin.ui : plugin.ui)); }
    catch (e) { await closeView(id); throw e; }
  }
  pluginInstallService.assertAvailable(id);
  assertViewEpoch(id,epoch);
  const destination = 'commerce-plugin://' + id + '/' + (settings ? plugin.settings?.entry || plugin.ui : plugin.ui);
  if (views.get(id).webContents.getURL() !== destination) await views.get(id).webContents.loadURL(destination);
  hideViews(); visible = id; return sanitizePlugin(plugin);
}
function kernelRequest(message, timeout = 30000) {
  if (!host || systems.length !== 7) return Promise.reject(new Error('Harness 内核不可用，请重新启动。'));
  return new Promise((resolve,reject) => { const id = ++kernelCounter; const timer = timeout > 0 ? setTimeout(() => { kernelRequests.delete(id); reject(new Error('内核请求超时。')); }, timeout) : null; kernelRequests.set(id,{resolve,reject,timer}); host.postMessage({...message,id}); });
}
let toolSyncPromise = null;
async function syncTools() {
  // Reconcile mutates the Harness registry. Different plugin jobs may finish
  // together, so queue only this operation; ordinary/nested RPC stays concurrent.
  const current = (toolSyncPromise ?? Promise.resolve()).catch(() => {}).then(async () => {
    for (const p of await manager.list()) if (!p.enabled || p.missing.length) await closeView(p.id);
    return kernelRequest({ type: 'sync', plugins: (await manager.list()).map(({ id, enabled, missing, services }) => ({ id, enabled, missing, services })) });
  });
  toolSyncPromise = current;
  try { return await current; }
  finally { if (toolSyncPromise === current) toolSyncPromise = null; }
}
async function startKernel() {
  approvals?.dispose();
  kernelError = null; systems = []; const previousHost = host; host = null; previousHost?.kill();
  for (const p of kernelRequests.values()) { clearTimeout(p.timer); p.reject(new Error('内核已重新启动。')); } kernelRequests.clear();
  host = utilityProcess.fork(path.join(root, 'desktop/kernel-host.mjs'), [], { serviceName: 'Commerce Harness Kernel', stdio: 'pipe', env: { ...process.env, DSH_HOME: path.join(app.getPath('userData'), 'harness'), DSH_TELEMETRY_DISABLED: '1' } });
  host.stderr?.on('data', data => console.error('[kernel]', data.toString().trim()));
  const currentHost = host;
  hostReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Harness 内核启动超时。')), 30000);
    host.on('message', async message => {
      if (currentHost !== host) return;
      if (message.type === 'reply') { const p=kernelRequests.get(message.id); kernelRequests.delete(message.id); if(p) {clearTimeout(p.timer); if(message.error) p.reject(new Error(message.error)); else p.resolve(message.result);} }
      else if (message.type === 'ready') { clearTimeout(timer); systems = message.systems; changed(); resolve(); }
      else if (message.type === 'fatal') { clearTimeout(timer); kernelError = message.error; changed(); reject(new Error(message.error)); }
      else if (message.type === 'invoke') { try { const result = await systemInvoke(message.service, message.method, message.args); if (currentHost === host) currentHost.postMessage({ type: 'result', id: message.id, result }); } catch (error) { if (currentHost === host) currentHost.postMessage({ type: 'result', id: message.id, error: error.message }); } }
    });
    host.once('exit', code => { if (currentHost !== host) return; for(const p of kernelRequests.values()) {clearTimeout(p.timer);p.reject(new Error('内核进程已退出。'));} kernelRequests.clear(); clearTimeout(timer); if (!quitting) { kernelError = 'Harness 内核已退出（' + code + '）。'; systems = []; void Promise.all([...views.keys()].map(closeView)).then(() => workers.stopAll()).finally(changed); changed(); reject(new Error(kernelError)); } });
  });
  host.postMessage({ type: 'init', options: { home: path.join(app.getPath('userData'), 'harness'), installAnchor: path.join(root, 'package.json'), enableAI: true } });
  await hostReady; await syncTools();
}
async function catalog(signal) {
  const config = JSON.parse(await readFile(path.join(generated, 'market.json'), 'utf8'));
  if (!config.url || !config.publicKey) return { items: [], configured: false, message: '插件目录尚未发布。可以导入本地插件包。' };
  const loadCatalog = async url => validateCatalog(JSON.parse((await boundedDownload(url, 1024 * 1024, signal)).toString()));
  const items = downloadSources ? await downloadSources.runWithFallback(config.url, loadCatalog, { signal }) : await loadCatalog(config.url);
  return { items, configured: true };
}
async function systemInvoke(service, method, args = {}) {
  if (service === 'ai') {
    if (method === 'models') return proxy.models();
    if (isHostChat(args.owner)) {
      if (method === 'connection') return proxy.connection(true);
      if (method === 'event') { aiChanged(args.owner, args.event); return; }
      if (method === 'tools.list') return { plugins: pluginToolCatalog(await manager.list()) };
      if (method === 'tools.call') return approvals.request(args.owner, args);
      throw new Error('对话工具接口未授权。');
    }
    const plugin = await manager.get(args.owner);
    if (!plugin.enabled || plugin.missing.length || !plugin.permissions.ai?.includes(method.startsWith('batch.') ? 'image-edit' : 'assistant')) throw new Error('AI 内核调用未授权。');
    if (method === 'connection') return proxy.connection(true);
    if (method === 'event') { aiChanged(plugin.id, args.event); return; }
    if (method === 'batch.get') return batches.snapshot(batches.get(plugin, args.id));
    if (method === 'batch.revise') return batches.revise(plugin, args);
    if (method === 'batch.cancel') return batches.cancel(plugin, args.id);
    throw new Error('AI 内核调用无效。');
  }
  if (service === 'home' && method === 'list') return (await manager.list()).map(sanitizePlugin);
  if (service === 'sandbox' && method === 'call') {
    const caller = await manager.get(args.caller), provider = await manager.get(args.provider);
    if (!caller.enabled || caller.missing.length || !provider.enabled || provider.missing.length || !(provider.services?.provides ?? []).includes(args.service) || ![...(caller.services?.provides ?? []), ...(caller.services?.requires ?? [])].includes(args.service)) throw new Error('服务调用未授权。');
    return (await workers.start(provider, caller.id)).call(args.method, args.args);
  }
  if (service === 'credentials' && ['set','status','clear'].includes(method)) {
    const plugin = await manager.get(args.id); if (!plugin.enabled || !(plugin.permissions.credentials ?? []).includes(args.name)) throw new Error('凭据未授权。');
    return credentials[method](args.id,args.name,args.value);
  }
  if (['plugins','market','updates'].includes(service) && method.startsWith(service + '.')) return performPlatform(method,args);
  throw new Error('系统方法未注册。');
}
async function performPlatform(method, args) {
  if (method === 'plugins.import') {
    const result = await dialog.showOpenDialog(window, { title: '导入插件', properties: ['openFile'], filters: [{ name: '电商工具插件', extensions: ['ecplugin', 'zip'] }] }); if (result.canceled || !result.filePaths?.length) return;
    const bytes = await readFile(result.filePaths[0]); const manifest=inspectPackage(bytes);
    pluginInstallService.assertAvailable(manifest.id);
    const confirm = await dialog.showMessageBox(window, { type: 'question', buttons: ['取消', '安装'], defaultId: 0, title: '安装本地插件', message: '此插件的作者尚未经过市场签名验证。', detail: manifest.title + ' (' + manifest.id + ') v' + manifest.version + '\n文件选择与保存：' + (manifest.permissions.files ? '申请' : '未申请') + '\n网络来源：' + (manifest.permissions.network ?? []).join('、') + '\n凭据名称：' + (manifest.permissions.credentials ?? []).join('、') + '\nAI 能力：' + (manifest.permissions.ai ?? []).join('、') + '\n插件将在隔离环境中运行，可随时停用或卸载。' }); if (confirm.response !== 1) return;
    pluginInstallService.assertAvailable(manifest.id);
    await manager.install(bytes); return;
  }
  if (['plugins.enable', 'plugins.uninstall', 'plugins.rollback'].includes(method)) pluginInstallService.assertAvailable(args.id);
  if (method === 'plugins.enable') { await manager.setEnabled(args.id, args.enabled); return; }
  if (method === 'plugins.uninstall') { await manager.uninstall(args.id); return; }
  if (method === 'plugins.rollback') { await manager.rollback(args.id); return; }
  if (method === 'market.list') return catalog();
  if (method === 'market.install') {
    return pluginInstallService.start(args.id);
  }
  if (method === 'updates.check' || method === 'updates.download') {
    if (localPreview) throw new Error('本地预览版本不连接正式更新，请使用后续经过验收的安装包。');
    if (!app.isPackaged) throw new Error('开发环境不检查安装包更新。');
    if (method === 'updates.check') updateService.check();
    else updateService.download();
    return;
  }
  if (method === 'updates.cleanCache') {
    return await updateService.cleanCache();
  }
  throw new Error('平台操作不受支持。');
}
ipcMain.handle('commerce:platform', async (event, method, args = {}) => {
  assertFrame(event, true); validateCall(method, args);
  if (method.startsWith('ai.')) {
    if (method.startsWith('ai.chat.')) {
      const operation = method.slice(3);
      if (operation === 'chat.tools') return pluginToolCatalog(await manager.list());
      if (operation === 'chat.approve') { approvals.respond(HOST_CHAT_PREFIX + args.id, args.approvalId, args.approve); return { accepted: true }; }
      if (operation === 'chat.cancel' || operation === 'chat.delete') approvals.cancelOwner(HOST_CHAT_PREFIX + args.id);
      if (!['chat.list', 'chat.create', 'chat.status', 'chat.send', 'chat.cancel', 'chat.delete'].includes(operation)) throw new Error('对话接口无效。');
      const value = await kernelRequest({ type: 'call', kind: 'ai', method: operation, args });
      if (operation === 'chat.status') return { ...value, approvals: approvals.list(HOST_CHAT_PREFIX + args.id) };
      return value;
    }
    const operations = { 'ai.status': () => proxy.status(), 'ai.configure': () => proxy.configure(args), 'ai.start': () => proxy.start(), 'ai.stop': () => proxy.stop(), 'ai.models': () => proxy.models(), 'ai.verify': () => proxy.verify() };
    if (!operations[method]) throw new Error('AI 设置接口无效。');
    return operations[method]();
  }
  if (method === 'downloadSource.get') return downloadSources.snapshot();
  if (method === 'downloadSource.set') return downloadSources.setSource(args.source);
  if (method === 'downloadSource.addCustomMirror') return downloadSources.addCustomMirror(args.url);
  if (method === 'downloadSource.removeCustomMirror') return downloadSources.removeCustomMirror(args.url);
  if (method === 'status') return { version: app.getVersion(), kernel: { ready: systems.length === 7, error: kernelError, version: HARNESS_VERSION, systems }, plugins: systems.length === 7 ? await kernelRequest({type:'call',kind:'system',service:'home',method:'list',args:{}}) : (await manager.list()).map(sanitizePlugin), pluginInstalls: pluginInstallService.snapshot(), update: updateService.state, downloadSource: downloadSources?.snapshot(), componentUpdates: { harness: { status: 'bundled', currentVersion: HARNESS_VERSION, candidateVersion: null, progress: 0, transferred: 0, total: 0, error: null, compatibility: 'bundled-with-qingzuo' } }, tabs: [...views.keys()], migration: await migration.status(manager) };
  if (method === 'migration.dismiss') { await migration.dismiss(); changed(); return; }
  if (method === 'kernel.retry') { await startKernel(); return true; }
  if (method === 'view.open') return openView(args.id, args.settings);
  if (method === 'view.hide') { hideViews(); return; }
  if (method === 'view.close') { await closeView(args.id); changed(); return; }
  if (method === 'view.bounds') { const view = views.get(visible); if (view) { const {width,height} = window.getContentBounds(); if (['x','y','width','height'].every(k => Number.isFinite(args[k]) && args[k] >= 0) && args.x+args.width <= width+2 && args.y+args.height <= height+2) { view.setBounds(Object.fromEntries(['x','y','width','height'].map(k => [k,Math.floor(args[k])]))); view.setVisible(true); } } return; }
  const service = method.split('.')[0];
  if (!['plugins','market','updates'].includes(service)) throw new Error('平台操作不受支持。');
  // The catalogue is native HTTP work, not a short kernel request. Installation
  // still enters the registered market service and only acknowledges a job.
  const result = method === 'market.list' ? await catalog() : await kernelRequest({type:'call',kind:'system',service,method,args}, method === 'plugins.import' ? 0 : 30000);
  if (service === 'plugins') {
    await syncTools();
    changed();
  }
  return result;
});
ipcMain.handle('commerce:plugin', async (event, method, args = {}) => {
  const id = assertFrame(event); validateCall(method, args); const plugin = await manager.get(id);
  if (!plugin.enabled || plugin.missing.length || systems.length !== 7) throw new Error('插件或内核不可用。');
  if (method.startsWith('ai.')) {
    const assistant = method.startsWith('ai.assistant.');
    if (!plugin.permissions.ai?.includes(assistant ? 'assistant' : 'image-edit')) throw new Error('AI 能力未授权。');
    if (method === 'ai.models') return imageEditor.models(plugin, args);
    if (assistant) return kernelRequest({ type: 'call', kind: 'ai', method: method.slice(3), args, caller: id });
    if (method === 'ai.batch.list') return batches.list(plugin);
    if (method === 'ai.batch.get') return batches.snapshot(batches.get(plugin, args.id));
    if (method === 'ai.batch.create') return batches.create(plugin, args);
    if (method === 'ai.batch.revise') return batches.revise(plugin, args);
    if (method === 'ai.batch.start') { const value = await batches.start(plugin, args); void kernelRequest({ type: 'call', kind: 'ai', method: 'batch.track', caller: id, args: { id: args.id } }).catch(() => {}); return value; }
    if (method === 'ai.batch.cancel') return batches.cancel(plugin, args.id);
    if (method === 'ai.batch.preview') return batches.preview(plugin, args);
    throw new Error('AI 插件接口无效。');
  }
  if (method === 'files.pick') return files.pick(plugin, args);
  if (method === 'files.pickMany') return files.pickMany(plugin, args);
  if (method === 'files.pickDirectory') return files.pickDirectory(plugin);
  if (method === 'files.create') {
    if (!plugin.permissions.files || typeof args.data !== 'string' || args.data.length > 35_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.data) || typeof args.filename !== 'string' || args.filename.length > 240 || typeof args.mime !== 'string' || args.mime.length > 100) throw new Error('文件内容无效或未授权。');
    return files.create(plugin, Buffer.from(args.data, 'base64'), args.filename, args.mime);
  }
  if (method === 'files.read') return files.read(plugin, args.token);
  if (method === 'files.url') return files.url(plugin, args.token);
  if (method === 'files.release') return files.release(plugin, args.token);
  if (method === 'files.save') return files.save(plugin, args.token, args.filename);
  if (method.startsWith('credentials.')) {
    if (!(plugin.permissions.credentials ?? []).includes(args.name)) throw new Error('凭据未授权。');
    return kernelRequest({type:'call',kind:'system',service:'credentials',method:method.slice(12),args:{...args,id}});
  }
  if (method === 'network.request') return network.call(plugin, args);
  if (method === 'tasks.cancel') { network.cancel(id, args.id); await workers.stop(id); return; }
  if (method === 'contributions.tool' || method === 'contributions.settings') { if (args.title !== plugin.title && args.title !== plugin.settings?.title) throw new Error('入口必须与已安装清单一致。'); return; }
  if (method === 'services.call') {
    if (!(plugin.services?.provides ?? []).includes(args.service) && !(plugin.services?.requires ?? []).includes(args.service)) throw new Error('服务未声明。');
    return kernelRequest({type:'call',kind:'tool',service:args.service,method:args.method,args:args.args,caller:id});
  }
  throw new Error('插件接口不受支持。');
});
async function shutdownRuntime() {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = (async () => {
    await pluginInstallService?.shutdown();
    approvals?.dispose();
    await batches?.shutdown();
    await proxy?.stop();
    await Promise.all([...views.keys()].map(closeView));
    await workers.stopAll();
    host?.postMessage({ type: 'shutdown' });
    await new Promise(resolve => setTimeout(resolve, 300));
    host?.kill();
  })().finally(() => {
    // Both the updater and the normal before-quit path call app.quit() after
    // this cleanup. Mark the application ready first so the second
    // before-quit event is allowed through instead of being prevented and
    // returning early because quitting is already true.
    quitReady = true;
  });
  return shutdownPromise;
}
async function main() {
await app.whenReady();
migration = await preparePluginMigration(app.getPath('userData'));
await mkdir(app.getPath('userData'), { recursive: true });
downloadSources = new DownloadSourceService({ root: app.getPath('userData'), changed });
await downloadSources.initialize();
credentials = new Credentials(launcher, 'profile.' + createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0,16) + ':'); files = new FileBroker(path.join(app.getPath('userData'), 'files'), dialog); network = new NetworkBroker(files, credentials);
await files.initialize();
const proxyRoot = path.join(app.getPath('userData'), 'ai-proxy');
proxy = new ProxyRuntime({ root: proxyRoot, credentials }); await proxy.initialize();
imageEditor = new ImageEditor(credentials, undefined, proxy);
batches = new BatchRuntime(path.join(app.getPath('userData'), 'ai-batches'), files, imageEditor, aiChanged); await batches.initialize();
approvals = new PluginApprovals({ plugins: () => manager.list(), changed: owner => aiChanged(owner, { type: 'approvals', approvals: approvals.list(owner) }), describe: async (plugin, tool, args) => {
  if (plugin.id === 'official.ai-image' && tool === 'start_batch') { const batch = batches.snapshot(batches.get(plugin, args.id)); if (batch.revision !== args.revision) throw new Error('批次方案已改变。'); return { imageCount: batch.items.length, source: batch.source === 'proxy' ? '外部代理' : '官方图像 API', model: batch.modelId, parameters: batch.parameters, prompts: batch.items.map(item => ({ name: item.name, prompt: item.prompt })), notice: '将逐图请求' + (batch.source === 'proxy' ? '已配置的代理图像服务' : '官方图像 API') + '，可能产生费用或消耗账户额度。确认后还需选择输出目录；不会自动重试失败或未知结果。' }; }
  return null;
}, execute: async (plugin, tool, args, owner, signal) => {
  signal.throwIfAborted();
  if (tool === 'open' || tool === 'settings') { await openView(plugin.id, tool === 'settings'); if (window && !window.isDestroyed()) window.webContents.send('commerce:ai', { type: 'navigate', pluginId: plugin.id, chatId: owner.slice(HOST_CHAT_PREFIX.length) }); changed(); return { opened: plugin.id, settings: tool === 'settings' }; }
  if (plugin.id === 'official.ai-image' && plugin.permissions.ai?.includes('image-edit')) {
    if (tool === 'list_batches') return { batches: batches.list(plugin) };
    if (tool === 'get_batch') return batches.snapshot(batches.get(plugin, args.id));
    if (tool === 'prepare_plan') return batches.revise(plugin, args);
    if (tool === 'cancel_batch') return batches.cancel(plugin, args.id);
    if (tool === 'start_batch') { const directory = await files.pickDirectory(plugin); signal.throwIfAborted(); const current = await manager.get(plugin.id); if (!current.enabled || current.missing.length || current.version !== plugin.version) throw new Error('插件已改变，批图未启动。'); if (!directory) return { canceled: true, started: false }; const batch = await batches.start(current, { ...args, directoryToken: directory.token }); void kernelRequest({ type: 'call', kind: 'ai', method: 'batch.track', caller: plugin.id, args: { id: args.id } }).catch(() => {}); return batch; }
  }
  const definition = plugin.assistant?.tools.find(value => value.name === tool);
  if (!definition || !plugin.backend || !(plugin.services?.provides || []).includes(definition.service)) throw new Error('插件工具未授权。');
  const worker = await workers.start(plugin, owner);
  const cancel = () => { void workers.stopCaller(plugin.id, owner).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted(); const result = await worker.call(definition.method, args);
    if ((JSON.stringify(result) || '').length > 1000000) throw new Error('插件结果过大。');
    return { result };
  } finally { signal.removeEventListener('abort', cancel); if (signal.aborted) await workers.stopCaller(plugin.id, owner); }
} });
workers = new Workers(path.join(app.getPath('userData'), 'jobs'), launcher, process.execPath);
await workers.recover().catch(error => { workers.recoveryError = error.message; console.error('沙箱任务恢复失败：',error.message); });
const marketConfig = JSON.parse(await readFile(path.join(generated, 'market.json'), 'utf8'));
const distribution = JSON.parse(await readFile(path.join(generated, 'distribution.json'), 'utf8'));
localPreview = app.isPackaged && distribution.preview === true;
const signed = desktopSigningMode({ COMMERCE_DESKTOP_SIGNING: distribution.signing }) === 'signed';
const receipt = path.join(app.getPath('userData'), 'update-error.txt');
const adapter = process.platform === 'darwin' && !signed
  ? macUpdateAdapter({ app, beforeInstall: shutdownRuntime, receipt, publicKey: marketConfig.updatePublicKey || marketConfig.publicKey, fetchImpl: (url, options) => downloadSources.fetch(url, options) })
  : nativeUpdateAdapter(autoUpdater);
updateService = new UpdateService(adapter, changed);
autoUpdater.on('error', error => updateService.fail(error));
const previousError = await previousUpdateError(receipt);
if (previousError) updateService.fail(new Error(previousError));
manager = new PluginManager(path.join(app.getPath('userData'), 'plugins'), path.join(generated, 'plugins'), {
  publicKey: marketConfig.publicKey, stop: stopPlugin,
  probe: async plugin => { if (plugin.backend) { await workers.start(plugin); await workers.stop(plugin.id); } },
  forget: async plugin => {
    for (const name of plugin.permissions.credentials ?? []) await credentials.clear(plugin.id, name);
    await session.fromPartition('persist:commerce-' + plugin.id).clearStorageData();
  },
});
await manager.initialize();
const pluginFinalizations = new Map();
async function finalizePlugin(id, notify) {
  const { version, restoring } = pluginFinalizations.get(id);
  notify({ version, status: 'syncing' });
  try {
    if (restoring) await migration.dismiss();
    await syncTools();
    pluginFinalizations.delete(id);
  } catch (error) {
    throw new Error('插件 v' + version + ' 已安装，但同步未完成：' + error.message + ' 请重试。');
  }
}
pluginInstallService = new PluginInstallService(async (id, notify, signal) => {
  const finalization = pluginFinalizations.get(id);
  if (finalization) {
    const installed = await manager.get(id).catch(() => null);
    if (installed?.source === 'market' && installed.version === finalization.version) {
      signal.throwIfAborted();
      await finalizePlugin(id, notify);
      return;
    }
    pluginFinalizations.delete(id);
  }
  const entry = (await catalog(signal)).items.find(item => item.id === id);
  signal.throwIfAborted();
  if (entry && !entry.compatible) throw new Error('请先升级轻作，当前插件 API 不兼容。');
  const artifact = entry?.artifacts?.[process.platform + '-' + process.arch];
  if (!artifact) throw new Error('没有适用当前平台的制品。');
  notify({ version: entry.version, status: 'downloading' });
  const downloadArtifactBytes = url => boundedDownload(url, undefined, signal, { onProgress: value => notify({ ...value, progress: value.total ? Math.min(100, value.transferred / value.total * 100) : null }) });
  const bytes = downloadSources ? await downloadSources.runWithFallback(artifact.url, downloadArtifactBytes, { signal }) : await downloadArtifactBytes(artifact.url);
  signal.throwIfAborted();
  notify({ status: 'verifying' });
  const restoring = id === 'official.labeledit' && await migration.status(manager);
  signal.throwIfAborted();
  notify({ status: 'installing' });
  // Cancellation is checked before entering the atomic manager transaction.
  // Once installation begins, shutdown drains it before disposing the kernel.
  await manager.install(bytes, { source: 'market', enabled: restoring ? migration.enabled : undefined,
    record: { ...artifact, id: entry.id, version: entry.version, api: entry.api, platform: process.platform + '-' + process.arch } });
  pluginFinalizations.set(id, { version: entry.version, restoring });
  await finalizePlugin(id, notify);
}, changed);
window = new BrowserWindow({ title: '轻作 · Qingzuo', width: 1380, height: 900, minWidth: 1000, minHeight: 680, icon: path.join(root, 'desktop/icons/icon.png'), webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
if (localPreview) window.setTitle('轻作 0.3.0 · 本地预览（未发布）');
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('commerce://shell/') && !(process.env.COMMERCE_DEV_URL && url.startsWith(process.env.COMMERCE_DEV_URL + '/'))) event.preventDefault(); });
protocol.handle('commerce', async request => { try { const url = new URL(request.url); if (url.hostname !== 'shell') return new Response('Forbidden', { status: 403 }); return resourceResponse(await confinedPath(path.join(root, 'dist'), decodeURIComponent(url.pathname.slice(1)))); } catch { return new Response('Not found', { status: 404 }); } });
await window.loadURL(process.env.COMMERCE_DEV_URL || 'commerce://shell/index.html');
void startKernel().catch(error => { kernelError = error.message; changed(); });
app.on('before-quit', event => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  const cancelDownload = ['downloading', 'extracting'].includes(updateService.state.status) && updateService.adapter.cancel;
  if (cancelDownload) updateService.adapter.cancel();
  void (async () => {
    if (cancelDownload) await updateService.pending;
    await shutdownRuntime();
  })().catch(error => console.error('退出清理失败：', error.message)).finally(() => { quitReady = true; app.quit(); });
});
app.on('window-all-closed', () => app.quit());

}
if (!primary) app.quit();
else void main().catch(error => { console.error(error); app.quit(); });

// Trusted main-process integration access; never exposed over renderer IPC.
export { network, workers, manager, host, updateService, pluginInstallService, batches, proxy, imageEditor, downloadSources, shutdownRuntime };
