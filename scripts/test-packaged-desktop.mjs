import { _electron, expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sourceExecutable = path.resolve(process.argv[2] || (process.platform === 'darwin'
  ? 'release/desktop/mac-arm64/Qingzuo.app/Contents/MacOS/Qingzuo'
  : 'release/desktop/win-unpacked/Qingzuo.exe'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'commerce-packaged-'));
let app;
try {
  // Installed applications cannot borrow peer dependencies from a developer
  // checkout. Copy the whole distribution and launch it outside the repository.
  const sourceRoot = process.platform === 'darwin' ? path.resolve(sourceExecutable, '../../..') : path.dirname(sourceExecutable);
  const installedRoot = path.join(temporary, path.basename(sourceRoot));
  await cp(sourceRoot, installedRoot, { recursive: true, verbatimSymlinks: true });
  const executablePath = path.join(installedRoot, path.relative(sourceRoot, sourceExecutable));
  const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
  app = await _electron.launch({ executablePath, cwd: temporary, env, args: ['--user-data-dir=' + path.join(temporary, 'data')], timeout: 30000 });
  app.process().stderr.on('data', bytes => process.stderr.write(bytes));
  const page = await app.firstWindow();
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.commerceDesktop.invoke('status'));
    if (current.kernel.error) throw new Error(current.kernel.error);
    return current.kernel.systems.length;
  }, { timeout: 30000 }).toBe(7);
  await expect(page.getByText('工具服务已就绪')).toBeVisible();
  const status = await page.evaluate(() => window.commerceDesktop.invoke('status'));
  expect(status.update.status).toBe('idle');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByText('下载完成后会自动安装并重启，请先保存正在编辑的文件。', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '工具中心', exact: true }).click();
  await mkdir('output/electron-tests', { recursive: true });
  await page.screenshot({ path: 'output/electron-tests/packaged-home.png' });
  expect(status.plugins).toEqual([]);
  await expect(page.getByText('这里还没有工具')).toBeVisible();
  const { readdir } = await import('node:fs/promises');
  const resources = process.platform === 'darwin' ? path.join(installedRoot, 'Contents/Resources/commerce') : path.join(installedRoot, 'resources/commerce');
  expect(await readdir(resources)).not.toContain('plugins');
  expect(JSON.parse(await readFile(path.join(resources, 'distribution.json'), 'utf8')).preview).toBe(false);
await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
await expect(page.getByRole('heading', { name: 'AI 对话', exact: true })).toBeVisible();
await page.getByRole('button', { name: '设置', exact: true }).click();
await page.getByRole('button', { name: '打开 AI 设置', exact: true }).click();
await expect(page.getByRole('button', { name: '代理连接', exact: true })).toBeVisible();
  console.log('Standalone pure platform: seven Harness services, empty tool center and no bundled business plugins passed.');
} finally {
  if (app) await app.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
