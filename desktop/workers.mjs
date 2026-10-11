import { mkdir, mkdtemp, realpath, rm, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { confinedPath, TARGET } from './security.mjs';
import { launchSandbox, RpcWorker, cleanupSandbox } from './sandbox.mjs';
export class Workers {
  constructor(root, launcher, nodeRuntime) { this.root = root; this.launcher = launcher; this.nodeRuntime = nodeRuntime; this.workers = new Map(); }
  async recover() {
    await mkdir(this.root,{recursive:true,mode:0o700});
    const journals = path.join(this.root,'.policies'); await mkdir(journals,{recursive:true,mode:0o700});
    for(const entry of await readdir(journals)) if(/^\.sandbox-[a-f0-9-]+\.json$/.test(entry)) { const file=path.join(journals,entry); await cleanupSandbox(this.launcher,file); await rm(file,{force:true}); }
    for(const name of await readdir(this.root)) {
      if(name === '.policies') continue;
      const dir = path.join(this.root,name);
      const info = await import('node:fs/promises').then(fs => fs.lstat(dir));
      if(info.isDirectory() && !info.isSymbolicLink()) await rm(dir,{recursive:true,force:true});
    }
  }
  async start(plugin, caller = plugin.id) {
    if (this.recoveryError) throw new Error('SANDBOX_UNAVAILABLE：任务恢复失败。' + this.recoveryError);
    const key = plugin.id + ":" + caller;
    if (!plugin.enabled || plugin.missing?.length) throw new Error('插件已停用或缺少服务依赖。');
    if (!plugin.backend) throw new Error('插件没有本地服务。');
    if (this.workers.has(key)) return this.workers.get(key);
    const pending = this.launch(plugin); this.workers.set(key, pending);
    try { const worker = await pending; worker.child.once('close', () => { if (this.workers.get(key) === pending) this.workers.delete(key); }); return worker; } catch (e) { this.workers.delete(key); throw e; }
  }
  async nodeExecutable() {
    if (process.platform !== 'win32') return realpath(this.nodeRuntime);
    if (!this.runtimeReady) this.runtimeReady = (async () => {
      // AppContainer ACL grants must never modify the running desktop image or
      // its DLLs: Chromium can reject new renderer processes while those grants
      // are active. Copy only the immutable Node-mode runtime resources into a
      // host-owned private cache, and grant access to that copy instead.
      const source = await realpath(this.nodeRuntime), directory = path.dirname(source);
      const cache = path.join(this.root, '.node-runtime');
      await mkdir(cache, {recursive:true,mode:0o700});
      const names = (await readdir(directory)).filter(name => name === path.basename(source) || /\.(dll|pak|dat|bin)$/i.test(name));
      await Promise.all(names.map(name => copyFile(path.join(directory,name),path.join(cache,name))));
      return realpath(path.join(cache,path.basename(source)));
    })();
    return this.runtimeReady;
  }
  async launch(plugin) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const cwd = await realpath(await mkdtemp(path.join(this.root, plugin.id + '-')));
    let worker;
    try {
      const entry = await confinedPath(plugin.folder, plugin.backend.entry[TARGET]);
      const node = plugin.backend.type === 'node'; const executable = node ? await this.nodeExecutable() : entry;
      const readOnly = [await realpath(plugin.folder)]; if (node) {
        const runtime = await realpath(executable), dir = path.dirname(runtime);
        readOnly.push(process.platform === 'win32' ? dir : runtime);
        if (process.platform === 'darwin' && dir.endsWith('/Contents/MacOS')) readOnly.push(await realpath(path.join(dir, '../Frameworks')));
      }
      // Artifacts reject symlinks on install. Avoid Node's realpath walk through
      // ungranted drive ancestors in AppContainer without broadening its ACLs.
      // Electron's Node mode otherwise opens the Windows NUL device even though
      // the launcher already supplied all three handles. AppContainer denies it.
      const nodeArgs = [...(process.platform === 'win32' ? ['--no-stdio-init'] : []), '--preserve-symlinks', '--preserve-symlinks-main', entry];
      const child = await launchSandbox({ executable, args: node ? nodeArgs : [], readOnly, writable: [cwd], cwd, launcher: this.launcher, env: node ? { ELECTRON_RUN_AS_NODE: '1' } : {} });
      worker = new RpcWorker(child); worker.directory = cwd; worker.cleaned = child.cleanup.then(() => rm(cwd, { recursive: true, force: true, maxRetries:5, retryDelay:100 }));
      const status=await worker.call('health');if(!status?.ready)throw new Error('插件本地服务尚未就绪。');return worker;
    } catch (e) { if(worker) {await worker.stop();await worker.cleaned;} else await rm(cwd,{recursive:true,force:true,maxRetries:5,retryDelay:100}); throw e; }
  }
  async stop(id) {
    const entries = [...this.workers].filter(([key]) => key.split(':').includes(id));
    for (const [key] of entries) this.workers.delete(key);
    await Promise.all(entries.map(async ([,pending]) => {const worker=await pending.catch(() => null);if(worker){await worker.stop();await worker.cleaned;}}));
  }
  async stopCaller(id, caller) {
    const key = id + ':' + caller, pending = this.workers.get(key); this.workers.delete(key);
    const worker = await pending?.catch(() => null); if (worker) { await worker.stop(); await worker.cleaned; }
  }
  async stopAll() { await Promise.all([...new Set([...this.workers.keys()].map(key => key.split(':')[0]))].map(id => this.stop(id))); }
}
