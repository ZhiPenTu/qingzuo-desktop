import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { PluginApprovals, pluginToolCatalog, HOST_CHAT_PREFIX } from '../../desktop/ai-plugin-tools.mjs';
import { validateManifest } from '../../packages/plugin-sdk/manifest.mjs';
import { bootCommerceKernel } from '../../desktop/kernel.mjs';

const fixturePlugin = { id: 'local.echo', title: '回声工具', description: '测试', enabled: true, missing: [], version: '1.0.0', backend: { type: 'node', entry: { 'darwin-arm64': 'backend.mjs' } }, permissions: {}, services: { provides: ['local.echo'] }, assistant: { tools: [{ name: 'echo', title: '运行回声', description: '返回给定文本', service: 'local.echo', method: 'echo', parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 100 } }, required: ['text'], additionalProperties: false } }] } };
const waitUntil = async condition => { for (let count = 0; count < 200; count++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('fixture timeout'); };
test('manifest validates explicit bounded tools and prohibits credentials, paths and undeclared services', () => {
  const pkg = { version: '1.0.0', commerce: { ...fixturePlugin, manifestVersion: 1, api: '^1.2.0', ui: 'index.html' } };
  assert.equal(validateManifest(pkg, 'darwin-arm64').assistant.tools[0].name, 'echo');
  for (const change of [{ service: 'system.credentials' }, { name: 'start_batch' }, { method: '../escape' }, { parameters: { type: 'object', properties: { apiKey: { type: 'string' } }, additionalProperties: false } }, { parameters: { type: 'object', properties: {}, additionalProperties: true } }]) {
    assert.throws(() => validateManifest({ ...pkg, commerce: { ...pkg.commerce, assistant: { tools: [{ ...fixturePlugin.assistant.tools[0], ...change }] } } }, 'darwin-arm64'));
  }
});
test('approvals freeze arguments, enforce identity, reject duplicates and recheck plugin version', async () => {
  let plugins = [structuredClone(fixturePlugin)], executions = 0;
  const approvals = new PluginApprovals({ plugins: async () => plugins, execute: async (_plugin, _tool, args) => { executions++; return args; }, changed: () => {} });
  const owner = HOST_CHAT_PREFIX + randomUUID(), other = HOST_CHAT_PREFIX + randomUUID();
  const args = { text: 'original' }; const result = approvals.request(owner, { pluginId: fixturePlugin.id, tool: 'echo', args }); await waitUntil(() => approvals.list(owner).length);
  args.text = 'mutated'; const id = approvals.list(owner)[0].id;
  assert.equal(executions, 0); assert.throws(() => approvals.respond(other, id, true), /未授权/);
  approvals.respond(owner, id, true); assert.throws(() => approvals.respond(owner, id, true), /失效/);
  assert.deepEqual(await result, { text: 'original' }); assert.equal(executions, 1);
  const changed = approvals.request(owner, { pluginId: fixturePlugin.id, tool: 'echo', args: { text: 'hello' } }); await waitUntil(() => approvals.list(owner).length); plugins[0].version = '1.1.0'; approvals.respond(owner, approvals.list(owner)[0].id, true); await assert.rejects(changed, /改变/);
  const rejected = approvals.request(owner, { pluginId: fixturePlugin.id, tool: 'echo', args: { text: 'hello' } }); await waitUntil(() => approvals.list(owner).length); approvals.respond(owner, approvals.list(owner)[0].id, false); await assert.rejects(rejected, /拒绝/);
  assert.equal(executions, 1); approvals.dispose();
});
test('disabled plugins, arbitrary services, extra arguments, cancellation and pending ownership fail closed', async () => {
  const owner = HOST_CHAT_PREFIX + randomUUID();
  const approvals = new PluginApprovals({ plugins: async () => [fixturePlugin], execute: async () => assert.fail('not approved'), changed: () => {} });
  for (const request of [{ pluginId: 'local.foreign', tool: 'echo', args: {} }, { pluginId: fixturePlugin.id, tool: 'credentials.get', args: {} }, { pluginId: fixturePlugin.id, tool: 'echo', args: { text: 'hello', path: '/etc' } }]) await assert.rejects(approvals.request(owner, request));
  await assert.rejects(approvals.request('local.echo', { pluginId: fixturePlugin.id, tool: 'open' }), /未授权/);
  assert.deepEqual(pluginToolCatalog([{ ...fixturePlugin, enabled: false }]), []);
  const pending = approvals.request(owner, { pluginId: fixturePlugin.id, tool: 'open' }); await waitUntil(() => approvals.list(owner).length); assert.equal(approvals.list(HOST_CHAT_PREFIX + randomUUID()).length, 0); approvals.cancelPlugin(fixturePlugin.id); await assert.rejects(pending, /停用/);
  const stopped = approvals.request(owner, { pluginId: fixturePlugin.id, tool: 'open' }); approvals.cancelOwner(owner); await assert.rejects(stopped, /停止/); approvals.dispose();
});
test('public Harness host chat calls declared plugins only after confirmation and restores conversations', async context => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-host-chat-')); let round = 0, executions = 0; const requests = [];
  const server = createServer(async (request, response) => {
    let input = ''; for await (const bytes of request) input += bytes; requests.push(JSON.parse(input)); round++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const call = round === 1 ? { name: 'list_plugins', arguments: '{}' } : round === 2 ? { name: 'call_plugin', arguments: JSON.stringify({ pluginId: fixturePlugin.id, tool: 'echo', args: { text: 'hello' } }) } : null;
    response.write('data: ' + JSON.stringify({ choices: [{ delta: call ? { tool_calls: [{ index: 0, id: 'call-' + round, function: call }] } : { content: '插件已返回 hello。' }, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const approvals = new PluginApprovals({ plugins: async () => [fixturePlugin], execute: async () => { executions++; return { text: 'hello' }; }, changed: () => {} });
  const invoke = async (_service, method, args) => {
    if (method === 'connection') return { base: 'http://127.0.0.1:' + server.address().port, key: 'fixture' };
    if (method === 'models') return [{ id: 'fixture-tool-model' }, { id: 'fixture-backup-model' }, { id: 'gpt-image-2.5', type: 'image' }];
    if (method === 'tools.list') return { plugins: pluginToolCatalog([fixturePlugin]) };
    if (method === 'tools.call') return approvals.request(args.owner, args);
    if (method === 'event') return;
    return [];
  };
  let kernel = await bootCommerceKernel({ home, enableAI: true, installAnchor: path.resolve('package.json'), invoke });
  context.after(async () => { approvals.dispose(); await kernel.dispose(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const chat = await kernel.call('ai', null, 'chat.create'); const owner = HOST_CHAT_PREFIX + chat.id;
  await assert.rejects(kernel.call('ai', null, 'chat.status', { id: chat.id }, fixturePlugin.id), /不能访问/);
  await kernel.call('ai', null, 'chat.send', { id: chat.id, text: '请调用回声插件' });
  await waitUntil(() => approvals.list(owner).length); assert.equal(executions, 0);
  await assert.rejects(kernel.assistant.send(owner, { text: 'duplicate' }), /上一条/);
  approvals.respond(owner, approvals.list(owner)[0].id, true); await kernel.assistant.handles.get(owner).agent.whenIdle();
  await waitUntil(() => kernel.assistant.status(owner).state === 'idle'); assert.equal(executions, 1);
  assert.ok(requests[0].tools.every(tool => ['list_plugins', 'call_plugin'].includes(tool.function.name)));
  assert.equal(requests[0].model, 'fixture-tool-model');
  assert.ok(kernel.assistant.status(owner).history.some(entry => entry.role === 'tool' && entry.state === 'succeeded'));
  await assert.rejects(kernel.assistant.createChat('gpt-image-2.5'), /可用列表/);
  const second = await kernel.assistant.createChat('fixture-backup-model'); assert.equal(second.model, 'fixture-backup-model'); assert.equal(kernel.assistant.status(HOST_CHAT_PREFIX + second.id).history.length, 0);
  await kernel.dispose(); kernel = await bootCommerceKernel({ home, enableAI: true, installAnchor: path.resolve('package.json'), invoke });
  assert.equal(kernel.assistant.listChats().length, 2);
  await kernel.assistant.send(owner, { text: '继续', model: 'fixture-backup-model' }); await kernel.assistant.handles.get(owner).agent.whenIdle();
  assert.ok(requests.at(-1).messages.some(message => message.content?.includes('请调用回声插件'))); assert.equal(executions, 1);
  assert.equal(requests.at(-1).model, 'fixture-backup-model');
});
