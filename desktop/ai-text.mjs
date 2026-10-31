import { boundedJson } from './ai-images.mjs';
import { isChatModel } from './ai-proxy.mjs';

const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_IMAGE_PARTS = 4;
const MAX_IMAGE_DATA_URL_CHARS = 4 * 1024 * 1024;
// 图片随消息一起走补全请求，整体上限按「一张主图 + 一段提示词」留足余量。
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ROLES = new Set(['system', 'user', 'assistant']);
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

// 图片只接受模型服务能直接读取的形式：https 地址，或 png/jpeg/webp 的 base64 data URL。
// 其它协议（file、http、data:text）一律拒绝，避免借补全请求读取插件无权访问的资源。
function imageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_IMAGE_DATA_URL_CHARS) throw new Error('消息图片无效。');
  if (value.startsWith('data:')) {
    if (!IMAGE_DATA_URL.test(value)) throw new Error('消息图片无效。');
    return value;
  }
  if (value.length > 2048) throw new Error('消息图片无效。');
  let url;
  try { url = new URL(value); } catch { throw new Error('消息图片无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('消息图片无效。');
  return value;
}

function contentOf(content) {
  if (typeof content === 'string') {
    if (content.length === 0 || content.length > MAX_MESSAGE_CHARS) throw new Error('消息内容无效。');
    return content;
  }
  if (!Array.isArray(content) || content.length === 0 || content.length > MAX_IMAGE_PARTS + 1) throw new Error('消息内容无效。');
  let images = 0;
  return content.map(part => {
    if (part?.type === 'text') {
      if (typeof part.text !== 'string' || part.text.length === 0 || part.text.length > MAX_MESSAGE_CHARS) throw new Error('消息内容无效。');
      return { type: 'text', text: part.text };
    }
    if (part?.type === 'image_url') {
      images += 1;
      if (images > MAX_IMAGE_PARTS) throw new Error('单条消息最多 4 张图片。');
      return { type: 'image_url', image_url: { url: imageUrl(part.image_url?.url) } };
    }
    throw new Error('消息内容无效。');
  });
}

export class TextRuntime {
  constructor({ proxy }) {
    this.proxy = proxy;
  }
  async models() {
    const catalog = await this.proxy.catalog();
    const models = catalog
      .filter(isChatModel)
      .map(({ id, title }) => ({ id, title }));
    return { models, defaultModel: models[0]?.id ?? '' };
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
      return { role: message.role, content: contentOf(message.content) };
    });
    const connection = await this.proxy.connection();
    const selectedModel = model || (await this.proxy.catalog(connection)).filter(isChatModel)[0]?.id;
    if (!selectedModel) throw new Error('没有可用的文本模型，请检查 AI 服务配置。');
    const body = { model: selectedModel, messages };
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
