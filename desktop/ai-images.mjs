import { secureRequest } from './network-transport.mjs';

export const imageModels = Object.freeze([
  { id: 'gemini-nano-banana-2.1', provider: 'google', title: 'Nano Banana 2.1', sizes: ['1K', '2K', '4K'], ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'] },
  { id: 'gemini-3-pro-image', provider: 'google', title: 'Nano Banana Pro', sizes: ['1K', '2K', '4K'], ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'] },
  { id: 'gpt-image-2.5-sunburst', provider: 'openai', title: 'GPT Image 2.5 Sunburst', sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '1536x864', '864x1536', '2560x1440', '1440x2560'], qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-image-2.5-flare', provider: 'openai', title: 'GPT Image 2.5 Flare', sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '1536x864', '864x1536', '2560x1440', '1440x2560'], qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
]);
export function proxyImageModels(catalog) {
  return catalog.flatMap(item => {
    const identity = [item.id, item.version, item.title].filter(Boolean).join(' ').toLowerCase();
    const google = /gemini[- ][^/]*image|(?:gemini[- ])?nano[- ]banana/.test(identity);
    const openai = /(?:^|\/)gpt-image-/.test(item.id) || /^gpt-image-/.test(item.version || '');
    if (!google && !openai && item.type !== 'openai-image') return [];
    const known = imageModels.find(model => model.id === item.id || model.id === item.version);
    const model = { id: item.id, title: item.title || item.id, provider: google && item.type !== 'openai-image' ? 'google' : openai ? 'openai' : 'compatible', source: 'proxy', sizes: [] };
    if (model.provider === 'google') {
      model.ratios = ['1:1', '4:3', '3:4', '16:9', '9:16'];
      if (!/2\.5[- ]flash[- ]image/.test(identity)) model.sizes = ['1K', '2K', '4K'];
    } else if (model.provider === 'openai' && (known?.provider === 'openai' || /gpt-image-(?:1\.5|2|2\.5(?:-flare|-sunburst)?)(?:\s|$)/.test(identity))) {
      model.sizes = known?.sizes || ['auto', '1024x1024', '1536x1024', '1024x1536'];
      model.qualities = known?.qualities || ['auto', 'low', 'medium', 'high'];
    }
    return [model];
  });
}
export function imageOptions(modelId, parameters = {}, catalog = imageModels) {
  const model = catalog.find(item => item.id === modelId);
  if (!model || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('图像型号或参数无效。');
  const allowed = [...(model.sizes.length ? ['size'] : []), ...(model.ratios?.length ? ['ratio'] : []), ...(model.qualities?.length ? ['quality'] : [])];
  if (Object.keys(parameters).some(key => !allowed.includes(key))) throw new Error('此型号不支持该参数。');
  const options = {};
  for (const [key, values] of [['size', model.sizes], ['ratio', model.ratios], ['quality', model.qualities]]) {
    if (!values?.length) continue;
    const value = parameters[key] ?? values[0];
    if (!values.includes(value)) throw new Error('图像参数不受支持：' + key + '。');
    options[key] = value;
  }
  return { model, parameters: options };
}
export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('服务返回了无效的图片。');
}
export async function boundedJson(response, limit = 96 * 1024 ** 2) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) { size += chunk.length; if (size > limit) { await response.body?.cancel?.().catch(() => {}); throw new Error('服务响应过大。'); } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('服务响应格式无效。'); }
}
export class ImageEditor {
  constructor(credentials, request = secureRequest, proxy = null) { this.credentials = credentials; this.request = request; this.proxy = proxy; }
  assert(plugin) {
    if (!plugin.permissions.ai?.includes('image-edit')) throw new Error('图像编辑未授权。');
  }
  async models(plugin, { source = 'official' } = {}) {
    this.assert(plugin);
    if (source === 'official') return imageModels.map(model => ({ ...model, source }));
    if (source !== 'proxy' || !this.proxy) throw new Error('图像来源无效或代理不可用。');
    return proxyImageModels(await this.proxy.catalog());
  }
  async resolve(plugin, { source = 'official', modelId, parameters }) {
    if (source === 'proxy') {
      this.assert(plugin);
      if (!this.proxy) throw new Error('代理图像编辑不可用。');
      const connection = await this.proxy.imageConnection();
      return { ...imageOptions(modelId, parameters, proxyImageModels(await this.proxy.catalog(connection))), connectionId: connection.id };
    }
    const selection = imageOptions(modelId, parameters, await this.models(plugin, { source }));
    return selection;
  }
  async assertSelection(plugin, selection) {
    this.assert(plugin);
    if (selection?.model.source === 'proxy') {
      if (!this.proxy || (await this.proxy.imageConnection()).id !== selection.connectionId) throw new Error('代理连接已改变，请重新准备批次并确认；不会改用其他服务。');
    }
  }
  async edit(plugin, { modelId, parameters, prompt, bytes, mime, signal, source = 'official', selection }) {
    this.assert(plugin);
    selection ??= await this.resolve(plugin, { source, modelId, parameters });
    const { model, parameters: options } = imageOptions(modelId, parameters, [selection.model]);
    await this.assertSelection(plugin, selection);
    const proxied = model.source === 'proxy';
    const origin = model.provider === 'google' ? 'https://generativelanguage.googleapis.com' : 'https://api.openai.com';
    const credential = model.provider + '-image';
    if (!proxied && (!plugin.permissions.network?.includes(origin) || !plugin.permissions.credentials?.includes(credential))) throw new Error('图像服务未授权。');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000 || bytes.length > 25 * 1024 ** 2 || imageMime(bytes) !== mime) throw new Error('原图或提示词无效。');
    signal?.throwIfAborted();
    const connection = proxied ? await this.proxy.imageConnection() : null;
    if (proxied && connection.id !== selection.connectionId) throw new Error('代理图像服务连接已改变，请重新准备批次并确认。');
    const secret = connection?.key || await this.credentials.get(plugin.id, credential); if (!secret) throw new Error('请先配置 ' + model.provider + ' 图像 API Key。');
    let url, body, headers;
    if (model.provider === 'google') {
      url = (proxied ? '/v1beta/models/' : origin + '/v1/models/') + encodeURIComponent(model.id) + ':generateContent';
      headers = { 'Content-Type': 'application/json', ...(proxied ? { Authorization: 'Bearer ' + secret } : { 'x-goog-api-key': secret }) };
      body = JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: bytes.toString('base64') } }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(options.ratio || options.size ? { imageConfig: { ...(options.ratio ? { aspectRatio: options.ratio } : {}), ...(options.size ? { imageSize: options.size } : {}) } } : {}) } });
    } else {
      url = (proxied ? '' : origin) + '/v1/images/edits'; headers = { Authorization: 'Bearer ' + secret };
      body = new FormData();
      for (const [key, value] of Object.entries({ model: model.id, prompt, n: '1', ...(options.size ? { size: options.size } : {}), ...(options.quality ? { quality: options.quality } : {}), ...(model.provider === 'openai' ? { output_format: 'png' } : {}), ...(proxied ? { response_format: 'b64_json' } : {}) })) body.append(key, value);
      body.append('image[]', new Blob([bytes], { type: mime }), 'original.' + (mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]));
    }
    const request = { method: 'POST', headers, body, redirect: 'error', signal };
    signal?.throwIfAborted();
    const response = proxied ? await this.proxy.request(connection.base, url, request) : await this.request(url, request);
    if (!response.ok) { await response.body?.cancel(); throw new Error(({ 401: proxied ? '代理访问密钥无效，请检查轻作 AI 设置。' : 'API Key 无效。', 403: '账号无权使用此型号。', 404: proxied ? '代理未启用此图像接口，请检查代理服务的版本与图像配置。' : '图像接口或型号不存在。', 400: proxied ? '代理拒绝此图片模型或参数，请检查图像路由配置；未改用其他型号。' : '图像服务拒绝此型号或参数。', 429: '请求限流或额度不足，请稍后手动重试。' })[response.status] || '图像服务请求失败（' + response.status + '）。'); }
    const data = await boundedJson(response);
    const part = model.provider === 'google' ? data.candidates?.[0]?.content?.parts?.find(item => item.inlineData || item.inline_data) : null;
    const encoded = model.provider === 'google' ? (part?.inlineData || part?.inline_data)?.data : data.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded || encoded.length > 90_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('服务未返回图片，可能被内容策略拒绝。');
    const output = Buffer.from(encoded, 'base64'); if (output.length > 64 * 1024 ** 2) throw new Error('结果图片过大。');
    return { bytes: output, mime: imageMime(output) };
  }
}
