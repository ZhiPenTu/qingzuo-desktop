import { boundedJson } from './ai-images.mjs';

const IMAGE_MODEL = /gpt[-_]?image|nano[-_ ]?banana|image[-_]?generation/i;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ROLES = new Set(['system', 'user', 'assistant']);

export class TextRuntime {
  constructor({ proxy }) {
    this.proxy = proxy;
  }
  async models() {
    const catalog = await this.proxy.catalog();
    const models = catalog
      .filter(item => !IMAGE_MODEL.test(item.id) && !IMAGE_MODEL.test(item.type ?? ''))
      .map(({ id, title }) => ({ id, title }));
    return { models, defaultModel: this.proxy.settings.model };
  }
  async complete(args = {}) {
    const model = args.model === undefined ? '' : String(args.model);
    if (model.length > 160) throw new Error('模型标识无效。');
    const temperature = args.temperature === undefined ? undefined : Number(args.temperature);
    if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error('temperature 必须在 0 到 2 之间。');
    const responseFormat = args.responseFormat === undefined ? undefined : args.responseFormat;
    if (responseFormat !== undefined && (typeof responseFormat !== 'object' || responseFormat === null || !['text', 'json_object'].includes(responseFormat.type))) throw new Error('responseFormat 无效。');
    if (!Array.isArray(args.messages) || args.messages.length === 0 || args.messages.length > MAX_MESSAGES) throw new Error('messages 必须为 1 到 100 条。');
    const messages = args.messages.map(message => {
      if (typeof message?.role !== 'string' || !ROLES.has(message.role)) throw new Error('消息角色无效。');
      if (typeof message.content !== 'string' || message.content.length === 0 || message.content.length > MAX_MESSAGE_CHARS) throw new Error('消息内容无效。');
      return { role: message.role, content: message.content };
    });
    const connection = await this.proxy.connection();
    const body = { model: model || connection.model, messages };
    if (temperature !== undefined) body.temperature = temperature;
    if (responseFormat !== undefined) body.response_format = { type: responseFormat.type };
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw new Error('补全请求过大。');
    const response = await this.proxy.request(connection.base, '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + connection.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new Error('AI 服务密钥无效或未授权。'); }
    if (response.status === 429) { await response.body?.cancel(); throw new Error('AI 服务请求过于频繁，请稍后重试。'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error('AI 补全失败（' + response.status + '）。'); }
    const value = await boundedJson(response, MAX_RESPONSE_BYTES);
    const content = value?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) throw new Error('AI 服务没有返回内容。');
    return { content, model: body.model };
  }
}
