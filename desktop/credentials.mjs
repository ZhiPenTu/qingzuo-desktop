import { spawn } from 'node:child_process';
import { isEncryptedCredential } from './credential-codec.mjs';

export class Credentials {
  constructor(launcher, namespace = '', store = '', codec = null) { this.launcher = launcher; this.namespace = namespace; this.store = store; this.codec = codec; }
  call(op, plugin, name, value) {
    if (!/^[a-z0-9.-]+$/.test(plugin) || !/^[a-z0-9.-]+$/.test(name)) throw new Error('凭据标识无效。');
    return new Promise((resolve, reject) => {
      const child = spawn(this.launcher, ['--credential'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); let output = ''; const timer=setTimeout(()=>{child.kill();reject(new Error('凭据存储响应超时。'));},15000);
      child.stdout.on('data', data => { output += data.toString(); });
      child.once('error', () => {clearTimeout(timer);reject(new Error('凭据存储不可用。'));});
      child.once('close', code => { clearTimeout(timer); if (code !== 0) return reject(new Error('凭据存储不可用。')); try { resolve(JSON.parse(output).value); } catch { reject(new Error('凭据存储响应无效。')); } });
      child.stdin.end(JSON.stringify({ op, account: this.namespace + plugin + ':' + name, value, store: this.store }));
    });
  }
  set(plugin, name, value) {
    if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('密钥格式无效。');
    if (!this.codec) throw new Error('系统凭据加密不可用。');
    return this.call('set', plugin, name, this.codec.encode(value));
  }
  async get(plugin, name) {
    const stored = await this.call('get', plugin, name);
    if (stored === null || stored === undefined) return null;
    if (!this.codec) throw new Error('系统凭据加密不可用。');
    return this.codec.decode(stored);
  }
  async status(plugin, name) { return Boolean(await this.get(plugin, name)); }
  clear(plugin, name) { return this.call('clear', plugin, name); }
  readRaw(plugin, name) { return this.call('get', plugin, name); }
  async purgeLegacy(plugin, names = []) {
    for (const name of names) {
      const value = await this.readRaw(plugin, name).catch(() => null);
      if (typeof value === 'string' && !isEncryptedCredential(value)) await this.clear(plugin, name).catch(() => {});
    }
  }
}
