import { test, expect, _electron } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function fixtureServer() {
  const server = createServer((request, response) => {
    const page = new URL(request.url, 'http://127.0.0.1').pathname;
    if (page === '/cookie') response.setHeader('set-cookie', 'browser_fixture=ok; Path=/');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${page === '/page2' ? '第二页' : '第一页'}</title><main>${page === '/page2' ? '页面二' : '页面一'}<button id="popup" onclick="window.open('/page2', '_blank')">打开第二页</button></main>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function browserPage(app, url) {
  await expect.poll(() => app.context().pages().some(candidate => candidate.url() === url)).toBe(true);
  return app.context().pages().find(candidate => candidate.url() === url);
}

test('opens an Electron browser pane, navigates multiple pages, and preserves browser storage', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-browser-'));
  const fixture = await fixtureServer();
  let app;
  try {
    const profile = path.join(temporary, 'profile');
    app = await _electron.launch({ args: [process.cwd(), '--user-data-dir=' + profile] });
    const shell = await app.firstWindow();
    await expect(shell.getByText('工具服务已就绪', { exact: true })).toBeVisible();
    await shell.getByRole('button', { name: '打开浏览器', exact: true }).click();
    await expect(shell.getByRole('tablist', { name: '浏览器标签页', exact: true })).toBeVisible();
    await expect(shell.locator('.commerce-browser-pane [role="tablist"]')).toHaveCount(0);
    await expect(shell.locator('.commerce-browser-pane')).toBeVisible();
    let browser = await shell.evaluate(() => window.commerceDesktop.invoke('browser.status'));
    const first = browser.tabs[0].id;
    const firstUrl = fixture.base + '/page1';
    await shell.evaluate(({ id, url }) => window.commerceDesktop.invoke('browser.navigate', { id, url }), { id: first, url: firstUrl });
    const firstPage = await browserPage(app, firstUrl);
    await expect(firstPage.getByText('页面一', { exact: false })).toBeVisible();

    const pane = shell.locator('.commerce-browser-pane');
    const divider = shell.getByRole('separator', { name: '调整浏览器面板宽度', exact: true });
    await expect(divider).toBeVisible();
    const initialPane = await pane.boundingBox();
    const dividerBox = await divider.boundingBox();
    expect(initialPane).toBeTruthy(); expect(dividerBox).toBeTruthy();
    await shell.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 30);
    await shell.mouse.down();
    await shell.mouse.move(dividerBox.x + 80, dividerBox.y + 30);
    await shell.mouse.up();
    await expect.poll(async () => (await pane.boundingBox())?.width || 0).toBeLessThan((initialPane?.width || 0) - 40);
    const narrowedPane = await pane.boundingBox();
    expect(narrowedPane?.width || 0).toBeLessThan((initialPane?.width || 0) - 40);
    await divider.press('ArrowLeft');
    await expect.poll(async () => (await pane.boundingBox())?.width || 0).toBeGreaterThan((narrowedPane?.width || 0) + 10);
    await expect(shell.locator('.commerce-sidebar')).toHaveCount(1);
    await shell.getByRole('button', { name: '收起侧边栏', exact: true }).click();
    await expect(shell.locator('.commerce-sidebar.is-collapsed')).toHaveCount(1);
    await shell.getByRole('button', { name: '展开侧边栏', exact: true }).click();
    await expect(shell.locator('.commerce-sidebar.is-collapsed')).toHaveCount(0);
    await shell.getByRole('button', { name: '隐藏浏览器面板', exact: true }).click();
    await expect(shell.locator('.commerce-browser-pane')).toHaveCount(0);
    await expect(shell.locator('.commerce-sidebar')).toHaveCount(1);
    await shell.getByRole('button', { name: '打开浏览器面板', exact: true }).click();
    await expect(shell.locator('.commerce-browser-pane')).toBeVisible();

    await firstPage.locator('#popup').click();
    const secondUrl = fixture.base + '/page2';
    await browserPage(app, secondUrl);
    browser = await shell.evaluate(() => window.commerceDesktop.invoke('browser.status'));
    expect(browser.tabs).toHaveLength(2);

    await shell.evaluate(({ id, url }) => window.commerceDesktop.invoke('browser.navigate', { id, url }), { id: first, url: secondUrl });
    await browserPage(app, secondUrl);
    await shell.evaluate(id => window.commerceDesktop.invoke('browser.activate', { id }), first);
    await shell.evaluate(() => window.commerceDesktop.invoke('browser.back'));
    await browserPage(app, firstUrl);
    await shell.evaluate(() => window.commerceDesktop.invoke('browser.forward'));
    await browserPage(app, secondUrl);

    const cookieUrl = fixture.base + '/cookie';
    await shell.evaluate(({ id, url }) => window.commerceDesktop.invoke('browser.navigate', { id, url }), { id: first, url: cookieUrl });
    const cookiePage = await browserPage(app, cookieUrl);
    await expect.poll(() => cookiePage.evaluate(() => document.cookie)).toContain('browser_fixture=ok');
    await app.close(); app = undefined;

    app = await _electron.launch({ args: [process.cwd(), '--user-data-dir=' + profile] });
    const relaunched = await app.firstWindow();
    await expect(relaunched.getByText('工具服务已就绪', { exact: true })).toBeVisible();
    await relaunched.getByRole('button', { name: '打开浏览器', exact: true }).click();
    const relaunchedStatus = await relaunched.evaluate(() => window.commerceDesktop.invoke('browser.status'));
    const relaunchedUrl = fixture.base + '/cookie';
    await relaunched.evaluate(({ id, url }) => window.commerceDesktop.invoke('browser.navigate', { id, url }), { id: relaunchedStatus.tabs[0].id, url: relaunchedUrl });
    const relaunchedPage = await browserPage(app, relaunchedUrl);
    await expect.poll(() => relaunchedPage.evaluate(() => document.cookie)).toContain('browser_fixture=ok');
    await expect(relaunched.evaluate(({ id }) => window.commerceDesktop.invoke('browser.navigate', { id, url: 'file:///tmp/blocked.html' }), { id: relaunchedStatus.tabs[0].id })).rejects.toThrow(/HTTP 或 HTTPS/);
  } finally {
    await app?.close();
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('keeps the tool and browser surfaces visible while switching between them', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-switch-'));
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Browser fixture</title><main>Browser fixture content</main>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
  let app;
  const visibleViews = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(view => ({ visible: view.getVisible?.(), url: view.webContents?.getURL?.() })));
  try {
    const cli = path.resolve('packages/plugin-sdk/cli.mjs');
    execFileSync(process.execPath, [cli, 'create', 'fixture-native', '--native'], { cwd: temporary });
    const artifact = path.join(temporary, 'fixture.ecplugin');
    execFileSync(process.execPath, [cli, 'pack', path.join(temporary, 'fixture-native'), artifact]);
    app = await _electron.launch({ args: [process.cwd(), '--user-data-dir=' + path.join(temporary, 'profile')] });
    const shell = await app.firstWindow();
    await expect(shell.getByText('工具服务已就绪', { exact: true })).toBeVisible();
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); dialog.showMessageBox = async () => ({ response: 1 }); }, artifact);
    await shell.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
    await shell.getByRole('button', { name: '工具中心', exact: true }).click();
    await shell.getByRole('button', { name: '打开工具', exact: true }).click();
    await expect.poll(() => app.context().pages().some(candidate => candidate.url().startsWith('commerce-plugin://local.fixture-native/'))).toBe(true);

    await shell.getByRole('button', { name: '打开浏览器面板', exact: true }).click();
    await expect(shell.locator('.commerce-browser-pane')).toBeVisible();
    const browser = await shell.evaluate(() => window.commerceDesktop.invoke('browser.status'));
    await shell.evaluate(({ id, url }) => window.commerceDesktop.invoke('browser.navigate', { id, url }), { id: browser.tabs[0].id, url: fixtureUrl });
    const browserContent = await browserPage(app, fixtureUrl);
    await expect(browserContent.getByText('Browser fixture content', { exact: true })).toBeVisible();

    const assertBothViewsVisible = async () => {
      const views = await visibleViews();
      expect(views.filter(view => view.visible)).toHaveLength(2);
      expect(views.some(view => view.url?.startsWith('commerce-plugin://local.fixture-native/'))).toBe(true);
      expect(views.some(view => view.url === fixtureUrl)).toBe(true);
    };
    await assertBothViewsVisible();
    await shell.getByRole('tab', { name: /fixture-native/ }).click();
    await assertBothViewsVisible();
    await shell.getByRole('tab', { name: /Browser fixture/ }).click();
    await assertBothViewsVisible();
  } finally {
    await app?.close();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
