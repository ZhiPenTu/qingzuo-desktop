import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginStorage } from '../../desktop/plugin-storage.mjs';
import { FileBroker } from '../../desktop/brokers.mjs';

const plugin = { id: 'plugin.shein-full', title: 'Fixture', permissions: { files: true, storage: true } };
const other = { id: 'plugin.other', title: 'Other', permissions: { files: true, storage: true } };

test('plugin storage isolates values, survives restart and stays bounded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-storage-'));
  const storage = new PluginStorage(root);
  await storage.initialize();
  try {
    assert.equal(await storage.get(plugin, 'drafts'), null);
    await storage.set(plugin, 'drafts', [{ id: 'a' }]);
    assert.deepEqual(await storage.get(plugin, 'drafts'), [{ id: 'a' }]);
    assert.deepEqual(await storage.keys(plugin), ['drafts']);
    assert.equal(await storage.get(other, 'drafts'), null);
    const restarted = new PluginStorage(root);
    await restarted.initialize();
    assert.deepEqual(await restarted.get(plugin, 'drafts'), [{ id: 'a' }]);
    await assert.rejects(restarted.set(plugin, 'huge', 'x'.repeat(1024 * 1024 + 1)), /1 MB/);
    await assert.rejects(restarted.set(plugin, '../escape', 1), /键名无效/);
    assert.equal(await restarted.remove(plugin, 'drafts'), true);
    assert.equal(await restarted.remove(plugin, 'drafts'), false);
    assert.deepEqual(await restarted.keys(plugin), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stored files stay usable for uploads after restart and never cross plugins', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-storage-files-'));
  const storage = new PluginStorage(root);
  await storage.initialize();
  const files = new FileBroker(path.join(root, 'ephemeral'), {}, { persistent: storage });
  try {
    const bytes = Buffer.from('89 50 4e 47'.replaceAll(' ', ''), 'hex');
    const saved = await storage.saveFile(plugin, { data: bytes.toString('base64'), filename: '主图.png', mime: 'image/png' });
    assert.equal(saved.name, '主图.png');
    assert.deepEqual(await storage.readFile(plugin, saved.token), { data: bytes.toString('base64'), mime: 'image/png' });
    const restartedFiles = new FileBroker(path.join(root, 'ephemeral'), {}, { persistent: new PluginStorage(root) });
    const item = await restartedFiles.get(plugin, saved.token);
    assert.equal(item.owner, plugin.id);
    assert.equal(item.size, bytes.length);
    await assert.rejects(restartedFiles.get(other, saved.token), /失效/);
    await assert.rejects(storage.readFile(other, saved.token), /失效/);
    await storage.clear(plugin.id);
    await assert.rejects(storage.readFile(plugin, saved.token), /失效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
