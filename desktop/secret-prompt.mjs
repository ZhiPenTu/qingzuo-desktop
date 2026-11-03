import { BrowserWindow, ipcMain } from 'electron';

let active = null;
let ipcReady = false;

function ensureIpc() {
  if (ipcReady) return;
  ipcReady = true;
  ipcMain.on('commerce:secret-prompt:cancel', event => {
    if (!active || event.sender !== active.window.webContents) return;
    active.finish({ canceled: true });
  });
  ipcMain.on('commerce:secret-prompt:submit', (event, value) => {
    if (!active || event.sender !== active.window.webContents) return;
    if (typeof value !== 'string' || value.length > 4096) {
      active.window.webContents.send('commerce:secret-prompt:invalid');
      return;
    }
    const secret = value.trim();
    if (!secret) {
      active.window.webContents.send('commerce:secret-prompt:invalid');
      return;
    }
    active.finish({ canceled: false, secret });
  });
}

export class SecretPrompt {
  constructor({ parent, htmlFile, preload, title = '输入访问密钥' } = {}) {
    if (!parent || typeof htmlFile !== 'string' || typeof preload !== 'string') throw new TypeError('安全输入窗口配置无效。');
    Object.assign(this, { parent, htmlFile, preload, title });
    ensureIpc();
  }

  show(options = {}) {
    if (active) throw new Error('另一个安全输入窗口正在使用中。');
    if (!this.parent || this.parent.isDestroyed()) return Promise.reject(new Error('请先打开轻作窗口。'));
    const window = new BrowserWindow({
      parent: this.parent,
      modal: true,
      show: false,
      width: 520,
      height: 300,
      minWidth: 440,
      minHeight: 260,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      resizable: false,
      title: typeof options.title === 'string' ? options.title.slice(0, 80) : this.title,
      backgroundColor: '#f7faf7',
      webPreferences: {
        preload: this.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    let settled = false;
    const promise = new Promise(resolve => {
      const finish = value => {
        if (settled) return;
        settled = true;
        if (active?.window === window) active = null;
        if (!window.isDestroyed()) window.close();
        resolve(value);
      };
      active = { window, finish };
      window.on('closed', () => finish({ canceled: true }));
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('did-finish-load', () => {
        if (window.isDestroyed()) return;
        window.webContents.send('commerce:secret-prompt:config', {
          title: typeof options.title === 'string' ? options.title.slice(0, 80) : this.title,
          message: typeof options.message === 'string' ? options.message.slice(0, 500) : '',
          detail: typeof options.detail === 'string' ? options.detail.slice(0, 2000) : '',
          label: typeof options.label === 'string' ? options.label.slice(0, 100) : '访问密钥',
          confirmLabel: typeof options.confirmLabel === 'string' ? options.confirmLabel.slice(0, 40) : '保存',
        });
        window.show();
      });
    });
    void window.loadFile(this.htmlFile).catch(() => {
      if (active?.window === window) active.finish({ canceled: true });
    });
    return promise;
  }
}
