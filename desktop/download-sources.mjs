import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { publicAddress } from "./network-transport.mjs";
import { RangeUnavailable } from "./update-download.mjs";

export const DOWNLOAD_SOURCES = Object.freeze(["github", "gitcode", "gh-proxy", "gh-fast"]);
export const MAX_CUSTOM_MIRRORS = 12;

const BUILTIN_LABELS = Object.freeze({
  github: "GitHub 官方源",
  gitcode: "GitCode 国内源",
  "gh-proxy": "GitHub 镜像 · gh-proxy.com",
  "gh-fast": "GitHub 镜像 · ghfast.top",
});

const BUILTIN_PREFIXES = Object.freeze({
  "gh-proxy": "https://gh-proxy.com/",
  "gh-fast": "https://ghfast.top/",
});

const GITHUB_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "api.github.com",
]);

const RESERVED_MIRROR_HOSTS = new Set([
  ...GITHUB_HOSTS,
  "gh-proxy.com",
  "www.gh-proxy.com",
  "ghfast.top",
  "www.ghfast.top",
  "gitcode.com",
  "www.gitcode.com",
  "raw.gitcode.com",
  "api.gitcode.com",
]);

async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, filename);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export function normalizeCustomMirrorUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new Error("请输入自定义镜像前缀地址。");
  if (/[\u0000-\u001f\u007f\s]/.test(value)) throw new Error("自定义镜像地址不能包含空白或控制字符。");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("自定义镜像地址格式无效，请输入完整的 HTTPS 地址。");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("自定义镜像必须为不含认证信息、端口、查询参数或片段的 HTTPS 地址。");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || /\.(?:local|localhost|internal)$/i.test(host) || (isIP(host) && !publicAddress(host))) {
    throw new Error("自定义镜像禁止使用本机或内网地址。");
  }
  if (!host.includes(".")) throw new Error("自定义镜像域名无效。");
  if (RESERVED_MIRROR_HOSTS.has(host)) throw new Error("该地址已作为内置源提供，请直接从下拉列表中选择。");
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url.toString();
}

export function formatDownloadSourceLabel(source) {
  if (typeof source !== "string") return BUILTIN_LABELS.github;
  if (Object.hasOwn(BUILTIN_LABELS, source)) return BUILTIN_LABELS[source];
  if (source.startsWith("custom:")) {
    const raw = source.slice(7);
    try {
      return `自定义镜像 · ${new URL(raw).host}`;
    } catch {
      return "自定义镜像";
    }
  }
  return BUILTIN_LABELS.github;
}

export function isGitHubFamilyUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" && GITHUB_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function rewriteDownloadUrl(url, source = "github") {
  const parsed = new URL(String(url));
  const host = parsed.hostname.toLowerCase();
  if (!GITHUB_HOSTS.has(host) || source === "github") return parsed.toString();
  if (Object.hasOwn(BUILTIN_PREFIXES, source)) {
    return `${BUILTIN_PREFIXES[source]}${parsed.toString()}`;
  }
  if (typeof source === "string" && source.startsWith("custom:")) {
    const prefix = normalizeCustomMirrorUrl(source.slice(7));
    return `${prefix}${parsed.toString()}`;
  }
  if (source === "gitcode") {
    if (host === "raw.githubusercontent.com") {
      const match = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(parsed.pathname);
      if (match) return `https://raw.gitcode.com/${match[1]}/${match[2]}/raw/${match[3]}/${match[4]}${parsed.search}`;
    }
    if (host === "github.com" || host === "www.github.com") {
      return `https://gitcode.com${parsed.pathname}${parsed.search}`;
    }
    if (host === "api.github.com") {
      const match = /^\/repos\/([^/]+)\/([^/]+)\/releases\/(.+)$/.exec(parsed.pathname);
      if (match) return `https://api.gitcode.com/api/v5/repos/${match[1]}/${match[2]}/releases/${match[3]}${parsed.search}`;
    }
  }
  return parsed.toString();
}

export function candidateDownloadSources(state = {}) {
  const customMirrors = Array.isArray(state.customMirrors) ? state.customMirrors : [];
  const gitcodeAvailable = state.gitcodeAvailable !== false;
  const primary = typeof state.source === "string" && state.source ? state.source : "github";
  const ordered = [
    primary,
    ...customMirrors.map(mirror => `custom:${mirror}`),
    "gh-proxy",
    "gh-fast",
    "github",
    ...(gitcodeAvailable ? ["gitcode"] : []),
  ];
  const seen = new Set();
  const result = [];
  for (const item of ordered) {
    if (item === "gitcode" && !gitcodeAvailable) continue;
    if (item.startsWith("custom:") && !customMirrors.includes(item.slice(7))) continue;
    if (!seen.has(item) && (DOWNLOAD_SOURCES.includes(item) || item.startsWith("custom:"))) {
      seen.add(item);
      result.push(item);
    }
  }
  return result.length ? result : ["github"];
}

function hasRangeHeader(headers) {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has("range");
  if (Array.isArray(headers)) return headers.some(([key]) => String(key).toLowerCase() === "range");
  if (typeof headers === "object") return Object.keys(headers).some(key => key.toLowerCase() === "range");
  return false;
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted) || error?.name === "AbortError" || error instanceof RangeUnavailable;
}

export class DownloadSourceService {
  constructor({ root, fetchImpl = globalThis.fetch, gitcodeAvailable = true, changed = () => {} } = {}) {
    this.root = root;
    this.file = root ? path.join(root, "download-sources.json") : null;
    this.fetchImpl = fetchImpl;
    this.changed = changed;
    this.state = {
      source: "github",
      customMirrors: [],
      gitcodeAvailable: Boolean(gitcodeAvailable),
      notice: null,
    };
  }

  snapshot() {
    return {
      source: this.state.source,
      customMirrors: [...this.state.customMirrors],
      gitcodeAvailable: this.state.gitcodeAvailable,
      notice: this.state.notice,
    };
  }

  async initialize() {
    if (!this.file) return this.snapshot();
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      const mirrors = [];
      if (Array.isArray(raw?.customMirrors)) {
        for (const item of raw.customMirrors) {
          if (mirrors.length >= MAX_CUSTOM_MIRRORS) break;
          try {
            const normalized = normalizeCustomMirrorUrl(item);
            if (!mirrors.includes(normalized)) mirrors.push(normalized);
          } catch {}
        }
      }
      let source = "github";
      if (typeof raw?.source === "string") {
        if (DOWNLOAD_SOURCES.includes(raw.source) && (raw.source !== "gitcode" || this.state.gitcodeAvailable)) {
          source = raw.source;
        } else if (raw.source.startsWith("custom:")) {
          try {
            const normalized = normalizeCustomMirrorUrl(raw.source.slice(7));
            if (!mirrors.includes(normalized) && mirrors.length < MAX_CUSTOM_MIRRORS) mirrors.push(normalized);
            if (mirrors.includes(normalized)) source = `custom:${normalized}`;
          } catch {}
        }
      }
      this.state.customMirrors = mirrors;
      this.state.source = source;
      this.state.notice = null;
    } catch (error) {
      if (error?.code !== "ENOENT") await rm(this.file, { force: true }).catch(() => {});
    }
    return this.snapshot();
  }

  async persist() {
    if (!this.file) return;
    await atomicJson(this.file, {
      schemaVersion: 1,
      source: this.state.source,
      customMirrors: this.state.customMirrors,
    });
  }

  validateSource(source) {
    if (typeof source !== "string" || !source) throw new Error("下载源标识无效。");
    if (source === "gitcode" && !this.state.gitcodeAvailable) {
      throw new Error("当前构建未配置完整的 GitCode 镜像源。");
    }
    if (DOWNLOAD_SOURCES.includes(source)) return source;
    if (source.startsWith("custom:")) {
      const normalized = normalizeCustomMirrorUrl(source.slice(7));
      if (!this.state.customMirrors.includes(normalized)) throw new Error("所选自定义镜像源不存在。");
      return `custom:${normalized}`;
    }
    throw new Error("不支持的下载源。");
  }

  async setSource(source) {
    const validated = this.validateSource(source);
    this.state.source = validated;
    this.state.notice = null;
    await this.persist();
    this.changed();
    return this.snapshot();
  }

  async addCustomMirror(url) {
    const normalized = normalizeCustomMirrorUrl(url);
    if (!this.state.customMirrors.includes(normalized)) {
      if (this.state.customMirrors.length >= MAX_CUSTOM_MIRRORS) {
        throw new Error(`最多可添加 ${MAX_CUSTOM_MIRRORS} 个自定义镜像源。`);
      }
      this.state.customMirrors = [...this.state.customMirrors, normalized];
    }
    this.state.source = `custom:${normalized}`;
    this.state.notice = null;
    await this.persist();
    this.changed();
    return this.snapshot();
  }

  async removeCustomMirror(url) {
    const normalized = normalizeCustomMirrorUrl(url);
    if (!this.state.customMirrors.includes(normalized)) {
      throw new Error("自定义镜像源不存在。");
    }
    this.state.customMirrors = this.state.customMirrors.filter(item => item !== normalized);
    if (this.state.source === `custom:${normalized}`) {
      this.state.source = "github";
    }
    this.state.notice = null;
    await this.persist();
    this.changed();
    return this.snapshot();
  }

  async markAutoFallback(candidate, previousSource) {
    if (!candidate || candidate === previousSource) return;
    this.state.source = candidate;
    this.state.notice = `当前下载源检测失败，已自动切换至 ${formatDownloadSourceLabel(candidate)}`;
    await this.persist().catch(() => {});
    this.changed();
  }

  async runWithFallback(url, operation, { signal } = {}) {
    if (!isGitHubFamilyUrl(url)) return operation(String(url), this.state.source);
    const initialSource = this.state.source;
    const candidates = candidateDownloadSources(this.state);
    let firstError = null;
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const rewritten = rewriteDownloadUrl(url, candidate);
      try {
        const result = await operation(rewritten, candidate);
        if (candidate !== initialSource) await this.markAutoFallback(candidate, initialSource);
        return result;
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        firstError ??= error;
      }
    }
    throw firstError ?? new Error("所有下载源均无法连接。");
  }

  async fetch(url, options = {}) {
    if (!isGitHubFamilyUrl(url)) return this.fetchImpl(url, options);
    const initialSource = this.state.source;
    const candidates = candidateDownloadSources(this.state);
    const ranged = hasRangeHeader(options.headers);
    const manualRedirect = options.redirect === "manual";
    let firstError = null;
    let firstFailedResponse = null;

    for (const candidate of candidates) {
      options.signal?.throwIfAborted();
      const rewritten = rewriteDownloadUrl(url, candidate);
      try {
        const response = await this.fetchImpl(rewritten, options);
        const validRedirect = manualRedirect && [301, 302, 303, 307, 308].includes(response.status) && Boolean(response.headers?.get("location"));
        const acceptableRange = ranged && response.status === 416;
        if (response.ok || validRedirect || acceptableRange) {
          if (candidate !== initialSource) await this.markAutoFallback(candidate, initialSource);
          return response;
        }
        await response.body?.cancel().catch(() => {});
        firstFailedResponse ??= new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        if (isAbortError(error, options.signal)) throw error;
        firstError ??= error;
      }
    }

    if (firstFailedResponse) return firstFailedResponse;
    throw firstError ?? new Error("所有下载源均无法连接。");
  }
}
