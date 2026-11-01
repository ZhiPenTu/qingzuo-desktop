export const DOWNLOAD_SOURCE_OPTIONS = Object.freeze([
  { id: 'github', label: 'GitHub 官方' },
  { id: 'gh-proxy', label: 'gh-proxy 加速', prefix: 'https://gh-proxy.com/' },
  { id: 'gh-fast', label: 'ghfast 加速', prefix: 'https://ghfast.top/' },
  { id: 'gitcode', label: 'GitCode 国内镜像' },
]);

const DOWNLOAD_SOURCE_IDS = new Set(DOWNLOAD_SOURCE_OPTIONS.map(source => source.id));
const DOWNLOAD_SOURCE_PREFIXES = new Map(
  DOWNLOAD_SOURCE_OPTIONS.filter(source => source.prefix).map(source => [source.id, source.prefix])
);
const GITHUB_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'api.github.com',
]);

export function normalizeDownloadSource(value) {
  return DOWNLOAD_SOURCE_IDS.has(value) ? value : 'github';
}

export function rewriteGitHubUrl(rawUrl, source = 'github') {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return String(rawUrl);
  }

  const normalizedSource = normalizeDownloadSource(source);
  const host = url.hostname.toLowerCase();
  if (!GITHUB_HOSTS.has(host) || normalizedSource === 'github') return url.toString();

  const prefix = DOWNLOAD_SOURCE_PREFIXES.get(normalizedSource);
  if (prefix) return prefix + url.toString();

  if (normalizedSource === 'gitcode') {
    if (host === 'raw.githubusercontent.com') {
      const match = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (match) {
        return `https://raw.gitcode.com/${match[1]}/${match[2]}/raw/${match[3]}/${match[4]}${url.search}`;
      }
    }
    if (host === 'github.com' || host === 'www.github.com') {
      return `https://gitcode.com${url.pathname}${url.search}`;
    }
    if (host === 'api.github.com') {
      const match = /^\/repos\/([^/]+)\/([^/]+)\/releases\/(.+)$/.exec(url.pathname);
      if (match) {
        return `https://api.gitcode.com/api/v5/repos/${match[1]}/${match[2]}/releases/${match[3]}${url.search}`;
      }
    }
  }

  return url.toString();
}
