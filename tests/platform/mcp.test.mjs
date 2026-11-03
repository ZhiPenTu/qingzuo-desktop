import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    await assert.rejects(runtime.create({ name: '本机', url: 'https://127.0.0.1/mcp' }), /不可访问/);
    await assert.rejects(runtime.create({ name: '私网', url: 'http://example.com/mcp' }), /HTTPS/);
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
