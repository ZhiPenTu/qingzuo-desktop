import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_AUTO_UPDATE, UpdatePreferences } from '../../desktop/update-preferences.mjs';

test('automatic updates default on and persist only validated booleans', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-update-preferences-'));
  try {
    const preferences = new UpdatePreferences({ root });
    assert.equal(DEFAULT_AUTO_UPDATE, true);
    assert.deepEqual(await preferences.initialize(), { autoUpdate: true });
    assert.deepEqual(await preferences.configure({ autoUpdate: false }), { autoUpdate: false });
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'update-settings.json'), 'utf8')), {
      schemaVersion: 1,
      autoUpdate: false,
    });
    await assert.rejects(preferences.configure({ autoUpdate: 'yes' }), /设置无效/);
    assert.deepEqual(new UpdatePreferences({ root }).snapshot(), { autoUpdate: true });
    const restored = new UpdatePreferences({ root });
    assert.deepEqual(await restored.initialize(), { autoUpdate: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid settings fall back to the safe default instead of blocking startup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-update-preferences-invalid-'));
  try {
    await writeFile(path.join(root, 'update-settings.json'), '{not-json');
    const preferences = new UpdatePreferences({ root });
    assert.deepEqual(await preferences.initialize(), { autoUpdate: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
