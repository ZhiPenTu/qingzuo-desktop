import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const root = process.cwd();
const configFile = path.join(root, 'resources/generated/market.json');
const moduleURL = new URL('../../desktop/main.mjs', import.meta.url).href;

async function withMarketplace(ids, run) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-install-lifecycle-'));
  const profile = path.join(temporary, 'profile'), previous = await readFile(configFile);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const artifacts = {}, plugins = ids.map(id => {
    const version = '0.1.0', zip = new AdmZip();
    zip.addFile('package.json', Buffer.from(JSON.stringify({ name: id, version, commerce: {
      manifestVersion: 1, id, title: id, description: 'Lifecycle fixture', api: '^1.0.0',
      ui: 'ui/index.html', permissions: {}, services: { provides: [id + '.echo'] },
    } })));
    zip.addFile('ui/index.html', Buffer.from('<h1>Lifecycle fixture</h1>'));
    const bytes = zip.toBuffer(), url = 'https://market.example/' + id + '.ecplugin';
    artifacts[url] = bytes.toString('base64');
    return { id, title: id, description: 'Lifecycle fixture', version, api: '^1.0.0', artifacts: {
      [process.platform + '-' + process.arch]: { url, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), signature: sign(null, bytes, privateKey).toString('base64') },
    } };
  });
  let application;
  try {
    await writeFile(configFile, JSON.stringify({ url: 'https://market.example/catalog.json', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }));
    application = await electron.launch({ args: [root, '--user-data-dir=' + profile], timeout: 20000 });
    const page = await application.firstWindow();
    await expect(page.getByText('Harness 内核已连接')).toBeVisible();
    await page.evaluate(() => window.commerceDesktop.invoke('status'));
    await application.evaluate(async (_, value) => {
      const vm = process.getBuiltinModule('node:vm');
      globalThis.lifecycleRuntime = await vm.runInThisContext('import(' + JSON.stringify(value.moduleURL) + ')', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      globalThis.fetch = async address => {
        const url = String(address);
        if (url.endsWith('/catalog.json')) return new Response(JSON.stringify(value.catalog));
        const bytes = value.artifacts[url];
        if (!bytes) throw new Error('Unknown fixture artifact: ' + url);
        return new Response(Buffer.from(bytes, 'base64'));
      };
    }, { moduleURL, catalog: { schemaVersion: 1, plugins }, artifacts });
    await run({ application, page, profile });
  } finally {
    // Release fixtures before closing even when an assertion failed mid-install.
    await application?.evaluate(() => { globalThis.lifecycleDrainSync?.(); globalThis.lifecycleReleaseProbe?.(); }).catch(() => {});
    await application?.close().catch(() => {});
    await writeFile(configFile, previous);
    await rm(temporary, { recursive: true, force: true });
  }
}

test('overlapping plugin finalizations queue Harness synchronization and refresh the complete plugin list', async () => {
  const ids = ['local.lifecycle-one', 'local.lifecycle-two'];
  await withMarketplace(ids, async ({ application, page }) => {
    await application.evaluate(() => {
      const host = globalThis.lifecycleRuntime.host, post = host.postMessage.bind(host);
      const held = []; let holding = true;
      globalThis.lifecycleSyncs = [];
      host.postMessage = message => {
        if (message.type === 'sync') {
          globalThis.lifecycleSyncs.push(message.plugins.map(plugin => plugin.id));
          if (holding) { held.push(message); return; }
        }
        post(message);
      };
      globalThis.lifecycleReleaseSync = () => { const message = held.shift(); if (!message) throw new Error('No queued synchronization'); post(message); };
      globalThis.lifecycleDrainSync = () => { holding = false; for (const message of held.splice(0)) post(message); };
    });
    await page.evaluate(ids => Promise.all(ids.map(id => window.commerceDesktop.invoke('market.install', { id }))), ids);
    await expect.poll(() => application.evaluate(() => globalThis.lifecycleRuntime.pluginInstallService.snapshot().map(job => job.status))).toEqual(['syncing', 'syncing']);
    // Both installations have committed, but only the first reconcile can reach
    // the utility process until its acknowledgement releases the queue.
    expect(await application.evaluate(() => globalThis.lifecycleSyncs.length)).toBe(1);
    expect((await application.evaluate(() => globalThis.lifecycleRuntime.manager.list())).map(plugin => plugin.id).sort()).toEqual(ids);
    await application.evaluate(() => globalThis.lifecycleReleaseSync());
    await expect.poll(() => application.evaluate(() => globalThis.lifecycleSyncs.length)).toBe(2);
    expect((await application.evaluate(() => globalThis.lifecycleSyncs[1])).sort()).toEqual(ids);
    await application.evaluate(() => globalThis.lifecycleReleaseSync());
    await expect.poll(() => application.evaluate(() => globalThis.lifecycleRuntime.pluginInstallService.snapshot().map(job => ({ status: job.status, error: job.error })))).toEqual([
      { status: 'installed', error: null }, { status: 'installed', error: null },
    ]);
  });
});

test('repeated quit requests keep Electron and its kernel alive until a committing plugin finishes', async () => {
  const id = 'local.lifecycle-quit';
  await withMarketplace([id], async ({ application, page, profile }) => {
    await application.evaluate((_, id) => {
      const { manager, host } = globalThis.lifecycleRuntime, probe = manager.probe;
      globalThis.lifecycleProbeEntered = false; globalThis.lifecycleShutdownSent = false;
      const gate = new Promise(resolve => { globalThis.lifecycleReleaseProbe = resolve; });
      manager.probe = async plugin => {
        if (plugin.id === id) { globalThis.lifecycleProbeEntered = true; await gate; }
        return probe(plugin);
      };
      const post = host.postMessage.bind(host);
      host.postMessage = message => { if (message.type === 'shutdown') globalThis.lifecycleShutdownSent = true; post(message); };
    }, id);
    await page.evaluate(id => window.commerceDesktop.invoke('market.install', { id }), id);
    await expect.poll(() => application.evaluate(() => globalThis.lifecycleProbeEntered)).toBe(true);
    const child = application.process();
    expect(child.exitCode).toBeNull();
    await expect(readFile(path.join(profile, 'plugins/state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await application.evaluate(({ app }) => { app.quit(); });
    await application.evaluate(({ app }) => { app.quit(); });
    // A second quit used to bypass the first request's installation drain.
    // Successful evaluation after both requests also proves the app stayed alive.
    expect(await application.evaluate(() => ({ probeEntered: globalThis.lifecycleProbeEntered, shutdownSent: globalThis.lifecycleShutdownSent, status: globalThis.lifecycleRuntime.pluginInstallService.snapshot()[0].status }))).toEqual({
      probeEntered: true, shutdownSent: false, status: 'installing',
    });
    expect(child.exitCode).toBeNull();
    const closed = application.waitForEvent('close', { timeout: 30000 });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    await application.evaluate(() => globalThis.lifecycleReleaseProbe());
    await closed;
    expect(await exited).toEqual({ code: 0, signal: null });
    const state = JSON.parse(await readFile(path.join(profile, 'plugins/state.json'), 'utf8'));
    expect(state.plugins[id]).toMatchObject({ source: 'market', enabled: true });
    const manifest = JSON.parse(await readFile(path.join(profile, 'plugins', state.plugins[id].folder, 'package.json'), 'utf8'));
    expect(manifest.version).toBe('0.1.0');
  });
});
