import { latestReleaseNotes } from './updates.mjs';

// Operations outlive renderer navigation and the Harness RPC timeout.
// Public state never contains local paths or download URLs.
export class UpdateService {
  state = { status: 'idle', version: null, notes: '', error: null, progress: 0, transferred: 0, total: 0, mode: null, fallbackReason: null, reusedBytes: 0 };
  pending = null;
  release = null;
  constructor(adapter, changed) { this.adapter = adapter; this.changed = changed; }
  set(value) { Object.assign(this.state, value); this.changed(); }
  fail(error) {
    // A failed download must not leave component/delta progress in the public
    // state. Keep the checked release version so the renderer can retry, but
    // clear transient transfer details from the failed attempt.
    this.set({ status: 'error', error: error.message || String(error), progress: 0, transferred: 0, total: 0, mode: null, fallbackReason: null, reusedBytes: 0 });
  }
  start(task) {
    this.pending = Promise.resolve().then(task).catch(error => this.fail(error)).finally(() => { this.pending = null; });
  }
  check() {
    if (this.pending || this.state.status === 'installing') return;
    this.release = null;
    this.set({ status: 'checking', version: null, notes: '', error: null, progress: 0, transferred: 0, total: 0, mode: null, fallbackReason: null, reusedBytes: 0 });
    this.start(async () => {
      this.release = await this.adapter.check();
      const { status, version, notes } = this.release;
      this.set({ status, version, notes });
    });
  }
  download() {
    if (this.pending || this.state.status === 'installing') return;
    if (this.release?.status !== 'available' || !['available', 'error'].includes(this.state.status)) throw new Error('请先检查可用更新。');
    this.set({ status: 'downloading', error: null, progress: 0, mode: null, fallbackReason: null, reusedBytes: 0, transferred: 0, total: this.release.artifact?.size || 0 });
    this.start(async () => {
      const prepared = await this.adapter.download(this.release, value => this.set(value));
      this.set({ status: 'installing', progress: 100 });
      await this.adapter.install(prepared);
    });
  }
}

export function nativeUpdateAdapter(autoUpdater) {
  autoUpdater.disableDifferentialDownload = false;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.fullChangelog = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      if (!result) throw new Error('当前环境无法检查更新。');
      return result.isUpdateAvailable
        ? { status: 'available', version: result.updateInfo.version, notes: latestReleaseNotes(result.updateInfo) }
        : { status: 'current', version: null, notes: '' };
    },
    async download(_release, notify) {
      const progress = info => notify({ status: 'downloading', progress: Math.min(100, Math.max(0, info.percent)), transferred: info.transferred, total: info.total });
      autoUpdater.on('download-progress', progress);
      try { await autoUpdater.downloadUpdate(); }
      finally { autoUpdater.removeListener('download-progress', progress); }
    },
    async install() {
      // The app's before-quit handler drains workers once the native updater
      // is ready. In particular, Squirrel verifies the Mac signature here;
      // leave the current runtime usable if that verification fails.
      autoUpdater.quitAndInstall(true, true);
    },
  };
}
