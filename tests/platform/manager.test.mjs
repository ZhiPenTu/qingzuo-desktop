import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { PluginManager, inspectPackage, marketTierMigrationMatches, marketTierRebindNeeded, marketTierUpdate, unpackPackage, verifyArtifact } from '../../desktop/plugin-manager.mjs';
import { validateManifest, TARGET } from '../../desktop/security.mjs';
import { expectedReleaseArtifactUrl, resolveMarketEntries } from '../../desktop/catalog.mjs';
function archive(version = '0.1.0', overrides = {}) {
  const zip = new AdmZip(); zip.addFile('package.json', Buffer.from(JSON.stringify({ name: 'fixture', version, commerce: { manifestVersion: 1, id: 'local.fixture', title: 'Fixture', description: 'test', api: '^1.0.0', ui: 'ui/index.html', permissions: {}, ...overrides } }))); zip.addFile('ui/index.html', Buffer.from('<h1>Fixture</h1>')); return zip.toBuffer();
}
function releaseRecord(bytes, version = '0.1.0', extra = {}) {
  return { id: 'local.fixture', version, api: '^1.0.0', platform: TARGET, sha256: createHash('sha256').update(bytes).digest('hex'), verification: 'github-release', ...extra };
}
test('local plugin can install, persist, disable, enable, upgrade, rollback and uninstall without a base build', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-manager-')); const bundled = path.join(root, 'bundled'); await mkdir(bundled);
  const stops = []; const manager = new PluginManager(path.join(root, 'plugins'), bundled, { stop: async id => stops.push(id) });
  try {
    await manager.initialize(); await manager.install(archive()); assert.equal((await manager.list())[0].version, '0.1.0');
    assert.equal((await manager.get('local.fixture')).tier, 'community');
    assert.match(manager.state.plugins['local.fixture'].artifactSha256, /^[a-f0-9]{64}$/);
    assert.match(manager.state.plugins['local.fixture'].folder, /^installed\/local\.fixture\/[A-Za-z0-9_-]{22}$/);
    await manager.setEnabled('local.fixture', false); assert.equal((await manager.get('local.fixture')).enabled, false);
    await manager.setEnabled('local.fixture', true); await manager.install(archive('0.2.0')); assert.equal((await manager.get('local.fixture')).version, '0.2.0');
    await manager.rollback('local.fixture'); assert.equal((await manager.get('local.fixture')).version, '0.1.0');
    const reloaded = new PluginManager(path.join(root, 'plugins'), bundled); await reloaded.initialize(); assert.equal((await reloaded.get('local.fixture')).version, '0.1.0');
    await manager.uninstall('local.fixture'); assert.equal((await manager.list()).length, 0); assert.ok(stops.length >= 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('failed upgrade preserves prior active version and persistent state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-upgrade-')); await mkdir(path.join(root, 'bundled'));
  const manager = new PluginManager(path.join(root, 'plugins'), path.join(root, 'bundled'), { probe: async p => { if (p.version === '0.2.0') throw new Error('startup failed'); } });
  try { await manager.initialize(); await manager.install(archive()); const state = await readFile(path.join(root, 'plugins/state.json')); await assert.rejects(manager.install(archive('0.2.0')), /startup failed/); assert.equal((await manager.get('local.fixture')).version, '0.1.0'); assert.deepEqual(await readFile(path.join(root, 'plugins/state.json')), state); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('failed stop removes the candidate directory, preserves installed state and permits retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-stop-failure-')); const bundled = path.join(root, 'bundled'); await mkdir(bundled);
  const primary = new Error('old plugin stop failed'); let stopError = null;
  const manager = new PluginManager(path.join(root, 'plugins'), bundled, { stop: async () => { if (stopError) throw stopError; } });
  try {
    await manager.initialize(); await manager.install(archive());
    const previous = structuredClone(manager.state.plugins['local.fixture']); const state = await readFile(path.join(root, 'plugins/state.json'));
    const installed = path.join(root, 'plugins/installed/local.fixture'); const folders = await readdir(installed);
    stopError = primary;
    await assert.rejects(manager.install(archive('0.2.0')), error => error === primary);
    assert.deepEqual(manager.state.plugins['local.fixture'], previous); assert.deepEqual(await readFile(path.join(root, 'plugins/state.json')), state);
    assert.deepEqual(await readdir(installed), folders); assert.deepEqual(await readdir(path.join(root, 'plugins/.staging')), []);
    const reloaded = new PluginManager(path.join(root, 'plugins'), bundled); await reloaded.initialize(); assert.equal((await reloaded.get('local.fixture')).version, '0.1.0');
    stopError = null; await manager.install(archive('0.2.0')); assert.equal((await manager.get('local.fixture')).version, '0.2.0');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('failed candidate stop does not replace the original probe error or skip directory cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-rollback-stop-')); const bundled = path.join(root, 'bundled'); await mkdir(bundled);
  const primary = new Error('candidate startup failed'); let stopCalls = 0;
  const manager = new PluginManager(path.join(root, 'plugins'), bundled, {
    stop: async () => { if (++stopCalls === 3) throw new Error('candidate stop failed'); },
    probe: async plugin => { if (plugin.version === '0.2.0') throw primary; },
  });
  try {
    await manager.initialize(); await manager.install(archive()); const state = await readFile(path.join(root, 'plugins/state.json'));
    const installed = path.join(root, 'plugins/installed/local.fixture'); const folders = await readdir(installed);
    await assert.rejects(manager.install(archive('0.2.0')), error => error === primary);
    assert.equal(stopCalls, 3); assert.equal((await manager.get('local.fixture')).version, '0.1.0');
    assert.deepEqual(await readFile(path.join(root, 'plugins/state.json')), state); assert.deepEqual(await readdir(installed), folders);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('filesystem cleanup failures preserve the original installation error', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-cleanup-failure-')); const bundled = path.join(root, 'bundled'); await mkdir(bundled);
  const primary = new Error('old plugin stop failed'); let stopError = null;
  const manager = new PluginManager(path.join(root, 'plugins'), bundled, { stop: async () => { if (stopError) throw stopError; } });
  const originalRm = fs.rm;
  try {
    await manager.initialize(); await manager.install(archive()); const state = await readFile(path.join(root, 'plugins/state.json')); const previous = structuredClone(manager.state.plugins['local.fixture']);
    const attempts = [];
    context.mock.method(fs, 'rm', async (file, options) => { attempts.push(file); if (String(file).startsWith(path.join(root, 'plugins'))) throw new Error('cleanup denied'); return originalRm(file, options); });
    syncBuiltinESMExports(); stopError = primary;
    await assert.rejects(manager.install(archive('0.2.0')), error => error === primary);
    assert.ok(attempts.some(file => String(file).startsWith(path.join(root, 'plugins/installed/local.fixture'))));
    assert.ok(attempts.some(file => String(file).startsWith(path.join(root, 'plugins/.staging'))));
    assert.deepEqual(manager.state.plugins['local.fixture'], previous); assert.deepEqual(await readFile(path.join(root, 'plugins/state.json')), state);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await originalRm(root, { recursive: true, force: true }); }
});
test('package signature binds artifact bytes, target, plugin identity and version', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const bytes = archive(); const record = { platform: TARGET, sha256: createHash('sha256').update(bytes).digest('hex'), signature: sign(null, bytes, privateKey).toString('base64') };
  verifyArtifact(bytes, record, publicKey); assert.throws(() => verifyArtifact(Buffer.concat([bytes, Buffer.from('tampered')]), record, publicKey)); assert.throws(() => verifyArtifact(bytes, { ...record, platform: 'invalid' }, publicKey)); assert.throws(() => verifyArtifact(bytes, record, null));
});
test('registered GitHub releases use an explicit digest-only verification mode', () => {
  const bytes = archive(), record = { platform: TARGET, sha256: createHash('sha256').update(bytes).digest('hex'), verification: 'github-release' };
  verifyArtifact(bytes, record, null);
  assert.throws(() => verifyArtifact(Buffer.concat([bytes, Buffer.from('tampered')]), record, null), /校验失败/);
  assert.throws(() => verifyArtifact(bytes, { ...record, verification: undefined }, null), /可信签名/);
});
test('legacy signed records keep their original package metadata contract', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), bytes = archive();
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-legacy-record-')), bundled = path.join(root, 'bundled');
  const manager = new PluginManager(path.join(root, 'plugins'), bundled, { publicKey });
  const record = {
    id: 'local.fixture',
    version: '0.1.0',
    api: '^1.0.0',
    platform: TARGET,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: sign(null, bytes, privateKey).toString('base64'),
    title: '旧目录标题',
    category: '旧目录分类',
    releaseNotes: '旧版本说明',
  };
  try {
    await mkdir(bundled); await manager.initialize();
    await manager.install(bytes, { source: 'market', tier: 'community', record });
    assert.equal((await manager.get('local.fixture')).version, '0.1.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('registered GitHub releases install through the normal atomic manager transaction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-release-manager-')), bundled = path.join(root, 'bundled');
  await mkdir(bundled);
  const manager = new PluginManager(path.join(root, 'plugins'), bundled);
  const bytes = archive(), record = {
    id: 'local.fixture',
    version: '0.1.0',
    api: '^1.0.0',
    platform: TARGET,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    verification: 'github-release',
  };
  try {
    await manager.initialize();
    await manager.install(bytes, { source: 'market', tier: 'official', record });
    assert.equal((await manager.get('local.fixture')).version, '0.1.0');
    assert.equal((await manager.get('local.fixture')).tier, 'official');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('market installs require an explicit catalog tier while local installs are always community', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-market-tier-')), bundled = path.join(root, 'bundled');
  await mkdir(bundled);
  const manager = new PluginManager(path.join(root, 'plugins'), bundled);
  const bytes = archive(), record = releaseRecord(bytes, '0.1.0', { tier: 'platform', official: true });
  try {
    await manager.initialize();
    await assert.rejects(manager.install(bytes, { source: 'market', record }), /信任层/);
    for (const tier of ['builtin', 'unknown', null]) {
      await assert.rejects(manager.install(bytes, { source: 'market', tier, record }), /信任层/);
    }
    await manager.install(bytes, { source: 'market', tier: 'community', record });
    assert.equal((await manager.get('local.fixture')).tier, 'community');
    assert.equal((await manager.get('local.fixture')).official, false);
    assert.equal(manager.state.plugins['local.fixture'].artifactSha256, record.sha256);
    const reloaded = new PluginManager(path.join(root, 'plugins'), bundled);
    await reloaded.initialize();
    assert.equal((await reloaded.get('local.fixture')).tier, 'community');
    const localBytes = archive('0.2.0');
    await reloaded.install(localBytes, { source: 'local', tier: 'platform' });
    assert.equal((await reloaded.get('local.fixture')).tier, 'community');
    assert.equal(reloaded.state.plugins['local.fixture'].artifactSha256, createHash('sha256').update(localBytes).digest('hex'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('legacy market state without a tier is community and manifest or identifier fields cannot elevate it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-legacy-tier-')), bundled = path.join(root, 'bundled'), plugins = path.join(root, 'plugins');
  const legacyFolder = path.join(plugins, 'installed', 'official.forged', 'fixture');
  const reviewedFolder = path.join(plugins, 'installed', 'official.reviewed', 'fixture');
  const localFolder = path.join(plugins, 'installed', 'local.forged', 'fixture');
  await mkdir(legacyFolder, { recursive: true });
  await mkdir(reviewedFolder, { recursive: true });
  await mkdir(localFolder, { recursive: true });
  await mkdir(bundled);
  const manifest = (id, tier) => JSON.stringify({ name: 'fixture', version: '0.1.0', commerce: { manifestVersion: 1, id, title: id, description: 'test', api: '^1.0.0', ui: 'ui/index.html', permissions: {}, tier } });
  await writeFile(path.join(legacyFolder, 'package.json'), manifest('official.forged', 'platform'));
  await writeFile(path.join(reviewedFolder, 'package.json'), manifest('official.reviewed', 'community'));
  await writeFile(path.join(localFolder, 'package.json'), manifest('local.forged', 'platform'));
  await writeFile(path.join(plugins, 'state.json'), JSON.stringify({ plugins: {
    'official.forged': { folder: 'installed/official.forged/fixture', enabled: true, source: 'market' },
    'official.reviewed': { folder: 'installed/official.reviewed/fixture', enabled: true, source: 'market', tier: 'official' },
    'local.forged': { folder: 'installed/local.forged/fixture', enabled: true, source: 'local', tier: 'platform' },
  } }));
  const manager = new PluginManager(plugins, bundled);
  try {
    await manager.initialize();
    const plugin = await manager.get('official.forged');
    assert.equal(plugin.tier, 'community');
    assert.equal(plugin.official, false);
    assert.equal((await manager.get('official.reviewed')).tier, 'official');
    assert.equal((await manager.get('local.forged')).tier, 'community');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('setMarketTier updates only a matching market installation and persists the reviewed tier', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-set-tier-')), bundled = path.join(root, 'bundled');
  await mkdir(bundled);
  const manager = new PluginManager(path.join(root, 'plugins'), bundled);
  const bytes = archive(), record = releaseRecord(bytes);
  try {
    await manager.initialize();
    await manager.install(bytes, { source: 'market', tier: 'community', record });
    await assert.rejects(manager.setMarketTier('local.fixture', 'official', { version: '0.2.0' }), /版本/);
    await assert.rejects(manager.setMarketTier('local.fixture', 'official', { version: '0.1.0', artifactSha256: 'f'.repeat(64) }), /摘要/);
    await assert.rejects(manager.setMarketTier('local.fixture', 'platform-invalid', { version: '0.1.0' }), /信任层/);
    const updated = await manager.setMarketTier('local.fixture', 'official', { version: '0.1.0', artifactSha256: record.sha256 });
    assert.equal(updated.tier, 'official');
    assert.equal(manager.state.plugins['local.fixture'].tier, 'official');
    const reloaded = new PluginManager(path.join(root, 'plugins'), bundled);
    await reloaded.initialize();
    assert.equal((await reloaded.get('local.fixture')).tier, 'official');
    await reloaded.install(archive('0.2.0'), { source: 'local' });
    await assert.rejects(reloaded.setMarketTier('local.fixture', 'official', { version: '0.2.0' }), /市场安装/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('rollback keeps the active installation tier instead of restoring a previous row tier', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-rollback-tier-')), bundled = path.join(root, 'bundled');
  await mkdir(bundled);
  const manager = new PluginManager(path.join(root, 'plugins'), bundled);
  const first = archive('0.1.0'), second = archive('0.2.0');
  try {
    await manager.initialize();
    await manager.install(first, { source: 'market', tier: 'community', record: releaseRecord(first) });
    await manager.install(second, { source: 'market', tier: 'official', record: releaseRecord(second, '0.2.0') });
    manager.state.plugins['local.fixture'].previous.tier = 'platform';
    await manager.rollback('local.fixture');
    const restored = await manager.get('local.fixture');
    assert.equal(restored.version, '0.1.0');
    assert.equal(restored.tier, 'official');
    assert.equal(manager.state.plugins['local.fixture'].tier, 'official');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('rollback never raises a lower previous tier to the active platform tier', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-rollback-lower-tier-')), bundled = path.join(root, 'bundled');
  await mkdir(bundled);
  const manager = new PluginManager(path.join(root, 'plugins'), bundled);
  const first = archive('0.1.0'), second = archive('0.2.0');
  try {
    await manager.initialize();
    await manager.install(first, { source: 'market', tier: 'community', record: releaseRecord(first) });
    await manager.install(second, { source: 'market', tier: 'platform', record: releaseRecord(second, '0.2.0') });
    await manager.rollback('local.fixture');
    assert.equal((await manager.get('local.fixture')).version, '0.1.0');
    assert.equal((await manager.get('local.fixture')).tier, 'community');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('legacy tier migration requires matching version, artifact digest and catalog digest', () => {
  const sha256 = 'a'.repeat(64);
  const plugin = { tierKnown: false, version: '1.0.0', artifactSha256: sha256 };
  const entry = { version: '1.0.0', artifacts: { [TARGET]: { sha256 } } };
  assert.equal(marketTierMigrationMatches(plugin, entry, TARGET), true);
  assert.equal(marketTierMigrationMatches({ ...plugin, version: '1.0.1' }, entry, TARGET), false);
  assert.equal(marketTierMigrationMatches({ ...plugin, tierKnown: true }, entry, TARGET), false);
  assert.equal(marketTierMigrationMatches({ ...plugin, artifactSha256: undefined }, entry, TARGET), false);
  assert.equal(marketTierMigrationMatches(plugin, { ...entry, artifacts: {} }, TARGET), false);
  assert.equal(marketTierMigrationMatches(plugin, { ...entry, artifacts: { [TARGET]: { sha256: 'b'.repeat(64) } } }, TARGET), false);
});
test('reviewed tier changes elevate the matching artifact and always apply revocations', () => {
  const sha256 = 'a'.repeat(64);
  const market = { source: 'market', tierKnown: true, tier: 'official', version: '1.0.0', artifactSha256: sha256 };
  const entry = { tier: 'platform', version: '1.0.0', artifacts: { [TARGET]: { sha256 } } };
  assert.deepEqual(marketTierUpdate(market, entry, TARGET), { tier: 'platform', version: '1.0.0', artifactSha256: sha256 });
  assert.equal(marketTierUpdate({ ...market, version: '1.0.1' }, entry, TARGET), null);
  assert.equal(marketTierUpdate({ ...market, artifactSha256: 'b'.repeat(64) }, entry, TARGET), null);
  assert.equal(marketTierUpdate(market, { ...entry, artifacts: {} }, TARGET), null);
  assert.equal(marketTierUpdate({ ...market, tier: 'platform' }, entry, TARGET), null);
  assert.equal(marketTierUpdate({ ...market, source: 'local' }, entry, TARGET), null);
  assert.deepEqual(
    marketTierUpdate({ ...market, tier: 'platform', artifactSha256: undefined }, { tier: 'community', version: '1.0.0', artifacts: {} }, TARGET),
    { tier: 'community', version: '1.0.0' },
  );
  assert.deepEqual(
    marketTierUpdate({ ...market, tierKnown: false, tier: 'community' }, entry, TARGET),
    { tier: 'platform', version: '1.0.0', artifactSha256: sha256 },
  );
  assert.equal(marketTierUpdate({ ...market, tierKnown: false, tier: 'community' }, { ...entry, version: '1.0.1' }, TARGET), null);
});
test('an installed official plugin upgrades to platform from a reviewed catalog entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-reviewed-tier-')), bundled = path.join(root, 'bundled'), plugins = path.join(root, 'plugins');
  const id = 'official.fixture', version = '0.1.0', sha256 = 'c'.repeat(64);
  const folder = path.join(plugins, 'installed', id, 'fixture');
  await mkdir(folder, { recursive: true });
  await mkdir(bundled);
  await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'fixture', version, commerce: { manifestVersion: 1, id, title: id, description: 'test', api: '^1.0.0', ui: 'ui/index.html', permissions: {} } }));
  await writeFile(path.join(plugins, 'state.json'), JSON.stringify({ plugins: {
    [id]: { folder: 'installed/' + id + '/fixture', enabled: true, source: 'market', tier: 'official', tierKnown: true, artifactSha256: sha256 },
  } }));
  const repository = 'ZhiPenTu/fixture';
  const fragment = { schemaVersion: 1, plugins: [{
    id, version, title: id, description: 'test', api: '^1.0.0',
    artifacts: { [TARGET]: { url: expectedReleaseArtifactUrl(repository, id, version, TARGET), size: 1024, sha256 } },
  }] };
  const entries = await resolveMarketEntries({ schemaVersion: 1, plugins: [{
    id, tier: 'platform', official: true, title: id, description: 'test', version, api: '^1.0.0',
    source: { type: 'github-release', repository },
  }] }, { platform: TARGET, load: async () => Buffer.from(JSON.stringify(fragment)) });
  const manager = new PluginManager(plugins, bundled);
  try {
    await manager.initialize();
    assert.equal((await manager.get(id)).tier, 'official');
    const update = marketTierUpdate(await manager.get(id), entries[0], TARGET);
    assert.deepEqual(update, { tier: 'platform', version, artifactSha256: sha256 });
    await manager.setMarketTier(id, update);
    const reloaded = new PluginManager(plugins, bundled);
    await reloaded.initialize();
    assert.equal((await reloaded.get(id)).tier, 'platform');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('legacy installs without a recorded digest only rebind to a higher tier', () => {
  const sha256 = 'd'.repeat(64);
  const plugin = { source: 'market', tier: 'community', tierKnown: false, version: '0.1.0' };
  const entry = { tier: 'platform', version: '0.1.0', artifacts: { [TARGET]: { sha256 } } };
  assert.equal(marketTierRebindNeeded(plugin, entry, TARGET), true);
  assert.equal(marketTierRebindNeeded(plugin, { ...entry, tier: 'official' }, TARGET), true);
  assert.equal(marketTierRebindNeeded(plugin, { ...entry, tier: 'community' }, TARGET), false);
  assert.equal(marketTierRebindNeeded(plugin, { ...entry, version: '0.1.1' }, TARGET), false);
  assert.equal(marketTierRebindNeeded({ ...plugin, source: 'local' }, entry, TARGET), false);
  assert.equal(marketTierRebindNeeded({ ...plugin, tierKnown: true }, entry, TARGET), false);
  assert.equal(marketTierRebindNeeded({ ...plugin, artifactSha256: sha256 }, entry, TARGET), false);
  assert.equal(marketTierRebindNeeded(plugin, { ...entry, artifacts: {} }, TARGET), false);
  assert.equal(marketTierRebindNeeded(plugin, { ...entry, artifacts: { [TARGET]: { sha256: 'x' } } }, TARGET), false);
});
test('a legacy install rebinds after the reviewed package matches every installed file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-rebind-')), bundled = path.join(root, 'bundled');
  const id = 'local.fixture', bytes = archive(), digest = createHash('sha256').update(bytes).digest('hex');
  await mkdir(bundled);
  try {
    const manager = new PluginManager(path.join(root, 'plugins'), bundled);
    await manager.initialize();
    await manager.install(bytes, { source: 'market', tier: 'community', record: releaseRecord(bytes) });
    const row = manager.state.plugins[id];
    delete row.tier; delete row.tierKnown; delete row.artifactSha256;
    await manager.persist();

    const reloaded = new PluginManager(path.join(root, 'plugins'), bundled);
    await reloaded.initialize();
    const legacy = await reloaded.get(id);
    assert.equal(legacy.tier, 'community');
    assert.equal(legacy.tierKnown, false);
    assert.equal(marketTierRebindNeeded(legacy, { tier: 'platform', version: '0.1.0', artifacts: { [TARGET]: { sha256: digest } } }, TARGET), true);

    await reloaded.bindMarketArtifact(id, bytes, { version: '0.1.0', tier: 'platform', artifact: releaseRecord(bytes) });
    const bound = await reloaded.get(id);
    assert.equal(bound.tier, 'platform');
    assert.equal(bound.tierKnown, true);
    assert.equal(reloaded.state.plugins[id].artifactSha256, digest);
    assert.equal((await reloaded.bindMarketArtifact(id, bytes, { version: '0.1.0', tier: 'platform', artifact: releaseRecord(bytes) })).tier, 'platform');
    await assert.rejects(reloaded.bindMarketArtifact(id, bytes, { version: '0.1.0', tier: 'official', artifact: releaseRecord(bytes) }), /已记录/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('rebinding rejects packages that differ from the installed files or identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-rebind-mismatch-')), bundled = path.join(root, 'bundled');
  await mkdir(bundled);
  const installLegacy = async () => {
    const manager = new PluginManager(path.join(root, 'plugins'), bundled);
    await manager.initialize();
    const bytes = archive();
    await manager.install(bytes, { source: 'market', tier: 'community', record: releaseRecord(bytes) });
    const row = manager.state.plugins['local.fixture'];
    delete row.tier; delete row.tierKnown; delete row.artifactSha256;
    await manager.persist();
    return { manager, bytes };
  };
  try {
    const first = await installLegacy();
    await assert.rejects(
      first.manager.bindMarketArtifact('local.fixture', first.bytes, { version: '0.1.0', tier: 'platform', artifact: { ...releaseRecord(first.bytes), sha256: 'e'.repeat(64) } }),
      /校验失败/,
    );
    const installedFolder = path.join(root, 'plugins', first.manager.state.plugins['local.fixture'].folder);
    await writeFile(path.join(installedFolder, 'ui/index.html'), '<h1>Changed</h1>');
    await assert.rejects(first.manager.bindMarketArtifact('local.fixture', first.bytes, { version: '0.1.0', tier: 'platform', artifact: releaseRecord(first.bytes) }), /已安装内容/);
    assert.equal((await first.manager.get('local.fixture')).tier, 'community');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'commerce-rebind-version-'));
  try {
    const manager = new PluginManager(path.join(secondRoot, 'plugins'), path.join(secondRoot, 'bundled'));
    await mkdir(path.join(secondRoot, 'bundled'));
    await manager.initialize();
    const bytes = archive();
    await manager.install(bytes, { source: 'market', tier: 'community', record: releaseRecord(bytes) });
    const row = manager.state.plugins['local.fixture'];
    delete row.tier; delete row.tierKnown; delete row.artifactSha256;
    await manager.persist();
    const next = archive('0.2.0');
    await assert.rejects(manager.bindMarketArtifact('local.fixture', next, { version: '0.2.0', tier: 'platform', artifact: releaseRecord(next, '0.2.0') }), /版本/);
  } finally {
    await rm(secondRoot, { recursive: true, force: true });
  }
});
test('a reviewed catalog icon may fill in a package without one, but embedded icons must match', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-catalog-icon-')), bundled = path.join(root, 'bundled');
  const first = archive(), second = archive('0.2.0', { icon: 'data:image/png;base64,iVBORw0KGgo=' });
  const catalogIcon = 'data:image/png;base64,iVBORw0KGgoAAA==';
  await mkdir(bundled);
  try {
    const manager = new PluginManager(path.join(root, 'plugins'), bundled);
    await manager.initialize();
    await manager.install(first, { source: 'market', tier: 'community', record: { ...releaseRecord(first), icon: catalogIcon } });
    assert.equal((await manager.get('local.fixture')).version, '0.1.0');
    await assert.rejects(
      manager.install(second, { source: 'market', tier: 'community', record: { ...releaseRecord(second, '0.2.0'), icon: catalogIcon } }),
      /市场展示信息/,
    );
    assert.equal((await manager.get('local.fixture')).version, '0.1.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('path traversal and symlink package entries are rejected before extraction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-malicious-'));
  try {
    // Rewrite actual local/central ZIP names; AdmZip.addFile normalizes traversal.
    const bytes = archive(); const from=Buffer.from('ui/index.html'), to=Buffer.from('../index.html');
    for(let offset=bytes.indexOf(from);offset>=0;offset=bytes.indexOf(from,offset+from.length)) to.copy(bytes,offset);
    await assert.rejects(unpackPackage(bytes,path.join(root,'stage')),/插件路径无效/);
    const zip=new AdmZip(archive());zip.addFile('symlink',Buffer.from('/tmp'));zip.getEntry('symlink').header.attr=(0o120777<<16)>>>0;
    await assert.rejects(unpackPackage(zip.toBuffer(),path.join(root,'stage')),/文件类型/);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('incompatible APIs, reserved identifiers and unsupported platforms are rejected', () => {
  for (const commerce of [{ api: '^2' }, { id: 'system.market' }, { ui: '../index.html' }, { icon: 'https://example.com/icon.png' }, { icon: 'data:image/png;base64,AAAA' }, { permissions: { network: ['http://localhost'] } }, { permissions: { credentialVault: 'admin' } }, { backend: { type: 'executable', entry: {} } }]) {
    const zip = new AdmZip(archive('0.1.0', commerce)); assert.throws(() => validateManifest(JSON.parse(zip.readAsText('package.json'))));
  }
});
test('shared credential permissions accept only use or manage', () => {
  for (const value of ['use', 'manage']) {
    const zip = new AdmZip(archive('0.1.0', { permissions: { credentialVault: value } }));
    assert.equal(validateManifest(JSON.parse(zip.readAsText('package.json'))).permissions.credentialVault, value);
  }
});
test('missing service dependencies prevent activation and preserve installed tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-dependency-')); await mkdir(path.join(root, 'bundled')); const manager = new PluginManager(path.join(root, 'plugins'), path.join(root, 'bundled'));
  try { await manager.initialize(); await assert.rejects(manager.install(archive('0.1.0', { services: { requires: ['unavailable.service'] } })), /缺少运行所需的组件/); assert.equal((await manager.list()).length, 0); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt installed state does not prevent bundled tools from starting',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'commerce-state-'));await mkdir(path.join(root,'bundled'));await mkdir(path.join(root,'plugins'));await writeFile(path.join(root,'plugins/state.json'),' {"plugins":{"bad":null}}');
 try {const manager=new PluginManager(path.join(root,'plugins'),path.join(root,'bundled'));await manager.initialize();assert.deepEqual(await manager.list(),[]);await manager.install(archive());assert.equal((await manager.list()).length,1);}finally{await rm(root,{recursive:true,force:true});}
});

test('bundled identity survives a later installation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-bundled-'));
  const bundled = path.join(root, 'bundled'), folder = path.join(bundled, 'local.fixture');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.1.0', commerce: { manifestVersion: 1, id: 'local.fixture', title: 'Fixture', description: 'test', api: '^1.0.0', ui: 'ui/index.html', permissions: {} } }));
  const manager = new PluginManager(path.join(root, 'plugins'), bundled);
  try {
    await manager.initialize();
    assert.equal((await manager.list())[0].bundled, true);
    assert.equal((await manager.list())[0].tier, 'platform');
    await manager.install(archive('0.2.0'));
    const installed = await manager.get('local.fixture');
    assert.equal(installed.source, 'local');
    assert.equal(installed.bundled, true);
    assert.equal(installed.tier, 'community');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uninstalling and reinstalling a plugin with services restores its descriptor without requiring app restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-reinstall-')); await mkdir(path.join(root, 'bundled'));
  const manager = new PluginManager(path.join(root, 'plugins'), path.join(root, 'bundled'));
  try {
    await manager.initialize();
    await manager.install(archive('0.1.0', { services: { provides: ['fixture.echo'] } }));
    assert.equal((await manager.list()).length, 1);
    assert.deepEqual((await manager.get('local.fixture')).services?.provides, ['fixture.echo']);
    await manager.uninstall('local.fixture');
    assert.equal((await manager.list()).length, 0);
    await manager.install(archive('0.1.0', { services: { provides: ['fixture.echo'] } }));
    assert.equal((await manager.list()).length, 1);
    assert.deepEqual((await manager.get('local.fixture')).services?.provides, ['fixture.echo']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('truncated or invalid zip packages fail with a clean Chinese message and support trailing padding and single-folder zip wrappers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-zip-format-'));
  try {
    const valid = archive();
    const truncated = valid.subarray(0, valid.length - 10);
    for (const bad of [Buffer.alloc(0), Buffer.from('not a zip'), truncated]) {
      assert.throws(() => inspectPackage(bad), err => {
        assert.match(err.message, /插件包格式无效或文件未下载完整/);
        assert.doesNotMatch(err.message, /ADM-ZIP/i);
        return true;
      });
      await assert.rejects(unpackPackage(bad, path.join(root, 'bad')), /插件包格式无效或文件未下载完整/);
    }
    const padded = Buffer.concat([valid, Buffer.from('   \r\n')]);
    assert.equal(inspectPackage(new Uint8Array(padded)).id, 'local.fixture');
    const wrapped = new AdmZip();
    wrapped.addFile('fixture-folder/', Buffer.alloc(0));
    wrapped.addFile('fixture-folder/package.json', Buffer.from(JSON.stringify({ name: 'fixture', version: '0.1.0', commerce: { manifestVersion: 1, id: 'local.fixture', title: 'Fixture', description: 'test', api: '^1.0.0', ui: 'ui/index.html', permissions: {} } })));
    wrapped.addFile('fixture-folder/ui/index.html', Buffer.from('<h1>Wrapped</h1>'));
    assert.equal(inspectPackage(wrapped.toBuffer()).id, 'local.fixture');
    const unpacked = await unpackPackage(wrapped.toBuffer(), path.join(root, 'wrapped'));
    assert.equal(unpacked.id, 'local.fixture');
    assert.equal(await readFile(path.join(root, 'wrapped/ui/index.html'), 'utf8'), '<h1>Wrapped</h1>');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
