import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const root = process.cwd();

function pluginArtifact(id) {
  const zip = new AdmZip();
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name: id,
    version: '0.1.0',
    commerce: {
      manifestVersion: 1,
      id,
      title: 'Surface fixture',
      description: 'Surface fixture',
      api: '^1.0.0',
      ui: 'ui/index.html',
      settings: { title: '设置', entry: 'ui/settings.html' },
      permissions: {},
    },
  })));
  zip.addFile('ui/index.html', Buffer.from('<!doctype html><meta charset="utf-8"><h1>Surface fixture</h1>'));
  zip.addFile('ui/settings.html', Buffer.from('<!doctype html><meta charset="utf-8"><h1>Surface settings</h1>'));
  return zip;
}

const surfaceState = application => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(child => ({
  visible: child.getVisible?.() ?? null,
  url: child.webContents?.getURL?.() ?? null,
  bounds: child.getBounds?.() ?? null,
})));

test('leaving a tool while it reloads keeps the native surface hidden', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-tool-surface-'));
  const profile = path.join(temporary, 'profile');
  const id = 'local.surface-fixture';
  let application;
  try {
    application = await electron.launch({ args: [root, '--user-data-dir=' + profile], timeout: 20000 });
    const page = await application.firstWindow();
    await expect(page.getByText('工具服务已就绪')).toBeVisible();

    const artifact = path.join(temporary, id + '.ecplugin');
    pluginArtifact(id).writeZip(artifact);
    await application.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, artifact);
    await page.evaluate(() => window.commerceDesktop.invoke('plugins.import'));

    await page.getByRole('button', { name: '工具中心', exact: true }).click();
    await page.getByRole('button', { name: '打开工具', exact: true }).click();
    await page.getByRole('tab', { name: /Surface fixture/ }).waitFor();
    await expect.poll(async () => (await surfaceState(application)).some(view => view.visible)).toBe(true);

    // Open the settings entry of the tool that is already on screen, then leave
    // for the tool centre before that navigation finishes. The tool must not
    // paint itself over the page the user moved on to.
    await page.evaluate(async pluginId => {
      void window.commerceDesktop.invoke('view.open', { id: pluginId, settings: true });
      void window.commerceDesktop.invoke('view.hide');
    }, id);
    await expect.poll(async () => (await surfaceState(application)).filter(view => view.visible).length, { timeout: 5000 }).toBe(0);

    // A reported rectangle must also be clamped onto the window instead of
    // leaving the native surface detached from its area.
    await page.evaluate(pluginId => window.commerceDesktop.invoke('view.bounds', { id: pluginId, x: 0, y: 0, width: 99999, height: 99999 }), id);
    await expect.poll(async () => (await surfaceState(application))[0]?.bounds).not.toEqual(null);
    const [surface] = await surfaceState(application);
    const content = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
    expect(surface.bounds.width).toBe(content.width);
    expect(surface.bounds.height).toBe(content.height);
  } finally {
    await application?.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});
