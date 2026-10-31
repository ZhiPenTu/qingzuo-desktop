const { ipcRenderer } = require('electron');

const MAX_ITEMS = 160;
const MEDIA_EXTENSIONS = /\.(?:avif|gif|jpe?g|m3u8|mov|mp4|png|webm|webp)(?:[?#]|$)/i;
let timer = null;

function clean(value, limit = 160) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function absolute(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function contextTitle(element) {
  const root = element.closest('article, [data-e2e*="feed"], [class*="card"], [class*="item"], li') || element.parentElement;
  const text = clean(root?.innerText || document.title || '');
  return text.split(' ').slice(0, 24).join(' ');
}

function add(items, seen, type, rawUrl, rawThumbnail, element) {
  const url = absolute(rawUrl);
  const thumbnailUrl = absolute(rawThumbnail);
  const title = contextTitle(element);
  const key = `${type}|${url || ''}|${thumbnailUrl || ''}|${title}`;
  if (seen.has(key) || items.length >= MAX_ITEMS) return;
  seen.add(key);
  items.push({ type, url, thumbnailUrl, title });
}

function scan() {
  timer = null;
  if (!/^https?:$/i.test(location.protocol)) return;
  const items = [];
  const seen = new Set();
  document.querySelectorAll('video').forEach(video => {
    add(items, seen, 'video', video.currentSrc || video.src, video.poster, video);
    video.querySelectorAll('source[src]').forEach(source => add(items, seen, 'video', source.src, video.poster, video));
  });
  document.querySelectorAll('img').forEach(image => {
    const width = image.naturalWidth || Number(image.getAttribute('width')) || 0;
    const height = image.naturalHeight || Number(image.getAttribute('height')) || 0;
    const raw = image.currentSrc || image.src;
    if ((width >= 120 && height >= 80) || MEDIA_EXTENSIONS.test(raw || '')) add(items, seen, 'image', raw, raw, image);
  });
  document.querySelectorAll('a[href]').forEach(anchor => {
    const href = absolute(anchor.href);
    if (!href || !MEDIA_EXTENSIONS.test(href)) return;
    const type = /\.(?:m3u8|mov|mp4|webm)(?:[?#]|$)/i.test(href) ? 'video' : 'image';
    add(items, seen, type, href, anchor.querySelector('img')?.currentSrc || '', anchor);
  });
  ipcRenderer.send('commerce:browser-candidates', {
    pageUrl: location.href,
    candidates: items,
  });
}

function schedule() {
  if (timer !== null) return;
  timer = setTimeout(scan, 220);
}

window.addEventListener('DOMContentLoaded', schedule, { once: true });
window.addEventListener('load', schedule, { once: true });
window.addEventListener('scroll', schedule, { passive: true });
window.addEventListener('hashchange', schedule);
window.addEventListener('commerce:rescan', schedule);
const observeDocument = () => {
  if (document.documentElement) new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'poster', 'href'] });
};
if (document.documentElement) observeDocument();
else window.addEventListener('DOMContentLoaded', observeDocument, { once: true });
schedule();
