import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { validateToolSchema } from './tool-schema-core.mjs';
export const API_VERSION = '1.3.0';
export const TARGET = process.platform + '-' + process.arch;
export const RESERVED_HEADERS = ['authorization', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection', 'te', 'trailer'];
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.includes('\0') || path.posix.isAbsolute(value)) throw new Error('插件路径无效。');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('插件路径无效。');
  return value;
}
export function validateManifest(pkg, target = TARGET) {
  const m = pkg?.commerce;
  if (!m || m.manifestVersion !== 1 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(m.id) || m.id.startsWith('system.') || m.id.length > 96) throw new Error('插件标识或清单格式无效。');
  if (!semver.valid(pkg.version) || !semver.satisfies(API_VERSION, m.api || '')) throw new Error('插件 API 版本不兼容。');
  if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 80 || typeof m.description !== 'string' || m.description.length > 2000) throw new Error('插件名称与说明无效。');
  safeRelative(m.ui);
  if (m.settings) { if (typeof m.settings.title !== 'string') throw new Error('插件设置无效。'); safeRelative(m.settings.entry); }
  const permissions = m.permissions ?? {};
  if (Object.keys(permissions).some(k => !['files', 'network', 'credentials', 'ai', 'browser', 'browserOrigins', 'networkHeaders', 'storage'].includes(k))) throw new Error('插件申请了不支持的权限。');
  if (permissions.ai !== undefined && (!Array.isArray(permissions.ai) || new Set(permissions.ai).size !== permissions.ai.length || permissions.ai.some(value => !['assistant', 'image-edit'].includes(value)))) throw new Error('AI 权限无效。');
  if (permissions.files !== undefined && typeof permissions.files !== 'boolean') throw new Error('文件权限无效。');
  if (permissions.storage !== undefined && typeof permissions.storage !== 'boolean') throw new Error('存储权限无效。');
  if (permissions.browser !== undefined && (!Array.isArray(permissions.browser) || new Set(permissions.browser).size !== permissions.browser.length || permissions.browser.some(value => !['detect', 'download', 'automate'].includes(value)))) throw new Error('浏览器权限无效。');
  for (const key of ['network', 'credentials']) if (permissions[key] !== undefined && (!Array.isArray(permissions[key]) || permissions[key].length > 16 || permissions[key].some(v => typeof v !== 'string'))) throw new Error('插件权限无效。');
  for (const origin of permissions.network ?? []) { const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('网络权限必须为 HTTPS 来源。'); }
  for (const name of permissions.credentials ?? []) if (!/^[a-z][a-z0-9.-]{0,63}$/.test(name)) throw new Error('凭据名称无效。');
  if (permissions.browserOrigins !== undefined) {
    if (!Array.isArray(permissions.browserOrigins) || permissions.browserOrigins.length > 16 || new Set(permissions.browserOrigins).size !== permissions.browserOrigins.length) throw new Error('浏览器页面权限无效。');
    for (const origin of permissions.browserOrigins) {
      if (typeof origin !== 'string' || origin.length > 255) throw new Error('浏览器页面权限无效。');
      let url; try { url = new URL(origin); } catch { throw new Error('浏览器页面权限无效。'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('浏览器页面权限必须为来源地址。');
    }
    if (permissions.browserOrigins.length && !(permissions.browser ?? []).includes('automate')) throw new Error('浏览器页面权限需要同时申请页面操作能力。');
  }
  if (permissions.networkHeaders !== undefined) {
    if (!Array.isArray(permissions.networkHeaders) || permissions.networkHeaders.length > 16 || new Set(permissions.networkHeaders.map(name => String(name).toLowerCase())).size !== permissions.networkHeaders.length) throw new Error('请求头权限无效。');
    for (const name of permissions.networkHeaders) {
      if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) || RESERVED_HEADERS.includes(name.toLowerCase())) throw new Error('请求头权限无效。');
    }
  }
  for (const kind of ['provides', 'requires']) if (m.services?.[kind] && (!Array.isArray(m.services[kind]) || m.services[kind].some(s => !/^[a-z][a-z0-9.-]{1,95}$/.test(s)))) throw new Error('服务声明无效。');
  if (m.assistant !== undefined) {
    if (!m.assistant || Object.keys(m.assistant).some(key => key !== 'tools') || !Array.isArray(m.assistant.tools) || m.assistant.tools.length > 16) throw new Error('助手能力声明无效。');
    const names = new Set(['open', 'settings', 'list_batches', 'get_batch', 'prepare_plan', 'start_batch', 'cancel_batch']);
    for (const tool of m.assistant.tools) {
      if (!tool || Object.keys(tool).some(key => !['name', 'title', 'description', 'service', 'method', 'parameters'].includes(key)) || !/^[a-z][a-z0-9_]{1,47}$/.test(tool.name) || names.has(tool.name) || typeof tool.title !== 'string' || !tool.title.trim() || tool.title.length > 80 || typeof tool.description !== 'string' || tool.description.length > 1000 || !m.backend || !(m.services?.provides || []).includes(tool.service) || !/^[a-z][a-zA-Z0-9.]{0,79}$/.test(tool.method)) throw new Error('助手工具声明无效。');
      validateToolSchema(tool.parameters); if (tool.parameters.type !== 'object') throw new Error('工具参数必须为对象。'); names.add(tool.name);
    }
  }
  if (m.backend) { if (!['node', 'executable'].includes(m.backend.type) || !m.backend.entry?.[target]) throw new Error('插件不支持当前平台。'); for (const entry of Object.values(m.backend.entry)) safeRelative(entry); }
  return { ...m, permissions, version: pkg.version };
}
export async function confinedPath(root, relative) {
  safeRelative(relative);
  const canonical = await realpath(root);
  let cursor = canonical;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('插件资源不允许符号链接。');
  }
  const resolved = await realpath(cursor);
  if (!resolved.startsWith(canonical + path.sep)) throw new Error('资源越过插件目录。');
  return resolved;
}
export function allowedNetwork(manifest, address) {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || !(manifest.permissions.network ?? []).includes(url.origin)) throw new Error('插件没有访问此服务的权限。');
  return url;
}
export function allowedBrowserOrigin(manifest, address) {
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !(manifest.permissions.browserOrigins ?? []).includes(url.origin)) throw new Error('插件没有操作此页面的权限。');
  return url;
}
export function allowedHeaderName(manifest, name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) || RESERVED_HEADERS.includes(name.toLowerCase())) throw new Error('请求头无效。');
  const declared = (manifest.permissions.networkHeaders ?? []).map(value => value.toLowerCase());
  if (!declared.includes(name.toLowerCase())) throw new Error('请求头未授权。');
  return name;
}
