import { test, expect, _electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const root = process.cwd();

function pluginArtifact() {
  const id = 'local.debug-log-fixture';
  const zip = new AdmZip();
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name: id,
    version: '0.1.0',
    commerce: {
      manifestVersion: 1,
      id,
      title: 'Debug log fixture',
      description: 'Debug log fixture',
      api: '^1.0.0',
      ui: 'ui/index.html',
      permissions: {},
    },
  })));
  zip.addFile('ui/index.html', Buffer.from('<!doctype html><meta charset="utf-8"><h1>Debug log fixture</h1><script src="./ui.js"></script>'));
  zip.addFile('ui/ui.js', Buffer.from('console.warn("plugin-debug-marker")'));
  return zip;
}

async function fixtureServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Debug page</title><main>Debug page</main><script>console.info("browser-debug-marker")</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

test('debug logging saves base, plugin, and browser logs to the selected directory', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-debug-log-e2e-'));
  const profile = path.join(temporary, 'profile');
  const logsDirectory = path.join(temporary, 'custom-logs');
  await mkdir(logsDirectory);
  const fixture = await fixtureServer();
  let application;
  try {
    const artifact = path.join(temporary, 'debug-log-fixture.ecplugin');
    pluginArtifact().writeZip(artifact);
    application = await _electron.launch({ args: [root, '--user-data-dir=' + profile], timeout: 20000 });
    const shell = await application.firstWindow();
    await expect(shell.getByText('工具服务已就绪')).toBeVisible();

    await shell.getByRole('button', { name: '设置', exact: true }).click();
    await shell.getByRole('switch', { name: '开启日志调试', exact: true }).click();
    await shell.getByRole('button', { name: '日志调试', exact: true }).click();
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, logsDirectory);
    await shell.getByRole('button', { name: '更改目录', exact: true }).click();
    await expect(shell.getByText(logsDirectory, { exact: true })).toBeVisible();

    await shell.evaluate(() => console.info('app-debug-marker'));
    await expect(shell.getByText('app-debug-marker', { exact: true })).toBeVisible();

    await shell.getByRole('button', { name: '工具中心', exact: true }).click();
    await shell.getByRole('button', { name: '打开浏览器', exact: true }).click();
    await shell.evaluate(url => window.commerceDesktop.invoke('browser.newTab', { url }), fixture.url);
    await expect.poll(() => application.context().pages().some(page => page.url() === fixture.url)).toBe(true);

    await shell.getByRole('button', { name: '工具中心', exact: true }).click();
    await application.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, artifact);
    await shell.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
    await expect(shell.getByRole('button', { name: '打开', exact: true })).toBeVisible();
    await shell.getByRole('button', { name: '打开', exact: true }).click();
    await expect.poll(() => application.context().pages().some(page => page.url().startsWith('commerce-plugin://local.debug-log-fixture/'))).toBe(true);

    await shell.getByRole('button', { name: '日志调试', exact: true }).click();
    await expect(shell.getByText('plugin-debug-marker', { exact: true })).toBeVisible();
    await expect(shell.getByText('browser-debug-marker', { exact: true })).toBeVisible();
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) {
      await mkdir(process.env.QINGZUO_UI_EVIDENCE_DIR, { recursive: true });
      await shell.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, '日志调试.png') });
    }

    await expect.poll(async () => {
      const files = (await readdir(logsDirectory)).filter(name => name.endsWith('.jsonl'));
      const contents = await Promise.all(files.map(name => readFile(path.join(logsDirectory, name), 'utf8')));
      return contents.join('\n');
    }).toContain('"scope":"app"');
    const contents = await Promise.all((await readdir(logsDirectory))
      .filter(name => name.endsWith('.jsonl'))
      .map(name => readFile(path.join(logsDirectory, name), 'utf8')));
    const saved = contents.join('\n');
    expect(saved).toContain('app-debug-marker');
    expect(saved).toContain('plugin-debug-marker');
    expect(saved).toContain('browser-debug-marker');
    expect(saved).toContain('"scope":"plugin"');
    expect(saved).toContain('"scope":"browser"');
  } finally {
    await application?.close().catch(() => {});
    await new Promise(resolve => fixture.server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
