import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPluginClient } from '../../packages/plugin-sdk/index.mjs';
import { ImageEditor, proxyImageModels } from '../../desktop/ai-images.mjs';
import { ProxyRuntime } from '../../desktop/ai-proxy.mjs';
import { BatchRuntime } from '../../desktop/ai-batches.mjs';
import { FileBroker } from '../../desktop/brokers.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAdkAAAAASUVORK5CYII=', 'base64');
const plugin = { id: 'official.ai-image', permissions: { files: true, ai: ['image-edit'] } };
const catalog = [
  { id: 'gemini-3.1-flash-image-preview', type: 'gemini', display_name: 'Nano Banana' },
  { id: 'gpt-image-2.5-sunburst', type: 'openai', version: 'gpt-image-2.5-sunburst' },
  { id: 'studio-edit', type: 'openai-image', display_name: 'My Image Alias' },
  { id: 'banana-alias', type: 'gemini', display_name: 'Gemini 3 Pro Image Preview', version: '3.0' },
  { id: 'gemini-2.5-flash-image', type: 'gemini' },
  { id: 'gpt-text', type: 'openai' },
  { id: 'gemini-3.8-flash-high', type: 'gemini' },
  { id: 'vision-only', type: 'openai', display_name: 'Image understanding' },
];
async function fixture(context, request) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-images-')), secrets = [], calls = [];
  const proxy = new ProxyRuntime({ root: path.join(root, 'proxy'), credentials: { get: async (...args) => { secrets.push(args); return 'shared-fixture'; } }, request: async (base, endpoint, options) => {
    calls.push({ base, endpoint, options });
    if (endpoint === '/v1/models') return Response.json({ data: catalog });
    if (request) return request(base, endpoint, options);
    return Response.json(endpoint.startsWith('/v1beta') ? { candidates: [{ content: { parts: [{ inline_data: { data: png.toString('base64') } }] } }] } : { data: [{ b64_json: png.toString('base64') }] });
  } });
  await proxy.initialize();
  await proxy.configure({ mode: 'external', address: 'http://127.0.0.1:8317', model: 'gemini-3.8-flash-high' });
  const editor = new ImageEditor({ get: async () => { throw new Error('Must not read plugin keys'); } }, async () => { throw new Error('Must not use official endpoints'); }, proxy);
  const output = path.join(root, 'output'); await mkdir(output);
  const files = new FileBroker(path.join(root, 'files'), { showOpenDialog: async () => ({ canceled: false, filePaths: [output] }) }); await files.initialize();
  const token = (await files.create(plugin, png, 'original.png', 'image/png')).token, grant = await files.pickDirectory(plugin);
  const runtime = new BatchRuntime(path.join(root, 'batches'), files, editor); await runtime.initialize();
  context.after(async () => { await runtime.shutdown(); await proxy.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, output, proxy, editor, secrets, calls, files, token, grant, runtime };
}
const input = (token, modelId = 'gpt-image-2.5-sunburst', count = 1) => ({ source: 'proxy', modelId, prompt: '保留文字，改成白底', concurrency: 2, items: Array.from({ length: count }, () => ({ token })) });
const edits = calls => calls.filter(call => call.options.method === 'POST');
async function finish(runtime, batch, grant) { await runtime.start(plugin, { id: batch.id, revision: batch.revision, directoryToken: grant.token }); await runtime.running.get(batch.id)?.done; }

test('proxy discovery filters text models, preserves image aliases and reveals no shared secrets', async context => {
  const { editor, proxy, secrets, calls } = await fixture(context);
  const models = await editor.models(plugin, { source: 'proxy' });
  assert.deepEqual(models.map(model => model.id), catalog.slice(0, 5).map(model => model.id));
  assert.equal(models[2].provider, 'compatible'); assert.deepEqual(models[2].sizes, []);
  assert.equal(models[3].provider, 'google'); assert.deepEqual(models[4].sizes, []);
  assert.ok(models.every(model => model.source === 'proxy'));
  assert.ok(!JSON.stringify(models).includes('shared-fixture'));
  assert.deepEqual(secrets, [['system.ai', 'external']]); assert.equal(edits(calls).length, 0);
  assert.equal(proxy.settings.model, 'gemini-3.8-flash-high'); assert.deepEqual(proxy.settings.verified, []);
  await assert.rejects(editor.models({ ...plugin, permissions: {} }, { source: 'proxy' }), /未授权/);
  assert.equal(calls.length, 1);
  await assert.rejects(editor.resolve(plugin, { source: 'proxy', modelId: 'gpt-text' }), /无效/);
  await assert.rejects(editor.resolve(plugin, { source: 'proxy', modelId: 'missing' }), /无效/);
  await assert.rejects(editor.resolve(plugin, { source: 'proxy', modelId: 'studio-edit', parameters: { quality: 'max' } }), /不支持/);
  const unknown = proxyImageModels([{ id: 'gpt-image-future', type: 'openai' }])[0];
  assert.deepEqual(unknown.sizes, []); assert.equal(unknown.qualities, undefined);
});

test('proxy edits send one original to exact native/multipart endpoints with host credentials', async context => {
  const { editor, calls, secrets } = await fixture(context);
  for (const modelId of ['gemini-3.1-flash-image-preview', 'gpt-image-2.5-sunburst', 'studio-edit', 'banana-alias']) {
    const result = await editor.edit(plugin, { source: 'proxy', modelId, prompt: 'edit', bytes: png, mime: 'image/png' });
    assert.deepEqual(result, { bytes: png, mime: 'image/png' });
  }
  const requests = edits(calls); assert.equal(requests.length, 4);
  assert.equal(requests[0].endpoint, '/v1beta/models/gemini-3.1-flash-image-preview:generateContent');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.contents[0].parts.length, 2); assert.equal(body.contents[0].parts[1].inline_data.data, png.toString('base64'));
  assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: '1:1', imageSize: '1K' });
  assert.equal(requests[3].endpoint, '/v1beta/models/banana-alias:generateContent');
  assert.equal(requests[1].endpoint, '/v1/images/edits');
  const multipart = requests[1].options.body;
  assert.equal(multipart.get('model'), 'gpt-image-2.5-sunburst'); assert.equal(multipart.get('n'), '1');
  assert.equal(multipart.get('response_format'), 'b64_json'); assert.equal(multipart.getAll('image[]').length, 1);
  assert.deepEqual(Buffer.from(await multipart.get('image[]').arrayBuffer()), png);
  assert.equal(requests[2].options.body.get('model'), 'studio-edit');
  assert.equal(requests[2].options.body.get('size'), null); assert.equal(requests[2].options.body.get('quality'), null);
  assert.ok(requests.every(call => call.options.headers.Authorization === 'Bearer shared-fixture' && !call.options.headers['x-goog-api-key'] && call.options.redirect === 'error'));
  assert.ok(secrets.every(args => args[0] === 'system.ai' && args[1] === 'external'));
});

test('proxy image errors, missing image, URL-only results and cancellation never fallback or resubmit', async context => {
  let response;
  const { editor, calls } = await fixture(context, async (_base, _endpoint, options) => { options.signal?.throwIfAborted(); return response; });
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const before = edits(calls).length; response = new Response('', { status });
    await assert.rejects(editor.edit(plugin, { source: 'proxy', modelId: 'studio-edit', prompt: 'edit', bytes: png, mime: 'image/png' }));
    assert.equal(edits(calls).length, before + 1);
  }
  for (const data of [{ data: [] }, { data: [{ url: 'http://127.0.0.1/private' }] }, { data: [{ b64_json: 'bm90LWltYWdl' }] }]) {
    response = Response.json(data);
    await assert.rejects(editor.edit(plugin, { source: 'proxy', modelId: 'studio-edit', prompt: 'edit', bytes: png, mime: 'image/png' }), /图片/);
  }
  const before = edits(calls).length;
  await assert.rejects(editor.edit(plugin, { source: 'proxy', modelId: 'studio-edit', prompt: 'edit', bytes: png, mime: 'image/png', signal: AbortSignal.abort() }), /abort/i);
  assert.equal(edits(calls).length, before);
});

test('proxy batches freeze source and parameters, run concurrently and isolate owners', async context => {
  const { runtime, token, grant, calls, output, root } = await fixture(context);
  const batch = await runtime.create(plugin, { ...input(token, 'gpt-image-2.5-sunburst', 4), parameters: { size: '2560x1440', quality: 'max' } });
  assert.equal(batch.source, 'proxy'); assert.equal(batch.selection, undefined);
  const persisted = JSON.parse(await readFile(path.join(root, 'batches', batch.id, 'state.json'), 'utf8'));
  assert.equal(persisted.selection.model.source, 'proxy'); assert.equal(persisted.selection.model.id, batch.modelId);
  assert.ok(!JSON.stringify(persisted).includes('shared-fixture'));
  await assert.rejects(runtime.start({ ...plugin, id: 'other.plugin' }, { id: batch.id, revision: 1, directoryToken: grant.token }), /未授权/);
  const options = { id: batch.id, revision: 1, directoryToken: grant.token };
  await Promise.all([runtime.start(plugin, options), runtime.start(plugin, options)]); await runtime.running.get(batch.id)?.done;
  assert.equal(edits(calls).length, 4); assert.equal((await readdir(output)).length, 4);
  assert.ok(edits(calls).every(call => call.options.body.get('quality') === 'max' && call.options.body.get('size') === '2560x1440'));
});

test('changed proxy destination blocks pending generation but does not block resaving existing results', async context => {
  const { runtime, token, grant, proxy, calls, output } = await fixture(context);
  const batch = await runtime.create(plugin, input(token));
  const conflict = path.join(output, 'original-ai-' + batch.id.slice(0, 8) + '-1.png'); await writeFile(conflict, 'keep');
  await finish(runtime, batch, grant); assert.equal(runtime.get(plugin, batch.id).items[0].state, 'save-failed');
  const pending = await runtime.create(plugin, input(token));
  await proxy.configure({ mode: 'external', address: 'http://127.0.0.1:9999', model: 'gemini-3.8-flash-high' });
  await assert.rejects(runtime.start(plugin, { id: pending.id, revision: 1, directoryToken: grant.token }), /连接已改变/);
  assert.equal(runtime.get(plugin, pending.id).state, 'draft'); assert.equal(edits(calls).length, 1);
  await rm(conflict); await finish(runtime, batch, grant);
  assert.equal(runtime.get(plugin, batch.id).items[0].state, 'succeeded'); assert.equal(edits(calls).length, 1);
});

test('restart retains proxy source and unknown requests are never automatically repeated', async context => {
  const { runtime, token, grant, proxy, calls, files, root } = await fixture(context, async (_base, _endpoint, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })));
  const batch = await runtime.create(plugin, { ...input(token, 'studio-edit', 3), concurrency: 1 });
  await runtime.start(plugin, { id: batch.id, revision: 1, directoryToken: grant.token });
  while (!edits(calls).length) await new Promise(resolve => setTimeout(resolve, 5));
  await runtime.shutdown();
  proxy.request = async () => Response.json({ data: [{ b64_json: png.toString('base64') }] });
  const recovered = new BatchRuntime(path.join(root, 'batches'), files, new ImageEditor({}, undefined, proxy)); await recovered.initialize();
  context.after(() => recovered.shutdown());
  assert.equal(recovered.get(plugin, batch.id).source, 'proxy'); assert.equal(recovered.get(plugin, batch.id).items[0].state, 'unknown');
  await finish(recovered, batch, await files.pickDirectory(plugin));
  assert.deepEqual(recovered.get(plugin, batch.id).items.map(item => item.state), ['unknown', 'succeeded', 'succeeded']);
});

test('SDK source options are additive and missing proxy catalog is an explicit error', async context => {
  const invocations = [], client = createPluginClient({ invoke: async (...args) => invocations.push(args), onDispose: () => () => {} });
  await client.ai.models(); await client.ai.models({ source: 'proxy' });
  assert.deepEqual(invocations, [['ai.models', {}], ['ai.models', { source: 'proxy' }]]);
  const { proxy, editor } = await fixture(context);
  proxy.request = async () => Response.json({ error: 'not a catalog' });
  await assert.rejects(editor.models(plugin, { source: 'proxy' }), /格式无效/);
});
