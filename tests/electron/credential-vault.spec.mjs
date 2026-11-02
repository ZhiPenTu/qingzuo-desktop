import { test, expect, _electron as electron } from '@playwright/test';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const root = process.cwd();
const configFile = path.join(root, 'resources/generated/market.json');
const manageId = 'official.credentials';
const consumerId = 'local.credentials-consumer';
const secret = 'ELECTRON-FIXTURE-SECRET';
const message = 'openKeyId=fixture&timestamp=1700000000000';

function fixturePlugin(id, title, permission) {
  const zip = new AdmZip();
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name: id,
    version: '0.1.0',
    commerce: {
      manifestVersion: 1,
      id,
      title,
      description: '共享凭证端到端测试插件',
      api: '^1.7.0',
      ui: 'ui/index.html',
      permissions: { credentialVault: permission },
    },
  })));
  zip.addFile('ui/index.html', Buffer.from('<!doctype html><html lang="zh-CN"><body><h1>' + title + '</h1></body></html>'));
  return zip.toBuffer();
}

async function prepareFixtures() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const entries = [
    { id: manageId, title: '凭证管理', permission: 'manage' },
    { id: consumerId, title: '凭证消费方', permission: 'use' },
  ];
  const artifacts = {}, plugins = entries.map(entry => {
    const bytes = fixturePlugin(entry.id, entry.title, entry.permission);
    const url = 'https://market.example/' + entry.id + '.ecplugin';
    artifacts[url] = bytes.toString('base64');
    return {
      id: entry.id,
      title: entry.title,
      description: '共享凭证端到端测试插件',
      version: '0.1.0',
      api: '^1.7.0',
      artifacts: {
        [process.platform + '-' + process.arch]: {
          url,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          signature: sign(null, bytes, privateKey).toString('base64'),
        },
      },
    };
  });
  const previous = await readFile(configFile);
  await writeFile(configFile, JSON.stringify({ url: 'https://market.example/catalog.json', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }));
  return { catalog: { schemaVersion: 1, plugins }, artifacts, previous };
}

async function installFixtures(application, page, fixtures) {
  await application.evaluate((_, value) => {
    globalThis.fetch = async address => {
      const url = String(address);
      if (url.endsWith('/catalog.json')) return new Response(JSON.stringify(value.catalog));
      const bytes = value.artifacts[url];
      if (!bytes) throw new Error('Unknown fixture artifact: ' + url);
      return new Response(Buffer.from(bytes, 'base64'));
    };
  }, fixtures);
  await page.evaluate(ids => Promise.all(ids.map(id => window.commerceDesktop.invoke('market.install', { id }))), [manageId, consumerId]);
  await expect.poll(async () => (await page.evaluate(() => window.commerceDesktop.invoke('status'))).plugins.map(plugin => plugin.id).sort(), { timeout: 60000 }).toEqual([consumerId, manageId].sort());
}

test('shared credentials install from the market, authorize a consumer, sign without exposing secrets, and revoke or delete access', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-credential-vault-'));
  const profile = path.join(temporary, 'profile');
  let application, fixtures;
  try {
    fixtures = await prepareFixtures();
    application = await electron.launch({ args: [root, '--user-data-dir=' + profile], timeout: 20000 });
    const page = await application.firstWindow();
    await expect.poll(async () => (await page.evaluate(() => window.commerceDesktop.invoke('status'))).kernel.ready, { timeout: 60000 }).toBe(true);
    await installFixtures(application, page, fixtures);
    await application.evaluate(({ dialog }) => {
      globalThis.credentialDialogs = [];
      dialog.showMessageBox = async (_window, options) => {
        globalThis.credentialDialogs.push(options);
        return { response: 1 };
      };
    });

    await page.evaluate(id => window.commerceDesktop.invoke('view.open', { id }), manageId);
    await expect.poll(() => application.context().pages().some(candidate => candidate.url().startsWith('commerce-plugin://' + manageId + '/')), { timeout: 60000 }).toBe(true);
    const manage = application.context().pages().find(candidate => candidate.url().startsWith('commerce-plugin://' + manageId + '/'));
    const created = await manage.evaluate(() => window.commercePlugin.invoke('credentials.records.create', {
      label: '端到端凭证',
      appId: 'APP-E2E-123456',
      environment: 'sandbox',
      secretKey: 'ELECTRON-FIXTURE-SECRET',
    }));
    expect(created.id).toMatch(/^rec-[a-f0-9]{12}$/);
    expect(created).not.toHaveProperty('secretKey');
    expect(JSON.stringify(created)).not.toContain(secret);

    await page.evaluate(async id => {
      await window.commerceDesktop.invoke('view.open', { id });
      await window.commerceDesktop.invoke('view.bounds', { id, x: 10, y: 10, width: 500, height: 400 });
    }, consumerId);
    await expect.poll(() => application.context().pages().some(candidate => candidate.url().startsWith('commerce-plugin://' + consumerId + '/')), { timeout: 60000 }).toBe(true);
    const consumer = application.context().pages().find(candidate => candidate.url().startsWith('commerce-plugin://' + consumerId + '/'));
    expect(await consumer.evaluate(() => window.commercePlugin.invoke('credentials.records.list'))).toEqual([]);
    const candidates = await consumer.evaluate(() => window.commercePlugin.invoke('credentials.records.browse'));
    expect(candidates).toEqual([{ id: created.id, label: '端到端凭证', environment: 'sandbox', appIdMasked: '••••3456', granted: false }]);
    expect(JSON.stringify(candidates)).not.toContain('APP-E2E-123456');

    const access = await consumer.evaluate(id => window.commercePlugin.invoke('credentials.records.request', { id }), created.id);
    expect(access).toEqual({ id: created.id, label: '端到端凭证', appId: 'APP-E2E-123456', environment: 'sandbox' });
    expect(JSON.stringify(access)).not.toContain(secret);
    const dialogs = await application.evaluate(() => globalThis.credentialDialogs);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].message).toContain('凭证消费方');
    expect(dialogs[0].message).toContain('端到端凭证');
    expect(dialogs[0].detail).toContain('APP-E2E-123456');
    const granted = await consumer.evaluate(() => window.commercePlugin.invoke('credentials.records.list'));
    expect(granted.map(record => record.id)).toEqual([created.id]);
    expect(JSON.stringify(granted)).not.toContain(secret);

    const signed = await consumer.evaluate(({ id, value }) => window.commercePlugin.invoke('network.sign', {
      credential: { record: id },
      algorithm: 'hmac-sha256',
      message: value,
    }), { id: created.id, value: message });
    expect(signed.digest).toBe(createHmac('sha256', secret).update(message).digest('base64'));
    expect(JSON.stringify(signed)).not.toContain(secret);

    if (process.platform === 'darwin') {
      const vault = await readFile(path.join(profile, 'credentials-vault.json'), 'utf8');
      expect(vault).toContain('enc:v1:');
      expect(vault).not.toContain(secret);
      const index = await readFile(path.join(profile, 'credential-records.json'), 'utf8');
      expect(index).not.toContain(secret);
    }

    await consumer.evaluate(id => window.commercePlugin.invoke('credentials.records.revoke', { id }), created.id);
    const denied = await consumer.evaluate(async id => {
      try {
        await window.commercePlugin.invoke('network.sign', { credential: { record: id }, algorithm: 'hmac-sha256', message: 'x' });
        return null;
      } catch (error) {
        return error.message;
      }
    }, created.id);
    expect(denied).toBe('请先在凭证管理中授权这个工具使用该凭证。');

    await consumer.evaluate(id => window.commercePlugin.invoke('credentials.records.request', { id }), created.id);
    await manage.evaluate(id => window.commercePlugin.invoke('credentials.records.remove', { id }), created.id);
    expect(await consumer.evaluate(() => window.commercePlugin.invoke('credentials.records.browse'))).toEqual([]);
    expect(await manage.evaluate(() => window.commercePlugin.invoke('credentials.records.list'))).toEqual([]);
    const deleted = await consumer.evaluate(async id => {
      try {
        await window.commercePlugin.invoke('credentials.records.request', { id });
        return null;
      } catch (error) {
        return error.message;
      }
    }, created.id);
    expect(deleted).toBe('凭证已删除，请重新选择。');
  } finally {
    await application?.close().catch(() => {});
    if (fixtures?.previous) await writeFile(configFile, fixtures.previous).catch(() => {});
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
