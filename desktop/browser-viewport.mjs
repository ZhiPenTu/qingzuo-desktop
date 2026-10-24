const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const held = new WeakMap();

function metricsFor(size) {
  const width = Math.max(MIN_WIDTH, Math.floor(Number(size?.width) || 0));
  const height = Math.max(MIN_HEIGHT, Math.floor(Number(size?.height) || 0));
  return { width, height, deviceScaleFactor: 1, mobile: false };
}

async function measure(webContents) {
  const value = await webContents.executeJavaScript('[window.innerWidth, window.innerHeight]', true).catch(() => null);
  const width = Number(Array.isArray(value) ? value[0] : 0);
  const height = Number(Array.isArray(value) ? value[1] : 0);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : { width: 0, height: 0 };
}

async function applyMetrics(webContents, metrics) {
  const attachedHere = !webContents.debugger.isAttached();
  if (attachedHere) webContents.debugger.attach('1.3');
  try { await webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', metrics); }
  finally { if (attachedHere) { try { webContents.debugger.detach(); } catch {} } }
}

// A WebContentsView that is not composited reports a 0×0 viewport, which
// collapses every block element and leaves page collection with empty text.
// Device metrics give the renderer a layout viewport without showing the pane.
export async function ensureBrowserLayout(webContents, size) {
  if (!webContents || webContents.isDestroyed()) throw new Error('浏览器页面尚未打开。');
  const current = await measure(webContents);
  if (current.width >= 1 && current.height >= 1) return current;
  const metrics = metricsFor(size);
  try { await applyMetrics(webContents, metrics); }
  catch { throw new Error('浏览器页面尚未完成布局，请稍后重试。'); }
  let applied = await measure(webContents);
  if (applied.width >= 1 && applied.height >= 1) return applied;
  // Some Chromium builds drop the override together with the debugger
  // session; keep the session only for as long as this view stays hidden.
  try {
    webContents.debugger.attach('1.3');
    await webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', metrics);
    held.set(webContents, true);
  } catch { throw new Error('浏览器页面尚未完成布局，请稍后重试。'); }
  applied = await measure(webContents);
  if (applied.width < 1 || applied.height < 1) throw new Error('浏览器页面尚未完成布局，请稍后重试。');
  return applied;
}

export async function releaseBrowserLayout(webContents) {
  if (!webContents || webContents.isDestroyed() || !held.has(webContents)) return;
  held.delete(webContents);
  try { await webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'); } catch {}
  try { webContents.debugger.detach(); } catch {}
}
