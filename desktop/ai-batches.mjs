import { mkdir, readFile, writeFile, rename, readdir, copyFile, lstat, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { imageOptions } from './ai-images.mjs';

export async function atomicJson(filename, value) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  try { await rename(temporary, filename); } finally { await rm(temporary, { force: true }); }
}
export class BatchRuntime {
  constructor(root, files, editor, changed = () => {}) { this.root = root; this.files = files; this.editor = editor; this.changed = changed; this.batches = new Map(); this.running = new Map(); this.writes = new Map(); this.closed = false; }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const id of await readdir(this.root)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const directory = path.join(this.root, id); if ((await lstat(directory)).isSymbolicLink()) continue;
      try {
        const batch = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
        if (batch.schemaVersion !== 1 || batch.id !== id || !/^[a-z][a-z0-9.-]+$/.test(batch.owner) || !Array.isArray(batch.items)) continue;
        batch.directory = null;
        for (const item of batch.items) if (item.state === 'running') { item.state = item.outputMime ? 'save-failed' : 'unknown'; item.error = item.outputMime ? '保存中断，可以重新保存。' : '执行中断，服务是否完成未知；不会自动重发。'; }
        if (['running', 'canceling'].includes(batch.state)) batch.state = 'interrupted';
        this.batches.set(id, batch); await this.persist(batch);
      } catch { continue; }
    }
  }
  assert(plugin) { if (!plugin.permissions.files || !plugin.permissions.ai?.includes('image-edit') || this.closed) throw new Error('批图未授权或运行时已关闭。'); }
  get(plugin, id) { this.assert(plugin); const batch = this.batches.get(id); if (batch?.owner !== plugin.id) throw new Error('批次未授权。'); return batch; }
  snapshot(batch) { const { directory, selection, ...value } = batch; return structuredClone(value); }
  list(plugin) { this.assert(plugin); return [...this.batches.values()].filter(batch => batch.owner === plugin.id).map(batch => this.snapshot(batch)).sort((left, right) => right.created - left.created); }
  persist(batch) {
    const filename = path.join(this.root, batch.id, 'state.json'), value = JSON.stringify(batch);
    const pending = (this.writes.get(batch.id) || Promise.resolve()).catch(() => {}).then(() => atomicJson(filename, JSON.parse(value)));
    this.writes.set(batch.id, pending); return pending.then(() => this.changed(batch.owner, { type: 'batch', batch: this.snapshot(batch) }));
  }
  async create(plugin, options) {
    this.assert(plugin);
    if (!['official', 'proxy'].includes(options.source ?? 'official')) throw new Error('图像来源无效。');
    if (options.source === 'proxy' && !this.editor.resolve) throw new Error('代理图像编辑不可用。');
    const selection = this.editor.resolve ? await this.editor.resolve(plugin, options) : imageOptions(options.modelId, options.parameters);
    if (!Array.isArray(options.items) || !options.items.length || options.items.length > 200 || !Number.isInteger(options.concurrency ?? 2) || (options.concurrency ?? 2) < 1 || (options.concurrency ?? 2) > 4) throw new Error('批次图片或并发数无效。');
    const id = randomUUID(), directory = path.join(this.root, id);
    const batch = { schemaVersion: 1, id, owner: plugin.id, created: Date.now(), revision: 1, state: 'draft', source: options.source ?? 'official', modelId: options.modelId, parameters: selection.parameters, selection, concurrency: options.concurrency ?? 2, directory: null, items: [] };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      for (const [index, input] of options.items.entries()) {
        const file = await this.files.get(plugin, input.token), prompt = input.prompt || options.prompt;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mime) || file.size > 25 * 1024 ** 2 || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new Error('图片或提示词无效。');
        await copyFile(file.filename, path.join(directory, 'input-' + index));
        batch.items.push({ id: String(index), name: file.name, mime: file.mime, prompt, state: 'pending', error: null, output: null });
      }
      this.batches.set(id, batch); await this.persist(batch); return this.snapshot(batch);
    } catch (error) { this.batches.delete(id); await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async revise(plugin, { id, revision, prompts }) {
    const batch = this.get(plugin, id);
    if (this.running.has(id) || batch.state !== 'draft' || batch.revision !== revision || !Array.isArray(prompts) || prompts.length !== batch.items.length || prompts.some(prompt => typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000)) throw new Error('方案已改变或提示词无效。');
    batch.items.forEach((item, index) => { item.prompt = prompts[index]; }); batch.revision++; await this.persist(batch); return this.snapshot(batch);
  }
  async start(plugin, { id, revision, directoryToken, retryFailed = false }) {
    const batch = this.get(plugin, id);
    if (this.running.has(id)) { await this.running.get(id).ready; return this.snapshot(batch); }
    if (batch.revision !== revision || !['draft', 'interrupted', 'finished', 'canceled'].includes(batch.state)) throw new Error('方案已改变，请重新确认。');
    const operation = { controllers: new Set(), canceled: false, done: null };
    let ready, rejectReady;
    operation.ready = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
    this.running.set(id, operation);
    operation.done = (async () => {
      const grant = this.files.directory(plugin, directoryToken); await this.validateDirectory(grant);
      if (batch.items.some(item => item.state === 'pending' || retryFailed && item.state === 'failed')) await this.editor.assertSelection?.(plugin, batch.selection);
      if (operation.canceled || this.closed) throw new Error('批次启动已取消。');
      batch.directory = grant;
      if (retryFailed) for (const item of batch.items) if (item.state === 'failed') { item.state = 'pending'; item.error = null; }
      batch.state = 'running'; await this.persist(batch); ready();
      await this.run(plugin, batch, operation);
    })().catch(async error => { rejectReady(error); if (batch.state === 'running') { batch.state = 'interrupted'; await this.persist(batch); } }).finally(() => this.running.delete(id));
    await operation.ready;
    return this.snapshot(batch);
  }
  async validateDirectory(grant) {
    const info = await lstat(grant.filename);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(grant.filename) !== grant.filename || info.dev !== grant.dev || info.ino !== grant.ino) throw new Error('输出目录已改变，请重新授权。');
  }
  async saveResult(batch, item, index) {
    await this.validateDirectory(batch.directory);
    const extension = item.outputMime === 'image/jpeg' ? 'jpg' : item.outputMime === 'image/webp' ? 'webp' : 'png';
    const name = path.parse(item.name).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 90) + '-ai-' + batch.id.slice(0, 8) + '-' + (index + 1) + '.' + extension;
    await copyFile(path.join(this.root, batch.id, 'output-' + index), path.join(batch.directory.filename, name), constants.COPYFILE_EXCL);
    item.output = name; item.state = 'succeeded'; item.error = null;
  }
  async run(plugin, batch, operation) {
    const pending = batch.items.map((item, index) => ['pending', 'save-failed'].includes(item.state) ? index : -1).filter(index => index >= 0);
    const consume = async () => {
      while (!operation.canceled && !this.closed) {
        const index = pending.shift(); if (index === undefined) return;
        const item = batch.items[index], saveOnly = item.state === 'save-failed'; item.state = 'running'; await this.persist(batch);
        if (operation.canceled || this.closed) { item.state = saveOnly ? 'save-failed' : 'pending'; await this.persist(batch); return; }
        const controller = new AbortController(); operation.controllers.add(controller); const timer = setTimeout(() => controller.abort(), 600000);
        try {
          if (!saveOnly) {
            const output = await this.editor.edit(plugin, { modelId: batch.modelId, source: batch.source ?? 'official', selection: batch.selection, parameters: batch.parameters, prompt: item.prompt, bytes: await readFile(path.join(this.root, batch.id, 'input-' + index)), mime: item.mime, signal: controller.signal });
            await writeFile(path.join(this.root, batch.id, 'output-' + index), output.bytes, { mode: 0o600 }); item.outputMime = output.mime;
          }
          item.state = 'save-failed'; await this.persist(batch);
          await this.saveResult(batch, item, index);
        } catch (error) {
          item.state = item.outputMime ? 'save-failed' : controller.signal.aborted ? 'unknown' : 'failed';
          item.error = controller.signal.aborted ? '请求已停止，服务结果未知；不会自动重发。' : error.message;
        } finally { clearTimeout(timer); operation.controllers.delete(controller); await this.persist(batch); }
      }
    };
    await Promise.all(Array.from({ length: batch.concurrency }, consume));
    batch.state = operation.canceled ? 'canceled' : this.closed ? 'interrupted' : 'finished'; await this.persist(batch);
  }
  async cancel(plugin, id) { const batch = this.get(plugin, id), operation = this.running.get(id); if (operation) { operation.canceled = true; batch.state = 'canceling'; for (const controller of operation.controllers) controller.abort(); await operation.done; } return this.snapshot(batch); }
  async preview(plugin, { id, itemId, original = false }) {
    const batch = this.get(plugin, id), index = batch.items.findIndex(item => item.id === itemId); if (index < 0) throw new Error('任务无效。');
    const item = batch.items[index]; if (!original && !item.outputMime) throw new Error('任务尚未生成结果。');
    return this.files.create(plugin, await readFile(path.join(this.root, id, (original ? 'input-' : 'output-') + index)), item.name, original ? item.mime : item.outputMime);
  }
  async stopPlugin(plugin) { for (const batch of this.batches.values()) if (batch.owner === plugin.id && this.running.has(batch.id)) await this.cancel(plugin, batch.id); }
  async shutdown() { this.closed = true; for (const operation of this.running.values()) for (const controller of operation.controllers) controller.abort(); await Promise.all([...this.running.values()].map(operation => operation.done)); }
}
