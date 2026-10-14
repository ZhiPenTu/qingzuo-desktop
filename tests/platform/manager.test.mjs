import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { PluginManager, inspectPackage, unpackPackage, verifyArtifact } from '../../desktop/plugin-manager.mjs';
import { validateManifest, TARGET } from '../../desktop/security.mjs';
function archive(version = '0.1.0', overrides = {}) {
  const zip = new AdmZip(); zip.addFile('package.json', Buffer.from(JSON.stringify({ name: 'fixture', version, commerce: { manifestVersion: 1, id: 'local.fixture', title: 'Fixture', description: 'test', api: '^1.0.0', ui: 'ui/index.html', permissions: {}, ...overrides } }))); zip.addFile('ui/index.html', Buffer.from('<h1>Fixture</h1>')); return zip.toBuffer();
}
test('local plugin can install, persist, disable, enable, upgrade, rollback and uninstall without a base build', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-manager-')); const bundled = path.join(root, 'bundled'); await mkdir(bundled);
  const stops = []; const manager = new PluginManager(path.join(root, 'plugins'), bundled, { stop: async id => stops.push(id) });
  try {
    await manager.initialize(); await manager.install(archive()); assert.equal((await manager.list())[0].version, '0.1.0');
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
  for (const commerce of [{ api: '^2' }, { id: 'system.market' }, { ui: '../index.html' }, { permissions: { network: ['http://localhost'] } }, { backend: { type: 'executable', entry: {} } }]) {
    const zip = new AdmZip(archive('0.1.0', commerce)); assert.throws(() => validateManifest(JSON.parse(zip.readAsText('package.json'))));
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
