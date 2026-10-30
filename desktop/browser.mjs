import { randomUUID } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dialog, session, WebContentsView } from 'electron';
import { isAllowedBrowserUrl, normalizeBrowserUrl, ownedBrowserTabs } from './browser-policy.mjs';
import { allowedBrowserOrigin } from './security.mjs';
import { buildActionScript, buildSnapshotScript, buildWaitScript, validateAction, validateWait } from './browser-automation.mjs';
import { readImageResource } from './browser-resources.mjs';
import { ensureBrowserLayout, releaseBrowserLayout } from './browser-viewport.mjs';
import {
  MAX_BROWSER_CANDIDATES,
  candidateKey,
  cleanCandidateText,
  likelyMediaUrl,
  normalizeCandidateUrl,
  publicCandidate,
  safeFilename,
} from './browser-detector.mjs';

const BROWSER_PARTITION = 'persist:commerce-browser';
const MAX_DOWNLOADS = 100;
// Sites often issue their login cookie without an expiry, and Chromium drops
// those the moment the app exits. A desktop browser is expected to stay signed
// in, so session cookies are mirrored to disk and re-applied on the next launch.
const SESSION_COOKIE_TTL = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_WRITE_DELAY = 500;
const SAME_SITE_VALUES = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);

function isNavigationAbort(error) {
  return error?.code === 'ERR_ABORTED' || error?.errno === -3 || /(?:ERR_ABORTED|\(-3\))/.test(error?.message || '');
}

function navigationFailure(error) {
  console.error('Browser navigation failed:', error?.message || error);
  return new Error(isNavigationAbort(error) ? '页面加载已中断，请重试。' : '页面加载失败，请检查网络后重试。');
}

function cookieKey(cookie) {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

function cookieAddress(cookie) {
  const host = cookie.domain.replace(/^\./, '');
  const path = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  return `${cookie.secure ? 'https' : 'http'}://${host}${path}`;
}

function publicTab(tab) {
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    loading: tab.loading,
    canGoBack: tab.view?.webContents.canGoBack() ?? false,
    canGoForward: tab.view?.webContents.canGoForward() ?? false,
  };
}

function publicDownload(task) {
  return {
    id: task.id,
    candidateId: task.candidateId,
    status: task.status,
    progress: task.progress,
    transferred: task.transferred,
    total: task.total,
    ...(task.filename ? { filename: task.filename } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
}

export class BrowserRuntime {
  constructor({ window, changed, event = () => {}, preload, resizeStop = () => {}, resizeMove = () => {}, files = null, storage = null, cookieStore = null }) {
    this.window = window;
    this.changed = changed;
    this.event = event;
    this.preload = preload;
    this.resizeStop = resizeStop;
    this.resizeMove = resizeMove;
    this.files = files;
    this.storage = storage;
    this.cookieStore = cookieStore;
    this.sessionCookies = new Map();
    this.cookieStoreDirty = false;
    this.cookieWriteTimer = null;
    this.browserSession = null;
    this.tabs = new Map();
    this.activeTabId = null;
    this.candidates = new Map();
    this.downloads = new Map();
    this.pendingDownloads = new Map();
    this.sequence = 0;
  }

  notify(value) {
    this.changed();
    this.event(value);
  }

  async ensureSession() {
    if (this.browserSession) return this.browserSession;
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.on('will-download', (_event, item, webContents) => this.handleDownloadItem(item, webContents));
    browserSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      this.observeNetwork(details);
      callback({});
    });
    this.browserSession = browserSession;
    await this.restoreSessionCookies(browserSession);
    this.trackSessionCookies(browserSession);
    return browserSession;
  }

  async readSessionCookies() {
    const saved = JSON.parse(await readFile(this.cookieStore, 'utf8'));
    // Older builds encrypted this file through safeStorage, which can make
    // macOS ask for the login keychain password. Those files are intentionally
    // ignored; the next cookie update replaces them with the 0600 JSON format.
    return Array.isArray(saved?.cookies) ? saved.cookies : [];
  }

  async restoreSessionCookies(browserSession) {
    if (!this.cookieStore) return;
    let entries;
    try { entries = await this.readSessionCookies(); }
    catch { return; }
    const now = Date.now();
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || !entry.name || typeof entry.value !== 'string') continue;
      if (typeof entry.domain !== 'string' || !entry.domain) continue;
      if (!Number.isFinite(entry.savedAt) || now - entry.savedAt > SESSION_COOKIE_TTL) continue;
      const cookie = {
        url: cookieAddress(entry),
        name: entry.name,
        value: entry.value,
        domain: entry.domain,
        path: typeof entry.path === 'string' && entry.path.startsWith('/') ? entry.path : '/',
        secure: Boolean(entry.secure),
        httpOnly: Boolean(entry.httpOnly),
        ...(SAME_SITE_VALUES.has(entry.sameSite) ? { sameSite: entry.sameSite } : {}),
      };
      try { await browserSession.cookies.set(cookie); }
      catch { /* a cookie whose domain no longer matches is simply skipped */ }
    }
  }

  trackSessionCookies(browserSession) {
    browserSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (!cookie || typeof cookie.name !== 'string') return;
      const key = cookieKey(cookie);
      // Partitioned cookies belong to the frame that stored them, so they are
      // left to Chromium instead of being replayed as first-party cookies.
      if (!removed && cookie.session && !cookie.partitionKey) {
        this.sessionCookies.set(key, {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: Boolean(cookie.secure),
          httpOnly: Boolean(cookie.httpOnly),
          sameSite: cookie.sameSite,
          savedAt: Date.now(),
        });
      } else {
        this.sessionCookies.delete(key);
      }
      this.cookieStoreDirty = true;
      this.scheduleCookieWrite();
    });
  }

  scheduleCookieWrite() {
    if (!this.cookieStore || this.cookieWriteTimer) return;
    this.cookieWriteTimer = setTimeout(() => {
      this.cookieWriteTimer = null;
      void this.writeSessionCookies();
    }, SESSION_COOKIE_WRITE_DELAY);
    this.cookieWriteTimer.unref?.();
  }

  async writeSessionCookies() {
    // Nothing was ever stored and nothing is pending: skip the write entirely so
    // quitting an app that never used the browser does not create a cookie file.
    if (!this.cookieStore || (!this.cookieStoreDirty && !this.sessionCookies.size)) return;
    const cookies = [...this.sessionCookies.values()];
    // Keep session cookies in the user-only app data file. Using safeStorage
    // here triggers a macOS Keychain prompt whenever Electron's credential
    // identity changes, while the cookie file itself is already protected by
    // the per-user application data directory and 0600 permissions.
    const payload = JSON.stringify({ version: 1, cookies });
    const staging = this.cookieStore + '.tmp';
    try {
      await writeFile(staging, payload, { mode: 0o600 });
      await rename(staging, this.cookieStore);
      this.cookieStoreDirty = false;
    } catch (error) {
      console.error('Browser cookie store failed:', error.message);
    }
  }

  // Quitting must never wait on cookie storage or the OS keychain, so the flush
  // below is bounded and whatever is left simply stays for the next launch.
  async flushCookies(timeout = 3000) {
    if (!this.browserSession) return;
    await Promise.race([
      (async () => {
        await this.writeSessionCookies();
        await this.browserSession?.cookies.flushStore().catch(() => {});
      })().catch(() => {}),
      new Promise(resolve => {
        const delay = setTimeout(resolve, timeout);
        delay.unref?.();
      }),
    ]);
  }

  status({ includeCandidates = true, includeDownloads = true } = {}) {
    return {
      open: this.tabs.size > 0,
      activeTabId: this.activeTabId,
      tabs: [...this.tabs.values()].map(publicTab),
      candidates: includeCandidates ? [...this.candidates.values()].flatMap(items => [...items.values()].map(publicCandidate)) : [],
      downloads: includeDownloads ? [...this.downloads.values()].map(publicDownload) : [],
    };
  }

  // Automation-only plugins get this narrower view: their own tabs, nothing else.
  statusForPlugin(plugin) {
    const owned = ownedBrowserTabs([...this.tabs.values()], plugin.id);
    return {
      open: owned.length > 0,
      activeTabId: owned.some(tab => tab.id === this.activeTabId) ? this.activeTabId : (owned[0]?.id ?? null),
      tabs: owned.map(publicTab),
      candidates: [],
      downloads: [],
    };
  }

  candidateFor(id) {
    for (const items of this.candidates.values()) {
      const candidate = [...items.values()].find(item => item.id === id);
      if (candidate) return candidate;
    }
    return null;
  }

  tabForContents(webContentsId) {
    return [...this.tabs.values()].find(tab => tab.view?.webContents.id === webContentsId) || null;
  }

  async open() {
    await this.ensureSession();
    if (!this.tabs.size) await this.newTab();
    return this.status();
  }

  resolveTab(tabId) {
    const id = tabId ?? this.activeTabId;
    const tab = id ? this.tabs.get(id) : null;
    if (!tab) throw new Error('浏览器标签不存在。');
    if (!tab.view || tab.view.webContents.isDestroyed()) throw new Error('浏览器页面尚未打开。');
    return tab;
  }

  assertTabOrigin(plugin, tab) {
    const address = tab.view?.webContents.getURL() || tab.url;
    if (!address) throw new Error('浏览器页面尚未加载。');
    return allowedBrowserOrigin(plugin, address);
  }

  async openForPlugin(plugin, url) {
    const address = normalizeBrowserUrl(url);
    allowedBrowserOrigin(plugin, address);
    await this.ensureSession();
    const previous = [...this.tabs.values()].find(tab => tab.owner === plugin.id && tab.view && !tab.view.webContents.isDestroyed());
    const created = previous ? null : await this.newTab();
    // newTab() returns the public tab, while ownership and the view live on
    // the internal record, so reuse the record rather than the public copy.
    const tab = previous ?? this.tabs.get(created.id);
    tab.owner = plugin.id;
    await this.navigate(tab.id, address);
    this.activeTabId = tab.id;
    this.notify({ type: 'status', tabId: tab.id });
    return { tabId: tab.id, url: address, title: tab.title };
  }

  async snapshot(plugin, options = {}) {
    const tab = this.resolveTab(options.tabId);
    const url = this.assertTabOrigin(plugin, tab);
    await ensureBrowserLayout(tab.view.webContents, this.window.getContentBounds());
    const result = await tab.view.webContents.executeJavaScript(buildSnapshotScript(), true);
    const nodes = Array.isArray(result?.nodes) ? result.nodes.filter(node => node && typeof node.ref === 'string' && typeof node.role === 'string') : [];
    return { tabId: tab.id, url: url.href, title: tab.title, nodes, truncated: Boolean(result?.truncated) };
  }

  async act(plugin, options = {}) {
    const input = validateAction(options);
    const tab = this.resolveTab(options.tabId);
    const url = this.assertTabOrigin(plugin, tab);
    await ensureBrowserLayout(tab.view.webContents, this.window.getContentBounds());
    const outcome = await tab.view.webContents.executeJavaScript(buildActionScript(input), true);
    if (!outcome || outcome.ok !== true) {
      const reason = outcome?.reason === 'missing' ? '页面元素已变化，请重新采集。' : outcome?.reason === 'option-missing' ? '下拉选项未找到。' : outcome?.reason === 'not-select' ? '该元素不是下拉框。' : '页面操作未完成。';
      throw new Error(reason);
    }
    return { tabId: tab.id, url: url.href, action: input.action, ok: true, ...(outcome.value !== undefined ? { value: outcome.value } : {}), ...(outcome.scrollY !== undefined ? { scrollY: outcome.scrollY } : {}) };
  }

  async waitFor(plugin, options = {}) {
    const input = validateWait(options);
    const tab = this.resolveTab(options.tabId);
    const url = this.assertTabOrigin(plugin, tab);
    await ensureBrowserLayout(tab.view.webContents, this.window.getContentBounds());
    const outcome = await tab.view.webContents.executeJavaScript(buildWaitScript(input), true);
    return { tabId: tab.id, url: url.href, ok: Boolean(outcome?.ok), elapsed: Number(outcome?.elapsed) || 0 };
  }

  async saveResource(plugin, options = {}) {
    if (!plugin.permissions.files || !this.files) throw new Error('插件没有文件权限。');
    if (!plugin.permissions.storage || !this.storage) throw new Error('插件需要长期保存图片，请声明插件存储权限。');
    const tab = this.resolveTab(options.tabId);
    const pageUrl = this.assertTabOrigin(plugin, tab);
    const address = normalizeBrowserUrl(options.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const resource = await readImageResource({ fetch: this.browserSession.fetch.bind(this.browserSession), address, referer: pageUrl.href, sameOrigin: pageUrl.origin, signal: controller.signal });
      const file = await this.storage.saveFile(plugin, { data: resource.bytes.toString('base64'), filename: resource.name, mime: resource.mime });
      return { tabId: tab.id, ...file };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('图片读取超时或已取消。');
      throw error instanceof Error && /^(图片|该地址)/.test(error.message) ? error : new Error('图片读取失败，请在页面中重新打开后重试。');
    } finally { clearTimeout(timer); }
  }

  async newTab(url) {
    await this.ensureSession();
    const tab = { id: 'browser-' + (++this.sequence) + '-' + randomUUID().slice(0, 8), title: '新标签页', url: '', loading: false, navigationSequence: 0, view: null };
    this.tabs.set(tab.id, tab);
    this.candidates.set(tab.id, new Map());
    this.activeTabId = tab.id;
    this.hide();
    if (url !== undefined) await this.navigate(tab.id, url);
    this.notify({ type: 'status', tabId: tab.id });
    return publicTab(tab);
  }

  async createView(tab) {
    if (tab.view) return tab.view;
    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession,
        preload: this.preload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    // A view that has never been sized reports a zero-width viewport, which
    // collapses block layout and makes page collection read empty values.
    const area = this.window.getContentBounds();
    view.setBounds({ x: 0, y: 0, width: Math.max(1, area.width), height: Math.max(1, area.height) });
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url)) void this.newTab(url).catch(error => console.error('Browser new tab failed:', error.message));
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => {
      try { normalizeBrowserUrl(url); }
      catch { event.preventDefault(); }
    });
    view.webContents.on('will-redirect', (event, url) => {
      try { normalizeBrowserUrl(url); }
      catch { event.preventDefault(); }
    });
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace && isAllowedBrowserUrl(url)) tab.navigationSequence += 1;
    });
    view.webContents.on('did-start-loading', () => { tab.loading = true; this.notify({ type: 'loading', tabId: tab.id }); });
    view.webContents.on('did-stop-loading', () => { tab.loading = false; this.updateTab(tab); this.notify({ type: 'status', tabId: tab.id }); });
    view.webContents.on('did-navigate', () => { this.resetCandidates(tab.id); this.updateTab(tab); this.notify({ type: 'candidates', tabId: tab.id }); });
    view.webContents.on('did-navigate-in-page', () => { this.resetCandidates(tab.id); this.updateTab(tab); this.notify({ type: 'candidates', tabId: tab.id }); });
    view.webContents.on('page-title-updated', (_event, title) => { tab.title = title || tab.url || '新标签页'; this.notify({ type: 'status', tabId: tab.id }); });
    view.webContents.on('input-event', (_event, input) => {
      if (input.type === 'mouseUp') this.resizeStop();
      else if (input.type === 'mouseMove') this.resizeMove(view.getBounds().x + input.x);
    });
    view.webContents.on('render-process-gone', (_event, details) => { tab.loading = false; console.error('Browser renderer gone:', tab.id, details); this.notify({ type: 'status', tabId: tab.id }); });
    this.window.contentView.addChildView(view);
    tab.view = view;
    return view;
  }

  updateTab(tab) {
    const address = tab.view?.webContents.getURL() || '';
    if (address && isAllowedBrowserUrl(address)) tab.url = address;
    tab.title = tab.view?.webContents.getTitle() || tab.url || '新标签页';
  }

  resetCandidates(tabId) {
    this.candidates.set(tabId, new Map());
  }

  observeNetwork(details) {
    const tab = this.tabForContents(details.webContentsId);
    if (!tab || !['media', 'image'].includes(details.resourceType)) return;
    const type = details.resourceType === 'image' ? 'image' : 'video';
    const url = normalizeCandidateUrl(details.url, tab.url);
    if (!url || !likelyMediaUrl(url, type)) return;
    const previous = [...(this.candidates.get(tab.id)?.values() || [])].find(candidate => candidate.sourceUrl === url);
    const candidate = this.upsertCandidate(tab, { type, url, title: tab.title, thumbnailUrl: type === 'image' ? url : null });
    if (!previous || previous.status !== candidate.status) this.notify({ type: 'candidates', tabId: tab.id });
  }

  ingestFromContents(webContentsId, payload = {}) {
    const tab = this.tabForContents(webContentsId);
    if (!tab || !payload || typeof payload !== 'object') return;
    const pageUrl = normalizeBrowserUrl(payload.pageUrl || tab.url);
    if (pageUrl !== tab.url) tab.url = pageUrl;
    if (!Array.isArray(payload.candidates)) return;
    let changed = false;
    for (const item of payload.candidates.slice(0, MAX_BROWSER_CANDIDATES)) {
      if (!item || !['video', 'image'].includes(item.type)) continue;
      const before = [...(this.candidates.get(tab.id)?.values() || [])].find(candidate => candidate.sourceUrl && candidate.sourceUrl === normalizeCandidateUrl(item.url, pageUrl));
      const candidate = this.upsertCandidate(tab, { ...item, pageUrl });
      changed ||= !before || before.status !== candidate.status || before.title !== candidate.title || before.thumbnailUrl !== candidate.thumbnailUrl;
    }
    if (changed) this.notify({ type: 'candidates', tabId: tab.id });
  }

  upsertCandidate(tab, item) {
    const pageUrl = normalizeCandidateUrl(item.pageUrl || tab.url, tab.url) || tab.url;
    const sourceUrl = normalizeCandidateUrl(item.url, pageUrl);
    const thumbnailUrl = normalizeCandidateUrl(item.thumbnailUrl, pageUrl);
    const title = cleanCandidateText(item.title) || tab.title || '未命名媒体';
    const type = item.type === 'image' ? 'image' : 'video';
    const key = candidateKey({ sourceUrl, type, title, pageUrl, thumbnailUrl });
    const items = this.candidates.get(tab.id) || new Map();
    let existing = [...items.values()].find(candidate => candidate.key === key);
    if (!existing && sourceUrl) existing = [...items.values()].find(candidate => !candidate.sourceUrl && candidate.type === type && candidate.title === title && candidate.thumbnailUrl === thumbnailUrl);
    const status = sourceUrl && !/\.m3u8(?:$|[?#])/i.test(sourceUrl) ? 'ready' : 'unresolved';
    const candidate = existing || {
      id: 'candidate-' + randomUUID(),
      tabId: tab.id,
      key,
      sourceUrl: null,
      type,
      title,
      pageUrl,
      thumbnailUrl: null,
      status,
      reason: status === 'ready' ? null : '请打开详情后重试。',
      suggestedFilename: null,
    };
    candidate.sourceUrl = sourceUrl || candidate.sourceUrl;
    candidate.type = type;
    candidate.title = title;
    candidate.pageUrl = pageUrl;
    candidate.thumbnailUrl = thumbnailUrl || candidate.thumbnailUrl;
    candidate.status = candidate.sourceUrl && !/\.m3u8(?:$|[?#])/i.test(candidate.sourceUrl) ? 'ready' : 'unresolved';
    candidate.reason = candidate.status === 'ready' ? null : '请打开详情后重试。';
    candidate.suggestedFilename = safeFilename(candidate.title, candidate.sourceUrl, candidate.type);
    if (!existing) items.set(key, candidate);
    this.candidates.set(tab.id, items);
    while (items.size > MAX_BROWSER_CANDIDATES) items.delete(items.keys().next().value);
    return candidate;
  }

  async navigate(id, value) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('浏览器标签不存在。');
    const address = normalizeBrowserUrl(value);
    const view = await this.createView(tab);
    tab.url = address;
    tab.title = address;
    tab.loading = true;
    this.hide();
    this.activeTabId = id;
    view.setVisible(false);
    const navigationSequence = tab.navigationSequence;
    try { await view.webContents.loadURL(address); }
    catch (error) {
      const superseded = isNavigationAbort(error)
        && !view.webContents.isDestroyed()
        && tab.navigationSequence > navigationSequence + 1
        && isAllowedBrowserUrl(tab.url);
      if (!superseded) throw navigationFailure(error);
    }
    this.notify({ type: 'status', tabId: id });
    return publicTab(tab);
  }

  async activate(id) {
    if (!this.tabs.has(id)) throw new Error('浏览器标签不存在。');
    this.activeTabId = id;
    this.hide();
    this.notify({ type: 'status', tabId: id });
    return publicTab(this.tabs.get(id));
  }

  activeTab() {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : null;
  }

  async goBack() {
    const tab = this.activeTab();
    if (tab?.view?.webContents.canGoBack()) await tab.view.webContents.goBack();
    return tab ? publicTab(tab) : null;
  }

  async goForward() {
    const tab = this.activeTab();
    if (tab?.view?.webContents.canGoForward()) await tab.view.webContents.goForward();
    return tab ? publicTab(tab) : null;
  }

  async reload() {
    const tab = this.activeTab();
    if (tab?.view) await tab.view.webContents.reload();
    return tab ? publicTab(tab) : null;
  }

  async rescan(id = this.activeTabId) {
    const tab = id ? this.tabs.get(id) : null;
    if (!tab?.view || tab.view.webContents.isDestroyed()) return this.status();
    await tab.view.webContents.executeJavaScript('window.dispatchEvent(new Event("commerce:rescan"))').catch(() => {});
    return this.status();
  }

  async closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('浏览器标签不存在。');
    const closingActiveTab = this.activeTabId === id;
    this.cancelForTab(id);
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      this.window.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }
    this.tabs.delete(id);
    this.candidates.delete(id);
    if (this.activeTabId === id) this.activeTabId = this.tabs.keys().next().value || null;
    if (!this.tabs.size) await this.newTab();
    // Closing an inactive tab must not hide the selected page. Its tab key and
    // URL are unchanged, so the renderer will not request another bounds sync.
    else if (closingActiveTab) this.hide();
    this.notify({ type: 'status', tabId: id });
    return this.status();
  }

  closeWorkspace() {
    for (const id of this.tabs.keys()) this.cancelForTab(id);
    for (const tab of this.tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        this.window.contentView.removeChildView(tab.view);
        tab.view.webContents.close();
      }
    }
    this.tabs.clear();
    this.candidates.clear();
    this.activeTabId = null;
    this.hide();
    this.notify({ type: 'status' });
    return this.status();
  }

  hide() {
    for (const tab of this.tabs.values()) tab.view?.setVisible(false);
  }

  bounds(bounds) {
    const tab = this.activeTab();
    const view = tab?.view;
    if (!view || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds?.[key]))) return;
    // Clamp instead of dropping: the page can report a rectangle that is a few
    // pixels past the window while a pane animation is running.
    const area = this.window.getContentBounds();
    const x = Math.max(0, Math.min(Math.floor(bounds.x), area.width - 1));
    const y = Math.max(0, Math.min(Math.floor(bounds.y), area.height - 1));
    view.setBounds({ x, y, width: Math.max(1, Math.min(Math.floor(bounds.width), area.width - x)), height: Math.max(1, Math.min(Math.floor(bounds.height), area.height - y)) });
    view.setVisible(true);
    void releaseBrowserLayout(view.webContents).catch(() => {});
  }

  async download({ candidateIds, mode = 'single' } = {}) {
    if (!Array.isArray(candidateIds) || !candidateIds.length || candidateIds.length > MAX_DOWNLOADS) throw new Error('请选择要下载的内容。');
    if (!['single', 'batch'].includes(mode)) throw new Error('下载方式无效。');
    const candidates = candidateIds.map(id => this.candidateFor(id));
    if (candidates.some(candidate => !candidate || candidate.status !== 'ready' || !candidate.sourceUrl)) throw new Error('部分内容暂时无法下载，请打开详情后重试。');
    if (mode === 'single' && candidates.length !== 1) throw new Error('单项下载只能选择一个内容。');
    if (mode === 'single') {
      const candidate = candidates[0];
      const result = await dialog.showSaveDialog(this.window, { defaultPath: candidate.suggestedFilename });
      if (result.canceled || !result.filePath) return this.status();
      const task = this.createTask(candidate, result.filePath);
      void this.runTask(task);
      return this.status();
    }
    const result = await dialog.showOpenDialog(this.window, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths?.[0]) return this.status();
    const used = new Set();
    for (const candidate of candidates) {
      const filename = await this.uniqueFilename(result.filePaths[0], candidate.suggestedFilename, used);
      used.add(filename);
      const task = this.createTask(candidate, path.join(result.filePaths[0], filename));
      void this.runTask(task);
    }
    return this.status();
  }

  createTask(candidate, targetPath) {
    const task = {
      id: 'download-' + randomUUID(),
      candidateId: candidate.id,
      tabId: candidate.tabId,
      path: targetPath,
      filename: path.basename(targetPath),
      status: 'queued',
      progress: 0,
      transferred: 0,
      total: 0,
      error: null,
      controller: new AbortController(),
      item: null,
    };
    this.downloads.set(task.id, task);
    while (this.downloads.size > MAX_DOWNLOADS) this.downloads.delete(this.downloads.keys().next().value);
    this.notify({ type: 'download', downloadId: task.id });
    return task;
  }

  async uniqueFilename(directory, filename, used) {
    const extension = path.extname(filename);
    const stem = extension ? filename.slice(0, -extension.length) : filename;
    for (let index = 0; index < 1000; index += 1) {
      const candidate = index ? `${stem} (${index})${extension}` : filename;
      if (used.has(candidate)) continue;
      try { await access(path.join(directory, candidate)); }
      catch { return candidate; }
    }
    return `${stem}-${randomUUID().slice(0, 8)}${extension}`;
  }

  async runTask(task) {
    const candidate = this.candidateFor(task.candidateId);
    const tab = candidate ? this.tabs.get(candidate.tabId) : null;
    if (!candidate?.sourceUrl || !tab?.view || tab.view.webContents.isDestroyed()) {
      task.status = 'failed'; task.error = '浏览器页面已关闭或媒体链接已失效。'; this.notify({ type: 'download', downloadId: task.id }); return;
    }
    task.status = 'downloading';
    this.notify({ type: 'download', downloadId: task.id });
    try {
      await new Promise((resolve, reject) => {
        const webContentsId = tab.view.webContents.id;
        const queue = this.pendingDownloads.get(webContentsId) || [];
        const pending = { task, resolve, reject };
        queue.push(pending);
        this.pendingDownloads.set(webContentsId, queue);
        const removePending = () => {
          const current = this.pendingDownloads.get(webContentsId);
          if (!current) return;
          const index = current.indexOf(pending);
          if (index >= 0) current.splice(index, 1);
          if (!current.length) this.pendingDownloads.delete(webContentsId);
        };
        task.controller.signal.addEventListener('abort', () => {
          removePending();
          task.item?.cancel();
          reject(new Error('下载已取消。'));
        }, { once: true });
        try { tab.view.webContents.downloadURL(candidate.sourceUrl); }
        catch (error) { removePending(); reject(error); }
      });
      task.status = 'completed'; task.progress = 100;
    } catch (error) {
      task.status = task.controller.signal.aborted ? 'canceled' : 'failed';
      task.error = task.status === 'canceled' ? null : (error instanceof Error ? error.message : String(error));
    }
    this.notify({ type: 'download', downloadId: task.id });
  }

  handleDownloadItem(item, webContents) {
    const queue = this.pendingDownloads.get(webContents?.id);
    const pending = queue?.shift();
    if (!queue?.length && webContents?.id) this.pendingDownloads.delete(webContents.id);
    if (!pending) return;
    const { task } = pending;
    task.item = item;
    item.pause();
    item.setSavePath(task.path);
    item.on('updated', (_event, state) => {
      if (state === 'interrupted') return;
      task.transferred = item.getReceivedBytes();
      task.total = item.getTotalBytes();
      task.progress = task.total > 0 ? Math.min(100, Math.round(task.transferred / task.total * 100)) : 0;
      this.notify({ type: 'download', downloadId: task.id });
    });
    item.once('done', (_event, state) => {
      if (state === 'completed') pending.resolve();
      else pending.reject(new Error('下载未完成，请重试。'));
    });
    if (task.controller.signal.aborted) item.cancel();
    else item.resume();
  }

  cancelForTab(tabId) {
    for (const task of this.downloads.values()) if (task.tabId === tabId && ['queued', 'downloading'].includes(task.status)) this.cancelDownload(task.id);
  }

  cancelDownload(id) {
    const task = this.downloads.get(id);
    if (!task || !['queued', 'downloading'].includes(task.status)) return this.status();
    task.controller.abort();
    if (task.status === 'queued') { task.status = 'canceled'; this.notify({ type: 'download', downloadId: id }); }
    return this.status();
  }

  async shutdown() {
    this.closeWorkspace();
    if (this.cookieWriteTimer) { clearTimeout(this.cookieWriteTimer); this.cookieWriteTimer = null; }
    await this.flushCookies();
    await this.browserSession?.closeAllConnections().catch(() => {});
  }
}
