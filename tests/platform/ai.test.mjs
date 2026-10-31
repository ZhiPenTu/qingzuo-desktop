import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { ImageEditor, imageOptions, isImageModel } from '../../desktop/ai-images.mjs';
import { BatchRuntime } from '../../desktop/ai-batches.mjs';
import { FileBroker } from '../../desktop/brokers.mjs';
import { ProxyRuntime, proxyAddress } from '../../desktop/ai-proxy.mjs';
import { bootCommerceKernel } from '../../desktop/kernel.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAdkAAAAASUVORK5CYII=', 'base64');
const plugin = { id: 'official.ai-image', title: 'AI 批图', permissions: { files: true, ai: ['image-edit', 'assistant'] } };
const foreign = { ...plugin, id: 'local.foreign' };
const credentials = { get: async () => 'fixture-key', set: async () => {} };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function fixture(context, edit = async () => ({ bytes: png, mime: 'image/png' })) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-ai-'));
  const output = path.join(root, 'output'); await mkdir(output);
  const files = new FileBroker(path.join(root, 'files'), { showOpenDialog: async () => ({ canceled: false, filePaths: [output] }) }); await files.initialize();
  const token = (await files.create(plugin, png, 'source.png', 'image/png')).token;
  const grant = await files.pickDirectory(plugin);
  const runtime = new BatchRuntime(path.join(root, 'batches'), files, { edit }); await runtime.initialize();
  context.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, output, files, token, grant, runtime };
}
const input = (token, count = 1, concurrency = 2) => ({ modelId: 'gemini-nano-banana-2.1', prompt: '统一白底', concurrency, items: Array.from({ length: count }, (_, index) => ({ token, ...(index === 1 ? { prompt: '第二张增加阴影' } : {}) })) });
async function start(runtime, batch, grant, retryFailed = false) { await runtime.start(plugin, { id: batch.id, revision: batch.revision, directoryToken: grant.token, retryFailed }); await runtime.running.get(batch.id)?.done; return runtime.get(plugin, batch.id); }

test('official image adapters use shared host credentials and parse image bytes', async () => {
  const requests = [], secrets = [];
  const editor = new ImageEditor({ get: async (...args) => { secrets.push(args); return 'fixture-key'; } }, async (url, options) => {
    requests.push({ url, ...options });
    return Response.json(url.includes('googleapis') ? { candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] } : { data: [{ b64_json: png.toString('base64') }] });
  });
  for (const modelId of ['gemini-nano-banana-2.1', 'gpt-image-2.5-sunburst']) assert.deepEqual(await editor.edit(plugin, { modelId, prompt: '保留文字', bytes: png, mime: 'image/png' }), { bytes: png, mime: 'image/png' });
  assert.equal(requests[0].headers['x-goog-api-key'], 'fixture-key');
  assert.equal(JSON.parse(requests[0].body).contents[0].parts[1].inline_data.data, png.toString('base64'));
  assert.equal(requests[1].url, 'https://api.openai.com/v1/images/edits');
  assert.equal(requests[1].body.get('n'), '1'); assert.equal(requests[1].body.get('model'), 'gpt-image-2.5-sunburst');
  assert.equal(requests[1].body.getAll('image[]').length, 1);
  assert.ok(secrets.every(([owner]) => owner === 'system.ai'));
  assert.deepEqual([...new Set(secrets.map(([, name]) => name))].sort(), ['google-image', 'openai-image']);
  assert.throws(() => imageOptions('unknown'), /无效/); assert.throws(() => imageOptions('gemini-nano-banana-2.1', { quality: 'low' }), /不支持/);
  assert.equal(imageOptions('gpt-image-2.5-sunburst', { size: '2560x1440', quality: 'max' }).parameters.quality, 'max');
  await assert.rejects(editor.edit({ ...plugin, permissions: { ...plugin.permissions, ai: [] } }, { modelId: 'gpt-image-2.5-sunburst' }), /未授权/);
});

test('shared image credentials are reusable by every image plugin and migrate legacy keys', async () => {
  const values = new Map(), writes = [];
  const shared = {
    get: async (owner, name) => values.get(owner + ':' + name) ?? null,
    set: async (owner, name, value) => { writes.push([owner, name]); values.set(owner + ':' + name, value); },
    clear: async (owner, name) => { writes.push([owner, name]); values.delete(owner + ':' + name); },
  };
  const editor = new ImageEditor(shared, async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }));
  const other = { id: 'local.image-editor', permissions: { files: true, ai: ['image-edit'] } };
  assert.deepEqual(await editor.models(plugin), []);
  const status = await editor.configureShared({ provider: 'google', apiKey: 'shared-google' });
  assert.equal(status.google.configured, true);
  assert.deepEqual((await editor.models(plugin)).map(model => model.id), ['gemini-nano-banana-2.1', 'gemini-3-pro-image']);
  assert.deepEqual((await editor.models(other)).map(model => model.id), ['gemini-nano-banana-2.1', 'gemini-3-pro-image']);
  assert.deepEqual(writes, [['system.ai', 'google-image']]);
  await editor.configureShared({ provider: 'google', clear: true });
  assert.deepEqual(await editor.models(plugin), []);

  values.set('official.ai-image:google-image', 'legacy-google');
  assert.equal((await editor.sharedStatus()).google.source, 'legacy');
  await editor.configureShared({ provider: 'google', clear: true });
  assert.equal(values.has('official.ai-image:google-image'), false);

  values.set('system.ai:external', 'openai-text-key');
  const inheriting = new ImageEditor(shared, async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }), { settings: { address: 'https://api.openai.com/v1' } });
  const inherited = await inheriting.sharedStatus();
  assert.deepEqual(inherited.openai, { configured: true, source: 'inherited' });
  assert.deepEqual(inherited.proxy, { configured: true });
  assert.deepEqual((await inheriting.models(other)).map(model => model.id), ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
  values.delete('system.ai:external');

  values.set('official.ai-image:openai-image', 'legacy-openai');
  assert.deepEqual((await editor.models(plugin)).map(model => model.id), ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
  assert.equal((await editor.sharedStatus()).openai.source, 'legacy');
  await editor.edit(other, { modelId: 'gpt-image-2.5-sunburst', prompt: 'edit', bytes: png, mime: 'image/png' });
  assert.equal(values.get('system.ai:openai-image'), 'legacy-openai');
  assert.equal(values.has('official.ai-image:openai-image'), false);
});

test('settings image catalog lists official and compatible image models without plugin permissions', async () => {
  const values = new Map([
    ['system.ai:google-image', 'shared-google'],
    ['system.ai:external', 'shared-compatible'],
  ]);
  const shared = {
    get: async (owner, name) => values.get(owner + ':' + name) ?? null,
    set: async (owner, name, value) => values.set(owner + ':' + name, value),
    clear: async (owner, name) => values.delete(owner + ':' + name),
  };
  const proxy = {
    catalog: async () => [
      { id: 'studio-render', type: 'image-generation', title: 'Studio Render' },
      { id: 'gpt-image-alias', type: 'openai-image', title: 'Image Alias' },
      { id: 'text-model', type: 'openai', title: 'Text Model' },
    ],
  };
  const editor = new ImageEditor(shared, async () => { throw new Error('must not call official endpoints'); }, proxy);
  const catalog = await editor.catalog();
  assert.deepEqual(catalog.models.map(model => model.id), [
    'gemini-nano-banana-2.1',
    'gemini-3-pro-image',
    'studio-render',
    'gpt-image-alias',
  ]);
  assert.deepEqual(catalog.models.map(model => model.source), ['official', 'official', 'proxy', 'proxy']);
  assert.equal(catalog.models.find(model => model.id === 'studio-render').provider, 'compatible');
  assert.equal(catalog.error, null);
  assert.equal(isImageModel({ id: 'studio-render', type: 'image-generation' }), true);
  assert.equal(isImageModel({ id: 'vision-only', type: 'openai', title: 'Image understanding' }), false);
});

test('image failures are explicit and never automatically resubmit', async () => {
  for (const status of [401, 403, 429, 500]) {
    let count = 0; const editor = new ImageEditor(credentials, async () => { count++; return new Response('', { status }); });
    await assert.rejects(editor.edit(plugin, { modelId: 'gpt-image-2.5-sunburst', prompt: 'edit', bytes: png, mime: 'image/png' })); assert.equal(count, 1);
  }
  for (const result of [{ data: [] }, { data: [{ b64_json: 'bm90LWFuLWltYWdl' }] }]) {
    const editor = new ImageEditor(credentials, async () => Response.json(result));
    await assert.rejects(editor.edit(plugin, { modelId: 'gpt-image-2.5-sunburst', prompt: 'edit', bytes: png, mime: 'image/png' }), /图片/);
  }
  const editor = new ImageEditor(credentials, async (_url, options) => { options.signal.throwIfAborted(); });
  await assert.rejects(editor.edit(plugin, { modelId: 'gpt-image-2.5-sunburst', prompt: 'edit', bytes: png, mime: 'image/png', signal: AbortSignal.abort() }), /abort/i);
});

test('batch snapshots prompts, limits concurrency and makes duplicate starts idempotent', async context => {
  let active = 0, maximum = 0, count = 0; const prompts = [];
  const { runtime, token, grant, output, files } = await fixture(context, async (_plugin, options) => { active++; maximum = Math.max(maximum, active); count++; prompts.push(options.prompt); await delay(30); active--; return { bytes: png, mime: 'image/png' }; });
  const batch = await runtime.create(plugin, input(token, 7));
  await files.revoke(plugin.id);
  const options = { id: batch.id, revision: batch.revision, directoryToken: grant.token };
  await Promise.all([runtime.start(plugin, options), runtime.start(plugin, options), runtime.start(plugin, options)]);
  await runtime.running.get(batch.id)?.done;
  assert.equal(count, 7); assert.equal(maximum, 2); assert.equal(prompts[1], '第二张增加阴影');
  assert.equal((await readdir(output)).length, 7); assert.ok(runtime.get(plugin, batch.id).items.every(item => item.state === 'succeeded'));
  assert.throws(() => runtime.get(foreign, batch.id), /未授权/); assert.throws(() => files.directory(foreign, grant.token), /未授权/);
  assert.equal(runtime.snapshot(runtime.get(plugin, batch.id)).directory, undefined);
});

test('failed destination copy preserves generated bytes and retries saving without a model call', async context => {
  let count = 0;
  const { runtime, token, grant, output } = await fixture(context, async () => { count++; return { bytes: png, mime: 'image/png' }; });
  const batch = await runtime.create(plugin, input(token, 3, 2));
  const conflict = path.join(output, 'source-ai-' + batch.id.slice(0, 8) + '-1.png'); await writeFile(conflict, 'existing');
  const finished = await start(runtime, batch, grant);
  assert.equal(finished.items[0].state, 'save-failed'); assert.equal(finished.items[2].state, 'succeeded'); assert.equal(count, 3);
  assert.equal(await readFile(conflict, 'utf8'), 'existing');
  await rm(conflict); await start(runtime, batch, grant, true);
  assert.equal(count, 3); assert.ok(finished.items.every(item => item.state === 'succeeded'));
});

test('single-image errors do not stop other images and retry requires explicit request', async context => {
  let count = 0;
  const { runtime, token, grant } = await fixture(context, async () => { if (++count === 1) throw new Error('fixture 429'); return { bytes: png, mime: 'image/png' }; });
  const batch = await runtime.create(plugin, input(token, 3, 1)); await start(runtime, batch, grant);
  assert.deepEqual(runtime.get(plugin, batch.id).items.map(item => item.state), ['failed', 'succeeded', 'succeeded']);
  await start(runtime, batch, grant); assert.equal(count, 3);
  await start(runtime, batch, grant, true); assert.equal(count, 4);
});

test('shutdown marks in-flight requests unknown; restart resumes only pending items after reauthorization', async context => {
  const { runtime, token, grant, files, root } = await fixture(context, async (_plugin, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const batch = await runtime.create(plugin, input(token, 3, 1)); await runtime.start(plugin, { id: batch.id, revision: 1, directoryToken: grant.token });
  while (!runtime.running.get(batch.id).controllers.size) await delay(5);
  await runtime.shutdown(); let count = 0;
  const recovered = new BatchRuntime(path.join(root, 'batches'), files, { edit: async () => { count++; return { bytes: png, mime: 'image/png' }; } }); await recovered.initialize();
  context.after(() => recovered.shutdown());
  assert.equal(recovered.get(plugin, batch.id).state, 'interrupted'); assert.equal(recovered.get(plugin, batch.id).items[0].state, 'unknown');
  await assert.rejects(recovered.start(plugin, { id: batch.id, revision: 1, directoryToken: 'invalid' }), /未授权/);
  await start(recovered, batch, await files.pickDirectory(plugin), true);
  assert.equal(count, 2); assert.equal(recovered.get(plugin, batch.id).items[0].state, 'unknown');
});

test('directory replacement and changed revisions fail closed before generation', async context => {
  let count = 0; const { runtime, token, grant, output, root } = await fixture(context, async () => { count++; return { bytes: png, mime: 'image/png' }; });
  const batch = await runtime.create(plugin, input(token));
  await assert.rejects(runtime.start(plugin, { id: batch.id, revision: 2, directoryToken: grant.token }), /方案/);
  await rename(output, path.join(root, 'previous')); await symlink(path.join(root, 'previous'), output);
  await assert.rejects(start(runtime, batch, grant), /目录/); assert.equal(count, 0);
});

test('shutdown between persistence and request submission never initiates a new model call', async context => {
  let count = 0;
  const { runtime, token, grant } = await fixture(context, async () => { count++; return { bytes: png, mime: 'image/png' }; });
  const batch = await runtime.create(plugin, input(token));
  runtime.changed = (_owner, event) => { if (event.batch.items.some(item => item.state === 'running')) void runtime.shutdown(); };
  await runtime.start(plugin, { id: batch.id, revision: 1, directoryToken: grant.token }); await runtime.shutdown();
  assert.equal(count, 0); assert.equal(runtime.batches.get(batch.id).items[0].state, 'pending');
});

test('proxy address boundary, external connection and full model discovery', async context => {
  for (const address of ['http://localhost:1234', 'http://192.168.1.1', 'https://user:key@example.com', 'http://127.0.0.1:1/?key=x']) assert.throws(() => proxyAddress(address));
  assert.equal(proxyAddress('http://127.0.0.1:8317/v1'), 'http://127.0.0.1:8317');
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-'));
  const proxy = new ProxyRuntime({ root, credentials, request: async (_base, endpoint, options) => {
    assert.equal(endpoint, '/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    return Response.json({ data: [{ id: 'fixture-chat-model' }, { id: 'gpt-image-2.5', type: 'image_generation' }] });
  } });
  context.after(() => rm(root, { recursive: true, force: true })); await proxy.initialize();
  await proxy.configure({ address: 'http://127.0.0.1:8317', connected: false });
  await assert.rejects(proxy.connection(true), /连接/);
  await proxy.verify();
  assert.deepEqual(await proxy.connection(true), { base: 'http://127.0.0.1:8317', key: 'fixture-key' });
  assert.deepEqual(await proxy.models(), [
    { id: 'fixture-chat-model', title: 'fixture-chat-model', type: '' },
    { id: 'gpt-image-2.5', title: 'gpt-image-2.5', type: 'image_generation' },
  ]);
  assert.equal(proxy.status().ready, true);
  assert.equal(proxy.status().mode, 'external');
  for (const operation of ['accounts', 'login', 'loginStatus', 'provider', 'setBinary']) assert.equal(typeof proxy[operation], 'undefined');
});

test('model test checks the catalog and sends one bounded chat request', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-test-model-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const requests = []; let chatStatus = 200;
  const proxy = new ProxyRuntime({ root, credentials, request: async (_base, endpoint, options) => {
    if (endpoint === '/v1/models') return Response.json({ data: [{ id: 'fixture-chat-model' }, { id: 'gpt-image-2.5', type: 'image' }] });
    if (endpoint === '/v1/chat/completions') {
      requests.push(JSON.parse(options.body));
      if (chatStatus !== 200) return new Response('', { status: chatStatus });
      return Response.json({ choices: [{ message: { content: 'OK' } }] });
    }
    assert.fail('unexpected endpoint');
  } });
  await proxy.initialize();
  await proxy.configure({ address: 'http://127.0.0.1:8317', connected: true });

  const success = await proxy.testModel({ model: 'fixture-chat-model' });
  assert.equal(success.ok, true);
  assert.equal(success.model, 'fixture-chat-model');
  assert.equal(success.response, 'OK');
  assert.ok(success.latencyMs >= 1);
  assert.equal(requests[0].model, 'fixture-chat-model');
  assert.equal(requests[0].stream, false);
  assert.match(requests[0].messages[0].content, /OK/);

  assert.deepEqual(await proxy.testModel({ model: 'not-listed' }), { ok: false, code: 'model_unavailable', message: '这个模型不在当前服务的可用列表中。', model: 'not-listed' });
  assert.deepEqual(await proxy.testModel({ model: 'gpt-image-2.5' }), { ok: false, code: 'model_not_chat', message: '这个模型不能用于对话测试。', model: 'gpt-image-2.5' });
  chatStatus = 400;
  const incompatible = await proxy.testModel({ model: 'fixture-chat-model' });
  assert.equal(incompatible.code, 'model_incompatible');
  assert.doesNotMatch(incompatible.message, /\b400\b/);
});

test('legacy model settings migrate to a model-independent connection', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-legacy-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    schemaVersion: 1,
    mode: 'external',
    address: 'https://legacy.example.com/v1',
    model: 'legacy-chat-model',
    verified: ['legacy-chat-model'],
  }));
  const proxy = new ProxyRuntime({ root, credentials });
  await proxy.initialize();
  assert.deepEqual(proxy.status(), {
    schemaVersion: 2,
    mode: 'external',
    address: 'https://legacy.example.com',
    connected: true,
    running: true,
    ready: true,
    error: null,
  });
  assert.equal('model' in proxy.settings, false);
  assert.deepEqual(await proxy.connection(true), { base: 'https://legacy.example.com', key: 'fixture-key' });
});

test('one-click setup saves the connection without choosing or testing a model', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-setup-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let savedKey = ''; const requests = [];
  const credentials = {
    get: async () => savedKey,
    set: async (_plugin, _name, value) => { savedKey = value; },
    clear: async () => { savedKey = ''; },
  };
  const proxy = new ProxyRuntime({ root, credentials, request: async (base, endpoint, options) => {
    requests.push({ base, endpoint, options });
    if (endpoint === '/v1/models') return Response.json({ data: [
      { id: 'gpt-image-2.5', type: 'image_generation' },
      { id: 'embedding-3', type: 'embedding' },
      { id: 'rerank-v2', type: 'rerank' },
      { id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash' },
    ] });
    return assert.fail('setup must not send a model request');
  } });
  await proxy.initialize();
  const result = await proxy.setup({ address: 'https://api.deepseek.com/v1', apiKey: 'sk-new' });
  assert.equal(result.ok, true);
  assert.equal(result.status.address, 'https://api.deepseek.com');
  assert.equal(result.status.ready, true);
  assert.deepEqual(result.models.map(item => item.id), ['gpt-image-2.5', 'embedding-3', 'rerank-v2', 'deepseek-v4-flash']);
  assert.equal(savedKey, 'sk-new');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')), { schemaVersion: 2, mode: 'external', address: 'https://api.deepseek.com', connected: true });
  assert.equal(requests.filter(item => item.endpoint === '/v1/chat/completions').length, 0);
});

test('setup restores the previous key when settings cannot be saved', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-save-failure-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let savedKey = 'old-key';
  const credentials = { get: async () => savedKey, set: async (_plugin, _name, value) => { savedKey = value; }, clear: async () => { savedKey = ''; } };
  const proxy = new ProxyRuntime({ root, credentials, request: async (_base, endpoint) => {
    if (endpoint === '/v1/models') return Response.json({ data: [{ id: 'chat-model' }] });
    return assert.fail('setup must not send a model request');
  } });
  await proxy.initialize();
  await mkdir(path.join(root, 'settings.json'));
  const result = await proxy.setup({ address: 'https://save.example.com', apiKey: 'new-key' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'save_failed');
  assert.equal(result.message, '无法保存 AI 设置，请检查磁盘空间后重试。');
  assert.equal(savedKey, 'old-key');
  assert.equal(proxy.status().ready, false);
});

test('setup reuses a key only for the same address and maps actionable failures without exposing status codes', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-errors-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const calls = []; let savedKey = '';
  const credentials = { get: async () => savedKey, set: async (_plugin, _name, value) => { savedKey = value; calls.push('set'); }, clear: async () => { savedKey = ''; } };
  const proxy = new ProxyRuntime({ root, credentials, request: async (base, endpoint, options) => {
    calls.push(base + endpoint + ':' + options.headers.Authorization);
    if (endpoint === '/v1/models') return Response.json({ data: [{ id: 'chat-model' }] });
    return assert.fail('setup must not send a model request');
  } });
  await proxy.initialize();
  await proxy.configure({ address: 'https://reuse.example.com/v1', apiKey: 'stored-key' });
  const reused = await proxy.setup({ address: 'https://reuse.example.com', apiKey: '' });
  assert.equal(reused.ok, true);
  assert.ok(calls.some(call => call.includes('Bearer stored-key')));
  assert.equal(calls.filter(call => call === 'set').length, 1);

  const missing = await proxy.setup({ address: 'https://other.example.com', apiKey: '' });
  assert.equal(missing.code, 'missing_key');

  for (const [status, code] of [[401, 'invalid_key'], [403, 'forbidden'], [404, 'incompatible_address'], [429, 'rate_limited']]) {
    const failing = new ProxyRuntime({ root: path.join(root, String(status)), credentials, request: async () => new Response('', { status }) });
    await failing.initialize();
    const result = await failing.setup({ address: 'https://errors.example.com', apiKey: 'sk-test' });
    assert.equal(result.ok, false); assert.equal(result.code, code); assert.doesNotMatch(result.message, new RegExp(String(status)));
  }
  const timeout = new ProxyRuntime({ root: path.join(root, 'timeout'), credentials, request: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } });
  await timeout.initialize();
  assert.equal((await timeout.setup({ address: 'https://timeout.example.com', apiKey: 'sk-test' })).code, 'network_timeout');
});

test('setup keeps image and other catalog entries but rejects an empty catalog', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-models-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let savedKey = 'sk-test'; let catalog = [];
  const credentials = { get: async () => savedKey, set: async (_plugin, _name, value) => { savedKey = value; }, clear: async () => { savedKey = ''; } };
  const proxy = new ProxyRuntime({ root, credentials, request: async (_base, endpoint) => {
    assert.equal(endpoint, '/v1/models');
    return Response.json({ data: catalog });
  } });
  await proxy.initialize();
  const empty = await proxy.setup({ address: 'http://127.0.0.1:8317', apiKey: 'sk-test' });
  assert.equal(empty.code, 'no_models');
  catalog = [{ id: 'text-embedding-3-large', type: 'embedding' }, { id: 'gpt-image-2.5', type: 'image' }];
  const custom = await proxy.setup({ address: 'http://127.0.0.1:8317', apiKey: 'sk-test' });
  assert.equal(custom.ok, true);
  assert.deepEqual(custom.models.map(item => item.id), ['text-embedding-3-large', 'gpt-image-2.5']);
  assert.equal(custom.status.ready, true);
});

test('real Harness executes only planning tools, streams errors, rejects concurrent sends and resumes sessions', { timeout: 30000 }, async context => {
  const { root, runtime, token } = await fixture(context);
  const batch = await runtime.create(plugin, input(token, 2)); let round = 0, fail = false; const calls = [];
  const server = createServer(async (request, response) => {
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes); calls.push(body); round++;
    if (fail) { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = delta => response.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n');
    if (round === 1) {
      send({ tool_calls: [{ index: 0, id: 'plan-call', function: { name: 'prepare_plan', arguments: JSON.stringify({ id: batch.id, revision: 1, prompts: ['白底保留文字', '白底柔和阴影'] }) } }] });
      response.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
    } else {
      send({ content: '方案已准备，请确认后执行。' }); response.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); context.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const invoke = async (_service, method, args) => {
    if (method === 'connection') return { base: 'http://127.0.0.1:' + server.address().port, key: 'fixture' };
    if (method === 'models') return [{ id: 'fixture-tool-model' }];
    if (method === 'batch.revise') { assert.equal(args.owner, plugin.id); return runtime.revise(plugin, args); }
    if (method === 'batch.get') return runtime.snapshot(runtime.get(plugin, args.id));
    if (method === 'event') return;
    return [];
  };
  const home = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-harness-ai-')); let kernel = await bootCommerceKernel({ home, enableAI: true, installAnchor: path.resolve('package.json'), invoke });
  context.after(async () => { await kernel.dispose(); await rm(home, { recursive: true, force: true }); });
  const pending = kernel.assistant.send(plugin.id, { text: '两张统一白底', batchId: batch.id });
  await assert.rejects(kernel.assistant.send(plugin.id, { text: 'duplicate' }), /上一条/); await pending;
  await kernel.assistant.handles.get(plugin.id).agent.whenIdle();
  assert.equal(kernel.assistant.status(plugin.id).error, null);
  assert.equal(runtime.get(plugin, batch.id).revision, 2); assert.equal(runtime.get(plugin, batch.id).state, 'draft'); assert.equal(round, 2);
  assert.ok(calls[0].tools.every(tool => ['prepare_plan', 'get_batch'].includes(tool.function.name)));
  assert.ok(calls[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 'plan-call'));
  const id = kernel.assistant.status(plugin.id).id; await kernel.dispose();
  kernel = await bootCommerceKernel({ home, enableAI: true, installAnchor: path.resolve('package.json'), invoke });
  await kernel.assistant.send(plugin.id, { text: '继续这个方案' }); await kernel.assistant.handles.get(plugin.id).agent.whenIdle();
  assert.equal(kernel.assistant.status(plugin.id).id, id); assert.equal(kernel.assistant.status(plugin.id).error, null);
  assert.ok(calls.at(-1).messages.some(message => message.content?.includes('两张统一白底')));
  fail = true; await kernel.assistant.send(plugin.id, { text: 'fixture failure' }); await kernel.assistant.handles.get(plugin.id).agent.whenIdle();
  assert.match(kernel.assistant.status(plugin.id).error, /401/);
});
