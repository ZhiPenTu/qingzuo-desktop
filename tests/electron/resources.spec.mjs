import { test, expect, _electron } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

test('private file resources render and expire after release', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-resources-'));
  let app;
  try {
    const zip = new AdmZip(), artifact = path.join(temporary, 'resource.ecplugin');
    zip.addFile('package.json', Buffer.from(JSON.stringify({ name: 'resource-fixture', version: '0.1.0', commerce: { manifestVersion: 1, id: 'local.resource', title: 'Resource fixture', description: '', api: '^1.1.0', ui: 'ui/index.html', permissions: { files: true } } })));
    zip.addFile('ui/index.html', Buffer.from('<h1>Resource fixture</h1><img id="image">'));
    await writeFile(artifact, zip.toBuffer());
    app = await _electron.launch({ args: [process.cwd(), '--user-data-dir=' + path.join(temporary, 'profile')] });
    const page = await app.firstWindow();
    await expect(page.getByText('工具服务已就绪')).toBeVisible();
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); dialog.showMessageBox = async () => ({ response: 1 }); }, artifact);
    await page.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
    await page.getByRole('button', { name: '打开工具', exact: true }).click();
    await expect.poll(() => app.context().pages().some(candidate => candidate.url().startsWith('commerce-plugin://local.resource/'))).toBe(true);
    const plugin = app.context().pages().find(candidate => candidate.url().startsWith('commerce-plugin://local.resource/'));
    const token = await plugin.evaluate(async () => {
      const bridge = window.commercePlugin;
      const item = await bridge.invoke('files.create', { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=', filename: 'pixel.png', mime: 'image/png' });
      document.querySelector('#image').src = await bridge.invoke('files.url', { token: item.token });
      return item.token;
    });
    await expect.poll(() => plugin.locator('#image').evaluate(image => image.naturalWidth)).toBe(1);
    await plugin.evaluate(token => window.commercePlugin.invoke('files.release', { token }), token);
    await expect(plugin.evaluate(token => window.commercePlugin.invoke('files.url', { token }), token)).rejects.toThrow(/未授权|失效/);
  } finally { await app?.close(); await rm(temporary, { recursive: true, force: true }); }
});
