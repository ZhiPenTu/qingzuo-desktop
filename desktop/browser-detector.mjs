import path from 'node:path';
import { createHash } from 'node:crypto';

const MEDIA_EXTENSIONS = new Set([
  '.avif', '.gif', '.jpeg', '.jpg', '.m3u8', '.mov', '.mp4', '.png', '.webm', '.webp'
]);
const INVALID_FILENAME = /[<>:"/\\|?*\x00-\x1f\x7f]/g;

export const MAX_BROWSER_CANDIDATES = 200;

export function cleanCandidateText(value, limit = 160) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

export function normalizeCandidateUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let address;
  try { address = new URL(value.trim(), base); }
  catch { return null; }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) return null;
  return address.href;
}

export function likelyMediaUrl(value, type) {
  if (typeof value !== 'string') return false;
  try {
    const extension = path.posix.extname(new URL(value).pathname).toLowerCase();
    if (MEDIA_EXTENSIONS.has(extension)) return true;
  } catch { /* The caller still gets a type hint from the DOM or network. */ }
  return type === 'video' || type === 'image';
}

export function candidateKey({ sourceUrl, type, title, pageUrl, thumbnailUrl }) {
  const raw = sourceUrl || [type, pageUrl, title, thumbnailUrl].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

export function safeFilename(title, sourceUrl, type) {
  const sourceName = (() => {
    try { return path.posix.basename(new URL(sourceUrl).pathname); }
    catch { return ''; }
  })();
  const fallback = type === 'image' ? 'image.jpg' : 'video.mp4';
  let filename = cleanCandidateText(title, 120).replace(INVALID_FILENAME, '_').replace(/[. ]+$/g, '').trim();
  if (!filename) filename = sourceName || fallback;
  if (!path.extname(filename)) filename += type === 'image' ? '.jpg' : '.mp4';
  return filename.slice(0, 180) || fallback;
}

export function publicCandidate(candidate) {
  const publicPageUrl = (() => {
    try {
      const url = new URL(candidate.pageUrl);
      url.search = '';
      url.hash = '';
      return url.href;
    } catch { return candidate.pageUrl; }
  })();
  const publicThumbnailUrl = (() => {
    try {
      const url = new URL(candidate.thumbnailUrl);
      return url.search || url.username || url.password ? null : url.href;
    } catch { return null; }
  })();
  return {
    id: candidate.id,
    tabId: candidate.tabId,
    type: candidate.type,
    title: candidate.title,
    pageUrl: publicPageUrl,
    ...(publicThumbnailUrl ? { thumbnailUrl: publicThumbnailUrl } : {}),
    status: candidate.status,
    ...(candidate.reason ? { reason: candidate.reason } : {}),
  };
}
