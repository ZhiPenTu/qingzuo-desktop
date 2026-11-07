import { test, expect, _electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { injectMarketFixture, prepareMarketFixture } from './market-fixture.mjs';

const id = 'official.downloader';
const version = '0.1.0';

function unpack(bytes) {
  const zip = new AdmZip(bytes);
  return zip.getEntries().map(entry => ({
    name: entry.entryName.replace(/\/$/, ''),
    directory: entry.isDirectory,
    bytes: entry.isDirectory ? null : entry.getData(),
  }));
}

async function writeLegacyInstall(profile, bytes) {
  const folder = path.join(profile, 'plugins', 'installed', id, 'legacy');
  for (const entry of unpack(bytes)) {
    const destination = path.join(folder, entry.name);
    if (entry.directory) await mkdir(destination, { recursive: true });
    else { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, entry.bytes); }
  }
  await mkdir(path.join(profile, 'plugins'), { recursive: true });
  await writeFile(path.join(profile, 'plugins', 'state.json'), JSON.stringify({ plugins: {
    [id]: { folder: 'installed/' + id + '/legacy', enabled: true, source: 'market' },
  } }));
}

test('a legacy market install is re-bound to platform only after the reviewed package matches', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-legacy-tier-'));
  const profile = path.join(temporary, 'profile');
  const market = await prepareMarketFixture([{
    id,
    title: '文件下载器',
    description: '下载文件',
    category: '文件工具',
    version,
    api: '^1.8.0',
    tier: 'platform',
    manifest: { ui: 'ui/index.html' },
    files: { 'ui/index.html': '<!doctype html><meta charset="utf-8"><h1>下载</h1>' },
  }]);
  const bytes = Buffer.from(market.artifacts['https://market.example/' + id + '.ecplugin'], 'base64');
  await writeLegacyInstall(profile, bytes);
  const executablePath = process.env.QINGZUO_HOST_EXECUTABLE;
  let application;
  try {
    application = await _electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: [...(executablePath ? [] : [process.cwd()]), '--user-data-dir=' + profile],
    });
    const page = await application.firstWindow();
    await expect(page.getByText('工具服务已就绪')).toBeVisible();
    const installed = async () => (await page.evaluate(() => window.commerceDesktop.invoke('status')))
      .plugins.find(candidate => candidate.id === id);

    expect((await installed())?.tier).toBe('community');
    await injectMarketFixture(application, market);
    await expect.poll(async () => {
      try {
        await page.evaluate(() => window.commerceDesktop.invoke('market.list', { refresh: true }));
        return true;
      } catch {
        return false;
      }
    }).toBe(true);
    await expect.poll(async () => (await installed())?.tier).toBe('platform');
    await expect(page.getByText('底座内置', { exact: true })).toBeVisible();

    const state = JSON.parse(await readFile(path.join(profile, 'plugins', 'state.json'), 'utf8'));
    expect(state.plugins[id].tier).toBe('platform');
    expect(state.plugins[id].artifactSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  } finally {
    if (application) await application.close();
    await market.restore();
    await rm(temporary, { recursive: true, force: true });
  }
});
