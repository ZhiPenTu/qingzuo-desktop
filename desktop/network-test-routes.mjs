import { secureRequest } from './network-transport.mjs';

// Automated plugin tests need the real platform hosts (and their TLS hostnames)
// without reaching the internet. Only these hosts can be redirected, only to
// loopback, and only in an unpackaged build with an explicit opt-in.
export const TEST_ROUTE_HOSTS = Object.freeze([
  'openapi.sheincorp.com',
  'openapi-test01.sheincorp.cn',
  'api.openai.com',
  'api.deepseek.com'
]);

export function parseTestRoutes(value) {
  if (value === undefined || value === null || value === '') return new Map();
  let raw;
  try { raw = JSON.parse(String(value)); } catch { throw new Error('测试网络路由必须是 JSON 对象。'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('测试网络路由必须是 JSON 对象。');
  const routes = new Map();
  for (const [origin, target] of Object.entries(raw)) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error('测试网络路由的来源地址无效。'); }
    if (!TEST_ROUTE_HOSTS.includes(parsed.hostname) || parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('测试网络路由只能指向已声明的平台主机。');
    }
    let destination;
    try { destination = new URL(String(target)); } catch { throw new Error('测试网络路由的目标地址无效。'); }
    if (!['http:', 'https:'].includes(destination.protocol) || destination.hostname !== '127.0.0.1'
      || destination.username || destination.password || destination.pathname !== '/' || destination.search || destination.hash) {
      throw new Error('测试网络路由只能转发到 127.0.0.1。');
    }
    routes.set(parsed.origin, destination.origin);
  }
  return routes;
}

// Wrapping happens after NetworkBroker has already authorized the plugin's
// origin, so the manifest still decides what may be called. Redirected
// requests never carry credentials across hosts: the cookie-free fetch keeps
// the caller's headers, which the broker itself built.
export function createTestRoutedRequest(routes, { request = secureRequest, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  if (!(routes instanceof Map) || routes.size === 0) return request;
  return async (address, options) => {
    let url;
    try { url = new URL(address); } catch { return request(address, options); }
    const destination = routes.get(url.origin);
    if (!destination) return request(address, options);
    return fetchImpl(destination + url.pathname + url.search, options);
  };
}

export function testRoutedRequest({ packaged, value, ...options } = {}) {
  if (packaged) return secureRequest;
  return createTestRoutedRequest(parseTestRoutes(value), options);
}
