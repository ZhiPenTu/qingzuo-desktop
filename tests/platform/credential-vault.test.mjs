import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { CredentialVault, MAX_GRANTS, MAX_RECORDS } from '../../desktop/credential-vault.mjs';
import { createPluginClient } from '../../packages/plugin-sdk/index.mjs';

class MemoryCredentials {
  constructor() { this.values = new Map(); }
  async set(owner, name, value) { this.values.set(owner + ':' + name, value); }
  async get(owner, name) { return this.values.get(owner + ':' + name) ?? null; }
  async clear(owner, name) { this.values.delete(owner + ':' + name); }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-vault-'));
  const credentials = new MemoryCredentials();
  const vault = new CredentialVault({ root, credentials, now: () => 1700000000000 });
  await vault.initialize();
  return { root, credentials, vault };
}

test('shared records store metadata separately from secrets', async () => {
  const { root, credentials, vault } = await fixture();
  try {
    const record = await vault.create({ label: '店铺 A', appId: 'app-123456', secretKey: 'secret-value', environment: 'sandbox' });
    assert.match(record.id, /^rec-[a-f0-9]{12}$/);
    assert.equal(record.appId, 'app-123456');
    assert.equal(record.environment, 'sandbox');
    assert.equal(record.hasSecret, true);
    assert.equal('secretKey' in record, false);
    assert.equal(credentials.values.get('vault:record-' + record.id), 'secret-value');
    const file = JSON.parse(await readFile(path.join(root, 'credential-records.json'), 'utf8'));
    assert.equal(file.schemaVersion, 1);
    assert.equal(JSON.stringify(file).includes('secret-value'), false);
    assert.equal(await vault.secret(record.id), 'secret-value');
    assert.deepEqual(await vault.accessOf(record.id), { id: record.id, label: '店铺 A', appId: 'app-123456', environment: 'sandbox' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('labels are unique, limits are enforced and updates can replace secrets', async () => {
  const { root, credentials, vault } = await fixture();
  try {
    const record = await vault.create({ label: 'Main', appId: 'a', secretKey: 'one' });
    await assert.rejects(() => vault.create({ label: 'main', appId: 'b', secretKey: 'two' }), /同名/);
    await assert.rejects(() => vault.create({ label: '', appId: 'b', secretKey: 'two' }), /别名/);
    await assert.rejects(() => vault.create({ label: 'bad', appId: 'b', secretKey: 'x'.repeat(1025) }), /密钥/);
    const updated = await vault.update(record.id, { label: 'Renamed', secretKey: 'two' });
    assert.equal(updated.label, 'Renamed');
    assert.equal(credentials.values.get('vault:record-' + record.id), 'two');
    assert.equal(await vault.secret(record.id), 'two');
    await vault.update(record.id, { label: 'Renamed again', secretKey: '' });
    assert.equal(await vault.secret(record.id), 'two');
    for (let index = 1; index < MAX_RECORDS; index += 1) await vault.create({ label: '凭证 ' + index, appId: 'app', secretKey: 's' });
    await assert.rejects(() => vault.create({ label: 'overflow', appId: 'app', secretKey: 's' }), /64/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('grants are scoped per plugin and revocation is durable', async () => {
  const { root, credentials, vault } = await fixture();
  try {
    const first = await vault.create({ label: 'A', appId: 'app-a', secretKey: 'one' });
    const second = await vault.create({ label: 'B', appId: 'app-b', secretKey: 'two' });
    assert.equal((await vault.listGranted('official.consumer')).length, 0);
    assert.deepEqual(await vault.grant('official.consumer', first.id), { id: first.id, label: 'A', appId: 'app-a', environment: 'production' });
    assert.equal((await vault.listGranted('official.consumer')).length, 1);
    assert.equal((await vault.list()).length, 2);
    const candidates = await vault.browse('official.consumer');
    assert.equal(candidates.find(item => item.id === first.id).granted, true);
    assert.equal(candidates.find(item => item.id === second.id).granted, false);
    assert.equal(candidates.find(item => item.id === first.id).appIdMasked, '••••pp-a');
    assert.deepEqual((await vault.grants(first.id)).map(item => item.pluginId), ['official.consumer']);
    await vault.revoke('official.consumer', first.id);
    assert.equal(vault.isGranted('official.consumer', first.id), false);
    await vault.grant('official.consumer', first.id);
    await vault.revokePlugin('official.consumer');
    assert.equal(vault.isGranted('official.consumer', first.id), false);
    await vault.grant('official.consumer', first.id);
    await vault.revokeGrant(first.id, 'official.consumer');
    assert.equal(vault.isGranted('official.consumer', first.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('each record is limited to 64 plugin grants', async () => {
  const { root, credentials, vault } = await fixture();
  try {
    const record = await vault.create({ label: '共享', appId: 'app', secretKey: 'secret' });
    for (let index = 0; index < MAX_GRANTS; index += 1) await vault.grant('local.consumer-' + index, record.id);
    await assert.rejects(() => vault.grant('local.overflow', record.id), /授权数量已达上限/);
    assert.equal((await vault.grants(record.id)).length, MAX_GRANTS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent writes are serialized without losing records', async () => {
  const { root, vault } = await fixture();
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => vault.create({
      label: '并发凭证 ' + index,
      appId: 'app-' + index,
      secretKey: 'secret-' + index,
    })));
    assert.equal((await vault.list()).length, 8);
    const file = JSON.parse(await readFile(path.join(root, 'credential-records.json'), 'utf8'));
    assert.equal(file.records.length, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deleting a record removes its grants and secret', async () => {
  const { root, credentials, vault } = await fixture();
  try {
    const record = await vault.create({ label: 'A', appId: 'app', secretKey: 'secret' });
    await vault.grant('official.consumer', record.id);
    await vault.remove(record.id);
    assert.equal(credentials.values.size, 0);
    assert.deepEqual(await vault.grants(record.id).catch(() => []), []);
    await assert.rejects(() => vault.secret(record.id), /凭证已删除/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a corrupt index is backed up and rebuilt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-vault-corrupt-'));
  try {
    await writeFile(path.join(root, 'credential-records.json'), '{broken');
    const vault = new CredentialVault({ root, credentials: new MemoryCredentials() });
    const messages = [];
    vault.log = message => messages.push(message);
    await vault.initialize();
    assert.deepEqual(await vault.list(), []);
    assert.equal(messages.length, 1);
    assert.equal((await readdir(root)).some(name => name.includes('.corrupt-')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the SDK keeps the update id authoritative over patch fields', async () => {
  const calls = [];
  const client = createPluginClient({
    invoke: async (method, args) => { calls.push([method, args]); },
    onDispose: () => () => {},
  });
  await client.credentials.records.update('rec-abcdef123456', { id: 'rec-000000000000', label: '改名' });
  assert.deepEqual(calls, [['credentials.records.update', { label: '改名', id: 'rec-abcdef123456' }]]);
});
