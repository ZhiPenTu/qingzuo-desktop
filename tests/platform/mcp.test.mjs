import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { McpRuntime } from '../../desktop/mcp.mjs';

const plugin = { id: 'official.wechat-studio', title: '公众号 AI 工作台', permissions: { mcp: ['read'] } };

function credentials() {
  const values = new Map();
  return {
    async get(namespace, name) { return values.get(namespace + ':' + name) ?? null; },
    async set(namespace, name, value) { values.set(namespace + ':' + name, value); },
    async clear(namespace, name) { values.delete(namespace + ':' + name); },
  };
}

test('MCP exposes only annotated read-only tools and grants per plugin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-mcp-'));
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
    assert.deepEqual(tools.map(tool => tool.name), ['search']);
    await assert.rejects(runtime.grant(plugin, { serverId: server.id, toolNames: ['write'] }), /只读/);
    await runtime.grant(plugin, { serverId: server.id, toolNames: ['search'] });
    const result = await runtime.call(plugin, { serverId: server.id, toolName: 'search', args: { query: '轻作' } });
    assert.equal(result.content[0].text, 'ok');
    assert.deepEqual(calls[0].arguments, { query: '轻作' });
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
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call' }),
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
