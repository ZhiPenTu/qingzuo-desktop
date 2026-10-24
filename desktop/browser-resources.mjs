import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { routedAddress } from './network-transport.mjs';

export const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;

export async function assertPublicResource(address, resolve = lookup, { allowPrivate = false } = {}) {
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('图片地址无效。');
  // A resource on the exact origin the user already opened is reachable
  // through that tab, so private hosts are only exempt for that same origin.
  if (allowPrivate) return url;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || /(^|\.)(local|localhost|internal|localdomain)$/i.test(hostname)) throw new Error('图片地址不可访问。');
  if (isIP(hostname)) {
    if (!routedAddress(hostname, hostname)) throw new Error('图片地址不可访问。');
    return url;
  }
  const resolved = await resolve(hostname, { all: true }).catch(() => []);
  if (!resolved.length || resolved.some(row => !routedAddress(row.address, hostname))) throw new Error('图片地址不可访问。');
  return url;
}

export function resourceFilename(address, mime) {
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[mime] || 'bin';
  try {
    const base = decodeURIComponent(new URL(address).pathname.split('/').pop() || '');
    if (/^[A-Za-z0-9_.-]{1,80}\.(png|jpe?g|webp|gif|avif)$/i.test(base)) return base;
  } catch {}
  // Stable per address so retries and duplicate gallery entries reuse one name.
  return 'image-' + createHash('sha256').update(String(address)).digest('hex').slice(0, 8) + '.' + extension;
}

export async function readImageResource({ fetch, address, referer, maxBytes = MAX_RESOURCE_BYTES, resolve = lookup, sameOrigin = null, signal }) {
  const allowed = origin => Boolean(sameOrigin && origin === sameOrigin);
  let requested = null;
  try { requested = new URL(address).origin; } catch {}
  const url = await assertPublicResource(address, resolve, { allowPrivate: allowed(requested) });
  const response = await fetch(url.href, { credentials: 'include', redirect: 'follow', signal, headers: { Referer: referer, Accept: 'image/*,*/*;q=0.8' } });
  if (!response.ok) throw new Error('图片读取失败（' + response.status + '）。');
  if (response.url && response.url !== url.href) {
    const target = new URL(response.url);
    await assertPublicResource(response.url, resolve, { allowPrivate: allowed(url.origin) && allowed(target.origin) });
  }
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\//.test(mime)) throw new Error('该地址不是图片。');
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('图片超过 32 MB。');
      chunks.push(chunk);
    }
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) throw new Error('图片内容为空。');
  return { bytes, mime, name: resourceFilename(response.url || url.href, mime) };
}
