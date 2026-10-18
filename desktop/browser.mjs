import { randomUUID } from 'node:crypto';
import { session, WebContentsView } from 'electron';
import { isAllowedBrowserUrl, normalizeBrowserUrl } from './browser-policy.mjs';

// Keep the browser on Electron's public WebContentsView/session APIs. Chromium
// security and compatibility updates arrive through the pinned Electron
// dependency rather than a second embedded browser runtime.
const BROWSER_PARTITION = 'persist:commerce-browser';

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

export class BrowserRuntime {
  constructor({ window, changed, resizeStop = () => {} }) {
    this.window = window;
    this.changed = changed;
    this.resizeStop = resizeStop;
    this.browserSession = null;
    this.tabs = new Map();
    this.activeTabId = null;
    this.sequence = 0;
  }

  async ensureSession() {
    if (this.browserSession) return this.browserSession;
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    this.browserSession = browserSession;
    return browserSession;
  }

  status() {
    return {
      open: this.tabs.size > 0,
      activeTabId: this.activeTabId,
      tabs: [...this.tabs.values()].map(publicTab),
    };
  }

  async open() {
    await this.ensureSession();
    if (!this.tabs.size) await this.newTab();
    return this.status();
  }

  async newTab(url) {
    await this.ensureSession();
    const tab = { id: 'browser-' + (++this.sequence) + '-' + randomUUID().slice(0, 8), title: '新标签页', url: '', loading: false, view: null };
    this.tabs.set(tab.id, tab);
    this.activeTabId = tab.id;
    this.hide();
    if (url !== undefined) await this.navigate(tab.id, url);
    this.changed();
    return publicTab(tab);
  }

  async createView(tab) {
    if (tab.view) return tab.view;
    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
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
    view.webContents.on('did-start-loading', () => { tab.loading = true; this.changed(); });
    view.webContents.on('did-stop-loading', () => { tab.loading = false; this.updateTab(tab); this.changed(); });
    view.webContents.on('did-navigate', () => { this.updateTab(tab); this.changed(); });
    view.webContents.on('did-navigate-in-page', () => { this.updateTab(tab); this.changed(); });
    view.webContents.on('page-title-updated', (_event, title) => { tab.title = title || tab.url || '新标签页'; this.changed(); });
    view.webContents.on('input-event', (_event, input) => { if (input.type === 'mouseUp') this.resizeStop(); });
    view.webContents.on('render-process-gone', (_event, details) => { tab.loading = false; console.error('Browser renderer gone:', tab.id, details); this.changed(); });
    this.window.contentView.addChildView(view);
    tab.view = view;
    return view;
  }

  updateTab(tab) {
    const address = tab.view?.webContents.getURL() || '';
    if (address && isAllowedBrowserUrl(address)) tab.url = address;
    tab.title = tab.view?.webContents.getTitle() || tab.url || '新标签页';
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
    await view.webContents.loadURL(address);
    this.changed();
    return publicTab(tab);
  }

  async activate(id) {
    if (!this.tabs.has(id)) throw new Error('浏览器标签不存在。');
    this.activeTabId = id;
    this.hide();
    this.changed();
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

  async closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('浏览器标签不存在。');
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      this.window.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }
    this.tabs.delete(id);
    if (this.activeTabId === id) this.activeTabId = this.tabs.keys().next().value || null;
    if (!this.tabs.size) await this.newTab();
    else this.hide();
    this.changed();
    return this.status();
  }

  closeWorkspace() {
    for (const tab of this.tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        this.window.contentView.removeChildView(tab.view);
        tab.view.webContents.close();
      }
    }
    this.tabs.clear();
    this.activeTabId = null;
    this.hide();
    this.changed();
    return this.status();
  }

  hide() {
    for (const tab of this.tabs.values()) tab.view?.setVisible(false);
  }

  bounds(bounds) {
    const tab = this.activeTab();
    const view = tab?.view;
    if (!view || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds?.[key]) && bounds[key] >= 0)) return;
    view.setBounds(Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.floor(bounds[key])])));
    view.setVisible(true);
  }

  async shutdown() {
    this.closeWorkspace();
    await this.browserSession?.closeAllConnections().catch(() => {});
  }
}

