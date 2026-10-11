const statuses = new Set(['checking', 'downloading', 'verifying', 'installing', 'syncing', 'installed', 'error']);
const initialState = id => ({ id, version: null, status: 'checking', progress: null, transferred: 0, total: 0, error: null });

// Installation belongs to the main process. Renderer requests acknowledge the
// job immediately; navigation and the short Harness RPC lifetime cannot end it.
export class PluginInstallService {
  #states = new Map();
  #controllers = new Map();
  #closing = false;
  #shutdown = null;
  pending = new Map();

  constructor(run, changed = () => {}) {
    if (typeof run !== 'function') throw new TypeError('插件安装任务无效。');
    this.run = run; this.changed = changed;
  }

  snapshot() { return [...this.#states.values()].map(state => ({ ...state })); }

  assertAvailable(id) {
    if (this.#closing) throw new Error('应用正在退出，不能更改插件。');
    if (this.pending.has(id)) throw new Error('插件正在安装或更新，请等待完成。');
  }

  #set(id, partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new TypeError('插件安装状态无效。');
    const current = this.#states.get(id), next = {};
    for (const field of ['version', 'status', 'progress', 'transferred', 'total', 'error']) {
      if (!Object.hasOwn(partial, field)) continue;
      const value = partial[field];
      if (field === 'status' && !statuses.has(value)
        || ['version', 'error'].includes(field) && value !== null && typeof value !== 'string'
        || field === 'progress' && value !== null && (!Number.isFinite(value) || value < 0 || value > 100)
        || ['transferred', 'total'].includes(field) && (!Number.isFinite(value) || value < 0)) throw new TypeError('插件安装状态无效：' + field);
      next[field] = value;
    }
    Object.assign(current, next);
    this.changed();
  }

  start(id) {
    if (this.#closing) throw new Error('应用正在退出，不能开始插件安装。');
    if (typeof id !== 'string' || !id || id.length > 128) throw new TypeError('插件标识无效。');
    if (this.pending.has(id)) return { ...this.#states.get(id) };

    const controller = new AbortController(), state = initialState(id);
    this.#states.set(id, state); this.#controllers.set(id, controller);
    let active = true;
    const notify = partial => { if (active) this.#set(id, partial); };
    const task = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      await this.run(id, notify, controller.signal);
      active = false;
      // An install that already committed may complete while shutdown drains
      // it. The runner decides where cancellation is still safe.
      this.#set(id, { status: 'installed', progress: 100, error: null });
    }).catch(error => {
      active = false;
      this.#set(id, { status: 'error', error: error?.message || String(error) });
    }).finally(() => {
      this.pending.delete(id); this.#controllers.delete(id);
    });
    // Register before notifying so reentrant UI/status callbacks see the lock.
    this.pending.set(id, task);
    this.changed();
    return { ...state };
  }

  shutdown() {
    if (this.#shutdown) return this.#shutdown;
    this.#closing = true;
    for (const controller of this.#controllers.values()) controller.abort(new Error('插件安装已取消。'));
    this.#shutdown = Promise.allSettled([...this.pending.values()]).then(() => undefined);
    return this.#shutdown;
  }
}
