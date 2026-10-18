import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';
import { boundedDownload } from '../desktop/plugin-manager.mjs';

if (process.platform !== 'win32') process.exit(0);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-installer-'));
let app;
async function install(filename, destination) {
  await new Promise((resolve, reject) => {
    const child = spawn(filename, ['/S', '/currentuser', '/D=' + destination], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Installer timed out.')); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Installer exit: ' + code)); });
  });
}
try {
  const releaseResponse = await fetch('https://api.github.com/repos/ZhiPenTu/qingzuo-desktop/releases/tags/v0.2.5');
  if (!releaseResponse.ok) throw new Error('Pinned upgrade baseline unavailable.');
  const baseline = (await releaseResponse.json()).assets.find(asset => asset.name === 'CommerceTools-0.2.5-win-x64.exe');
  assert.ok(baseline?.digest?.startsWith('sha256:'));
  const bytes = await boundedDownload(baseline.browser_download_url);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), baseline.digest.slice(7));
  const oldInstaller = path.join(temporary, 'old.exe'), installed = path.join(temporary, 'installed'), profile = path.join(temporary, 'profile');
  await writeFile(oldInstaller, bytes);
  await install(oldInstaller, installed);
  const executablePath = path.join(installed, 'Qingzuo.exe');
  await access(path.join(installed, 'resources/commerce/plugins/official.labeledit/package.json'));
  app = await _electron.launch({ executablePath, args: ['--user-data-dir=' + profile], cwd: temporary });
  const oldPage = await app.firstWindow();
  // The pinned v0.2.5 baseline is a real older release and keeps its own original copy.
  await expect(oldPage.getByText('Harness 内核已连接')).toBeVisible();
  const oldStatus = await oldPage.evaluate(() => window.commerceDesktop.invoke('status'));
  expect(oldStatus.version).toBe('0.2.5');
  await oldPage.evaluate(() => window.commerceDesktop.invoke('plugins.enable', { id: 'official.labeledit', enabled: false }));
  await app.close(); app = null;
  const marker = path.join(profile, 'plugins/installed/local.preserved/user-data');
  await mkdir(path.dirname(marker), { recursive: true }); await writeFile(marker, 'preserve plugin data');
  const priorExecutable = await readFile(executablePath);
  const invalid = path.join(temporary, 'invalid.exe'); await writeFile(invalid, 'invalid update');
  await assert.rejects(install(invalid, installed));
  assert.deepEqual(await readFile(executablePath), priorExecutable);
  assert.equal(await readFile(marker, 'utf8'), 'preserve plugin data');
  const { version } = JSON.parse(await readFile('package.json'));
  const installer = path.resolve('release/desktop', 'CommerceTools-' + version + '-win-x64.exe');
  await install(installer, installed);
  assert.equal((await readdir(path.join(installed, 'resources/commerce'))).includes('plugins'), false);
  assert.equal(await readFile(marker, 'utf8'), 'preserve plugin data');
  app = await _electron.launch({ executablePath, args: ['--user-data-dir=' + profile], cwd: temporary });
  const page = await app.firstWindow();
  await expect(page.getByText('工具服务已就绪')).toBeVisible();
  const status = await page.evaluate(() => window.commerceDesktop.invoke('status'));
  expect(status.version).toBe(version);
  expect(status.kernel.systems).toHaveLength(7);
  expect(status.plugins).toEqual([]);
  expect(status.migration).toMatchObject({ id: 'official.labeledit', enabled: false });
  await mkdir('output/update-validation', { recursive: true });
  await writeFile('output/update-validation/windows-installer.json', JSON.stringify({ baseline: '0.2.5', version, installation: 'passed', invalidInstallerPreservation: 'passed', pluginDataPreservation: 'passed', purePlatform: 'passed', legacyPrompt: 'passed' }, null, 2));
  console.log('Windows NSIS: actual v0.2.5 installation, failed installer preservation and pure-platform upgrade with plugin data retained passed.');
} finally { await app?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
