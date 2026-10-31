import { spawn, execFile } from 'node:child_process';
import { mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
const quote = value => JSON.stringify(value);
export function seatbeltProfile({ executable, readOnly, writable }) {
  const rules = ['(version 1)', '(deny default)',
    '(allow process-exec (literal ' + quote(executable) + '))',
    '(allow file-read-data (literal "/"))', '(allow sysctl-read)', '(allow file-read-metadata)',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.logd"))',
    '(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/private/var/db/dyld") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime"))',
    '(allow file-read* file-write* (literal "/dev/null"))'];
  if (readOnly.length) rules.push('(allow file-read* ' + readOnly.map(p => '(subpath ' + quote(p) + ')').join(' ') + ')');
  if (writable.length) rules.push('(allow file-read* file-write* ' + writable.map(p => '(subpath ' + quote(p) + ')').join(' ') + ')');
  return rules.join('\n');
}
export async function launchSandbox({ executable, args = [], readOnly = [], writable = [], cwd, launcher, env = {} }) {
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('SANDBOX_UNAVAILABLE：当前系统不支持本地插件。');
  const canonical = { executable: await realpath(executable), args, readOnly: await Promise.all(readOnly.map(p => realpath(p))), writable: await Promise.all(writable.map(p => realpath(p))), cwd: await realpath(cwd), container: 'Commerce.Plugin.' + randomUUID() };
  // Only app-owned resource directories are passed here. No arbitrary user tree gets an ACL grant.
  const policyRoot = path.join(path.dirname(cwd), '.policies'); await mkdir(policyRoot, {recursive:true,mode:0o700});
  const filename = path.join(policyRoot, '.sandbox-' + randomUUID() + '.json');
  await writeFile(filename, JSON.stringify({ ...canonical, profile: process.platform === 'darwin' ? seatbeltProfile(canonical) : '' }), { mode: 0o600 });
  const cleanEnv = { LANG: 'en_US.UTF-8', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', TMPDIR: cwd, TEMP: cwd, TMP: cwd, ...env };
  if (process.platform === 'win32') { cleanEnv.SystemRoot = process.env.SystemRoot; cleanEnv.WINDIR = process.env.WINDIR; for(const name of ['USERPROFILE','LOCALAPPDATA','APPDATA']) if(process.env[name]) cleanEnv[name]=process.env[name]; }
  let child;
  try { child = spawn(launcher, [filename], { cwd, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform === 'darwin' }); }
  catch { throw new Error('SANDBOX_UNAVAILABLE：无法启动原生沙箱。'); }
  child.cleanup = new Promise(resolve => child.once('close', async () => { try { await cleanupSandbox(launcher, filename); await rm(filename, { force: true }); resolve(); } catch(error) { console.error('沙箱清理失败：',error.message); resolve(); } }));
  return child;
}
export async function cleanupSandbox(launcher, policy) {
  if (process.platform !== 'win32') return;
  await new Promise((resolve,reject) => execFile(launcher,['--cleanup',policy],{windowsHide:true,timeout:10000},error => error ? reject(error) : resolve()));
}
export class RpcWorker {
  constructor(child, timeout = 90000, log = () => {}) {
    this.child = child; this.timeout = timeout; this.pending = new Map(); this.counter = 0; this.closed = false; this.exited = new Promise(resolve => { child.once('close', resolve); });
    this.error = '';
    child.stderr.on('data', data => {
      const text = data.toString().trim();
      this.error = (this.error + data.toString()).slice(-4000);
      if (text) log('warn', text);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { if (line.trim()) log('debug', line); return; }
      const entry = this.pending.get(message.id);
      if (!entry) { if (line.trim()) log('debug', line); return; }
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    });
    child.on('error', error => this.fail(new Error('SANDBOX_UNAVAILABLE：' + error.message)));
    child.on('exit', code => this.fail(new Error('插件进程已退出（' + code + '）。' + this.error)));
  }
  fail(error) { this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  call(method, args = {}) {
    if (this.closed) return Promise.reject(new Error('插件进程已停止。'));
    return new Promise((resolve, reject) => { const id = ++this.counter;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('插件处理超时（' + method + '）。' + this.error)); void this.stop(); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, args }) + '\n', error => { if (error) this.fail(error); });
    });
  }
  async stop() {
    this.fail(new Error('插件任务已取消。'));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exited.then(() => this.child.cleanup);
    this.child.stdin.end();
    const timer = setTimeout(() => { try { if (process.platform === 'darwin') process.kill(-this.child.pid, 'SIGKILL'); else this.child.kill('SIGKILL'); } catch {} }, 1500);
    try { await this.exited; await this.child.cleanup; } finally { clearTimeout(timer); }
  }
}
