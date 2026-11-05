export class MarketCatalogStore {
  constructor({ cache, load, publish = () => {}, report = () => {}, now = Date.now } = {}) {
    this.cache = cache;
    this.load = load;
    this.publish = publish;
    this.report = report;
    this.now = now;
    this.pending = null;
  }

  refresh() {
    if (this.pending) return this.pending;
    const pending = (async () => {
      const value = await this.load();
      if (!value?.configured) return { configured: false, items: [], message: value?.message };
      const fetchedAt = this.now();
      const payload = { items: value.items, fetchedAt };
      if (this.cache) {
        const written = await this.cache.write(value.items).catch(error => {
          this.report('插件目录缓存写入失败：' + error.message);
          return true;
        });
        if (!written) this.report('插件目录过大，已跳过本地缓存。');
      }
      this.publish(payload);
      return { configured: true, ...payload };
    })().finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  async list(args = {}) {
    const cached = this.cache ? await this.cache.read() : null;
    if (args?.refresh === true) {
      const fresh = await this.refresh();
      if (fresh.configured) return { items: fresh.items, fetchedAt: fresh.fetchedAt, cached: false };
      return { items: [], message: fresh.message, configured: false, fetchedAt: null, cached: false };
    }
    if (cached) {
      // Serve the last catalogue immediately; refresh in the background when it
      // has aged out or the page was just (re)entered.
      if (args?.background === true || !this.cache.isFresh(cached)) {
        void this.refresh().catch(error => this.report('插件目录刷新失败：' + error.message));
      }
      return { items: cached.items, fetchedAt: cached.fetchedAt, cached: true };
    }
    const fresh = await this.refresh();
    if (fresh.configured) return { items: fresh.items, fetchedAt: fresh.fetchedAt, cached: false };
    return { items: [], message: fresh.message, configured: false, fetchedAt: null, cached: false };
  }
}
