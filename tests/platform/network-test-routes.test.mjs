import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRoutedRequest, parseTestRoutes, testRoutedRequest } from '../../desktop/network-test-routes.mjs';
import { secureRequest } from '../../desktop/network-transport.mjs';

test('测试路由只接受已声明的平台主机', () => {
  assert.equal(parseTestRoutes(undefined).size, 0);
  const routes = parseTestRoutes(JSON.stringify({ 'https://openapi-test01.sheincorp.cn': 'http://127.0.0.1:1234' }));
  assert.equal(routes.get('https://openapi-test01.sheincorp.cn'), 'http://127.0.0.1:1234');
  for (const value of [
    { 'https://example.com': 'http://127.0.0.1:1234' },
    { 'https://api.openai.com/v1': 'http://127.0.0.1:1234' },
    { 'http://api.openai.com': 'http://127.0.0.1:1234' },
    { 'https://api.openai.com': 'http://192.168.1.5:1234' },
    { 'https://api.openai.com': 'http://localhost:1234' },
    { 'https://api.openai.com': 'http://127.0.0.1:1234/path' }
  ]) assert.throws(() => parseTestRoutes(JSON.stringify(value)), /测试网络路由/);
  assert.throws(() => parseTestRoutes('not json'), /测试网络路由/);
});

test('测试路由只重写命中的主机并保留路径与查询', async () => {
  const seen = [];
  const request = createTestRoutedRequest(parseTestRoutes(JSON.stringify({ 'https://api.openai.com': 'http://127.0.0.1:7000' })), {
    request: async address => ({ status: 200, address }),
    fetchImpl: async (address, options) => { seen.push({ address, options }); return { status: 200, address }; }
  });
  const hit = await request('https://api.openai.com/v1/chat/completions?x=1', { method: 'POST' });
  assert.equal(hit.address, 'http://127.0.0.1:7000/v1/chat/completions?x=1');
  assert.equal(seen[0].options.method, 'POST');
  const passthrough = await request('https://openapi.sheincorp.com/open-api/goods/x', {});
  assert.equal(passthrough.address, 'https://openapi.sheincorp.com/open-api/goods/x');
  assert.equal(seen.length, 1);
});

test('打包构建始终使用固定传输', () => {
  assert.equal(testRoutedRequest({ packaged: true, value: JSON.stringify({ 'https://api.openai.com': 'http://127.0.0.1:1' }) }), secureRequest);
  assert.equal(testRoutedRequest({ packaged: false, value: '' }), secureRequest);
  assert.notEqual(testRoutedRequest({ packaged: false, value: JSON.stringify({ 'https://api.openai.com': 'http://127.0.0.1:2' }) }), secureRequest);
});
