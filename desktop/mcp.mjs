import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import semver from 'semver';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { publicAddress, secureRequest } from './network-transport.mjs';

const SERVER_ID = /^mcp-[a-f0-9]{12}$/;
const AUTH_MODES = new Set(['none', 'bearer', 'oauth']);
const MAX_SERVERS = 24;
const MAX_TOOLS = 500;
const MAX_ARGUMENTS = 256 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_CATALOG_RESPONSE = 8 * 1024 * 1024;
const MAX_TOOL_RESPONSE = 16 * 1024 * 1024;
const MAX_INLINE_IMAGE = 12 * 1024 * 1024;
const MAX_INLINE_IMAGES = 4;
const MAX_INLINE_CANDIDATES = 8;
const MAX_INLINE_TOTAL = 24 * 1024 * 1024;
const MAX_INLINE_RESPONSE = 36 * 1024 * 1024;
const INLINE_IMAGE_TIMEOUT = 30_000;
const INLINE_TOTAL_TIMEOUT = 45_000;
const MAX_ACTIVE_CALLS = 16;
const MAX_ACTIVE_CALLS_PER_PLUGIN = 4;
const REQUEST_TIMEOUT = 60_000;
const OAUTH_TIMEOUT = 5 * 60_000;
const CREDENTIAL_NAMESPACE = 'mcp-servers';

class McpPolicyError extends Error {}

function cleanText(value, max, label, { required = true } = {}) {
  if (typeof value !== 'string') throw new Error(label + '无效。');
  const text = value.trim();
  if ((required && !text) || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error(label + '无效。');
  return text;
}

function isLoopbackHostname(value) {
  const hostname = value.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost') return true;
  if (hostname === '[::1]' || hostname === '::1') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part, index) => index === 0 || /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isAllowedTransportUrl(url) {
  return url.protocol === 'https:' || url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

function isAllowedServiceUrl(url) {
  return !url.username && !url.password && !url.hash && isAllowedTransportUrl(url);
}

function validateServerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MCP 服务地址无效。');
  }
  if (url.username || url.password || url.hash) throw new Error('MCP 服务地址无效。');
  if (!isAllowedServiceUrl(url)) throw new Error('MCP 服务地址必须为 HTTPS 地址，本机服务可以使用 HTTP。');
  if (!isLoopbackHostname(url.hostname) && (url.hostname.length > 253 || /\.(?:local|localhost|internal)$/i.test(url.hostname))) throw new Error('MCP 服务地址不可访问。');
  if (!isLoopbackHostname(url.hostname) && isIP(url.hostname) && !publicAddress(url.hostname)) throw new Error('MCP 服务地址不可访问。');
  return url.href;
}

function validateHeaderName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(value)) throw new Error('鉴权请求头无效。');
  const lower = value.toLowerCase();
  if (['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'cookie', 'proxy-authorization', 'te', 'trailer'].includes(lower)) throw new Error('鉴权请求头无效。');
  return value;
}

function emptyState() {
  return { schemaVersion: 1, servers: [], grants: {}, sideEffects: {} };
}

function normalizeState(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.servers) || !value.grants || typeof value.grants !== 'object' || Array.isArray(value.grants)) return null;
  const servers = [];
  const ids = new Set();
  for (const entry of value.servers) {
    if (!entry || !SERVER_ID.test(entry.id) || ids.has(entry.id)) continue;
    let url;
    try {
      url = validateServerUrl(entry.url);
    } catch {
      continue;
    }
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80 || !AUTH_MODES.has(entry.authMode)) continue;
    if (entry.authMode === 'bearer') {
      try {
        validateHeaderName(entry.headerName || 'Authorization');
      } catch {
        continue;
      }
    }
    if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) continue;
    ids.add(entry.id);
    servers.push({
      id: entry.id,
      name: entry.name.trim(),
      url,
      authMode: entry.authMode,
      headerName: entry.authMode === 'bearer' ? (entry.headerName || 'Authorization') : null,
      enabled: entry.enabled !== false,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
  }
  const grants = {};
  for (const [pluginId, valueByServer] of Object.entries(value.grants)) {
    if (!/^[a-z][a-z0-9.-]{1,95}$/.test(pluginId) || !valueByServer || typeof valueByServer !== 'object' || Array.isArray(valueByServer)) continue;
    const next = {};
    for (const [serverId, names] of Object.entries(valueByServer)) {
      if (!ids.has(serverId) || !Array.isArray(names)) continue;
      const tools = [...new Set(names.filter(name => typeof name === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(name)))].slice(0, MAX_TOOLS);
      if (tools.length) next[serverId] = tools;
    }
    if (Object.keys(next).length) grants[pluginId] = next;
  }
  const sideEffects = {};
  const effectSource = value.sideEffects && typeof value.sideEffects === 'object' && !Array.isArray(value.sideEffects) ? value.sideEffects : {};
  for (const [pluginId, valueByServer] of Object.entries(effectSource)) {
    if (!/^[a-z][a-z0-9.-]{1,95}$/.test(pluginId) || !valueByServer || typeof valueByServer !== 'object' || Array.isArray(valueByServer)) continue;
    const next = {};
    for (const [serverId, names] of Object.entries(valueByServer)) {
      if (!ids.has(serverId) || !Array.isArray(names)) continue;
      const tools = [...new Set(names.filter(name => typeof name === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(name)))].slice(0, MAX_TOOLS);
      if (tools.length) next[serverId] = tools;
    }
    if (Object.keys(next).length) sideEffects[pluginId] = next;
  }
  return { schemaVersion: 1, servers, grants, sideEffects };
}

async function atomicJson(filename, value) {
  const temporary = filename + '.' + randomBytes(5).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, filename);
    if (process.platform !== 'win32') await chmod(filename, 0o600).catch(() => {});
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseCredential(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function responseLimit(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    throw new Error('MCP 服务响应过大。');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let total = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          controller.error(new Error('MCP 服务响应过大。'));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function responseLimitFor(body) {
  if (!body?.length) return MAX_RESPONSE;
  try {
    const message = JSON.parse(body.toString('utf8'));
    if (message?.method === 'tools/list') return MAX_CATALOG_RESPONSE;
    if (message?.method === 'tools/call') return MAX_TOOL_RESPONSE;
    return MAX_RESPONSE;
  } catch {
    return MAX_RESPONSE;
  }
}

function publicTool(tool) {
  return {
    name: String(tool.name),
    title: typeof tool.title === 'string' && tool.title.trim() ? tool.title.trim().slice(0, 120) : String(tool.name),
    description: typeof tool.description === 'string' ? tool.description.slice(0, 1000) : '',
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

function supportsToolInvocation(plugin) {
  const minimum = semver.minVersion(plugin.api ?? '^1.0.0');
  return Boolean(minimum && semver.gte(minimum, '1.11.0'));
}

function stripUrlPunctuation(value) {
  return String(value).replace(/[.,;:!?，。；：！？、）)】\]}>'"]+$/g, '');
}

function imageUrls(content, limit = MAX_INLINE_CANDIDATES) {
  const urls = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (urls.length >= limit) break;
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'resource_link' && typeof item.uri === 'string') urls.push(item.uri);
    if (item.type === 'resource' && typeof item.resource?.uri === 'string' && String(item.resource.mimeType || '').startsWith('image/')) {
      urls.push(item.resource.uri);
    }
    if (item.type === 'image_url') {
      const value = typeof item.image_url === 'string' ? item.image_url : item.image_url?.url;
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) urls.push(value);
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      for (const match of item.text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
        urls.push(stripUrlPunctuation(match[0]));
        if (urls.length >= limit) break;
      }
    }
  }
  return [...new Set(urls)].slice(0, limit);
}

export class McpRuntime {
  constructor({
    root,
    credentials,
    shell,
    request = secureRequest,
    localRequest = (address, options) => globalThis.fetch(address, options),
    clientFactory = () => new Client({ name: 'qingzuo-desktop', version: '1.9.0', listMaxPages: 8 }),
    transportFactory = (url, options) => new StreamableHTTPClientTransport(url, options),
    confirmGrant = async () => false,
    isPluginActive = async () => true,
    log = () => {},
    now = () => Date.now(),
  }) {
    this.root = root;
    this.credentials = credentials;
    this.shell = shell;
    this.request = request;
    this.localRequest = localRequest;
    this.clientFactory = clientFactory;
    this.transportFactory = transportFactory;
    this.confirmGrant = confirmGrant;
    this.isPluginActive = isPluginActive;
    this.log = log;
    this.now = now;
    this.file = path.join(root, 'mcp-servers.json');
    this.state = emptyState();
    this.queue = Promise.resolve();
    this.clients = new Map();
    this.toolCache = new Map();
    this.status = new Map();
    this.errors = new Map();
    this.oauth = new Map();
    this.callbackServers = new Set();
    this.activeCalls = new Set();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const normalized = normalizeState(JSON.parse(await readFile(this.file, 'utf8')));
      if (!normalized) {
        await rename(this.file, this.file + '.corrupt-' + Date.now()).catch(() => {});
        this.state = emptyState();
        this.log('MCP 服务索引格式不兼容，已保留原文件并停止使用旧授权。');
      } else {
        this.state = normalized;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await rename(this.file, this.file + '.corrupt-' + Date.now()).catch(() => {});
        this.state = emptyState();
      }
    }
  }

  async mutate(change) {
    const execute = async () => {
      const draft = structuredClone(this.state);
      const result = await change(draft);
      await atomicJson(this.file, draft);
      this.state = draft;
      return result;
    };
    const operation = this.queue.then(execute, execute);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  nextId(draft) {
    for (let index = 0; index < 4; index += 1) {
      const id = 'mcp-' + randomBytes(6).toString('hex');
      if (!draft.servers.some(server => server.id === id)) return id;
    }
    throw new Error('无法生成 MCP 服务标识。');
  }

  find(id) {
    const server = this.state.servers.find(item => item.id === id);
    if (!server) throw new Error('MCP 服务不存在。');
    return server;
  }

  secretName(id) {
    return 'secret-' + id;
  }

  credentialName(id, suffix) {
    return suffix + '-' + id;
  }

  async secret(id) {
    const value = await this.credentials.get(CREDENTIAL_NAMESPACE, this.secretName(id));
    if (!value) throw new Error('MCP 服务尚未配置鉴权信息。');
    return value;
  }

  async oauthCredential(id, suffix) {
    return parseCredential(await this.credentials.get(CREDENTIAL_NAMESPACE, this.credentialName(id, suffix)).catch(() => null));
  }

  async setOAuthCredential(id, suffix, value) {
    if (value === null || value === undefined) {
      await this.credentials.clear(CREDENTIAL_NAMESPACE, this.credentialName(id, suffix)).catch(() => {});
      return;
    }
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 4096) throw new Error('MCP 授权信息过大。');
    await this.credentials.set(CREDENTIAL_NAMESPACE, this.credentialName(id, suffix), encoded);
  }

  async hasOAuthTokens(id) {
    return Boolean(await this.oauthCredential(id, 'tokens'));
  }

  async guardedFetch(server, input, init = {}) {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const url = new URL(request.url);
    const local = isLoopbackHostname(url.hostname);
    if (local && !isLoopbackHostname(new URL(server.url).hostname)) throw new Error('MCP 服务地址不可访问。');
    if (url.username || url.password || !isAllowedTransportUrl(url)) throw new Error('MCP 服务地址不可访问。');
    if (!local && (url.hostname.length > 253 || /\.(?:local|localhost|internal)$/i.test(url.hostname) || isIP(url.hostname) && !publicAddress(url.hostname))) throw new Error('MCP 服务地址不可访问。');
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT)])
      : AbortSignal.timeout(REQUEST_TIMEOUT);
    const headers = Object.fromEntries(request.headers);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
    const limit = responseLimitFor(body);
    const requestOptions = {
      method: request.method,
      headers,
      body,
      redirect: 'error',
      signal,
    };
    const response = local ? await this.localRequest(url.href, requestOptions) : await this.request(url.href, requestOptions);
    return responseLimit(response, limit);
  }

  async clientInformationProvider(server) {
    const runtime = this;
    return {
      get redirectUrl() {
        return runtime.oauth.get(server.id)?.redirectUrl;
      },
      get clientMetadata() {
        return {
          client_name: '轻作 Qingzuo',
          redirect_uris: [String(runtime.oauth.get(server.id)?.redirectUrl || 'http://127.0.0.1/callback')],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        };
      },
      async state() {
        const value = randomBytes(24).toString('base64url');
        await runtime.setOAuthCredential(server.id, 'state', { value });
        const pending = runtime.oauth.get(server.id);
        if (pending) pending.state = value;
        return value;
      },
      clientInformation: () => runtime.oauthCredential(server.id, 'client'),
      saveClientInformation: value => runtime.setOAuthCredential(server.id, 'client', value),
      tokens: () => runtime.oauthCredential(server.id, 'tokens'),
      saveTokens: value => runtime.setOAuthCredential(server.id, 'tokens', value),
      saveCodeVerifier: value => runtime.setOAuthCredential(server.id, 'verifier', { value }),
      codeVerifier: async () => {
        const value = await runtime.oauthCredential(server.id, 'verifier');
        if (!value?.value) throw new Error('MCP 授权校验信息已失效。');
        return value.value;
      },
      redirectToAuthorization: async authorizationUrl => {
        const pending = runtime.oauth.get(server.id);
        if (!pending) throw new Error('MCP 授权流程未开始。');
        const localServer = isLoopbackHostname(new URL(server.url).hostname);
        const localAuthorization = authorizationUrl instanceof URL && isLoopbackHostname(authorizationUrl.hostname);
        const allowed = authorizationUrl instanceof URL
          && !authorizationUrl.username
          && !authorizationUrl.password
          && (localAuthorization ? localServer && ['http:', 'https:'].includes(authorizationUrl.protocol) : authorizationUrl.protocol === 'https:');
        if (!allowed) {
          throw new Error('MCP 授权地址无效。');
        }
        pending.authorizationUrl = authorizationUrl.href;
        await runtime.shell.openExternal(authorizationUrl.href);
      },
      invalidateCredentials: async scope => {
        const suffixes = scope === 'all' ? ['client', 'tokens', 'verifier', 'state'] : scope === 'tokens' ? ['tokens'] : scope === 'client' ? ['client'] : scope === 'verifier' ? ['verifier'] : [];
        for (const suffix of suffixes) await runtime.setOAuthCredential(server.id, suffix, null);
      },
    };
  }

  async createTransport(server) {
    let authProvider;
    let headers = {};
    if (server.authMode === 'bearer') {
      if (server.headerName === 'Authorization') {
        const runtime = this;
        authProvider = { token: () => runtime.secret(server.id) };
      } else {
        headers[server.headerName] = await this.secret(server.id);
      }
    } else if (server.authMode === 'oauth') {
      if (!(await this.hasOAuthTokens(server.id)) && !this.oauth.get(server.id)) throw new Error('请先在设置中完成 MCP 服务授权。');
      authProvider = await this.clientInformationProvider(server);
    }
    return this.transportFactory(new URL(server.url), {
      authProvider,
      requestInit: { headers },
      fetch: (input, init) => this.guardedFetch(server, input, init),
      reconnectionOptions: {
        maxReconnectionDelay: 10_000,
        initialReconnectionDelay: 500,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 2,
      },
    });
  }

  async connect(server) {
    const current = this.clients.get(server.id);
    if (current?.server.updatedAt === server.updatedAt) return current;
    if (current) await this.closeServer(server.id);
    const client = this.clientFactory();
    const transport = await this.createTransport(server);
    try {
      await this.withTimeout(client.connect(transport), REQUEST_TIMEOUT, 'MCP 服务连接超时。');
      const value = { client, transport, server };
      this.clients.set(server.id, value);
      this.status.set(server.id, 'ready');
      this.errors.delete(server.id);
      return value;
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      this.status.set(server.id, error instanceof UnauthorizedError || server.authMode === 'oauth' && !(await this.hasOAuthTokens(server.id)) ? 'auth-required' : 'error');
      this.errors.set(server.id, this.safeError(error));
      throw new Error(this.safeError(error));
    }
  }

  async withTimeout(promise, milliseconds, message, controller) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller?.abort(new Error(message));
            reject(new Error(message));
          }, milliseconds);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  safeError(error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/响应过大/.test(text)) return 'MCP 服务响应过大。';
    if (/超时|timeout/i.test(text)) return 'MCP 服务响应超时。';
    if (/私有|本机|重定向|地址不可访问|HTTPS/i.test(text)) return 'MCP 服务地址不可访问。';
    if (/401|unauthorized|授权/i.test(text)) return 'MCP 服务需要授权。';
    return 'MCP 服务连接失败，请检查服务配置。';
  }

  async listTools(server, { fresh = false } = {}) {
    const cached = this.toolCache.get(server.id);
    if (!fresh && cached?.updatedAt === server.updatedAt) return cached.tools;
    const { client } = await this.connect(server);
    try {
      const result = await this.withTimeout(
        client.listTools(undefined, fresh ? { cacheMode: 'refresh' } : undefined),
        REQUEST_TIMEOUT,
        'MCP 工具列表读取超时。',
      );
      const tools = (result.tools ?? []).slice(0, MAX_TOOLS).map(publicTool);
      this.toolCache.set(server.id, { updatedAt: server.updatedAt, tools });
      return tools;
    } catch (error) {
      this.status.set(server.id, 'error');
      this.errors.set(server.id, this.safeError(error));
      throw new Error(this.safeError(error));
    }
  }

  abortActiveCalls(predicate) {
    for (const call of this.activeCalls) {
      if (predicate(call)) call.controller.abort();
    }
  }

  abortPlugin(pluginId) {
    this.abortActiveCalls(call => call.pluginId === pluginId);
  }

  async abortable(promise, signal, message) {
    if (!signal) return promise;
    if (signal.aborted) throw new Error(message);
    let listener;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          listener = () => reject(new Error(message));
          signal.addEventListener('abort', listener, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', listener);
    }
  }

  async closeServer(id) {
    const current = this.clients.get(id);
    this.clients.delete(id);
    if (!current) return;
    await current.client.close().catch(() => {});
    await current.transport.close().catch(() => {});
  }

  async adminList() {
    const result = [];
    for (const server of this.state.servers) {
      let status = this.status.get(server.id);
      if (!server.enabled) status = 'disabled';
      else if (!status) status = server.authMode === 'oauth' && !(await this.hasOAuthTokens(server.id)) ? 'auth-required' : 'ready';
      const hasSecret = server.authMode === 'bearer' ? Boolean(await this.credentials.get(CREDENTIAL_NAMESPACE, this.secretName(server.id)).catch(() => null)) : false;
      result.push({
        id: server.id,
        name: server.name,
        url: server.url,
        authMode: server.authMode,
        headerName: server.headerName,
        enabled: server.enabled,
        hasSecret,
        status,
        checked: this.status.has(server.id),
        error: this.errors.get(server.id) ?? null,
        toolCount: this.toolCache.get(server.id)?.tools.length ?? 0,
        createdAt: server.createdAt,
        updatedAt: server.updatedAt,
      });
    }
    return result.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async pluginServers(plugin) {
    if (!(plugin.permissions.mcp ?? []).includes('read')) throw new Error('MCP 能力未授权。');
    const allTools = supportsToolInvocation(plugin);
    const result = [];
    for (const server of this.state.servers) {
      if (!server.enabled) continue;
      let status = this.status.get(server.id);
      if (!status) status = server.authMode === 'oauth' && !(await this.hasOAuthTokens(server.id)) ? 'auth-required' : 'ready';
      result.push({
        id: server.id,
        name: server.name,
        status,
        toolCount: this.toolCache.get(server.id)?.tools.filter(tool => allTools || tool.readOnly).length ?? 0,
      });
    }
    return result.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }

  async adminGrants(serverId) {
    if (serverId !== undefined) this.find(serverId);
    const result = [];
    for (const [pluginId, grants] of Object.entries(this.state.grants)) {
      for (const [id, tools] of Object.entries(grants)) {
        if (serverId !== undefined && id !== serverId) continue;
        result.push({ pluginId, serverId: id, toolNames: [...tools] });
      }
    }
    return result;
  }

  async adminTools(id) {
    const server = this.find(id);
    return this.listTools(server);
  }

  async adminRevokeGrant(pluginId, serverId) {
    if (typeof pluginId !== 'string' || !/^[a-z][a-z0-9.-]{1,95}$/.test(pluginId)) throw new Error('插件标识无效。');
    if (serverId !== undefined) this.find(serverId);
    await this.mutate(draft => {
      if (!draft.grants[pluginId] && !draft.sideEffects[pluginId]) return;
      if (serverId === undefined) {
        delete draft.grants[pluginId];
        delete draft.sideEffects[pluginId];
        return;
      } else {
        if (draft.grants[pluginId]) delete draft.grants[pluginId][serverId];
        if (draft.sideEffects[pluginId]) delete draft.sideEffects[pluginId][serverId];
      }
      if (draft.grants[pluginId] && !Object.keys(draft.grants[pluginId]).length) delete draft.grants[pluginId];
      if (draft.sideEffects[pluginId] && !Object.keys(draft.sideEffects[pluginId]).length) delete draft.sideEffects[pluginId];
    });
    this.abortActiveCalls(call => call.pluginId === pluginId && (serverId === undefined || call.serverId === serverId));
  }

  async pluginTools(plugin, { serverId } = {}) {
    if (!(plugin.permissions.mcp ?? []).includes('read')) throw new Error('MCP 能力未授权。');
    const server = this.find(serverId);
    if (!server.enabled) throw new Error('MCP 服务已停用。');
    const tools = await this.listTools(server);
    return supportsToolInvocation(plugin) ? tools : tools.filter(tool => tool.readOnly);
  }

  async grant(plugin, { serverId, toolNames } = {}) {
    if (!(plugin.permissions.mcp ?? []).includes('read')) throw new Error('MCP 能力未授权。');
    const server = this.find(serverId);
    if (!server.enabled) throw new Error('MCP 服务已停用。');
    if (!Array.isArray(toolNames) || !toolNames.length || toolNames.length > MAX_TOOLS || new Set(toolNames).size !== toolNames.length || toolNames.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(name))) throw new Error('MCP 工具授权无效。');
    const tools = await this.listTools(server);
    const allowed = new Map(tools.map(tool => [tool.name, tool]));
    if (allowed.size !== tools.length) throw new Error('MCP 工具目录存在重复项。');
    if (toolNames.some(name => !allowed.has(name))) throw new Error('MCP 工具不存在。');
    if (!supportsToolInvocation(plugin) && toolNames.some(name => allowed.get(name).readOnly !== true)) {
      throw new Error('当前插件 API 版本只能授权只读 MCP 工具。');
    }
    const approved = await this.confirmGrant(plugin, server, toolNames, toolNames.map(name => allowed.get(name)));
    if (!approved) throw new Error('MCP 工具授权已取消。');
    if (!await this.isPluginActive(plugin.id)) throw new Error('插件已停用或卸载，授权未保存。');
    const current = this.find(serverId);
    if (!current.enabled || current.updatedAt !== server.updatedAt) throw new Error('MCP 服务在授权期间已变化，请重新确认。');
    const confirmedTools = await this.listTools(server, { fresh: true });
    const confirmed = new Map(confirmedTools.map(tool => [tool.name, tool]));
    for (const name of toolNames) {
      const tool = confirmed.get(name);
      if (!tool || tool.readOnly !== allowed.get(name).readOnly) throw new Error('MCP 工具权限已变化，请重新授权。');
    }
    if (!await this.isPluginActive(plugin.id)) throw new Error('插件已停用或卸载，授权未保存。');
    await this.mutate(draft => {
      const target = draft.servers.find(item => item.id === serverId);
      if (!target || !target.enabled || target.updatedAt !== server.updatedAt) {
        throw new Error('MCP 服务在授权期间已变化，请重新确认。');
      }
      const grants = draft.grants[plugin.id] ?? {};
      grants[serverId] = [...new Set([...(grants[serverId] ?? []), ...toolNames])].slice(0, MAX_TOOLS);
      draft.grants[plugin.id] = grants;
      const sideEffects = draft.sideEffects[plugin.id] ?? {};
      const effects = new Set(sideEffects[serverId] ?? []);
      for (const name of toolNames) {
        if (allowed.get(name).readOnly === true) effects.delete(name);
        else effects.add(name);
      }
      if (effects.size) sideEffects[serverId] = [...effects].slice(0, MAX_TOOLS);
      else delete sideEffects[serverId];
      if (Object.keys(sideEffects).length) draft.sideEffects[plugin.id] = sideEffects;
      else delete draft.sideEffects[plugin.id];
    });
    this.log('已授权 MCP 工具：' + toolNames.length + ' 个。');
  }

  async revoke(plugin, { serverId, toolNames } = {}) {
    if (!(plugin.permissions.mcp ?? []).includes('read')) throw new Error('MCP 能力未授权。');
    if (serverId !== undefined) this.find(serverId);
    if (toolNames !== undefined && (!Array.isArray(toolNames) || toolNames.length > MAX_TOOLS || toolNames.some(name => typeof name !== 'string'))) throw new Error('MCP 工具授权无效。');
    await this.mutate(draft => {
      if (!draft.grants[plugin.id]) return;
      if (serverId === undefined) {
        delete draft.grants[plugin.id];
        delete draft.sideEffects[plugin.id];
        return;
      }
      if (toolNames === undefined) {
        delete draft.grants[plugin.id][serverId];
        if (draft.sideEffects[plugin.id]) delete draft.sideEffects[plugin.id][serverId];
      } else {
        draft.grants[plugin.id][serverId] = (draft.grants[plugin.id][serverId] ?? []).filter(name => !toolNames.includes(name));
        if (draft.sideEffects[plugin.id]?.[serverId]) {
          draft.sideEffects[plugin.id][serverId] = draft.sideEffects[plugin.id][serverId].filter(name => !toolNames.includes(name));
          if (!draft.sideEffects[plugin.id][serverId].length) delete draft.sideEffects[plugin.id][serverId];
        }
      }
      if (!Object.keys(draft.grants[plugin.id]).length) delete draft.grants[plugin.id];
      if (draft.sideEffects[plugin.id] && !Object.keys(draft.sideEffects[plugin.id]).length) delete draft.sideEffects[plugin.id];
    });
    this.abortActiveCalls(call => call.pluginId === plugin.id
      && (serverId === undefined || call.serverId === serverId)
      && (toolNames === undefined || toolNames.includes(call.toolName)));
  }

  async inlineImageUrls(content, server, signal) {
    if (signal?.aborted) throw new Error('MCP 工具调用已撤销。');
    const accepted = Array.isArray(content) ? [...content] : [];
    let total = 0;
    let count = 0;
    for (const item of accepted) {
      if (item?.type !== 'image' || !item.data) continue;
      const size = Buffer.byteLength(String(item.data), 'base64');
      if (size > MAX_INLINE_IMAGE) throw new Error('MCP 服务响应过大。');
      total += size;
      count += 1;
    }
    if (count > MAX_INLINE_IMAGES || total > MAX_INLINE_TOTAL) throw new Error('MCP 服务响应过大。');
    if (count > 0) return accepted;
    const serverLocal = isLoopbackHostname(new URL(server.url).hostname);
    const deadline = this.now() + INLINE_TOTAL_TIMEOUT;
    let candidates = 0;
    const warnings = new Set();
    for (const raw of imageUrls(accepted)) {
      if (signal?.aborted) break;
      candidates += 1;
      if (candidates > MAX_INLINE_CANDIDATES || count >= MAX_INLINE_IMAGES || total >= MAX_INLINE_TOTAL || this.now() >= deadline) break;
      let url;
      try {
        url = new URL(raw);
      } catch {
        continue;
      }
      const local = isLoopbackHostname(url.hostname);
      if (local && !serverLocal) {
        warnings.add('部分图片地址被安全策略拒绝。');
        continue;
      }
      if (url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
        warnings.add('部分图片地址被安全策略拒绝。');
        continue;
      }
      try {
        const timeout = Math.min(INLINE_IMAGE_TIMEOUT, Math.max(1, deadline - this.now()));
        const requestSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout);
        const response = local
          ? await this.localRequest(url.href, { redirect: 'error', signal: requestSignal })
          : await this.request(url.href, { redirect: 'error', signal: requestSignal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          warnings.add('部分图片地址无法访问。');
          continue;
        }
        const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!/^image\/(?:png|jpe?g|webp|gif)$/.test(mimeType)) {
          await response.body?.cancel().catch(() => {});
          warnings.add('部分链接不是支持的图片格式。');
          continue;
        }
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > MAX_INLINE_IMAGE || total + declared > MAX_INLINE_TOTAL) {
          await response.body?.cancel().catch(() => {});
          warnings.add('部分图片超过大小限制。');
          continue;
        }
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        for await (const chunk of response.body ?? []) {
          size += chunk.length;
          if (size > MAX_INLINE_IMAGE || total + size > MAX_INLINE_TOTAL) {
            tooLarge = true;
            break;
          }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        if (tooLarge || !body.length || body.length > MAX_INLINE_IMAGE || total + body.length > MAX_INLINE_TOTAL) {
          if (tooLarge || body.length > MAX_INLINE_IMAGE || total + body.length > MAX_INLINE_TOTAL) warnings.add('部分图片超过大小限制。');
          continue;
        }
        accepted.push({ type: 'image', data: body.toString('base64'), mimeType });
        total += body.length;
        count += 1;
      } catch {
        if (signal?.aborted) break;
        warnings.add('部分图片下载失败或超时。');
        // A broken preview link must not hide otherwise usable text or image content.
      }
    }
    if (signal?.aborted) throw new Error('MCP 工具调用已撤销。');
    if (warnings.size) accepted.push({ type: 'text', text: [...warnings].join('') });
    return accepted;
  }

  async call(plugin, { serverId, toolName, args, inlineImages = false } = {}) {
    if (!(plugin.permissions.mcp ?? []).includes('read')) throw new McpPolicyError('MCP 能力未授权。');
    const server = this.find(serverId);
    if (!server.enabled) throw new McpPolicyError('MCP 服务已停用。');
    if (typeof toolName !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(toolName)) throw new McpPolicyError('MCP 工具无效。');
    const grants = this.state.grants[plugin.id]?.[serverId] ?? [];
    if (!grants.includes(toolName)) throw new McpPolicyError('MCP 工具尚未授权。');
    const sideEffects = this.state.sideEffects[plugin.id]?.[serverId] ?? [];
    const approvedSideEffect = sideEffects.includes(toolName);
    const payload = args ?? {};
    if (Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8') > MAX_ARGUMENTS) throw new Error('MCP 调用参数过大。');
    const active = [...this.activeCalls];
    if (active.length >= MAX_ACTIVE_CALLS) throw new McpPolicyError('同时进行的 MCP 调用过多，请稍后重试。');
    if (active.filter(item => item.pluginId === plugin.id).length >= MAX_ACTIVE_CALLS_PER_PLUGIN) {
      throw new McpPolicyError('该插件同时进行的 MCP 调用过多，请稍后重试。');
    }
    const call = { pluginId: plugin.id, serverId, toolName, controller: new AbortController() };
    this.activeCalls.add(call);
    try {
      const tools = await this.abortable(this.listTools(server), call.controller.signal, 'MCP 工具调用已撤销。');
      const tool = tools.find(item => item.name === toolName);
      if (!tool) throw new McpPolicyError('MCP 工具不可调用。');
      if (!supportsToolInvocation(plugin) && tool.readOnly !== true) {
        throw new McpPolicyError('当前插件 API 版本只能调用只读 MCP 工具。');
      }
      if (tool.readOnly !== true && !approvedSideEffect) {
        throw new McpPolicyError('MCP 工具权限已变化，请重新授权。');
      }
      const { client } = await this.abortable(this.connect(server), call.controller.signal, 'MCP 工具调用已撤销。');
      const current = this.find(serverId);
      if (!current.enabled || current.updatedAt !== server.updatedAt) throw new McpPolicyError('MCP 服务已变化，请重新授权。');
      if (!(this.state.grants[plugin.id]?.[serverId] ?? []).includes(toolName)) throw new McpPolicyError('MCP 工具授权已撤销。');
      if (!approvedSideEffect) {
        const liveTools = await this.abortable(this.listTools(server, { fresh: true }), call.controller.signal, 'MCP 工具调用已撤销。');
        const liveTool = liveTools.find(item => item.name === toolName);
        if (!liveTool || liveTool.readOnly !== true) throw new McpPolicyError('MCP 工具权限已变化，请重新授权。');
      }
      const result = await this.withTimeout(
        client.callTool({ name: toolName, arguments: payload }, { timeout: REQUEST_TIMEOUT, signal: call.controller.signal }),
        REQUEST_TIMEOUT,
        'MCP 工具调用超时。',
        call.controller,
      );
      if (call.controller.signal.aborted) throw new Error('MCP 工具调用已撤销。');
      const content = inlineImages ? await this.inlineImageUrls(result.content ?? [], server, call.controller.signal) : result.content ?? [];
      const structuredContent = result.structuredContent;
      const text = JSON.stringify({ content, ...(structuredContent !== undefined ? { structuredContent } : {}) });
      if (Buffer.byteLength(text) > (inlineImages ? MAX_INLINE_RESPONSE : MAX_TOOL_RESPONSE)) throw new Error('MCP 服务响应过大。');
      return { content, ...(structuredContent !== undefined ? { structuredContent } : {}), ...(result.isError ? { isError: true } : {}) };
    } catch (error) {
      if (call.controller.signal.aborted) {
        const reason = call.controller.signal.reason;
        if (reason instanceof Error && /超时/.test(reason.message)) throw new Error(this.safeError(reason));
        throw new Error('MCP 工具调用已撤销。');
      }
      if (error instanceof McpPolicyError) throw error;
      throw new Error(this.safeError(error));
    } finally {
      this.activeCalls.delete(call);
    }
  }

  async create(input = {}) {
    const name = cleanText(input.name, 80, 'MCP 服务名称');
    const url = validateServerUrl(input.url);
    const authMode = input.authMode ?? 'none';
    if (!AUTH_MODES.has(authMode)) throw new Error('MCP 鉴权方式无效。');
    const headerName = authMode === 'bearer' ? (input.headerName || 'Authorization') : null;
    if (headerName) validateHeaderName(headerName);
    if (authMode === 'bearer') {
      if (typeof input.secret !== 'string' || !input.secret.trim() || input.secret.length > 4096) throw new Error('MCP 鉴权密钥无效。');
    }
    let created;
    await this.mutate(draft => {
      if (draft.servers.length >= MAX_SERVERS) throw new Error('MCP 服务数量已达上限。');
      if (draft.servers.some(server => server.name.toLowerCase() === name.toLowerCase())) throw new Error('已存在同名 MCP 服务。');
      const id = this.nextId(draft);
      const stamp = this.now();
      created = { id, name, url, authMode, headerName, enabled: true, createdAt: stamp, updatedAt: stamp };
      draft.servers.push(created);
    });
    if (authMode === 'bearer') await this.credentials.set(CREDENTIAL_NAMESPACE, this.secretName(created.id), input.secret.trim());
    return (await this.adminList()).find(server => server.id === created.id);
  }

  async update(id, patch = {}) {
    const current = this.find(id);
    const nextUrl = patch.url !== undefined ? validateServerUrl(patch.url) : current.url;
    const urlChanged = nextUrl !== current.url;
    const nextAuthMode = patch.authMode !== undefined ? patch.authMode : current.authMode;
    const nextHeaderName = patch.authMode !== undefined
      ? (nextAuthMode === 'bearer' ? (patch.headerName ?? current.headerName ?? 'Authorization') : null)
      : (current.authMode === 'bearer' && patch.headerName !== undefined ? patch.headerName : current.headerName);
    const trustChanged = urlChanged
      || nextAuthMode !== current.authMode
      || nextHeaderName !== current.headerName
      || patch.secret !== undefined;
    let updated;
    await this.mutate(draft => {
      const server = draft.servers.find(item => item.id === id);
      if (!server) throw new Error('MCP 服务不存在。');
      if (patch.name !== undefined) {
        const name = cleanText(patch.name, 80, 'MCP 服务名称');
        if (draft.servers.some(item => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw new Error('已存在同名 MCP 服务。');
        server.name = name;
      }
      if (patch.url !== undefined) server.url = nextUrl;
      if (patch.authMode !== undefined) {
        if (!AUTH_MODES.has(patch.authMode)) throw new Error('MCP 鉴权方式无效。');
        server.authMode = patch.authMode;
        server.headerName = patch.authMode === 'bearer' ? (patch.headerName ?? server.headerName ?? 'Authorization') : null;
        if (server.headerName) validateHeaderName(server.headerName);
      } else if (patch.headerName !== undefined && server.authMode === 'bearer') {
        server.headerName = validateHeaderName(patch.headerName);
      }
      if (patch.enabled !== undefined) server.enabled = Boolean(patch.enabled);
      if (trustChanged || patch.enabled === false) {
        for (const grants of Object.values(draft.grants)) delete grants[id];
        for (const effects of Object.values(draft.sideEffects)) delete effects[id];
        for (const [pluginId, grants] of Object.entries(draft.grants)) {
          if (!Object.keys(grants).length) delete draft.grants[pluginId];
        }
        for (const [pluginId, effects] of Object.entries(draft.sideEffects)) if (!Object.keys(effects).length) delete draft.sideEffects[pluginId];
      }
      server.updatedAt = Math.max(this.now(), server.updatedAt + 1);
      updated = { ...server };
    });
    if (urlChanged || current.authMode !== updated.authMode) {
      await this.credentials.clear(CREDENTIAL_NAMESPACE, this.secretName(id)).catch(() => {});
      for (const suffix of ['client', 'tokens', 'verifier', 'state']) await this.setOAuthCredential(id, suffix, null);
    }
    if (patch.secret !== undefined) {
      if (updated.authMode !== 'bearer' || typeof patch.secret !== 'string' || !patch.secret.trim() || patch.secret.length > 4096) throw new Error('MCP 鉴权密钥无效。');
      await this.credentials.set(CREDENTIAL_NAMESPACE, this.secretName(id), patch.secret.trim());
    }
    if (trustChanged || patch.enabled === false) this.abortActiveCalls(call => call.serverId === id);
    await this.closeServer(id);
    this.toolCache.delete(id);
    this.status.delete(id);
    this.errors.delete(id);
    return (await this.adminList()).find(server => server.id === id);
  }

  async remove(id) {
    this.find(id);
    this.abortActiveCalls(call => call.serverId === id);
    await this.closeServer(id);
    await this.mutate(draft => {
      draft.servers = draft.servers.filter(server => server.id !== id);
      for (const grants of Object.values(draft.grants)) delete grants[id];
      for (const effects of Object.values(draft.sideEffects)) delete effects[id];
      for (const [pluginId, grants] of Object.entries(draft.grants)) if (!Object.keys(grants).length) delete draft.grants[pluginId];
      for (const [pluginId, effects] of Object.entries(draft.sideEffects)) if (!Object.keys(effects).length) delete draft.sideEffects[pluginId];
    });
    await this.credentials.clear(CREDENTIAL_NAMESPACE, this.secretName(id)).catch(() => {});
    for (const suffix of ['client', 'tokens', 'verifier', 'state']) await this.setOAuthCredential(id, suffix, null);
    this.toolCache.delete(id);
    this.status.delete(id);
    this.errors.delete(id);
  }

  async test(id) {
    const server = this.find(id);
    if (!server.enabled) throw new Error('MCP 服务已停用。');
    await this.closeServer(id);
    this.toolCache.delete(id);
    const tools = await this.listTools(server);
    return {
      ok: true,
      toolCount: tools.length,
      readOnlyToolCount: tools.filter(tool => tool.readOnly).length,
      tools,
    };
  }

  async authorize(id) {
    const server = this.find(id);
    if (server.authMode !== 'oauth') throw new Error('该 MCP 服务不使用 OAuth 授权。');
    if (this.oauth.has(id)) throw new Error('该 MCP 服务正在授权。');
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const sockets = new Set();
    const callback = http.createServer((request, response) => {
      const pending = this.oauth.get(id);
      if (!pending || request.url?.split('?')[0] !== '/callback') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        response.end('Not found');
        return;
      }
      const url = new URL(request.url, pending.redirectUrl);
      if (url.searchParams.get('state') !== pending.state) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        response.end('授权校验失败');
        rejectDone(new Error('MCP 授权校验失败。'));
        return;
      }
      if (url.searchParams.get('error')) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        response.end('授权未完成');
        rejectDone(new Error('MCP 授权未完成。'));
        return;
      }
      pending.transport.finishAuth(url.searchParams).then(() => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        response.end('<!doctype html><meta charset="utf-8"><title>授权完成</title><p>授权已完成，可以关闭此页面并返回轻作。</p>');
        resolveDone();
      }).catch(() => {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        response.end('授权失败');
        rejectDone(new Error('MCP 授权失败。'));
      });
    });
    callback.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      callback.once('error', reject);
      callback.listen(0, '127.0.0.1', resolve);
    });
    this.callbackServers.add(callback);
    const address = callback.address();
    if (!address || typeof address === 'string') {
      callback.close();
      throw new Error('无法启动 MCP 授权回调。');
    }
    const redirectUrl = 'http://127.0.0.1:' + address.port + '/callback';
    const state = randomBytes(24).toString('base64url');
    await this.setOAuthCredential(id, 'state', { value: state });
    const pending = { redirectUrl, state, transport: null, authorizationUrl: null };
    this.oauth.set(id, pending);
    let client;
    let transport;
    try {
      client = this.clientFactory();
      transport = await this.createTransport(server);
      pending.transport = transport;
      try {
        await this.withTimeout(client.connect(transport), REQUEST_TIMEOUT, 'MCP 服务连接超时。');
      } catch (error) {
        if (!pending.authorizationUrl) throw error;
        await this.withTimeout(done, OAUTH_TIMEOUT, 'MCP 授权超时，请重试。');
      }
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      this.status.delete(id);
      this.errors.delete(id);
      const result = await this.test(id);
      this.log('MCP 服务授权完成，工具 ' + result.toolCount + ' 个。');
      return { ok: true, toolCount: result.toolCount, readOnlyToolCount: result.readOnlyToolCount };
    } catch (error) {
      await client?.close().catch(() => {});
      await transport?.close().catch(() => {});
      this.status.set(id, 'auth-required');
      this.errors.set(id, this.safeError(error));
      throw new Error(this.safeError(error));
    } finally {
      this.oauth.delete(id);
      this.callbackServers.delete(callback);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => callback.close(resolve));
    }
  }

  async revokePlugin(pluginId) {
    if (!this.state.grants[pluginId] && !this.state.sideEffects[pluginId]) return;
    await this.mutate(draft => {
      delete draft.grants[pluginId];
      delete draft.sideEffects[pluginId];
    });
    this.abortActiveCalls(call => call.pluginId === pluginId);
  }

  async shutdown() {
    this.abortActiveCalls(() => true);
    await Promise.allSettled([...this.clients.keys()].map(id => this.closeServer(id)));
    for (const socket of this.oauth.values()) socket.transport?.close?.().catch?.(() => {});
    this.oauth.clear();
    await Promise.all([...this.callbackServers].map(server => new Promise(resolve => server.close(resolve))));
    this.callbackServers.clear();
  }
}
