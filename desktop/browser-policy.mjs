const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function isAllowedBrowserUrl(value) {
  try {
    const address = new URL(value);
    return ALLOWED_PROTOCOLS.has(address.protocol) && Boolean(address.hostname) && !address.username && !address.password;
  } catch {
    return false;
  }
}

export function normalizeBrowserUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入完整的 HTTP 或 HTTPS 地址。');
  let address;
  try { address = new URL(value.trim()); }
  catch { throw new Error('请输入完整的 HTTP 或 HTTPS 地址。'); }
  if (!isAllowedBrowserUrl(address.href)) throw new Error('浏览器仅支持 HTTP 或 HTTPS 地址。');
  return address.href;
}

// A plugin limited to `automate` still needs to know whether the tab it opened
// is alive. It must never learn about tabs the user opened themselves, so the
// ownership filter is the only thing such a plugin may observe.
export function ownedBrowserTabs(tabs, pluginId) {
  if (typeof pluginId !== 'string' || !pluginId) return [];
  return (Array.isArray(tabs) ? tabs : []).filter(tab => tab && tab.owner === pluginId);
}

