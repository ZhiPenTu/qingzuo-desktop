import { test, expect, _electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

test('pure platform installs a sandboxed Node plugin and supports uninstall/reinstall', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-lifecycle-'));
  let app;
  try {
    const cli = path.resolve('packages/plugin-sdk/cli.mjs');
    execFileSync(process.execPath, [cli, 'create', 'fixture-native', '--native'], { cwd: temporary });
    const artifact = path.join(temporary, 'fixture.ecplugin');
    execFileSync(process.execPath, [cli, 'pack', path.join(temporary, 'fixture-native'), artifact]);
    app = await _electron.launch({ args: [process.cwd(), '--user-data-dir=' + path.join(temporary, 'profile')] });
    const page = await app.firstWindow();
    await expect(page.getByText('工具服务已就绪')).toBeVisible();
    expect((await page.evaluate(() => window.commerceDesktop.invoke('status'))).plugins).toEqual([]);
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); dialog.showMessageBox = async () => ({ response: 1 }); }, artifact);
    for (let iteration = 0; iteration < 2; iteration++) {
      await page.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
      await page.getByRole('button', { name: '工具中心', exact: true }).click();
      await page.getByRole('button', { name: '打开工具', exact: true }).click();
      await expect.poll(() => app.context().pages().some(candidate => candidate.url().startsWith('commerce-plugin://local.fixture-native/'))).toBe(true);
      const plugin = app.context().pages().find(candidate => candidate.url().startsWith('commerce-plugin://local.fixture-native/'));
      await plugin.getByRole('button', { name: '运行示例' }).click();
      await expect(plugin.locator('#result')).toHaveText('插件服务调用成功');
      await page.evaluate(() => window.commerceDesktop.invoke('plugins.uninstall', { id: 'local.fixture-native' }));
      expect((await page.evaluate(() => window.commerceDesktop.invoke('status'))).plugins).toEqual([]);
    }
  } finally { await app?.close(); await rm(temporary, { recursive: true, force: true }); }
});
