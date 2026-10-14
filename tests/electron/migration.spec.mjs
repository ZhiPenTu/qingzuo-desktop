import { test, expect, _electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const screenshotDirectory = path.join(os.tmpdir(), 'qingzuo-migration-qa');

test('legacy recovery is explicit, offline-safe, state-preserving and recorded per profile', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-migration-ui-'));
  const configFile = path.resolve('resources/generated/market.json'), originalConfig = await readFile(configFile);
  const keys = generateKeyPairSync('ed25519'), profile = path.join(temporary, 'profile');
  let app;
  try {
    await mkdir(screenshotDirectory, { recursive: true });
    await mkdir(path.join(profile, 'harness/profiles/commerce-desktop'), { recursive: true });
    await writeFile(path.join(profile, 'harness/profiles/commerce-desktop/package.json'), '{}');
    await mkdir(path.join(profile, 'plugins'));
    await writeFile(path.join(profile, 'plugins/state.json'), JSON.stringify({ plugins: { 'official.labeledit': { enabled: false } } }));
    await writeFile(path.join(profile, 'user-document.pdf'), 'preserved document');
    await writeFile(configFile, JSON.stringify({ url: 'https://market.example/catalog.json', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }));
    app = await _electron.launch({ args: [process.cwd(), '--user-data-dir=' + profile] });
    const page = await app.firstWindow();
    await expect(page.getByText('工具服务已就绪')).toBeVisible();
    const recover = page.getByRole('button', { name: '恢复 LabelEdit', exact: true });
    const later = page.getByRole('button', { name: '稍后从市场安装', exact: true });
    await expect(recover).toBeVisible();
    await app.evaluate(() => { globalThis.fetch = async () => { throw new Error('offline'); }; });
    await recover.click();
    await expect(page.getByRole('alert').filter({ hasText: 'offline' })).toBeVisible();
    await expect(recover).toBeEnabled();
    await expect(later).toBeEnabled();
    expect((await page.evaluate(() => window.commerceDesktop.invoke('status'))).plugins).toEqual([]);
    await page.screenshot({ path: path.join(screenshotDirectory, 'offline-error.png'), fullPage: false });
    const zip = new AdmZip();
    zip.addFile('package.json', Buffer.from(JSON.stringify({ version: '0.1.2', commerce: { manifestVersion: 1, id: 'official.labeledit', title: 'LabelEdit', description: '', api: '^1.1.0', ui: 'ui/index.html', permissions: {} } })));
    zip.addFile('ui/index.html', Buffer.from('<h1>Recovery fixture</h1>'));
    const bytes = zip.toBuffer(), catalog = { schemaVersion: 1, plugins: [{ id: 'official.labeledit', title: 'LabelEdit', description: '', version: '0.1.2', api: '^1.1.0', artifacts: { [process.platform + '-' + process.arch]: { url: 'https://market.example/plugin.ecplugin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), signature: sign(null, bytes, keys.privateKey).toString('base64') } } }] };
    await app.evaluate((_, value) => {
      globalThis.fetch = async url => {
        if (String(url).endsWith('catalog.json')) return Response.json(value.catalog);
        const bytes = Buffer.from(value.bytes, 'base64'), half = Math.max(1, Math.floor(bytes.length / 2));
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(bytes.subarray(0, half));
          setTimeout(() => { controller.enqueue(bytes.subarray(half)); controller.close(); }, 2000);
        } }), { headers: { 'Content-Length': String(bytes.length) } });
      };
    }, { catalog, bytes: bytes.toString('base64') });
    await recover.click();
    const recovery = page.getByRole('status', { name: 'LabelEdit 恢复状态', exact: true });
    await expect(recovery).toContainText('正在下载插件');
    await expect(recover).toBeDisabled();
    await expect(later).toBeDisabled();
    expect((await page.evaluate(() => window.commerceDesktop.invoke('status'))).plugins).toEqual([]);
    await page.screenshot({ path: path.join(screenshotDirectory, 'recovery-progress.png'), fullPage: false });
    await expect(recover).toHaveCount(0);
    expect((await page.evaluate(() => window.commerceDesktop.invoke('status'))).plugins[0].enabled).toBe(false);
    expect(await readFile(path.join(profile, 'user-document.pdf'), 'utf8')).toBe('preserved document');
    await app.close(); app = null;
    app = await _electron.launch({ args: [process.cwd(), '--user-data-dir=' + profile] });
    const reopened = await app.firstWindow();
    await expect(reopened.getByText('工具服务已就绪')).toBeVisible();
    const status = await reopened.evaluate(() => window.commerceDesktop.invoke('status'));
    expect(status.migration).toBeNull();
    expect(status.plugins[0]).toMatchObject({ version: '0.1.2', enabled: false });
  } finally { await app?.close(); await writeFile(configFile, originalConfig); await rm(temporary, { recursive: true, force: true }); }
});
