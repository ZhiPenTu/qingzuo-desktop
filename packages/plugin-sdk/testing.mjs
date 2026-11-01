import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function launchPluginTestHost({ executablePath, artifactPath, pluginId, env = {} }) {
  const { _electron, expect } = await import('@playwright/test');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-plugin-test-'));
  let app;
  try {
    const environment = { ...process.env, ...env };
    delete environment.NODE_PATH;
    delete environment.NODE_OPTIONS;
    app = await _electron.launch({ executablePath: path.resolve(executablePath), cwd: temporary,
      args: ['--user-data-dir=' + path.join(temporary, 'profile')], env: environment, timeout: 60000 });
    const page = await app.firstWindow();
    await expect.poll(async () => (await page.evaluate(() => window.commerceDesktop.invoke('status'))).kernel.ready, { timeout: 60000 }).toBe(true);
    await app.evaluate(({ dialog }, artifact) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [artifact] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, path.resolve(artifactPath));
    await page.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
    const status = await page.evaluate(() => window.commerceDesktop.invoke('status'));
    const title = status.plugins.find(candidate => candidate.id === pluginId)?.title;
    if (!title) throw new Error('Test plugin did not install.');
    await page.getByRole('button', { name: '工具中心', exact: true }).click();
    await page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button', { name: '打开', exact: true }).click();
    await expect.poll(() => app.context().pages().some(candidate => candidate.url().startsWith('commerce-plugin://' + pluginId + '/')), { timeout: 60000 }).toBe(true);
    const plugin = app.context().pages().find(candidate => candidate.url().startsWith('commerce-plugin://' + pluginId + '/'));
    return { app, page, plugin, temporary, async close() { await app.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } };
  } catch (error) {
    await app?.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw error;
  }
}
