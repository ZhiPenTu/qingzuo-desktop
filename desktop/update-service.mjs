import { latestReleaseNotes } from './updates.mjs';

const stateFields = ['status', 'version', 'notes', 'error', 'progress', 'transferred', 'total', 'mode', 'fallbackReason', 'reusedBytes'];
const updateModes = new Set(['full', 'resume', 'delta', 'cached', 'components']);

function finiteNonNegative(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normaliseState(partial) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new TypeError('更新状态无效。');
  const next = {};
  for (const field of stateFields) {
    if (!Object.hasOwn(partial, field)) continue;
    const value = partial[field];
    if (field === 'progress') next[field] = value === null ? null : Math.min(100, Math.max(0, finiteNonNegative(value)));
    else if (field === 'transferred' || field === 'total' || field === 'reusedBytes') next[field] = finiteNonNegative(value);
    else if (field === 'mode') next[field] = value === null || updateModes.has(value) ? value : null;
    else if (field === 'version' || field === 'notes' || field === 'error' || field === 'fallbackReason') next[field] = value === null || typeof value === 'string' ? value : String(value);
    else if (field === 'status' && typeof value === 'string') next[field] = value;
  }
  return next;
}

function checkedRelease(release) {
  if (!release || typeof release !== 'object' || typeof release.status !== 'string') throw new Error('更新检查返回了无效结果。');
  if (!['available', 'current', 'unpublished'].includes(release.status)) throw new Error('更新检查返回了无效状态。');
  if (release.status === 'available' && (typeof release.version !== 'string' || !release.version)) throw new Error('更新检查缺少版本信息。');
  return { ...release, version: typeof release.version === 'string' ? release.version : null, notes: typeof release.notes === 'string' ? release.notes : '' };
}

// Operations outlive renderer navigation and the Harness RPC timeout.
// Public state never contains local paths or download URLs.
export class UpdateService {
  state = { status: 'idle', version: null, notes: '', error: null, progress: 0, transferred: 0, total: 0, mode: null, fallbackReason: null, reusedBytes: 0 };
  pending = null;
  release = null;
  constructor(adapter, changed) { this.adapter = adapter; this.changed = changed; }
  set(value) { Object.assign(this.state, normaliseState(value)); this.changed(); }
  fail(error) {
    // A failed download must not leave component/delta progress in the public
    // state. Keep the checked release version so the renderer can retry, but
    // clear transient transfer details from the failed attempt.
    this.set({ status: 'error', error: error?.message || String(error), progress: 0, transferred: 0, total: 0, mode: null, fallbackReason: null, reusedBytes: 0 });
  }
  start(task) {
    this.pending = Promise.resolve().then(task).catch(error => this.fail(error)).finally(() => { this.pending = null; });
  }
  check() {
    if (this.pending || this.state.status === 'installing') return;
    this.release = null;
    this.set({ status: 'checking', version: null, notes: '', error: null, progress: 0, transferred: 0, total: 0, mode: null, fallbackReason: null, reusedBytes: 0 });
    this.start(async () => {
      this.release = checkedRelease(await this.adapter.check());
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
  async cleanCache() {
    if (this.pending || this.state.status === 'installing' || this.state.status === 'downloading') {
      throw new Error('更新进行中，无法清理缓存。');
    }
    if (typeof this.adapter.cleanCache === 'function') {
      return await this.adapter.cleanCache();
    }
    return { freedBytes: 0 };
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
      const progress = info => notify({ status: 'downloading', progress: Number.isFinite(info?.percent) ? Math.min(100, Math.max(0, info.percent)) : 0, transferred: finiteNonNegative(info?.transferred), total: finiteNonNegative(info?.total) });
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
