import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BlockAssembler, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { ExternalProxyAdapter, readSse, wireMessages } from '../../desktop/ai-harness.mjs';
import { HOST_CHAT_PREFIX } from '../../desktop/ai-plugin-tools.mjs';
import { bootCommerceKernel } from '../../desktop/kernel.mjs';

const collect = async stream => { const result = []; for await (const value of stream) result.push(value); return result; };
const event = (delta = {}, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
const sse = events => events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n';
function responseFrom(bytes, fragmentSize = bytes.length) {
  return new Response(new ReadableStream({
    start(controller) { for (let offset = 0; offset < bytes.length; offset += fragmentSize) controller.enqueue(bytes.subarray(offset, offset + fragmentSize)); controller.close(); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function fixture(events, changes = {}, request) {
  const session = { owner: 'fixture-owner', id: 'fixture-session', history: [], partial: '' }, requests = [], notifications = [];
  const invoke = async (_service, method, args) => {
    if (method === 'connection') return { base: 'http://127.0.0.1:8317', key: 'fixture-key' };
    if (method === 'event') notifications.push(args);
    if (method === 'models') return [{ id: 'fixture-model' }];
  };
  const adapter = new ExternalProxyAdapter(invoke, new Map([[session.owner, session]]), async (base, endpoint, options) => {
    requests.push({ base, endpoint, ...options });
    return request ? request(options) : responseFrom(Buffer.from(sse(events)), 3);
  });
  const options = { sessionId: session.id, model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }], ...changes };
  return { adapter, options, session, requests, notifications, run: () => collect(adapter.stream(options)) };
}
const assembled = chunks => { const result = new BlockAssembler(); for (const chunk of chunks) result.push(chunk); return result; };

test('SSE frames fragmented UTF-8, BOM, CRLF, multiline data and final unterminated events', async () => {
  const first = event({ content: '你好 🐇' });
  const source = '\uFEFF: heartbeat\r\nevent: message\r\nid: 1\r\ndata: {\r\ndata: "choices": ' + JSON.stringify(first.choices) + '\r\ndata: }\r\n\r\n' +
    'data:' + JSON.stringify(event({}, 'stop'));
  assert.deepEqual(await collect(readSse(responseFrom(Buffer.from(source), 1))), [first, event({}, 'stop')]);
  assert.deepEqual(await collect(readSse(responseFrom(Buffer.from('data: {"x":1}\r\rdata: [DONE]\r\rdata: invalid'), 1))), [{ x: 1 }]);
});

test('SSE refuses malformed JSON, incomplete UTF-8 and responses beyond the byte limit', async () => {
  await assert.rejects(collect(readSse(responseFrom(Buffer.from('data: {secret-fixture}\n\n')))), error => error.code === 'PROXY_PROTOCOL' && !error.message.includes('secret-fixture'));
  await assert.rejects(collect(readSse(responseFrom(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe4, 0xbd])))), error => error.code === 'PROXY_PROTOCOL');
  await assert.rejects(collect(readSse(responseFrom(Buffer.alloc(8 * 1024 ** 2 + 1, 32)))), error => error.code === 'RESPONSE_TOO_LARGE');
});

test('adapter preserves official reasoning/text blocks, usage and request controls through public assembly', async () => {
  const usage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 20 } };
  const current = fixture([event({ reasoning_content: '先检查' }), event({ reasoning_content: '条件', content: '你好' }), event({ content: '。' }, 'stop'), { choices: [], usage }], { temperature: 0, maxTokens: 128, stop: ['STOP'], reasoningEffort: 'high' });
  const chunks = await current.run(), result = assembled(chunks), request = JSON.parse(current.requests[0].body);
  assert.deepEqual(result.blocks(), [{ type: 'reasoning', text: '先检查条件' }, { type: 'text', text: '你好。' }]);
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 30, totalTokens: 130, cacheReadTokens: 60, reasoningTokens: 20 });
  assert.deepEqual(result.finish, { kind: 'stop' });
  assert.equal(chunks.at(-2).type, 'usage'); assert.equal(chunks.at(-1).type, 'finish');
  assert.deepEqual(current.session.history, [{ role: 'assistant', text: '你好。' }]);
  assert.equal(current.session.partial, ''); assert.equal(current.notifications.length, 2);
  assert.deepEqual({ temperature: request.temperature, max_tokens: request.max_tokens, stop: request.stop, reasoning_effort: request.reasoning_effort }, { temperature: 0, max_tokens: 128, stop: ['STOP'], reasoning_effort: 'high' });
  assert.deepEqual(request.stream_options, { include_usage: true });
  for (const [name, value] of Object.entries(attributionHeaders())) assert.equal(current.requests[0].headers[name], value);
  assert.equal(current.requests[0].headers.Authorization, 'Bearer fixture-key');
});

test('adapter reports disjoint DeepSeek cache hits and does not invent malformed usage', async () => {
  for (const [raw, expected] of [
    [{ prompt_tokens: 20, completion_tokens: 5, prompt_cache_hit_tokens: 12 }, { inputTokens: 8, outputTokens: 5, totalTokens: 25, cacheReadTokens: 12 }],
    [{ prompt_tokens: 20, completion_tokens: 5, total_tokens: 99 }, { inputTokens: 20, outputTokens: 5 }],
    [{ prompt_tokens: 20, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 50 } }, { inputTokens: 20, outputTokens: 5, totalTokens: 25 }],
    [{ prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 21 } }, undefined],
    [{ prompt_tokens: 20, completion_tokens: -1 }, undefined],
    [{ completion_tokens: 5 }, undefined],
  ]) {
    const chunks = await fixture([event({ content: 'ok' }, 'stop'), { choices: [], usage: raw }]).run();
    assert.deepEqual(assembled(chunks).usage, expected);
  }
});

test('adapter assembles interleaved fragmented tool calls without fabricated IDs', async () => {
  const current = fixture([
    event({ tool_calls: [{ index: 1, function: { name: 'fi', arguments: '{"b":' } }, { index: 0, id: 'call-a', function: { name: 'first', arguments: '{"a":' } }] }),
    event({ content: '工具准备就绪。', tool_calls: [{ index: 1, id: 'call-b', function: { name: 'rst', arguments: '2}' } }, { index: 0, function: { arguments: '1}' } }] }),
    event({}, 'tool_calls'),
  ]);
  const chunks = await current.run(), result = assembled(chunks);
  assert.deepEqual(result.blocks(), [
    { type: 'tool-call', id: 'call-b', name: 'first', arguments: '{"b":2}' },
    { type: 'tool-call', id: 'call-a', name: 'first', arguments: '{"a":1}' },
    { type: 'text', text: '工具准备就绪。' },
  ]);
  assert.deepEqual(result.finish, { kind: 'tool-calls' });
  assert.ok(chunks.filter(chunk => chunk.type === 'tool-call-delta').every(chunk => typeof chunk.id === 'string' && chunk.id));
});

test('length finish prevents complete and truncated tools from entering the public Harness message', async () => {
  const current = fixture([
    event({ content: '回复达到上限', tool_calls: [{ index: 0, id: 'call-a', function: { name: 'list_plugins', arguments: '{}' } }, { index: 1, function: { name: 'call_plugin', arguments: '{' } }] }),
    event({}, 'length'),
  ]);
  const result = assembled(await current.run());
  assert.deepEqual(result.finish, { kind: 'max-tokens' });
  assert.deepEqual(result.blocks(), [{ type: 'text', text: '回复达到上限' }]);
  assert.match(current.session.error, /长度上限/);
});

test('assistant reasoning replay and tool correlation survive wire projection; unsupported attachments fail explicitly', () => {
  const projected = wireMessages({ system: '系统', messages: [
    { role: 'assistant', content: [{ type: 'reasoning', text: '分析' }, { type: 'text', text: '内容' }, { type: 'tool-call', id: 'call-a', name: 'echo', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call-a', content: [{ type: 'text', text: 'result' }] },
  ] });
  assert.deepEqual(projected, [{ role: 'system', content: '系统' }, { role: 'assistant', content: '内容', reasoning_content: '分析', tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'echo', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-a', content: 'result' }]);
  for (const type of ['image', 'file']) assert.throws(() => wireMessages({ messages: [{ role: 'user', content: [{ type, attachment: { attachmentId: 'fixture' } }] }] }), error => error.code === 'UNSUPPORTED_CONTENT');
});

test('malformed tools, filtered/unknown finish reasons and missing termination are errors, with one request only', async () => {
  for (const [events, code] of [
    [[event({ content: '部分回复' })], 'STREAM_CLOSED'],
    [[event({}, 'content_filter')], 'CONTENT_FILTER'],
    [[event({}, 'unknown')], 'PROXY_PROTOCOL'],
    [[event({}, 'stop')], 'EMPTY_RESPONSE'],
    [[event({}, 'tool_calls')], 'PROXY_PROTOCOL'],
    [[event({ tool_calls: [{ index: 0, function: { name: 'echo', arguments: '{}' } }] }, 'tool_calls')], 'PROXY_PROTOCOL'],
    [[event({ tool_calls: [{ index: 0, id: 'call-a', function: { name: 'echo', arguments: '{' } }] }, 'tool_calls')], 'PROXY_PROTOCOL'],
    [[event({ content: 'done' }, 'stop'), event({ content: 'late' })], 'PROXY_PROTOCOL'],
  ]) {
    const current = fixture(events), chunks = await current.run();
    assert.equal(chunks.at(-1).reason.kind, 'error'); assert.equal(chunks.at(-1).reason.failure.code, code);
    assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1); assert.equal(current.requests.length, 1);
    assert.equal(current.session.partial, '');
  }
});

test('HTTP and in-band failures retain safe status facts without exposing upstream error content', async () => {
  const http = fixture([], {}, () => new Response('fixture-secret-upstream-error', { status: 429 }));
  const finish = (await http.run()).at(-1);
  assert.equal(finish.reason.failure.status, 429); assert.equal(finish.reason.failure.code, 'PROXY_HTTP_ERROR');
  assert.ok(!finish.reason.failure.message.includes('fixture-secret'));
  const inBand = fixture([{ error: { message: 'fixture-secret-upstream-error' } }]);
  assert.equal((await inBand.run()).at(-1).reason.failure.message, '助手模型返回错误。');
});

test('cancellation stops before dispatch or during reading and preserves visible partial text', async () => {
  const before = fixture([], { signal: AbortSignal.abort() });
  assert.equal((await before.run()).at(-1).reason.kind, 'aborted'); assert.equal(before.requests.length, 0);
  const controller = new AbortController(); let bodyCanceled = false;
  const during = fixture([], { signal: controller.signal }, options => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(Buffer.from('data: ' + JSON.stringify(event({ content: '部分内容' })) + '\n\n'));
      options.signal.addEventListener('abort', () => { bodyCanceled = true; stream.error(options.signal.reason); }, { once: true });
    },
  })));
  const chunks = [];
  for await (const chunk of during.adapter.stream(during.options)) { chunks.push(chunk); if (chunk.type === 'text-delta') controller.abort(); }
  assert.equal(chunks.at(-1).reason.kind, 'aborted'); assert.equal(chunks.at(-1).reason.failure.code, 'ABORTED');
  assert.deepEqual(during.session.history, [{ role: 'assistant', text: '部分内容' }]); assert.equal(during.session.partial, '');
  assert.ok(bodyCanceled); assert.equal(during.requests.length, 1);
});

test('real Harness persists reasoning and usage, resumes them, and never dispatches length-truncated tools', async context => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-harness-adapter-')), requests = [], recorded = []; let executions = 0;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes; requests.push(JSON.parse(body));
    const events = requests.length === 1 ? [event({ content: '需要继续', tool_calls: [{ index: 0, id: 'length-call', function: { name: 'list_plugins', arguments: '{}' } }] }, 'length')] : [
      event({ reasoning_content: '检查插件权限' }), event({ content: '已检查' }, 'stop'),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } } },
    ];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(sse(events));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const invoke = async (_service, method) => {
    if (method === 'connection') return { base: 'http://127.0.0.1:' + server.address().port, key: 'fixture-key', model: 'fixture-model' };
    if (method === 'tools.list') { executions++; return { plugins: [] }; }
    if (method === 'event') return;
    return [];
  };
  let kernel = await bootCommerceKernel({ home, enableAI: true, installAnchor: path.resolve('package.json'), invoke });
  context.after(async () => { await kernel.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  kernel.ctx.on('session/event', (_session, value) => recorded.push(value));
  const chat = await kernel.assistant.createChat(), owner = HOST_CHAT_PREFIX + chat.id;
  await kernel.assistant.send(owner, { text: '长度测试' }); await kernel.assistant.handles.get(owner).agent.whenIdle();
  assert.equal(executions, 0); assert.equal(requests.length, 1); assert.match(kernel.assistant.status(owner).error, /长度上限/);
  await kernel.assistant.send(owner, { text: '继续对话' }); await kernel.assistant.handles.get(owner).agent.whenIdle();
  const message = recorded.filter(value => value.type === 'assistant/message').at(-1);
  assert.deepEqual(message.data.message.content, [{ type: 'reasoning', text: '检查插件权限' }, { type: 'text', text: '已检查' }]);
  assert.deepEqual(message.data.usage, { inputTokens: 7, outputTokens: 4, totalTokens: 14, cacheReadTokens: 3, reasoningTokens: 2 });
  await kernel.dispose(); kernel = await bootCommerceKernel({ home, enableAI: true, installAnchor: path.resolve('package.json'), invoke });
  await kernel.assistant.send(owner, { text: '恢复后继续' }); await kernel.assistant.handles.get(owner).agent.whenIdle();
  assert.ok(requests.at(-1).messages.some(value => value.role === 'assistant' && value.reasoning_content === '检查插件权限' && value.content === '已检查'));
  assert.equal(executions, 0); assert.equal(requests.length, 3);
});
