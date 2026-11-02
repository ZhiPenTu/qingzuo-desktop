import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const moduleURL = new URL('../../desktop/main.mjs', import.meta.url).href;

const payloads = {
  '/segmented.bin': Buffer.from(Array.from({ length: 2 * 1024 * 1024 }, (_, index) => (index * 37) % 251)),
  '/restart.bin': Buffer.from(Array.from({ length: 1024 * 1024 }, (_, index) => (index * 53 + 11) % 253)),
};

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function stream(bytes, signal, onActiveChange) {
  let active = true;
  const done = () => {
    if (!active) return;
    active = false;
    onActiveChange?.(-1);
  };
  return new ReadableStream({
    async start(controller) {
      onActiveChange?.(1);
      let offset = 0;
      try {
        while (offset < bytes.length) {
          if (signal?.aborted) throw signal.reason || new Error('aborted');
          await delay(12);
          const end = Math.min(bytes.length, offset + 32 * 1024);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        }
        done();
        controller.close();
      } catch (error) {
        done();
        try { controller.error(error); } catch {}
      }
    },
    cancel() { done(); },
  });
}

async function rangeServer() {
  const stats = { active: 0, maxActive: 0, gets: 0 };
  const change = amount => {
    stats.active = Math.max(0, stats.active + amount);
    stats.maxActive = Math.max(stats.maxActive, stats.active);
  };
  const server = createServer((request, response) => {
    const bytes = payloads[new URL(request.url, 'http://127.0.0.1').pathname];
    if (!bytes) { response.writeHead(404); response.end(); return; }
    const etag = '"' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '"';
    const headers = {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="' + path.basename(request.url) + '"',
      etag,
    };
    if (request.method === 'HEAD') {
      response.writeHead(200, { ...headers, 'content-length': String(bytes.length) });
      response.end();
      return;
    }
    stats.gets++;
    const range = request.headers.range;
    if (!range) {
      response.writeHead(200, { ...headers, 'content-length': String(bytes.length) });
      response.end(bytes);
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) { response.writeHead(416); response.end(); return; }
    const start = Number(match[1]);
    const end = Math.min(bytes.length - 1, match[2] ? Number(match[2]) : bytes.length - 1);
    if (start >= bytes.length || end < start) {
      response.writeHead(416, { 'content-range': 'bytes */' + bytes.length });
      response.end();
      return;
    }
    const selected = bytes.subarray(start, end + 1);
    response.writeHead(206, {
      ...headers,
      'content-length': String(selected.length),
      'content-range': `bytes ${start}-${end}/${bytes.length}`,
    });
    const controller = new AbortController();
    request.on('close', () => controller.abort(new Error('request closed')));
    const body = stream(selected, controller.signal, change);
    void (async () => {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!response.write(Buffer.from(value))) await new Promise(resolve => response.once('drain', resolve));
        }
        response.end();
      } catch {
        response.destroy();
      } finally {
        reader.releaseLock();
      }
    })();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    origin: 'http://127.0.0.1:' + server.address().port,
    stats,
  };
}

async function createFixturePlugin(temporary) {
  const directory = path.join(temporary, 'fixture');
  await mkdir(path.join(directory, 'ui'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: '@local/downloads',
    version: '0.1.0',
    commerce: {
      manifestVersion: 1,
      id: 'local.downloads',
      title: '下载验收',
      description: '验证宿主下载能力',
      api: '^1.8.0',
      ui: 'ui/index.html',
      permissions: { downloads: 'use' },
    },
  }));
  await writeFile(path.join(directory, 'ui/index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>下载验收</title></head><body>
<button id="start" type="button">开始</button>
<button id="pause" type="button">暂停</button>
<button id="resume" type="button">继续</button>
<pre id="out"></pre>
<script type="module" src="./app.mjs"></script></body></html>`);
  await writeFile(path.join(directory, 'ui/app.mjs'), `import { createPluginClient } from './sdk.mjs';
const client = createPluginClient();
const out = document.querySelector('#out');
const show = value => { window.__last = value; out.textContent = JSON.stringify(value, null, 2); };
document.querySelector('#start').addEventListener('click', async () => {
  try {
    const directory = await client.downloads.pickDirectory();
    const url = window.__url;
    const probe = await client.downloads.probe({ url });
    const task = await client.downloads.start({ url, directoryToken: directory?.token, concurrency: 4 });
    window.__taskId = task.id;
    show({ probe, task });
  } catch (error) { show({ error: error.message }); }
});
document.querySelector('#pause').addEventListener('click', async () => {
  try { show(await client.downloads.pause(window.__taskId)); } catch (error) { show({ error: error.message }); }
});
document.querySelector('#resume').addEventListener('click', async () => {
  try { show(await client.downloads.resume(window.__taskId)); } catch (error) { show({ error: error.message }); }
});`);
  await cp(path.resolve('packages/plugin-sdk/index.mjs'), path.join(directory, 'ui/sdk.mjs'));
  const artifact = path.join(temporary, 'downloads.ecplugin');
  execFileSync(process.execPath, [path.resolve('packages/plugin-sdk/cli.mjs'), 'pack', directory, artifact], { stdio: 'pipe' });
  return artifact;
}

async function launch(profile) {
  const application = await electron.launch({
    args: [root, '--user-data-dir=' + profile],
    timeout: 20000,
  });
  const shell = await application.firstWindow();
  await expect(shell.getByText('工具服务已就绪', { exact: true })).toBeVisible();
  return { application, shell };
}

async function installFixtures(application, { artifact, downloadDirectory, origin }) {
  await application.evaluate((_, value) => {
    const vm = process.getBuiltinModule('node:vm');
    globalThis.downloadsRuntime = undefined;
    return vm.runInThisContext('import(' + JSON.stringify(value.moduleURL) + ')', {
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }).then(runtime => {
      globalThis.downloadsRuntime = runtime;
      runtime.downloads.request = async (address, options = {}) => {
        const { allowRedirectResponses, ...requestOptions } = options;
        void allowRedirectResponses;
        return fetch(value.origin + new URL(address).pathname, requestOptions);
      };
    });
  }, { moduleURL, origin });
  await application.evaluate(({ dialog }, value) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.length > 1 ? args[1] : args[0];
      return {
        canceled: false,
        filePaths: [options?.title === '导入插件' ? value.artifact : value.downloadDirectory],
      };
    };
    dialog.showMessageBox = async () => ({ response: 1 });
  }, { artifact, downloadDirectory });
}

async function openTool(application, shell) {
  await shell.getByRole('button', { name: '工具中心', exact: true }).click();
  await shell.locator('[data-slot="card"]')
    .filter({ has: shell.getByRole('heading', { name: '下载验收', exact: true }) })
    .getByRole('button', { name: '打开', exact: true })
    .click();
  await expect.poll(() => application.context().pages().some(page => page.url().startsWith('commerce-plugin://local.downloads/'))).toBe(true);
  return application.context().pages().find(page => page.url().startsWith('commerce-plugin://local.downloads/'));
}

async function invoke(plugin, method, args) {
  return plugin.evaluate(({ method, args }) => window.commercePlugin.invoke(method, args), { method, args });
}

async function waitTask(plugin, id, statuses, timeout = 30000) {
  await expect.poll(async () => (await invoke(plugin, 'downloads.get', { id }))?.status, { timeout }).toMatch(new RegExp('^(?:' + statuses.join('|') + ')$'));
  return invoke(plugin, 'downloads.get', { id });
}

test('downloads use real plugin IPC, four-way Range transfer, pause/resume, restart recovery and exact hashes', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-electron-downloads-'));
  const profile = path.join(temporary, 'profile');
  const downloadDirectory = path.join(temporary, 'downloads');
  await mkdir(downloadDirectory, { recursive: true });
  const fixture = await rangeServer();
  const artifact = await createFixturePlugin(temporary);
  let application;
  try {
    let launched = await launch(profile);
    application = launched.application;
    await installFixtures(application, { artifact, downloadDirectory, origin: fixture.origin });
    await launched.shell.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
    let plugin = await openTool(application, launched.shell);
    await plugin.evaluate(url => { window.__url = url; }, 'https://downloads.example/segmented.bin');
    await plugin.getByRole('button', { name: '开始', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => window.__taskId ?? null)).not.toBeNull();
    const id = await plugin.evaluate(() => window.__taskId);
    await waitTask(plugin, id, ['downloading']);
    let current = await waitTask(plugin, id, ['downloading']);
    expect(current.mode).toBe('segmented');
    expect(JSON.stringify(current)).not.toContain('downloads.example/segmented.bin');
    expect(JSON.stringify(current)).not.toContain(downloadDirectory);
    await invoke(plugin, 'downloads.pause', { id });
    const paused = await waitTask(plugin, id, ['paused']);
    expect(paused.transferred).toBeGreaterThan(0);
    expect(fixture.stats.maxActive).toBeGreaterThan(1);
    expect(fixture.stats.maxActive).toBeLessThanOrEqual(4);
    await invoke(plugin, 'downloads.resume', { id });
    const completed = await waitTask(plugin, id, ['completed'], 60000);
    expect(completed.progress).toBe(100);
    expect(createHash('sha256').update(await readFile(path.join(downloadDirectory, completed.filename))).digest('hex'))
      .toBe(createHash('sha256').update(payloads['/segmented.bin']).digest('hex'));

    await plugin.evaluate(url => { window.__url = url; }, 'https://downloads.example/restart.bin');
    await plugin.evaluate(() => { window.__taskId = null; });
    await plugin.getByRole('button', { name: '开始', exact: true }).click();
    await expect.poll(() => plugin.evaluate(() => window.__taskId ?? null)).not.toBeNull();
    const restartId = await plugin.evaluate(() => window.__taskId);
    const beforeRestart = await waitTask(plugin, restartId, ['downloading']);
    await expect.poll(async () => (await invoke(plugin, 'downloads.get', { id: restartId })).transferred).toBeGreaterThan(256 * 1024);
    expect(beforeRestart.mode).toBe('segmented');

    await application.close();
    launched = await launch(profile);
    application = launched.application;
    await installFixtures(application, { artifact, downloadDirectory, origin: fixture.origin });
    plugin = await openTool(application, launched.shell);
    await expect.poll(async () => (await invoke(plugin, 'downloads.get', { id: restartId }))?.status, { timeout: 30000 }).toMatch(/^(paused|failed)$/);
    const recovered = await invoke(plugin, 'downloads.get', { id: restartId });
    expect(recovered.transferred).toBeGreaterThan(0);
    await invoke(plugin, 'downloads.resume', { id: restartId });
    const restarted = await waitTask(plugin, restartId, ['completed'], 60000);
    expect(createHash('sha256').update(await readFile(path.join(downloadDirectory, restarted.filename))).digest('hex'))
      .toBe(createHash('sha256').update(payloads['/restart.bin']).digest('hex'));
  } finally {
    await application?.close().catch(() => {});
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
