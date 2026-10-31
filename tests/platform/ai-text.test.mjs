import test from 'node:test';
import assert from 'node:assert/strict';
import { TextRuntime } from '../../desktop/ai-text.mjs';
import { API_VERSION, validateManifest } from '../../packages/plugin-sdk/manifest.mjs';

function runtime({ catalog = [{ id: 'gpt-5.6-terra', title: 'Terra' }], key = 'base-key', request } = {}) {
  return new TextRuntime({
    proxy: {
      catalog: async () => catalog,
      connection: async () => ({ base: 'https://proxy.example.test', key }),
      request,
    },
  });
}
const completion = content => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
const messages = [{ role: 'user', content: '翻译这段文案' }];

test('text model catalog filters non-chat models and derives a fallback from the catalog', async () => {
  const result = await runtime({ catalog: [
    { id: 'text-embedding-3-large', title: 'Embedding', type: 'embedding' },
    { id: 'gpt-5.6-terra', title: 'Terra' },
    { id: 'gpt-image-2.5-sunburst', title: 'Sunburst', type: 'openai-image' },
    { id: 'gemini-nano-banana-2.1', title: 'Banana' },
  ] }).models();
  assert.deepEqual(result, { models: [{ id: 'gpt-5.6-terra', title: 'Terra' }], defaultModel: 'gpt-5.6-terra' });
});

test('complete posts through the configured proxy and returns the answer', async () => {
  const requests = [];
  const ai = runtime({ request: async (base, endpoint, options) => {
    requests.push({ base, endpoint, options });
    return completion('{"title":"ok"}');
  } });
  assert.deepEqual(await ai.complete({ messages, temperature: 0.2, responseFormat: { type: 'json_object' } }), { content: '{"title":"ok"}', model: 'gpt-5.6-terra' });
  assert.equal(requests[0].base, 'https://proxy.example.test');
  assert.equal(requests[0].endpoint, '/v1/chat/completions');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer base-key');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body, { model: 'gpt-5.6-terra', messages, temperature: 0.2, response_format: { type: 'json_object' } });
  assert.deepEqual(await ai.complete({ model: 'gpt-5.6-luna', messages }), { content: '{"title":"ok"}', model: 'gpt-5.6-luna' });
});

test('complete uses the first available text model when the caller does not choose one', async () => {
  const requests = [];
  const ai = runtime({ catalog: [
    { id: 'embedding-3', title: 'Embedding', type: 'embedding' },
    { id: 'catalog-chat', title: 'Catalog Chat' },
  ], request: async (_base, _endpoint, options) => { requests.push(JSON.parse(options.body)); return completion('ok'); } });
  assert.deepEqual(await ai.complete({ messages }), { content: 'ok', model: 'catalog-chat' });
  assert.equal(requests[0].model, 'catalog-chat');
});

test('complete rejects invalid plugin input before any network call', async () => {
  let calls = 0;
  const ai = runtime({ request: async () => { calls++; return completion('x'); } });
  for (const bad of [
    { messages: [] },
    { messages: Array.from({ length: 101 }, () => ({ role: 'user', content: 'a' })) },
    { messages: [{ role: 'tool', content: 'a' }] },
    { messages: [{ role: 'user', content: '' }] },
    { messages, temperature: 3 },
    { messages, responseFormat: { type: 'json' } },
    { model: 'x'.repeat(161), messages },
  ]) await assert.rejects(ai.complete(bad), Error);
  assert.equal(calls, 0);
});

test('complete maps service failures to explicit errors', async () => {
  const failing = status => runtime({ request: async () => new Response('', { status }) });
  for (const status of [401, 403, 429, 500]) await assert.rejects(failing(status).complete({ messages }), Error);
  const empty = runtime({ request: async () => new Response(JSON.stringify({ choices: [] })) });
  await assert.rejects(empty.complete({ messages }), /没有返回内容/);
});

test('plugin manifests declare text AI capability against API 1.5', () => {
  assert.equal(API_VERSION, '1.5.0');
  // 1.5 只增加可选的图片片段，声明 ^1.4.0 的旧插件仍然兼容。
  const manifest = { commerce: { manifestVersion: 1, id: 'official.shein-full', title: '希音全托管铺货', description: '采集与翻译', ui: 'ui/index.html', api: '^1.4.0', permissions: { ai: ['image-edit', 'text'] } }, version: '0.2.0' };
  const validated = validateManifest(manifest);
  assert.deepEqual(validated.permissions.ai, ['image-edit', 'text']);
  manifest.commerce.permissions.ai = ['vision'];
  assert.throws(() => validateManifest(manifest), /AI 权限无效/);
});

const PNG = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');
const withImage = url => [{ role: 'user', content: [{ type: 'text', text: '给出 3 个标题' }, { type: 'image_url', image_url: { url } }] }];

test('complete forwards an image part next to the prompt', async () => {
  const requests = [];
  const ai = runtime({ request: async (base, endpoint, options) => { requests.push(options); return completion('{"titles":[]}'); } });
  const messages = withImage(PNG);
  await ai.complete({ messages });
  assert.deepEqual(JSON.parse(requests[0].body).messages, messages);
  const remote = withImage('https://img.example.test/main.jpg');
  await ai.complete({ messages: remote });
  assert.deepEqual(JSON.parse(requests[1].body).messages, remote);
});

test('complete rejects image sources the model service must not fetch', async () => {
  let calls = 0;
  const ai = runtime({ request: async () => { calls++; return completion('x'); } });
  for (const url of ['http://img.example.test/a.png', 'file:///tmp/a.png', 'data:text/plain;base64,AAAA', 'data:image/gif;base64,AAAA', 'https://user:pass@img.example.test/a.png']) {
    await assert.rejects(ai.complete({ messages: withImage(url) }), /消息图片无效/);
  }
  const tooMany = [{ role: 'user', content: Array.from({ length: 5 }, () => ({ type: 'image_url', image_url: { url: PNG } })) }];
  await assert.rejects(ai.complete({ messages: tooMany }), /最多 4 张图片/);
  const unknownPart = [{ role: 'user', content: [{ type: 'file', file: {} }] }];
  await assert.rejects(ai.complete({ messages: unknownPart }), /消息内容无效/);
  assert.equal(calls, 0);
});
