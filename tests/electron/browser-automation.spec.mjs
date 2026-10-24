import { test, expect, _electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const detail = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>批发详情</title></head><body>
<nav><a href="/market">首页</a><a href="/market/scarf">围巾</a></nav>
<h1>纯棉针织围巾 冬季加厚保暖</h1>
<div class="price">¥ 12.50</div><div class="moq">2 件起批</div>
<table><tbody><tr><th>材质</th><td>棉</td></tr><tr><th>风格</th><td>简约</td></tr></tbody></table>
<table><thead><tr><th>颜色</th><th>单价</th><th>库存</th></tr></thead><tbody><tr><td>米白</td><td>12.50</td><td>900</td></tr><tr><td>墨黑</td><td>13.00</td><td>800</td></tr></tbody></table>
<div><img src="/main.jpg" alt="主图" width="600" height="600"></div>
<div><img src="/detail.jpg" alt="详情图" width="600" height="400"></div>
<input id="sku-note" type="text" placeholder="备注">
<input id="hidden" type="hidden" value="hidden-secret-value">
<input id="password" type="password" value="password-value">
<button id="toggle" type="button">展开说明</button>
<p id="extra" hidden>已展开</p>
<script>document.getElementById('toggle').addEventListener('click', () => { document.getElementById('extra').hidden = false; });</script>
</body></html>`;

async function listen(html) {
  const server = createServer((request, response) => {
    const page = new URL(request.url, 'http://127.0.0.1').pathname;
    if (page.endsWith('.jpg')) { response.writeHead(200, { 'content-type': 'image/jpeg' }); response.end('jpeg'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}

async function fixturePlugin(temporary, origin) {
  const directory = path.join(temporary, 'fixture');
  await mkdir(path.join(directory, 'ui'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: '@local/browser-automation', version: '0.1.0',
    commerce: {
      manifestVersion: 1, id: 'local.browser-automation', title: '页面采集验收', description: '验收页面采集与插件存储', api: '^1.3.0', ui: 'ui/index.html',
      permissions: { files: true, storage: true, browser: ['automate', 'detect'], browserOrigins: [origin], network: ['https://openapi.sheincorp.com'], networkHeaders: ['x-lt-signature'], credentials: ['fixture.secret'] },
    },
  }));
  await writeFile(path.join(directory, 'ui/index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面采集验收</title></head><body>
<button id="collect" data-action="collect" type="button">采集</button>
<button id="snapshot" data-action="snapshot" type="button">快照</button>
<button id="click" data-action="click" type="button">点击</button>
<button id="type" data-action="type" type="button">输入</button>
<button id="save" data-action="save" type="button">转存</button>
<button id="read" data-action="read" type="button">读草稿</button>
<button id="readImage" data-action="readImage" type="button">读图片</button>
<pre id="out"></pre><script type="module" src="./app.mjs"></script></body></html>`);
  await writeFile(path.join(directory, 'ui/app.mjs'), `import { createPluginClient } from './sdk.mjs';
const client = createPluginClient();
const out = document.querySelector('#out');
const show = value => { window.__last = value; out.textContent = JSON.stringify(value, null, 2); };
const snapshot = async () => {
  const value = await client.browser.snapshot({ tabId: window.__tab });
  const nodes = value.nodes;
  window.__refs = { click: nodes.find(node => node.name === '展开说明')?.ref, type: nodes.find(node => node.role === 'textbox')?.ref };
  return value;
};
const runs = {
  collect: async () => { const tab = await client.browser.open(window.__url); window.__tab = tab.tabId; return snapshot(); },
  snapshot,
  click: async () => client.browser.act({ tabId: window.__tab, ref: window.__refs.click, action: 'click' }),
  type: async () => client.browser.act({ tabId: window.__tab, ref: window.__refs.type, action: 'type', value: '轻作测试' }),
  save: async () => { const file = await client.browser.saveResource({ tabId: window.__tab, url: new URL('/main.jpg', window.__url).href }); await client.storage.set('asset', file); return file; },
  read: async () => client.storage.get('drafts'),
  readImage: async () => { const stored = await client.storage.get('asset'); return client.storage.readFile(stored.token); },
};
for (const button of document.querySelectorAll('button[data-action]')) button.addEventListener('click', async () => {
  try { show(await runs[button.dataset.action]()); } catch (error) { show({ error: error.message }); }
});`);
  await cp(path.resolve('packages/plugin-sdk/index.mjs'), path.join(directory, 'ui/sdk.mjs'));
  const artifact = path.join(temporary, 'fixture.ecplugin');
  execFileSync(process.execPath, [path.resolve('packages/plugin-sdk/cli.mjs'), 'pack', directory, artifact], { stdio: 'pipe' });
  return artifact;
}

test('page automation is origin scoped, snapshot stays redacted, stored files survive restart and signing stays in the host', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-automation-'));
  const page = await listen(detail);
  const other = await listen('<!doctype html><title>其他站点</title><h1>其他站点</h1>');
  let app;
  const launch = async () => {
    app = await _electron.launch({ args: [process.cwd(), '--user-data-dir=' + path.join(temporary, 'profile')] });
    const shell = await app.firstWindow();
    await expect(shell.getByText('工具服务已就绪', { exact: true })).toBeVisible();
    return shell;
  };
  const openTool = async shell => {
    await shell.getByRole('button', { name: '工具中心', exact: true }).click();
    await shell.locator('[data-slot="card"]').filter({ has: shell.getByRole('heading', { name: '页面采集验收', exact: true }) }).getByRole('button', { name: '打开工具', exact: true }).click();
    await expect.poll(() => app.context().pages().some(candidate => candidate.url().startsWith('commerce-plugin://local.browser-automation/'))).toBe(true);
    return app.context().pages().find(candidate => candidate.url().startsWith('commerce-plugin://local.browser-automation/'));
  };
  try {
    const artifact = await fixturePlugin(temporary, page.origin);
    let shell = await launch();
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, artifact);
    await shell.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
    let plugin = await openTool(shell);

    await plugin.evaluate(url => { window.__url = url; }, page.origin + '/detail');
    await plugin.getByRole('button', { name: '采集', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => window.__last?.nodes?.length ?? 0)).toBeGreaterThan(5);
    await expect(shell.locator('.commerce-browser-pane')).toBeVisible();
    const snapshot = await plugin.evaluate(() => window.__last);
    const text = JSON.stringify(snapshot);
    expect(text).toContain('纯棉针织围巾');
    expect(text).toContain('材质');
    expect(text).toContain('/main.jpg');
    expect(text).not.toContain('hidden-secret-value');
    expect(text).not.toContain('password-value');
    expect(snapshot.nodes.some(node => node.role === 'textbox' && node.value === 'password-value')).toBe(false);

    await plugin.getByRole('button', { name: '点击', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => JSON.stringify(window.__last))).toContain('ok');
    await plugin.getByRole('button', { name: '快照', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => window.__last?.nodes?.some(node => node.name === '已展开') ?? false)).toBe(true);
    await plugin.getByRole('button', { name: '输入', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => window.__last?.value)).toBe('轻作测试');

    const denied = await plugin.evaluate(url => window.commercePlugin.invoke('browser.open', { url }).then(() => null, error => error.message), other.origin + '/');
    expect(denied).toMatch(/没有操作此页面的权限/);
    const foreignTab = await shell.evaluate(url => window.commerceDesktop.invoke('browser.newTab', { url }), other.origin + '/');
    const foreignSnapshot = await plugin.evaluate(id => window.commercePlugin.invoke('browser.snapshot', { tabId: id }).then(() => null, error => error.message), foreignTab.id);
    expect(foreignSnapshot).toMatch(/没有操作此页面的权限/);
    const foreignAct = await plugin.evaluate(async id => { const error = await window.commercePlugin.invoke('browser.waitFor', { tabId: id, text: '其他站点' }).then(() => null, reason => reason.message); return error; }, foreignTab.id);
    expect(foreignAct).toMatch(/没有操作此页面的权限/);

    const signed = await plugin.evaluate(async () => { await window.commercePlugin.invoke('credentials.set', { name: 'fixture.secret', value: 'fixture-secret' }); return window.commercePlugin.invoke('network.sign', { credential: 'fixture.secret', algorithm: 'hmac-sha256', message: 'openKeyId&1&/open-api/goods/x' }); });
    expect(signed.digest).toBe(createHmac('sha256', 'fixture-secret').update('openKeyId&1&/open-api/goods/x').digest('base64'));
    expect(JSON.stringify(signed)).not.toContain('fixture-secret');
    const undeclaredCredential = await plugin.evaluate(() => window.commercePlugin.invoke('network.sign', { credential: 'other.secret', algorithm: 'hmac-sha256', message: 'x' }).then(() => null, error => error.message));
    expect(undeclaredCredential).toMatch(/凭据未授权/);
    const undeclaredHeader = await plugin.evaluate(() => window.commercePlugin.invoke('network.request', { url: 'https://openapi.sheincorp.com/open-api/goods/x', headers: { 'x-other': '1' } }).then(() => null, error => error.message));
    expect(undeclaredHeader).toMatch(/请求头未授权/);

    await plugin.getByRole('button', { name: '转存', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => window.__last?.token ?? null)).not.toBeNull();
    const saved = await plugin.evaluate(() => window.__last);
    expect(saved.mime).toBe('image/jpeg');
    expect(saved.name).toBe('main.jpg');
    await plugin.getByRole('button', { name: '读图片', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => window.__last?.data)).toBe(Buffer.from('jpeg').toString('base64'));

    await plugin.evaluate(() => window.commercePlugin.invoke('storage.set', { key: 'drafts', value: [{ id: 'a' }] }));
    await plugin.getByRole('button', { name: '读草稿', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => JSON.stringify(window.__last))).toBe('[{"id":"a"}]');
    await app.close();

    shell = await launch();
    plugin = await openTool(shell);
    await plugin.getByRole('button', { name: '读草稿', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => JSON.stringify(window.__last))).toBe('[{"id":"a"}]');
    await plugin.getByRole('button', { name: '读图片', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => window.__last?.data)).toBe(Buffer.from('jpeg').toString('base64'));

    await shell.evaluate(() => window.commerceDesktop.invoke('plugins.uninstall', { id: 'local.browser-automation' }));
    const afterRemove = await readFile(path.join(temporary, 'profile', 'plugin-storage', 'local.browser-automation', 'values', 'drafts.json')).then(() => 'present', () => 'missing');
    expect(afterRemove).toBe('missing');
  } finally {
    await app?.close().catch(() => {});
    page.server.close(); other.server.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
