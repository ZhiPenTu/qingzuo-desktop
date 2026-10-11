import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const root = process.cwd(), configFile = path.join(root, 'resources/generated/market.json');
const moduleURL = new URL('../../desktop/main.mjs', import.meta.url).href;
const id = 'local.market-slow', title = '慢下载回归工具';
const screenshotDirectory = path.join(os.tmpdir(), 'qingzuo-market-slow-qa');
const status = page => page.evaluate(() => window.commerceDesktop.invoke('status'));
const install = page => page.evaluate(id => window.commerceDesktop.invoke('market.install', { id }), id);
const cardFor = page => page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

async function signedFixture(version, privateKey, badSignature = false) {
  const zip = new AdmZip(), service = 'fixture.market-slow.v' + version.split('.')[1];
  zip.addFile('package.json', Buffer.from(JSON.stringify({ name: '@local/market-slow', version, type: 'module', commerce: {
    manifestVersion: 1, id, title, description: '签名下载与服务同步的合成测试工具', api: '^1.0.0', ui: 'ui/index.html', permissions: {},
    backend: { type: 'node', entry: { 'darwin-arm64': 'worker.mjs', 'win32-x64': 'worker.mjs' } }, services: { provides: [service] },
  } })));
  zip.addFile('ui/index.html', Buffer.from('<!doctype html><html lang="zh"><meta charset="UTF-8"><title>' + title + '</title><h1>' + title + '</h1><button id="run">验证新服务</button><p id="result" role="status"></p><script type="module" src="app.mjs"></script></html>'));
  zip.addFile('ui/sdk.mjs', await readFile(path.join(root, 'packages/plugin-sdk/index.mjs')));
  zip.addFile('ui/app.mjs', Buffer.from("import {createPluginClient} from './sdk.mjs';const client=createPluginClient();document.querySelector('#run').onclick=async()=>{try{document.querySelector('#result').textContent=await client.services.call(" + JSON.stringify(service) + ",'echo',{text:'新版本服务已同步'});}catch(error){document.querySelector('#result').textContent=error.message;}};"));
  zip.addFile('worker.mjs', Buffer.from("import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin})){const request=JSON.parse(line);const result=request.method==='health'?{ready:true}:request.method==='echo'?" + JSON.stringify('v' + version + ' · ') + "+request.args.text:null;process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');}"));
  const bytes = zip.toBuffer(), catalog = { schemaVersion: 1, plugins: [{ id, title, description: '签名下载与服务同步的合成测试工具', category: '测试工具', version,
    artifacts: { [process.platform + '-' + process.arch]: { url: 'https://market.example/slow.ecplugin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), signature: badSignature ? Buffer.alloc(64).toString('base64') : sign(null, bytes, privateKey).toString('base64') } },
  }] };
  return { bytes, catalog, version };
}

async function fixtureFetch(app, fixture, delay = 0) {
  await app.evaluate((_, value) => {
    globalThis.__marketSlow ??= { downloads: [] };
    globalThis.fetch = async (address, options = {}) => {
      if (String(address) === 'https://market.example/catalog.json') return Response.json(value.catalog);
      if (String(address) !== 'https://market.example/slow.ecplugin') throw new Error('Unexpected external request in isolated marketplace fixture.');
      options.signal?.throwIfAborted();
      const bytes = Buffer.from(value.bytes, 'base64'), half = Math.max(1, Math.floor(bytes.length / 2));
      const download = { version: value.version, started: Date.now(), finished: null, aborted: false }; globalThis.__marketSlow.downloads.push(download);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, half));
          const timer = setTimeout(() => {
            options.signal?.removeEventListener('abort', abort);
            download.finished = Date.now(); controller.enqueue(bytes.subarray(half)); controller.close();
          }, value.delay);
          const abort = () => { clearTimeout(timer); download.aborted = true; controller.error(options.signal.reason); };
          options.signal?.addEventListener('abort', abort, { once: true });
        },
      });
      return new Response(stream, { headers: { 'Content-Length': String(bytes.length) } });
    };
  }, { catalog: fixture.catalog, bytes: fixture.bytes.toString('base64'), version: fixture.version, delay });
}

test('signed plugin download outlives 30s RPC, keeps navigation locks, syncs without restart and retries signature failure', async () => {
  test.setTimeout(120000);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-market-slow-profile-'));
  const previous = await readFile(configFile), { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const errors = []; let app;
  try {
    await mkdir(screenshotDirectory, { recursive: true });
    await writeFile(configFile, JSON.stringify({ url: 'https://market.example/catalog.json', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }));
    app = await electron.launch({ args: [root, '--user-data-dir=' + path.join(temp, 'profile')], timeout: 20000 });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByText('Harness 内核已连接', { exact: true })).toBeVisible();
    expect(page.url()).toMatch(/^commerce:\/\/shell\//); expect(await page.title()).toMatch(/轻作|Qingzuo/);
    const first = await signedFixture('0.1.0', privateKey); await fixtureFetch(app, first);
    await install(page); await expect.poll(async () => (await status(page)).pluginInstalls.find(job => job.id === id)?.status).toBe('installed');
    const hostPid = await app.evaluate(async (_, url) => {
      const vm = process.getBuiltinModule('node:vm');
      return (await vm.runInThisContext('import(' + JSON.stringify(url) + ')', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })).host.pid;
    }, moduleURL);

    const second = await signedFixture('0.2.0', privateKey); await fixtureFetch(app, second, 34000);
    await page.getByRole('button', { name: '插件市场', exact: true }).click();
    const marketCard = cardFor(page); await expect(marketCard.getByRole('button', { name: '更新插件', exact: true })).toBeVisible();
    const acknowledged = await page.evaluate(async id => {
      const started = performance.now(), value = await window.commerceDesktop.invoke('market.install', { id });
      return { elapsed: performance.now() - started, value };
    }, id);
    expect(acknowledged.elapsed).toBeLessThan(2000); expect(['checking', 'downloading']).toContain(acknowledged.value.status);
    await expect(marketCard.getByRole('status')).toContainText('正在下载新版本');
    await expect(marketCard.getByRole('button', { name: '更新插件', exact: true })).toBeDisabled();
    await expect.poll(async () => (await status(page)).pluginInstalls.find(job => job.id === id)?.transferred).toBeGreaterThan(0);
    const active = await status(page); expect(active.plugins.find(plugin => plugin.id === id).version).toBe('0.1.0');
    expect((await install(page)).status).toBe('downloading');
    expect(await app.evaluate(() => globalThis.__marketSlow.downloads.filter(download => download.version === '0.2.0').length)).toBe(1);
    const mutationErrors = await page.evaluate(async id => {
      const results = [];
      for (const [method, args] of [['plugins.uninstall', { id }], ['plugins.enable', { id, enabled: false }], ['plugins.enable', { id, enabled: true }], ['plugins.rollback', { id }]]) {
        try { await window.commerceDesktop.invoke(method, args); results.push('unexpected success'); }
        catch (error) { results.push(error.message); }
      }
      return results;
    }, id);
    expect(mutationErrors).toHaveLength(4); expect(mutationErrors.every(error => error.includes('正在安装或更新'))).toBe(true);

    await page.getByRole('button', { name: '插件管理', exact: true }).click();
    const managementCard = cardFor(page); await expect(managementCard.getByRole('status')).toContainText('正在下载新版本');
    await expect(managementCard.getByRole('button', { name: '停用', exact: true })).toBeDisabled();
    await expect(managementCard.getByRole('button', { name: '卸载', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '工具中心', exact: true }).click();
    await expect(cardFor(page).getByRole('status')).toContainText('正在下载新版本');
    await expect(cardFor(page).getByRole('button', { name: '打开工具', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '插件市场', exact: true }).click();
    await expect(marketCard.getByRole('status')).toContainText('正在下载新版本');
    await page.screenshot({ path: path.join(screenshotDirectory, 'slow-download.png'), fullPage: false });

    // Keep the real Electron main process and stream alive beyond the old RPC
    // deadline, then prove normal status/IPC still works before bytes finish.
    await expect.poll(() => app.evaluate(() => Date.now() - globalThis.__marketSlow.downloads.find(download => download.version === '0.2.0').started), { timeout: 35000 }).toBeGreaterThan(30500);
    expect((await status(page)).pluginInstalls.find(job => job.id === id).status).toBe('downloading');
    await expect(marketCard.getByRole('button', { name: '更新插件', exact: true })).toBeDisabled();
    await expect(marketCard.getByRole('status')).toContainText('安装完成 · v0.2.0', { timeout: 30000 });
    await expect(marketCard.getByRole('button', { name: '已安装', exact: true })).toBeVisible();
    const completed = await status(page); expect(completed.plugins.find(plugin => plugin.id === id).version).toBe('0.2.0'); expect(completed.kernel.ready).toBe(true);
    const elapsed = await app.evaluate(() => { const download = globalThis.__marketSlow.downloads.find(download => download.version === '0.2.0'); return download.finished - download.started; });
    expect(elapsed).toBeGreaterThanOrEqual(33000);
    const sameHost = await app.evaluate(async (_, url) => {
      const vm = process.getBuiltinModule('node:vm'), runtime = await vm.runInThisContext('import(' + JSON.stringify(url) + ')', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      return { pid: runtime.host.pid, pending: runtime.pluginInstallService.pending.size, state: runtime.pluginInstallService.snapshot() };
    }, moduleURL);
    expect(sameHost.pid).toBe(hostPid); expect(sameHost.pending).toBe(0); expect(sameHost.state.find(job => job.id === id).status).toBe('installed');
    await page.screenshot({ path: path.join(screenshotDirectory, 'installed.png'), fullPage: false });
    await page.getByRole('button', { name: '工具中心', exact: true }).click(); await cardFor(page).getByRole('button', { name: '打开工具', exact: true }).click();
    await expect.poll(() => app.context().pages().some(candidate => candidate.url().startsWith('commerce-plugin://' + id + '/'))).toBe(true);
    const pluginPage = app.context().pages().find(candidate => candidate.url().startsWith('commerce-plugin://' + id + '/'));
    await pluginPage.getByRole('button', { name: '验证新服务', exact: true }).click();
    await expect(pluginPage.getByRole('status')).toHaveText('v0.2.0 · 新版本服务已同步');

    const bad = await signedFixture('0.3.0', privateKey, true); await fixtureFetch(app, bad);
    await page.getByRole('button', { name: '插件市场', exact: true }).click(); await marketCard.getByRole('button', { name: '更新插件', exact: true }).click();
    await expect(marketCard.getByRole('alert')).toContainText('插件签名无效。'); await expect(marketCard.getByRole('button', { name: '重试更新', exact: true })).toBeEnabled();
    expect((await status(page)).plugins.find(plugin => plugin.id === id).version).toBe('0.2.0');
    await page.screenshot({ path: path.join(screenshotDirectory, 'signature-error.png'), fullPage: false });
    const valid = await signedFixture('0.3.0', privateKey); await fixtureFetch(app, valid);
    await marketCard.getByRole('button', { name: '重试更新', exact: true }).click();
    await expect(marketCard.getByRole('status')).toContainText('安装完成 · v0.3.0'); expect((await status(page)).plugins.find(plugin => plugin.id === id).version).toBe('0.3.0');
    await page.screenshot({ path: path.join(screenshotDirectory, 'retried.png'), fullPage: false });
    expect(await app.evaluate(() => globalThis.__marketSlow.downloads.filter(download => download.version === '0.3.0').length)).toBe(2);

    // Fail only after the new version is durably committed. Recovery must retry
    // reconciliation, not download/reinstall the same market version again.
    const fourth = await signedFixture('0.4.0', privateKey); await fixtureFetch(app, fourth);
    await page.getByRole('button', { name: '工具中心', exact: true }).click();
    await page.getByRole('button', { name: '插件市场', exact: true }).click();
    await expect(marketCard.getByRole('button', { name: '更新插件', exact: true })).toBeVisible();
    await app.evaluate(async (_, url) => {
      const vm = process.getBuiltinModule('node:vm'), runtime = await vm.runInThisContext('import(' + JSON.stringify(url) + ')', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      const persist = runtime.manager.persist.bind(runtime.manager);
      runtime.manager.persist = async () => {
        await persist(); runtime.manager.persist = persist;
        const exited = new Promise(resolve => runtime.host.once('exit', resolve)); runtime.host.kill(); await exited;
      };
    }, moduleURL);
    await marketCard.getByRole('button', { name: '更新插件', exact: true }).click();
    await expect(marketCard.getByRole('alert')).toContainText('插件 v0.4.0 已安装，但同步未完成');
    expect((await status(page)).plugins.find(plugin => plugin.id === id).version).toBe('0.4.0');
    expect(await app.evaluate(() => globalThis.__marketSlow.downloads.filter(download => download.version === '0.4.0').length)).toBe(1);
    await page.screenshot({ path: path.join(screenshotDirectory, 'sync-error.png'), fullPage: false });
    await page.getByRole('button', { name: '重新启动内核', exact: true }).click();
    await expect(page.getByText('Harness 内核已连接', { exact: true })).toBeVisible();
    await marketCard.getByRole('button', { name: '重试更新', exact: true }).click();
    await expect(marketCard.getByRole('status')).toContainText('安装完成 · v0.4.0');
    expect(await app.evaluate(() => globalThis.__marketSlow.downloads.filter(download => download.version === '0.4.0').length)).toBe(1);
    await page.screenshot({ path: path.join(screenshotDirectory, 'sync-retried.png'), fullPage: false });
    await page.getByRole('button', { name: '工具中心', exact: true }).click(); await cardFor(page).getByRole('button', { name: '打开工具', exact: true }).click();
    await expect.poll(() => app.context().pages().some(candidate => candidate.url().startsWith('commerce-plugin://' + id + '/'))).toBe(true);
    const recoveredPlugin = app.context().pages().find(candidate => candidate.url().startsWith('commerce-plugin://' + id + '/'));
    await recoveredPlugin.getByRole('button', { name: '验证新服务', exact: true }).click();
    await expect(recoveredPlugin.getByRole('status')).toHaveText('v0.4.0 · 新版本服务已同步');
    expect(errors).toEqual([]); await expect(page.getByText('内核请求超时。', { exact: false })).toHaveCount(0);
  } finally { await app?.close(); await writeFile(configFile, previous); await rm(temp, { recursive: true, force: true }); }
});
