import { test, expect, _electron } from '@playwright/test';
import { createServer } from 'node:http';
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
    await expect(shell.locator('.commerce-sidebar')).toHaveCount(1);
    await shell.getByRole('button', { name: '收起侧边栏', exact: true }).click();
    await expect(shell.locator('.commerce-sidebar.is-collapsed')).toHaveCount(1);
    await shell.getByRole('button', { name: '隐藏浏览器面板', exact: true }).click();
    await expect(shell.locator('.commerce-browser-pane')).toHaveCount(0);
    await expect(shell.locator('.commerce-sidebar')).toHaveCount(1);
    await shell.getByRole('button', { name: '打开浏览器面板', exact: true }).click();
    await expect(shell.locator('.commerce-browser-pane')).toBeVisible();

    let browser = await shell.evaluate(() => window.commerceDesktop.invoke('browser.status'));
    const first = browser.tabs[0].id;
    const firstUrl = fixture.base + '/page1';
    await shell.evaluate(({ id, url }) => window.commerceDesktop.invoke('browser.navigate', { id, url }), { id: first, url: firstUrl });
    const firstPage = await browserPage(app, firstUrl);
    await expect(firstPage.getByText('页面一', { exact: false })).toBeVisible();
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

