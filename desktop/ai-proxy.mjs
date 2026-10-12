import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './ai-batches.mjs';
import { boundedJson } from './ai-images.mjs';
import { secureRequest } from './network-transport.mjs';

export function proxyAddress(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !((url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) || url.protocol === 'https:')) throw new Error('代理地址必须为 HTTPS 或本机 HTTP 地址。');
  return url.href.replace(/\/$/, '').replace(/\/v1$/, '');
}

export async function proxyRequest(base, endpoint, options = {}) {
  const target = new URL(base + endpoint);
  return target.protocol === 'http:' ? fetch(target, { ...options, redirect: 'error' }) : secureRequest(target.href, { ...options, redirect: 'error' });
}

export class ProxyRuntime {
  constructor({ root, credentials, request = proxyRequest }) {
    Object.assign(this, { root, credentials, request });
    this.settings = { schemaVersion: 1, mode: 'external', address: 'http://127.0.0.1:8317', model: '', verified: [] };
    this.error = null;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(path.join(this.root, 'settings.json'), 'utf8'));
      if (value.schemaVersion !== 1) throw new Error('AI 配置版本不受支持。');
      this.settings = { ...this.settings, ...value, mode: 'external', address: proxyAddress(value.address || 'http://127.0.0.1:8317'), verified: Array.isArray(value.verified) ? value.verified : [] };
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = 'AI 配置读取失败，请重新设置。';
    }
  }
  status() {
    return { ...this.settings, mode: 'external', running: true, error: this.error };
  }
  async configure(options) {
    if (typeof options.model !== 'string' || options.model.length > 160) throw new Error('AI 配置无效。');
    const address = proxyAddress(options.address || this.settings.address);
    if (options.apiKey) await this.credentials.set('system.ai', 'external', options.apiKey);
    const changed = address !== this.settings.address || Boolean(options.apiKey);
    this.settings = { schemaVersion: 1, mode: 'external', address, model: options.model, verified: changed ? [] : this.settings.verified };
    await atomicJson(path.join(this.root, 'settings.json'), this.settings);
    return this.status();
  }
  async start() {
    return this.status();
  }
  async stop() {
    return this.status();
  }
  async connection(requireVerified = false) {
    if (requireVerified && /gpt[-_]?image|nano[-_ ]?banana|image[-_]?generation/i.test(this.settings.model)) throw new Error('图像模型不能用作文本助手，请选择支持工具调用的文本型号。');
    const base = this.settings.address;
    const key = await this.credentials.get('system.ai', 'external');
    if (!key) throw new Error('请配置代理访问密钥。');
    if (requireVerified && (!this.settings.model || !this.settings.verified.includes(this.settings.model))) throw new Error('请在 AI 模型设置中选择模型并验证工具调用。');
    return { base, key, model: this.settings.model };
  }
  async models() {
    return (await this.catalog()).map(item => ({ id: item.id }));
  }
  async imageConnection() {
    const connection = await this.connection();
    return { ...connection, id: createHash('sha256').update(JSON.stringify(['external', connection.base])).digest('hex') };
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
}
