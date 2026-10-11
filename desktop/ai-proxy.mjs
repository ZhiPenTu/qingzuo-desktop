import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { atomicJson } from './ai-batches.mjs';
import { boundedJson } from './ai-images.mjs';
import { secureRequest } from './network-transport.mjs';

export const PROXY_VERSION = '8.0.23';
const oauthPaths = { codex: 'codex-auth-url', claude: 'anthropic-auth-url', antigravity: 'antigravity-auth-url' };
export function proxyAddress(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !((url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) || url.protocol === 'https:')) throw new Error('代理地址必须为 HTTPS 或本机 HTTP 地址。');
  return url.href.replace(/\/$/, '').replace(/\/v1$/, '');
}
export async function proxyRequest(base, endpoint, options = {}) {
  const target = new URL(base + endpoint);
  return target.protocol === 'http:' ? fetch(target, { ...options, redirect: 'error' }) : secureRequest(target.href, { ...options, redirect: 'error' });
}
async function availablePort() {
  const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
export class ProxyRuntime {
  constructor({ root, binary, credentials, openExternal, request = proxyRequest }) {
    Object.assign(this, { root, binary, credentials, openExternal, request });
    this.settings = { schemaVersion: 1, mode: 'builtin', address: 'http://127.0.0.1:8317', model: '', verified: [] };
    this.child = null; this.starting = null; this.oauth = new Map(); this.error = null; this.epoch = 0;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { const value = JSON.parse(await readFile(path.join(this.root, 'settings.json'), 'utf8')); if (value.schemaVersion !== 1) throw new Error('AI 配置版本不受支持。'); this.settings = { ...this.settings, ...value, address: proxyAddress(value.address), verified: Array.isArray(value.verified) ? value.verified : [] }; } catch (error) { if (error.code !== 'ENOENT') this.error = 'AI 配置读取失败，请重新设置。'; }
  }
  status() { return { ...this.settings, version: PROXY_VERSION, running: Boolean(this.child && this.child.exitCode === null), error: this.error }; }
  async configure(options) {
    if (!['builtin', 'external'].includes(options.mode) || typeof options.model !== 'string' || options.model.length > 160) throw new Error('AI 配置无效。');
    const address = proxyAddress(options.address || this.settings.address);
    if (options.apiKey) await this.credentials.set('system.ai', 'external', options.apiKey);
    const changed = options.mode !== this.settings.mode || address !== this.settings.address || Boolean(options.apiKey);
    if (changed) await this.stop();
    this.settings = { schemaVersion: 1, mode: options.mode, address, model: options.model, verified: changed ? [] : this.settings.verified };
    await atomicJson(path.join(this.root, 'settings.json'), this.settings); return this.status();
  }
  async start() {
    if (this.settings.mode === 'external') return this.status();
    if (this.starting) return this.starting;
    if (this.child) return this.status();
    this.starting = this.launch().finally(() => { this.starting = null; }); return this.starting;
  }
  async launch() {
    const epoch = this.epoch;
    this.error = null;
    this.apiKey = randomBytes(32).toString('hex'); this.managementKey = randomBytes(32).toString('hex');
    const port = await availablePort(); this.builtinAddress = 'http://127.0.0.1:' + port;
    await mkdir(path.join(this.root, 'auths'), { recursive: true, mode: 0o700 });
    let providers = {}; try { providers = JSON.parse(await readFile(path.join(this.root, 'providers.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const config = { host: '127.0.0.1', port, 'auth-dir': path.join(this.root, 'auths'), 'api-keys': [this.apiKey], 'remote-management': { 'allow-remote': false, 'secret-key': this.managementKey, 'disable-control-panel': true }, 'request-retry': 0, 'request-log': false, 'logging-to-file': false, 'usage-statistics-enabled': false, pprof: { enable: false }, ...providers };
    const configFile = path.join(this.root, 'runtime.json'); await atomicJson(configFile, config); await chmod(configFile, 0o600);
    if (epoch !== this.epoch) throw new Error('代理启动已取消。');
    const child = spawn(this.binary, ['--config', configFile], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }); this.child = child;
    let launchError; child.once('error', () => { launchError = new Error('内置 CLIProxyAPI 无法启动。'); this.error = launchError.message; });
    child.once('exit', () => { if (this.child === child) { this.child = null; this.error = 'CLIProxyAPI 已停止。'; } });
    for (let attempt = 0; attempt < 80; attempt++) {
      if (epoch !== this.epoch) throw new Error('代理启动已取消。');
      if (launchError || child.exitCode !== null) break;
      try { const response = await this.request(this.builtinAddress, '/v1/models', { headers: { Authorization: 'Bearer ' + this.apiKey }, signal: AbortSignal.timeout(1500) }); await response.body?.cancel(); if (response.ok) return this.status(); } catch { }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await this.stop(); throw launchError || new Error('内置 CLIProxyAPI 启动失败或超时。');
  }
  async stop() {
    this.epoch++;
    const child = this.child; this.child = null; this.oauth.clear();
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    }
    return this.status();
  }
  async connection(requireVerified = false) {
    if (requireVerified && /gpt[-_]?image|nano[-_ ]?banana|image[-_]?generation/i.test(this.settings.model)) throw new Error('图像模型不能用作文本助手，请选择支持工具调用的文本型号。');
    if (this.settings.mode === 'builtin') await this.start();
    const base = this.settings.mode === 'builtin' ? this.builtinAddress : this.settings.address;
    const key = this.settings.mode === 'builtin' ? this.apiKey : await this.credentials.get('system.ai', 'external');
    if (!key) throw new Error('请配置代理访问密钥。');
    if (requireVerified && (!this.settings.model || !this.settings.verified.includes(this.settings.model))) throw new Error('请在 AI 模型设置中选择模型并验证工具调用。');
    return { base, key, model: this.settings.model };
  }
  async models() {
    return (await this.catalog()).map(item => ({ id: item.id }));
  }
  async imageConnection() {
    const connection = await this.connection();
    return { ...connection, id: createHash('sha256').update(JSON.stringify([this.settings.mode, this.settings.mode === 'builtin' ? 'builtin' : connection.base])).digest('hex') };
  }
  async catalog(connection = null) {
    const { base, key } = connection ?? await this.connection();
    const response = await this.request(base, '/v1/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('无法获取代理模型列表（' + response.status + '）。'); }
    const value = await boundedJson(response, 1024 ** 2);
    if (!Array.isArray(value.data)) throw new Error('代理模型列表格式无效。');
    return [...new Map(value.data.filter(item => item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 160 && !/[\x00-\x1f\x7f]/.test(item.id)).map(item => [item.id, { id: item.id, title: typeof item.display_name === 'string' ? item.display_name.slice(0, 160) : item.id, type: typeof item.type === 'string' ? item.type : '', version: typeof item.version === 'string' ? item.version.slice(0, 160) : '' }])).values()];
  }
  async verify() {
    if (/gpt[-_]?image|nano[-_ ]?banana|image[-_]?generation/i.test(this.settings.model)) throw new Error('图像模型不能用作文本助手，不会发送验证请求。');
    const { base, key, model } = await this.connection(); if (!model) throw new Error('请选择助手模型。');
    const response = await this.request(base, '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Call the connection_check tool with ok=true.' }], tools: [{ type: 'function', function: { name: 'connection_check', description: 'Verify tool calling', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }], tool_choice: { type: 'function', function: { name: 'connection_check' } }, stream: false }), signal: AbortSignal.timeout(60000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('模型连接测试失败（' + response.status + '）。'); }
    const result = await boundedJson(response, 1024 ** 2), call = result.choices?.[0]?.message?.tool_calls?.find(item => item.function?.name === 'connection_check');
    let args; try { args = JSON.parse(call?.function?.arguments); } catch { }
    if (args?.ok !== true) throw new Error('此模型未通过工具调用验证。');
    this.settings.verified = [...new Set([...this.settings.verified, model])]; await atomicJson(path.join(this.root, 'settings.json'), this.settings); return this.status();
  }
  async management(endpoint, options = {}) {
    if (this.settings.mode !== 'builtin') throw new Error('外部代理请使用其原有账户管理端。');
    await this.start();
    const response = await this.request(this.builtinAddress, '/v0/management/' + endpoint, { ...options, headers: { Authorization: 'Bearer ' + this.managementKey, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('账户管理请求失败（' + response.status + '）。'); }
    return boundedJson(response, 4 * 1024 ** 2);
  }
  async provider({ provider, apiKey, baseURL, models }) {
    if (!['openai', 'google', 'claude', 'compatible'].includes(provider) || typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096) throw new Error('提供商配置无效。');
    const field = { openai: 'codex-api-key', google: 'gemini-api-key', claude: 'claude-api-key', compatible: 'openai-compatibility' }[provider];
    let entry = { 'api-key': apiKey };
    if (provider === 'compatible') {
      const base = new URL(baseURL); if (base.protocol !== 'https:' || base.username || base.password) throw new Error('提供商地址必须为 HTTPS。');
      if (!Array.isArray(models) || !models.length || models.some(value => typeof value !== 'string' || !value || value.length > 160)) throw new Error('请输入提供商模型名。');
      entry = { name: 'qingzuo', 'base-url': base.href, 'api-key-entries': [{ 'api-key': apiKey }], models: models.map(name => ({ name })) };
    }
    await this.management(field, { method: 'PUT', body: JSON.stringify([entry]) });
    let providers = {}; try { providers = JSON.parse(await readFile(path.join(this.root, 'providers.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    providers[field] = [entry]; await atomicJson(path.join(this.root, 'providers.json'), providers);
    this.settings.verified = []; await atomicJson(path.join(this.root, 'settings.json'), this.settings); return { saved: true };
  }
  async accounts() {
    const result = await this.management('auth-files');
    return (result.files || []).map(item => ({ name: String(item.name || '').slice(0, 160), provider: item.provider || item.type, disabled: Boolean(item.disabled), status: item.status || 'unknown' }));
  }
  async login(provider) {
    const endpoint = oauthPaths[provider]; if (!endpoint) throw new Error('OAuth 提供商不受支持。');
    const result = await this.management(endpoint + '?is_webui=true');
    const url = new URL(result.url);
    const domains = { codex: ['auth.openai.com'], claude: ['claude.ai', 'console.anthropic.com', 'platform.claude.com'], antigravity: ['accounts.google.com'] }[provider];
    if (url.protocol !== 'https:' || url.username || url.password || !domains.includes(url.hostname) || typeof result.state !== 'string') throw new Error('登录链接无效。');
    this.oauth.set(result.state, { provider, created: Date.now() }); await this.openExternal(url.href); return { state: result.state, status: 'wait' };
  }
  async loginStatus(state, cancel = false) {
    if (!this.oauth.has(state)) throw new Error('登录会话无效。');
    if (cancel) { await this.management('oauth-session?state=' + encodeURIComponent(state), { method: 'DELETE' }); this.oauth.delete(state); return { status: 'canceled' }; }
    if (Date.now() - this.oauth.get(state).created > 600000) { await this.loginStatus(state, true); return { status: 'error', error: '登录已超时。' }; }
    const result = await this.management('get-auth-status?state=' + encodeURIComponent(state));
    if (result.status !== 'wait') this.oauth.delete(state);
    return { status: ['ok', 'wait', 'error'].includes(result.status) ? result.status : 'error', error: result.status === 'error' ? '授权失败，请重新登录。' : undefined };
  }
}
