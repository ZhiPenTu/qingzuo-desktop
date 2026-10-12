import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { ImageEditor, imageOptions } from '../../desktop/ai-images.mjs';
import { BatchRuntime } from '../../desktop/ai-batches.mjs';
import { FileBroker } from '../../desktop/brokers.mjs';
import { ProxyRuntime, proxyAddress } from '../../desktop/ai-proxy.mjs';
import { bootCommerceKernel } from '../../desktop/kernel.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAdkAAAAASUVORK5CYII=', 'base64');
const plugin = { id: 'official.ai-image', title: 'AI 批图', permissions: { files: true, ai: ['image-edit', 'assistant'], network: ['https://api.openai.com', 'https://generativelanguage.googleapis.com'], credentials: ['google-image', 'openai-image'] } };
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

test('official image adapters send one original, exact models, isolated keys and parse image bytes', async () => {
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
  assert.deepEqual(secrets, [[plugin.id, 'google-image'], [plugin.id, 'openai-image']]);
  assert.throws(() => imageOptions('unknown'), /无效/); assert.throws(() => imageOptions('gemini-nano-banana-2.1', { quality: 'low' }), /不支持/);
  assert.equal(imageOptions('gpt-image-2.5-sunburst', { size: '2560x1440', quality: 'max' }).parameters.quality, 'max');
  await assert.rejects(editor.edit({ ...plugin, permissions: { ...plugin.permissions, network: [] } }, { modelId: 'gpt-image-2.5-sunburst' }), /未授权/);
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

test('proxy address boundary and external tool verification', async context => {
  for (const address of ['http://localhost:1234', 'http://192.168.1.1', 'https://user:key@example.com', 'http://127.0.0.1:1/?key=x']) assert.throws(() => proxyAddress(address));
  assert.equal(proxyAddress('http://127.0.0.1:8317/v1'), 'http://127.0.0.1:8317');
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-')), requests = [];
  const proxy = new ProxyRuntime({ root, credentials, request: async (_base, endpoint, options) => {
    requests.push({ endpoint, options });
    if (endpoint === '/v1/models') return Response.json({ data: [{ id: 'fixture-tool-model', display_name: 'Fixture' }] });
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'connection_check', arguments: '{"ok":true}' } }] } }] });
  } });
  context.after(() => rm(root, { recursive: true, force: true })); await proxy.initialize();
  await proxy.configure({ mode: 'external', address: 'http://127.0.0.1:8317', model: 'fixture' });
  await assert.rejects(proxy.connection(true), /验证/); await proxy.verify(); assert.equal((await proxy.connection(true)).model, 'fixture');
  assert.deepEqual(await proxy.models(), [{ id: 'fixture-tool-model' }]);
  assert.equal(proxy.status().mode, 'external');
  for (const operation of ['accounts', 'login', 'loginStatus', 'provider', 'setBinary']) assert.equal(typeof proxy[operation], 'undefined');
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
    if (method === 'connection') return { base: 'http://127.0.0.1:' + server.address().port, key: 'fixture', model: 'fixture-tool-model' };
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
