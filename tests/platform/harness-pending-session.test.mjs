import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { bootCommerceKernel } from '../../desktop/kernel.mjs';
import { HOST_CHAT_PREFIX, PluginApprovals } from '../../desktop/ai-plugin-tools.mjs';

const fixture = new URL('../fixtures/harness/0.2.1-alpha.1-pending/', import.meta.url);
const waitUntil = async condition => {
  for (let index = 0; index < 300; index++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Pending Harness fixture condition timed out.');
};

test('frozen alpha.1 pending engine call is interrupted without replay; new plugin calls require fresh approval', { timeout: 30000 }, async context => {
  const originalIndex = await readFile(new URL('ai/sessions.json', fixture)), record = JSON.parse(originalIndex).sessions[0];
  const originalLog = await readFile(new URL('ai-session-logs/_no-cwd/' + record.id + '/session.v4.jsonl', fixture));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const events = originalLog.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].version, 4); assert.equal(JSON.parse(originalIndex).harness, '0.2.1-alpha.1');
  assert.equal(record.state, 'running'); assert.equal(record.history.at(-1).state, 'running');
  assert.equal(events.at(-1).type, 'tool/call'); assert.equal(events.at(-1).data.callId, 'old-pending-call');
  assert.ok(!events.some(event => event.type === 'tool/result' || event.type === 'turn/end'), 'The old fixture must represent a genuinely open engine call.');

  const home = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-harness-pending-')); await cp(fixture, home, { recursive: true });
  const requests = [], attempts = [], executions = [];
  const plugin = { id: 'local.echo', title: 'Fixture Echo', enabled: true, missing: [], version: '1.0.0', assistant: { tools: [{ name: 'echo', title: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] } };
  const approvals = new PluginApprovals({ plugins: async () => [plugin], execute: async (_plugin, _tool, args) => { executions.push(args); return { text: args.text }; }, changed: () => {} });
  const server = createServer(async (request, response) => {
    let input = ''; for await (const bytes of request) input += bytes; requests.push(JSON.parse(input));
    const call = requests.length === 1 ? { name: 'call_plugin', arguments: JSON.stringify({ pluginId: 'local.echo', tool: 'echo', args: { text: 'fresh approved echo' } }) } : null;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ delta: call ? { tool_calls: [{ index: 0, id: 'new-confirmed-call', function: call }] } : { content: 'fresh approval completed' }, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let kernel;
  context.after(async () => {
    approvals.dispose(); await kernel?.dispose(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true });
  });
  const invoke = async (_service, method, args) => {
    if (method === 'connection') return { base: 'http://127.0.0.1:' + server.address().port, key: 'synthetic-fixture-key', model: 'fixture-harness' };
    if (method === 'tools.call') { attempts.push(args); return approvals.request(args.owner, args); }
    if (method === 'event') return;
    return [];
  };
  kernel = await bootCommerceKernel({ home, enableAI: true, installAnchor: path.resolve('package.json'), invoke });
  const owner = HOST_CHAT_PREFIX + record.id, status = kernel.assistant.status(owner);
  assert.equal(status.state, 'idle'); assert.match(status.error, /中断/); assert.equal(status.history.at(-1).state, 'interrupted');

  // Resume the actual open JSONL before supplying any new user message.
  // Checking only initialize() would leave the engine recovery path untested.
  const handle = await kernel.assistant.handle(owner); await handle.agent.whenIdle();
  assert.deepEqual(approvals.list(owner), []); assert.deepEqual(attempts, []); assert.deepEqual(executions, []); assert.deepEqual(requests, []);

  await kernel.assistant.send(owner, { text: 'request a freshly approved echo' }); await waitUntil(() => approvals.list(owner).length === 1);
  assert.equal(attempts.length, 1); assert.equal(attempts[0].args.text, 'fresh approved echo'); assert.equal(requests.length, 1);
  assert.deepEqual(executions, []);
  const pending = approvals.list(owner)[0]; assert.deepEqual(pending.args, { text: 'fresh approved echo' });
  assert.throws(() => approvals.respond(HOST_CHAT_PREFIX + randomUUID(), pending.id, true), /未授权/);
  approvals.respond(owner, pending.id, true); assert.throws(() => approvals.respond(owner, pending.id, true), /失效/);
  await handle.agent.whenIdle(); await waitUntil(() => kernel.assistant.status(owner).state === 'idle');
  assert.deepEqual(executions, [{ text: 'fresh approved echo' }]); assert.equal(attempts.length, 1); assert.equal(requests.length, 2);
  assert.ok(requests[0].messages.some(message => message.role === 'user' && message.content.includes('fixture user awaits old plugin approval')));
  assert.ok(requests.at(-1).messages.some(message => message.role === 'tool' && message.tool_call_id === 'new-confirmed-call' && message.content.includes('fresh approved echo')));
  assert.ok(kernel.assistant.status(owner).history.some(message => message.text === 'fresh approval completed'));

  assert.equal(digest(await readFile(new URL('ai/sessions.json', fixture))), digest(originalIndex));
  assert.equal(digest(await readFile(new URL('ai-session-logs/_no-cwd/' + record.id + '/session.v4.jsonl', fixture))), digest(originalLog), 'Restore must mutate only the temporary copy.');
});
