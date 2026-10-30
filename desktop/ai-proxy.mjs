import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './ai-batches.mjs';
import { boundedJson } from './ai-images.mjs';
import { secureRequest } from './network-transport.mjs';

const IMAGE_MODEL = /gpt[-_]?image|nano[-_ ]?banana|image[-_]?generat/i;
const NON_CHAT_MODEL = /(?:^|[/_. -])(?:embedding|embed|rerank|reranker|bge|whisper|transcri(?:be|ption)|speech|audio|tts|video|sora|veo|kling|imagen|dall-e|stable-diffusion|flux)(?:$|[/_. -])/i;

export function proxyAddress(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !((url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) || url.protocol === 'https:')) throw new Error('代理地址必须为 HTTPS 或本机 HTTP 地址。');
  return url.href.replace(/\/$/, '').replace(/\/v1$/, '');
}

export function isChatModel(item) {
  const signature = `${item?.id ?? ''} ${item?.title ?? ''} ${item?.type ?? ''}`;
  return !IMAGE_MODEL.test(signature) && !NON_CHAT_MODEL.test(signature);
}

export async function proxyRequest(base, endpoint, options = {}) {
  const target = new URL(base + endpoint);
  return target.protocol === 'http:' ? fetch(target, { ...options, redirect: 'error' }) : secureRequest(target.href, { ...options, redirect: 'error' });
}

class AIHttpError extends Error {
  constructor(status, phase) {
    super(httpSetupError(status, phase).message);
    this.status = status;
    this.phase = phase;
  }
}

class AISetupError extends Error {
  constructor(code, message, models) {
    super(message);
    Object.assign(this, { code, models });
  }
}

function httpSetupError(status, phase) {
  if (status === 401) return new AISetupError('invalid_key', '访问密钥无效，请检查后重新粘贴。');
  if (status === 403) return new AISetupError('forbidden', '这个密钥没有调用所选服务的权限，请在服务商后台检查权限。');
  if (status === 404) return new AISetupError('incompatible_address', '服务地址不兼容，请检查是否填写了 OpenAI 兼容接口地址。');
  if (status === 408) return new AISetupError('network_timeout', '连接超时，请检查网络后重试。');
  if (status === 429) return new AISetupError('rate_limited', '请求过于频繁或额度不足，请稍后再试，或检查服务商账户。');
  if ((status === 400 || status === 422) && phase === 'verify') return new AISetupError('model_incompatible', '这个模型不支持 AI 助手所需的工具调用，请选择其他模型。');
  if (status === 400 || status === 422) return new AISetupError('incompatible_address', '服务地址不兼容，请检查是否填写了 OpenAI 兼容接口地址。');
  if (status >= 500) return new AISetupError('service_unavailable', '服务暂时不可用，请稍后重试。');
  return new AISetupError('request_failed', '连接服务失败，请检查服务地址后重试。');
}

function setupFailure(error, models = []) {
  if (error instanceof AISetupError) {
    return { ok: false, code: error.code, message: error.message, ...(error.models?.length ? { models: error.models } : models.length ? { models } : {}) };
  }
  if (error instanceof AIHttpError) {
    const mapped = httpSetupError(error.status, error.phase);
    return { ok: false, code: mapped.code, message: mapped.message, ...(models.length ? { models } : {}) };
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { ok: false, code: 'network_timeout', message: '连接超时，请检查网络后重试。', ...(models.length ? { models } : {}) };
  }
  if (/凭据|credential/i.test(error?.message ?? '')) {
    return { ok: false, code: 'credential_error', message: '无法保存访问密钥，请检查应用数据目录权限后重试。', ...(models.length ? { models } : {}) };
  }
  return { ok: false, code: 'network_error', message: '无法连接 AI 服务，请检查网络或服务地址后重试。', ...(models.length ? { models } : {}) };
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
    return { ...this.settings, mode: 'external', running: true, ready: Boolean(this.settings.model && this.settings.verified.includes(this.settings.model) && !IMAGE_MODEL.test(this.settings.model)), error: this.error };
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
    if (!response.ok) { await response.body?.cancel(); throw new AIHttpError(response.status, 'catalog'); }
    const value = await boundedJson(response, 1024 ** 2);
    if (!Array.isArray(value.data)) throw new AISetupError('catalog_invalid', '模型列表格式无效，请确认地址来自 OpenAI 兼容服务。');
    return [...new Map(value.data.filter(item => item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 160 && !/[\x00-\x1f\x7f]/.test(item.id)).map(item => [item.id, { id: item.id, title: typeof item.display_name === 'string' ? item.display_name.slice(0, 160) : item.id, type: typeof item.type === 'string' ? item.type : '', version: typeof item.version === 'string' ? item.version.slice(0, 160) : '' }])).values()];
  }
  async setupKey(address, apiKey) {
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4096)) throw new AISetupError('invalid_config', '访问密钥格式无效。');
    const provided = apiKey?.trim();
    if (provided) return provided;
    if (address !== proxyAddress(this.settings.address)) throw new AISetupError('missing_key', '请填写这个服务的访问密钥。');
    const saved = await this.credentials.get('system.ai', 'external');
    if (!saved) throw new AISetupError('missing_key', '请填写访问密钥。');
    return saved;
  }
  async verifyModel(connection, model) {
    if (IMAGE_MODEL.test(model)) throw new AISetupError('model_not_chat', '这个模型不能用于 AI 助手，请选择文本模型。');
    const { base, key } = connection;
    const response = await this.request(base, '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Call the connection_check tool with ok=true.' }], tools: [{ type: 'function', function: { name: 'connection_check', description: 'Verify tool calling', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }], tool_choice: { type: 'function', function: { name: 'connection_check' } }, stream: false }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new AIHttpError(response.status, 'verify'); }
    const result = await boundedJson(response, 1024 ** 2), call = result.choices?.[0]?.message?.tool_calls?.find(item => item.function?.name === 'connection_check');
    let args; try { args = JSON.parse(call?.function?.arguments); } catch { }
    if (args?.ok !== true) throw new AISetupError('model_incompatible', '这个模型不支持 AI 助手所需的工具调用，请选择其他模型。');
  }
  async commitSetup(address, apiKey, model) {
    const previousSettings = this.settings;
    let previousKey = null, keyChanged = false;
    try {
      if (apiKey) {
        try {
          previousKey = await this.credentials.get('system.ai', 'external');
        } catch {
          throw new AISetupError('credential_error', '无法读取已保存的访问密钥，请重新填写。');
        }
        keyChanged = true;
        try {
          await this.credentials.set('system.ai', 'external', apiKey);
        } catch {
          throw new AISetupError('credential_error', '无法保存访问密钥，请检查应用数据目录权限后重试。');
        }
      }
      this.settings = { schemaVersion: 1, mode: 'external', address, model, verified: [model] };
      try {
        await atomicJson(path.join(this.root, 'settings.json'), this.settings);
      } catch {
        throw new AISetupError('save_failed', '无法保存 AI 设置，请检查磁盘空间后重试。');
      }
    } catch (error) {
      this.settings = previousSettings;
      if (keyChanged) {
        await (previousKey ? this.credentials.set('system.ai', 'external', previousKey) : this.credentials.clear('system.ai', 'external')).catch(() => {});
      }
      throw error;
    }
  }
  async setup(options = {}) {
    let models = [];
    try {
      const address = proxyAddress(options.address || this.settings.address);
      if (!Array.isArray(options.preferredModels) || options.preferredModels.length > 20 || options.preferredModels.some(value => typeof value !== 'string' || !value || value.length > 160)) throw new AISetupError('invalid_config', '推荐模型配置无效。');
      const explicitModel = options.model === undefined ? '' : String(options.model).trim();
      if (explicitModel.length > 160) throw new AISetupError('invalid_config', '模型标识无效。');
      if (explicitModel && IMAGE_MODEL.test(explicitModel)) throw new AISetupError('model_not_chat', '这个模型不能用于 AI 助手，请选择文本模型。');
      const key = await this.setupKey(address, options.apiKey);
      const catalog = await this.catalog({ base: address, key });
      models = catalog.filter(isChatModel).map(({ id, title }) => ({ id, title }));
      const model = explicitModel || options.preferredModels.find(candidate => models.some(item => item.id === candidate)) || models[0]?.id;
      if (!model) throw new AISetupError('no_models', '没有找到可用于对话的模型，请检查账户权限或改选其他服务。');
      if (IMAGE_MODEL.test(model)) throw new AISetupError('model_not_chat', '这个模型不能用于 AI 助手，请选择文本模型。', models);
      await this.verifyModel({ base: address, key }, model);
      await this.commitSetup(address, options.apiKey?.trim(), model);
      return { ok: true, status: this.status() };
    } catch (error) {
      return setupFailure(error, models);
    }
  }
  async verify() {
    if (IMAGE_MODEL.test(this.settings.model)) throw new Error('图像模型不能用作文本助手，不会发送验证请求。');
    const { base, key, model } = await this.connection(); if (!model) throw new Error('请选择助手模型。');
    await this.verifyModel({ base, key }, model);
    this.settings.verified = [...new Set([...this.settings.verified, model])]; await atomicJson(path.join(this.root, 'settings.json'), this.settings); return this.status();
  }
}
