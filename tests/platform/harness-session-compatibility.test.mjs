import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { bootCommerceKernel } from '../../desktop/kernel.mjs';
import { HOST_CHAT_PREFIX, PluginApprovals } from '../../desktop/ai-plugin-tools.mjs';

// Frozen output of the pinned 0.2.1-alpha.1 public API, generated with synthetic
// text, a local SSE server and no user profile/environment/credentials. Never
// regenerate this fixture during a candidate upgrade: it is the old format gate.
const fixture = new URL('../fixtures/harness/0.2.1-alpha.1/', import.meta.url);
const log = new URL('ai-session-logs/_no-cwd/0ddd50ca-4027-41f5-8fd8-fc98516a4b03/session.v4.jsonl', fixture);
const waitUntil = async condition => {
  for (let index = 0; index < 300; index++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Harness fixture condition timed out.');
};

test('frozen alpha.1 JSONL restores prior messages and completed tools without replay, then cancels a new stream', async context => {
  const original = await readFile(log), digest = createHash('sha256').update(original).digest('hex');
  const home = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-harness-compat-'));
  await cp(fixture, home, { recursive: true });
  const record = JSON.parse(await readFile(path.join(home, 'ai/sessions.json'), 'utf8')).sessions[0];
  const requests = []; let hold = false, calls = 0;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const bytes of request) text += bytes;
    requests.push(JSON.parse(text)); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: hold ? 'cancel fixture delta' : 'continued from old JSONL' }, finish_reason: null }] }) + '\n\n');
    if (!hold) response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let kernel;
  context.after(async () => { await kernel?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const invoke = async (_service, method) => {
    if (method === 'connection') return { base: 'http://127.0.0.1:' + server.address().port, key: 'fixture', model: 'fixture-harness' };
    if (method === 'tools.call') { calls++; assert.fail('Completed tools must not replay while restoring old JSONL.'); }
    if (method === 'event') return;
    return [];
  };
  kernel = await bootCommerceKernel({ home, enableAI: true, installAnchor: path.resolve('package.json'), invoke });
  const owner = HOST_CHAT_PREFIX + record.id;
  await kernel.assistant.send(owner, { text: 'continue fixture' });
  await kernel.assistant.handles.get(owner).agent.whenIdle(); await waitUntil(() => kernel.assistant.status(owner).state === 'idle');
  assert.ok(requests[0].messages.some(message => message.role === 'user' && message.content?.includes('fixture original user request')));
  assert.ok(requests[0].messages.some(message => message.role === 'tool' && message.tool_call_id === 'old-call-2' && message.content.includes('old JSONL echo')));
  assert.equal(calls, 0);
  assert.ok(kernel.assistant.status(owner).history.some(message => message.text === 'continued from old JSONL'));
  hold = true;
  await kernel.assistant.send(owner, { text: 'cancel fixture' });
  await waitUntil(() => kernel.assistant.status(owner).partial === 'cancel fixture delta');
  await kernel.assistant.cancel(owner); await waitUntil(() => kernel.assistant.status(owner).state === 'idle');
  assert.match(kernel.assistant.status(owner).error ?? '', /停止/);
  assert.equal(requests.length, 2); assert.equal(calls, 0);
  assert.equal(createHash('sha256').update(await readFile(log)).digest('hex'), digest, 'Tests must mutate only a private copy of the old fixture.');
});

test('old index interruption clears prior authorization; a new tool still requires confirmation and can be rejected', async context => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-harness-interrupted-')); await cp(fixture, home, { recursive: true });
  const index = JSON.parse(await readFile(path.join(home, 'ai/sessions.json'), 'utf8')), record = index.sessions[0];
  record.state = 'running'; record.history.push({ role: 'tool', tool: 'call_plugin', state: 'running', text: '' });
  await writeFile(path.join(home, 'ai/sessions.json'), JSON.stringify(index));
  let round = 0, executions = 0;
  const server = createServer(async (request, response) => {
    for await (const _bytes of request) {} round++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const call = { name: 'call_plugin', arguments: JSON.stringify({ pluginId: 'local.echo', tool: 'echo', args: { text: 'new request' } }) };
    response.write('data: ' + JSON.stringify({ choices: [{ delta: round === 1 ? { tool_calls: [{ index: 0, id: 'new-call', function: call }] } : { content: 'rejection acknowledged' }, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: round === 1 ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const plugin = { id: 'local.echo', title: 'Fixture', enabled: true, missing: [], version: '1.0.0', assistant: { tools: [{ name: 'echo', title: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] } };
  const approvals = new PluginApprovals({ plugins: async () => [plugin], execute: async () => { executions++; return { text: 'new request' }; }, changed: () => {} });
  let kernel;
  context.after(async () => { approvals.dispose(); await kernel?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const invoke = async (_service, method, args) => {
    if (method === 'connection') return { base: 'http://127.0.0.1:' + server.address().port, key: 'fixture', model: 'fixture-harness' };
    if (method === 'tools.call') return approvals.request(args.owner, args);
    if (method === 'event') return;
    return [];
  };
  kernel = await bootCommerceKernel({ home, enableAI: true, installAnchor: path.resolve('package.json'), invoke });
  const owner = HOST_CHAT_PREFIX + record.id, restored = kernel.assistant.status(owner);
  assert.equal(restored.state, 'idle'); assert.match(restored.error, /中断/);
  assert.equal(restored.history.at(-1).state, 'interrupted'); assert.deepEqual(approvals.list(owner), []); assert.equal(executions, 0);
  await kernel.assistant.send(owner, { text: 'request a new tool' }); await waitUntil(() => approvals.list(owner).length === 1);
  assert.equal(executions, 0); approvals.respond(owner, approvals.list(owner)[0].id, false);
  await kernel.assistant.handles.get(owner).agent.whenIdle(); await waitUntil(() => kernel.assistant.status(owner).state === 'idle');
  assert.equal(executions, 0); assert.equal(round, 2);
  assert.ok(kernel.assistant.status(owner).history.some(message => message.role === 'tool' && message.state === 'failed' && /拒绝/.test(message.text)));
});
