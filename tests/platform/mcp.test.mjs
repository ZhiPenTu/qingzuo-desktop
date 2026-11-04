import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { McpRuntime } from '../../desktop/mcp.mjs';

const plugin = { id: 'official.wechat-studio', title: '公众号 AI 工作台', api: '^1.11.0', permissions: { mcp: ['read'] } };

function credentials() {
  const values = new Map();
  return {
    async get(namespace, name) { return values.get(namespace + ':' + name) ?? null; },
    async set(namespace, name, value) { values.set(namespace + ':' + name, value); },
    async clear(namespace, name) { values.delete(namespace + ':' + name); },
  };
}

test('MCP exposes tools and grants read-only or side-effecting tools per plugin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcpimg-'));
  const calls = [];
  const fakeClient = {
    async connect() {},
    async listTools() {
      return { tools: [
        { name: 'search', title: '搜索', description: '查找资料', annotations: { readOnlyHint: true } },
        { name: 'write', title: '写入', description: '修改资料', annotations: { readOnlyHint: false } },
        { name: 'untyped', title: '未声明' },
      ] };
    },
    async callTool(params) { calls.push(params); return { content: [{ type: 'text', text: 'ok' }] }; },
    async close() {},
  };
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({ ...fakeClient }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const server = await runtime.create({ name: '资料服务', url: 'https://example.com/mcp', authMode: 'none' });
    const tools = await runtime.pluginTools(plugin, { serverId: server.id });
    assert.deepEqual(tools.map(tool => tool.name), ['search', 'write', 'untyped']);
    await runtime.grant(plugin, { serverId: server.id, toolNames: ['write'] });
    const written = await runtime.call(plugin, { serverId: server.id, toolName: 'write', args: { text: '更新' } });
    assert.equal(written.content[0].text, 'ok');
    await runtime.grant(plugin, { serverId: server.id, toolNames: ['search'] });
    const result = await runtime.call(plugin, { serverId: server.id, toolName: 'search', args: { query: '轻作' } });
    assert.equal(result.content[0].text, 'ok');
    assert.deepEqual(calls[0].arguments, { text: '更新' });
    assert.deepEqual(calls[1].arguments, { query: '轻作' });
    assert.equal((await runtime.adminGrants(server.id)).length, 1);
    await runtime.revoke(plugin, { serverId: server.id });
    await assert.rejects(runtime.call(plugin, { serverId: server.id, toolName: 'search' }), /尚未授权/);
    const local = await runtime.create({ name: '本机', url: 'http://127.0.0.1:3000/mcp' });
    assert.equal(local.url, 'http://127.0.0.1:3000/mcp');
    assert.equal((await runtime.create({ name: '本机域名', url: 'http://localhost:3001/mcp' })).url, 'http://localhost:3001/mcp');
    await assert.rejects(runtime.create({ name: '公网 HTTP', url: 'http://example.com/mcp' }), /HTTPS/);
    await assert.rejects(runtime.create({ name: '私网', url: 'http://192.168.1.2/mcp' }), /HTTPS/);
    const credentialUrl = 'http://user:' + ['sec', 'ret'].join('') + '@127.0.0.1/mcp';
    await assert.rejects(runtime.create({ name: '带凭据', url: credentialUrl }), /无效/);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP preserves read-only tool visibility for plugins on older API ranges', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcpimg-'));
  const calls = [];
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() {
        return { tools: [
          { name: 'search', annotations: { readOnlyHint: true } },
          { name: 'write', annotations: { readOnlyHint: false } },
          { name: 'untyped' },
        ] };
      },
      async callTool(params) { calls.push(params); return { content: [] }; },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  const oldPlugin = { ...plugin, api: '^1.10.0' };
  try {
    await runtime.initialize();
    const server = await runtime.create({ name: '旧插件服务', url: 'https://example.com/mcp' });
    const tools = await runtime.pluginTools(oldPlugin, { serverId: server.id });
    assert.deepEqual(tools.map(tool => tool.name), ['search']);
    await assert.rejects(
      runtime.grant(oldPlugin, { serverId: server.id, toolNames: ['write'] }),
      /只能授权只读/,
    );
    await runtime.grant(oldPlugin, { serverId: server.id, toolNames: ['search'] });
    await runtime.call(oldPlugin, { serverId: server.id, toolName: 'search' });
    assert.equal(calls.length, 1);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP inlines image links only when the plugin asks for images', async t => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYQ5WQAAAABJRU5ErkJggg==', 'base64');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) });
    response.end(png);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/image.png';
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-mcp-'));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: [{ name: 'generate', annotations: { readOnlyHint: false } }] }; },
      async callTool() { return { content: [{ type: 'text', text: 'saved: ' + url }] }; },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const service = await runtime.create({ name: '生图', url: 'http://127.0.0.1:3000/mcp' });
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    const plain = await runtime.call(plugin, { serverId: service.id, toolName: 'generate' });
    assert.equal(plain.content.length, 1);
    const inlined = await runtime.call(plugin, { serverId: service.id, toolName: 'generate', inlineImages: true });
    assert.equal(inlined.content.length, 2);
    assert.equal(inlined.content[1].type, 'image');
    assert.equal(inlined.content[1].mimeType, 'image/png');
    assert.equal(Buffer.from(inlined.content[1].data, 'base64').equals(png), true);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP remote services cannot inline loopback image links', async t => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYQ5WQAAAABJRU5ErkJggg==', 'base64');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) });
    response.end(png);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/image.png';
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcpssrf-'));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: [{ name: 'generate', annotations: { readOnlyHint: false } }] }; },
      async callTool() { return { content: [{ type: 'text', text: 'image: ' + url }] }; },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const service = await runtime.create({ name: '远程生图', url: 'https://example.com/mcp' });
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    const result = await runtime.call(plugin, { serverId: service.id, toolName: 'generate', inlineImages: true });
    assert.equal(result.content.some(item => item.type === 'image'), false);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP inline image limits also apply to already embedded images', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcpinline-'));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: [{ name: 'generate', annotations: { readOnlyHint: false } }] }; },
      async callTool() {
        return {
          content: Array.from({ length: 5 }, () => ({
            type: 'image',
            data: Buffer.from('x').toString('base64'),
            mimeType: 'image/png',
          })),
        };
      },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const service = await runtime.create({ name: '生图', url: 'https://example.com/mcp' });
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    await assert.rejects(
      runtime.call(plugin, { serverId: service.id, toolName: 'generate', inlineImages: true }),
      /响应过大/,
    );
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP re-authorizes when a granted tool becomes side-effecting', async () => {
  let readOnly = true;
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcpdrift-'));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: [{ name: 'generate', annotations: { readOnlyHint: readOnly } }] }; },
      async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const service = await runtime.create({ name: '生图', url: 'https://example.com/mcp' });
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    assert.equal((await runtime.call(plugin, { serverId: service.id, toolName: 'generate' })).content[0].text, 'ok');
    readOnly = false;
    await assert.rejects(runtime.call(plugin, { serverId: service.id, toolName: 'generate' }), /重新授权/);
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    assert.equal((await runtime.call(plugin, { serverId: service.id, toolName: 'generate' })).content[0].text, 'ok');
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP rejects a grant when the service changes during confirmation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcpprompt-'));
  let service;
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: [{ name: 'generate', annotations: { readOnlyHint: false } }] }; },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => {
      await runtime.update(service.id, { url: 'https://example.org/changed' });
      return true;
    },
  });
  try {
    await runtime.initialize();
    service = await runtime.create({ name: '生图', url: 'https://example.com/mcp' });
    await assert.rejects(runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] }), /授权期间已变化/);
    assert.deepEqual(runtime.state.grants[plugin.id]?.[service.id] ?? [], []);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP bypasses the SDK tool cache during grant revalidation', async () => {
  const cacheModes = [];
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcpcache-'));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools(_params, options) {
        cacheModes.push(options?.cacheMode ?? 'use');
        return { tools: [{ name: 'generate', annotations: { readOnlyHint: false } }] };
      },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const service = await runtime.create({ name: '生图', url: 'https://example.com/mcp' });
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    assert.equal(cacheModes.includes('refresh'), true);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP does not persist a grant after the plugin stops', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcplife-'));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: [{ name: 'generate', annotations: { readOnlyHint: false } }] }; },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
    isPluginActive: async () => false,
  });
  try {
    await runtime.initialize();
    const service = await runtime.create({ name: '生图', url: 'https://example.com/mcp' });
    await assert.rejects(runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] }), /停用或卸载/);
    assert.deepEqual(runtime.state.grants[plugin.id]?.[service.id] ?? [], []);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP revocation aborts a call that is still connecting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcprevoke-'));
  let gateConnect = false;
  let releaseConnect;
  let markConnecting;
  const connecting = new Promise(resolve => { markConnecting = resolve; });
  const connectGate = new Promise(resolve => { releaseConnect = resolve; });
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {
        if (gateConnect) {
          markConnecting();
          await connectGate;
        }
      },
      async listTools() { return { tools: [{ name: 'generate', annotations: { readOnlyHint: false } }] }; },
      async callTool() { throw new Error('不应在撤销后调用工具'); },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const service = await runtime.create({ name: '生图', url: 'https://example.com/mcp' });
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    runtime.clients.delete(service.id);
    gateConnect = true;
    const pending = assert.rejects(runtime.call(plugin, { serverId: service.id, toolName: 'generate' }), /撤销|重新授权|尚未授权/);
    await connecting;
    await runtime.revoke(plugin, { serverId: service.id });
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('撤销未及时中断连接阶段')), 500);
      timer.unref?.();
    });
    await Promise.race([pending, guard]);
    clearTimeout(timer);
    releaseConnect();
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP changing authentication context revokes granted tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcpauth-'));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: [{ name: 'generate', annotations: { readOnlyHint: false } }] }; },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const service = await runtime.create({ name: '生图', url: 'https://example.com/mcp', authMode: 'bearer', secret: 'first-token' });
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    assert.deepEqual(runtime.state.grants[plugin.id][service.id], ['generate']);
    await runtime.update(service.id, { secret: 'second-token' });
    assert.equal(runtime.state.grants[plugin.id], undefined);
    assert.equal(runtime.state.sideEffects[plugin.id], undefined);
    await assert.rejects(runtime.call(plugin, { serverId: service.id, toolName: 'generate' }), /尚未授权/);
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    await runtime.update(service.id, { authMode: 'none' });
    assert.equal(runtime.state.grants[plugin.id], undefined);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP revocation cancels an in-flight tool call', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcprevoke-'));
  let markCalling;
  let rejectCall;
  const calling = new Promise(resolve => { markCalling = resolve; });
  const callGate = new Promise((_, reject) => { rejectCall = reject; });
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: [{ name: 'generate', annotations: { readOnlyHint: false } }] }; },
      async callTool(_params, options) {
        markCalling();
        options?.signal?.addEventListener('abort', () => rejectCall(new DOMException('Aborted', 'AbortError')), { once: true });
        await callGate;
        return { content: [] };
      },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const service = await runtime.create({ name: '生图', url: 'https://example.com/mcp' });
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    const pending = assert.rejects(runtime.call(plugin, { serverId: service.id, toolName: 'generate' }), /撤销/);
    await calling;
    await runtime.revoke(plugin, { serverId: service.id });
    await pending;
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP bounds concurrent calls per plugin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcplimit-'));
  const pending = [];
  let started = 0;
  let markStarted;
  const fourStarted = new Promise(resolve => { markStarted = resolve; });
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: [{ name: 'generate', annotations: { readOnlyHint: false } }] }; },
      async callTool(_params, options) {
        started += 1;
        if (started === 4) markStarted();
        await new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const service = await runtime.create({ name: '生图', url: 'https://example.com/mcp' });
    await runtime.grant(plugin, { serverId: service.id, toolNames: ['generate'] });
    for (let index = 0; index < 4; index += 1) {
      pending.push(runtime.call(plugin, { serverId: service.id, toolName: 'generate' }).catch(error => error));
    }
    await fourStarted;
    await assert.rejects(runtime.call(plugin, { serverId: service.id, toolName: 'generate' }), /调用过多/);
    await runtime.revoke(plugin, { serverId: service.id });
    const errors = await Promise.all(pending);
    assert.equal(errors.every(error => /撤销/.test(error.message)), true);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP timeouts abort the underlying request signal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qzmcptimeout-'));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
  });
  try {
    await runtime.initialize();
    const controller = new AbortController();
    await assert.rejects(
      runtime.withTimeout(new Promise(() => {}), 5, 'MCP 工具调用超时。', controller),
      /超时/,
    );
    assert.equal(controller.signal.aborted, true);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP sends loopback HTTP requests without the public-network guard', async t => {
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/mcp' });
      response.end();
      return;
    }
    if (request.url === '/large') {
      response.writeHead(200, { 'content-length': String(2 * 1024 * 1024 + 1) });
      response.end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ method: request.method, body }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-mcp-'));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const local = await runtime.create({ name: '本机服务', url: 'http://127.0.0.1:' + server.address().port + '/mcp', authMode: 'none' });
    const response = await runtime.guardedFetch(local, local.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"ping":1}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { method: 'POST', body: '{"ping":1}' });
    await assert.rejects(runtime.guardedFetch(local, 'http://127.0.0.1:' + server.address().port + '/redirect', { method: 'GET' }));
    await assert.rejects(runtime.guardedFetch(local, 'http://127.0.0.1:' + server.address().port + '/large', { method: 'GET' }), /响应过大/);
    const remote = { url: 'https://example.com/mcp' };
    await assert.rejects(runtime.guardedFetch(remote, local.url, { method: 'HEAD' }), /不可访问/);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP accepts large tool catalogs but still bounds ordinary responses', async t => {
  const catalog = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] }, padding: 'x'.repeat(3 * 1024 * 1024) });
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const method = JSON.parse(body).method;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(method === 'tools/list' ? catalog : 'x'.repeat(3 * 1024 * 1024));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-mcp-'));
  const runtime = new McpRuntime({ root, credentials: credentials(), shell: { async openExternal() {} } });
  try {
    await runtime.initialize();
    const local = await runtime.create({ name: '本机目录', url: 'http://127.0.0.1:' + server.address().port + '/mcp' });
    const listed = await runtime.guardedFetch(local, local.url, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal((await listed.text()).length, catalog.length);
    const call = await runtime.guardedFetch(local, local.url, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/read' }),
    });
    await assert.rejects(call.text(), /响应过大/);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP keeps aggregated hub tool catalogs intact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-mcp-'));
  const tools = Array.from({ length: 346 }, (_, index) => ({
    name: 'hub__tool-' + index,
    description: '聚合工具 ' + index,
    annotations: { readOnlyHint: index % 2 === 0 },
  }));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools }; },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
  });
  try {
    await runtime.initialize();
    const server = await runtime.create({ name: '聚合枢纽', url: 'http://127.0.0.1:3425/mcp/hub' });
    assert.equal((await runtime.adminList())[0].checked, false);
    const result = await runtime.test(server.id);
    assert.equal(result.toolCount, tools.length);
    assert.equal(result.readOnlyToolCount, 173);
    const listed = (await runtime.adminList())[0];
    assert.equal(listed.checked, true);
    assert.equal(listed.toolCount, tools.length);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP only opens loopback HTTP authorization URLs for loopback servers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-mcp-'));
  let opened = '';
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal(url) { opened = url; } },
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const local = await runtime.create({ name: '本机', url: 'http://127.0.0.1:3000/mcp' });
    const remote = await runtime.create({ name: '远程', url: 'https://example.com/mcp' });
    runtime.oauth.set(local.id, { redirectUrl: 'http://127.0.0.1/callback' });
    runtime.oauth.set(remote.id, { redirectUrl: 'http://127.0.0.1/callback' });
    const localProvider = await runtime.clientInformationProvider(local);
    const remoteProvider = await runtime.clientInformationProvider(remote);
    const authorizationUrl = new URL('http://127.0.0.1:4000/authorize');
    await localProvider.redirectToAuthorization(authorizationUrl);
    assert.equal(opened, authorizationUrl.href);
    await localProvider.redirectToAuthorization(new URL('https://127.0.0.1:4000/authorize'));
    assert.equal(opened, 'https://127.0.0.1:4000/authorize');
    await assert.rejects(remoteProvider.redirectToAuthorization(authorizationUrl), /授权地址无效/);
    await assert.rejects(remoteProvider.redirectToAuthorization(new URL('https://127.0.0.1:4000/authorize')), /授权地址无效/);
    assert.equal(opened, 'https://127.0.0.1:4000/authorize');
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP grant stays unpersisted when the host confirmation is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-mcp-'));
  const runtime = new McpRuntime({
    root,
    credentials: credentials(),
    shell: { async openExternal() {} },
    clientFactory: () => ({
      async connect() {},
      async listTools() {
        return { tools: [{ name: 'search', title: '搜索', annotations: { readOnlyHint: true } }] };
      },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => false,
  });
  try {
    await runtime.initialize();
    const server = await runtime.create({ name: '资料服务', url: 'https://example.com/mcp', authMode: 'none' });
    await assert.rejects(runtime.grant(plugin, { serverId: server.id, toolNames: ['search'] }), /取消/);
    assert.equal((await runtime.adminGrants(server.id)).length, 0);
    const persisted = JSON.parse(await readFile(path.join(root, 'mcp-servers.json'), 'utf8'));
    assert.equal(persisted.grants[plugin.id], undefined);
    const restarted = new McpRuntime({
      root,
      credentials: credentials(),
      shell: { async openExternal() {} },
      clientFactory: () => ({ async connect() {}, async listTools() { return { tools: [] }; }, async callTool() { return { content: [] }; }, async close() {} }),
      transportFactory: () => ({ async close() {} }),
      confirmGrant: async () => true,
    });
    await restarted.initialize();
    assert.equal((await restarted.adminGrants(server.id)).length, 0);
    await assert.rejects(restarted.call(plugin, { serverId: server.id, toolName: 'search' }), /尚未授权/);
    await restarted.shutdown();
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP settings never return bearer secrets and revoke plugin grants on request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-mcp-'));
  const store = credentials();
  const runtime = new McpRuntime({
    root,
    credentials: store,
    shell: { async openExternal() {} },
    clientFactory: () => ({ async connect() {}, async listTools() { return { tools: [] }; }, async callTool() { return { content: [] }; }, async close() {} }),
    transportFactory: () => ({ async close() {} }),
    confirmGrant: async () => true,
  });
  try {
    await runtime.initialize();
    const server = await runtime.create({ name: '检索', url: 'https://example.com/mcp', authMode: 'bearer', headerName: 'Authorization', secret: 'very-secret' });
    const listed = await runtime.adminList();
    assert.equal(listed[0].hasSecret, true);
    assert.equal(JSON.stringify(listed).includes('very-secret'), false);
    await runtime.grant(plugin, { serverId: server.id, toolNames: [] }).catch(() => {});
    await runtime.adminRevokeGrant(plugin.id);
    assert.equal((await runtime.adminGrants()).length, 0);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
