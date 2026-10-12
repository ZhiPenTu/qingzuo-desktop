import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliProxyUpdateService, extractCliProxyArchive } from '../../desktop/cli-proxy-update.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const testBinaryName = process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
function manifest(version = '8.0.24') {
  const darwin = Buffer.from('darwin archive'), windows = Buffer.from('windows archive');
  return { schemaVersion: 1, repository: 'router-for-me/CLIProxyAPI', version, tag: `v${version}`,
    releaseUrl: `https://github.com/router-for-me/CLIProxyAPI/releases/tag/v${version}`,
    checksums: { name: 'checksums.txt', sha256: 'a'.repeat(64) },
    artifacts: { 'darwin-arm64': { name: `CLIProxyAPI_${version}_darwin_aarch64.tar.gz`, sha256: digest(darwin) }, 'win32-x64': { name: `CLIProxyAPI_${version}_windows_amd64.zip`, sha256: digest(windows) } } };
}
function runtime(binary) {
  return { binary, version: '8.0.23', settings: { mode: 'builtin', verified: ['model'] }, running: false,
    status() { return { version: this.version, mode: this.settings.mode, running: this.running, verified: this.settings.verified }; },
    async setBinary(filename, version) { this.binary = filename; this.version = version; this.settings.verified = []; },
    async stop() { this.running = false; }, async start() { this.running = true; } };
}
async function fixture(context, { failStart = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-cli-proxy-update-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packaged = path.join(root, 'packaged-cli-proxy'); await writeFile(packaged, 'packaged');
  const proxy = runtime(packaged); if (failStart) { const start = proxy.start.bind(proxy); proxy.start = async () => { if (proxy.version === '8.0.24') throw new Error('candidate health check failed'); return start(); }; }
  const candidate = manifest();
  const service = new CliProxyUpdateService({ proxy, root: path.join(root, 'profile'), request: async () => { throw new Error('network not expected'); },
    inspect: async ({ version } = {}) => version ? candidate : candidate,
    download: async () => ({ bytes: Buffer.from('candidate archive') }),
    extract: async (_bytes, _target, destination) => { const binary = path.join(destination, testBinaryName); await writeFile(binary, 'candidate'); return { binary, sha256: digest(Buffer.from('candidate')) }; },
  });
  return { root, proxy, service, candidate, packaged };
}

test('CLIProxy update check only reads the official candidate and exposes unverified compatibility', async context => {
  const { service } = await fixture(context);
  const state = await service.check();
  assert.equal(state.status, 'available'); assert.equal(state.currentVersion, '8.0.23'); assert.equal(state.candidateVersion, '8.0.24');
  assert.equal(state.compatibility, 'unverified'); assert.equal(service.proxy.binary.endsWith('packaged-cli-proxy'), true);
  assert.throws(() => service.update(), /双平台兼容性验收/);
});

test('CLIProxy update stages a versioned user-data binary, switches atomically and clears verification', async context => {
  const { root, service, proxy } = await fixture(context);
  await service.check(); service.approveCandidate({ schemaVersion: 1, component: 'CLIProxyAPI', version: '8.0.24', artifacts: { 'darwin-arm64': service.candidate.artifacts['darwin-arm64'].sha256, 'win32-x64': service.candidate.artifacts['win32-x64'].sha256 }, checks: { proxyContracts: 'passed', 'darwin-arm64': 'passed', 'win32-x64': 'passed' } }); const state = await service.update();
  assert.equal(state.status, 'ready'); assert.equal(state.currentVersion, '8.0.24'); assert.equal(proxy.version, '8.0.24');
  assert.deepEqual(proxy.settings.verified, []); assert.equal(proxy.running, false);
  const active = JSON.parse(await readFile(path.join(root, 'profile', 'active.json'), 'utf8'));
  assert.equal(active.version, '8.0.24'); assert.equal(active.binary, `versions/8.0.24/${testBinaryName}`);
  assert.equal(await readFile(path.join(root, 'profile', active.binary), 'utf8'), 'candidate');
});

test('failed candidate health check rolls back the active pointer and packaged runtime', async context => {
  const { root, service, proxy, packaged } = await fixture(context, { failStart: true });
  await service.check(); service.approveCandidate({ schemaVersion: 1, component: 'CLIProxyAPI', version: '8.0.24', artifacts: { 'darwin-arm64': service.candidate.artifacts['darwin-arm64'].sha256, 'win32-x64': service.candidate.artifacts['win32-x64'].sha256 }, checks: { proxyContracts: 'passed', 'darwin-arm64': 'passed', 'win32-x64': 'passed' } }); const state = await service.update();
  assert.equal(state.status, 'error'); assert.match(state.error, /health check/); assert.equal(proxy.version, '8.0.23');
  assert.equal(proxy.binary, packaged); assert.equal(proxy.running, false);
  await assert.rejects(readFile(path.join(root, 'profile', 'active.json')));
});

test('active user-data version is restored before the next runtime starts', async context => {
  const { root, service, proxy } = await fixture(context);
  await service.check(); service.approveCandidate({ schemaVersion: 1, component: 'CLIProxyAPI', version: '8.0.24', artifacts: { 'darwin-arm64': service.candidate.artifacts['darwin-arm64'].sha256, 'win32-x64': service.candidate.artifacts['win32-x64'].sha256 }, checks: { proxyContracts: 'passed', 'darwin-arm64': 'passed', 'win32-x64': 'passed' } }); await service.update(); await proxy.stop();
  const second = new CliProxyUpdateService({ proxy, root: path.join(root, 'profile'), extract: service.extract, inspect: service.inspect, download: service.download });
  await second.initialize(); assert.equal(proxy.version, '8.0.24');
  assert.equal(path.normalize(proxy.binary).endsWith(path.join('versions', '8.0.24', testBinaryName)), true);
});

test('archive extraction rejects a missing executable and accepts only the expected regular file', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-cli-proxy-archive-')); context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(extractCliProxyArchive(Buffer.from('fixture'), 'darwin-arm64', path.join(root, 'missing'), { extractor: async () => {} }), /ENOENT|executable/);
  const installed = await extractCliProxyArchive(Buffer.from('fixture'), 'darwin-arm64', path.join(root, 'ok'), { extractor: async output => { await writeFile(path.join(output, 'cli-proxy-api'), 'binary'); } });
  assert.equal(installed.sha256, digest(Buffer.from('binary'))); assert.equal(await readFile(installed.binary, 'utf8'), 'binary');
});


test('win32 archive extraction translates corrupted zip errors into a clean Chinese message', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-cli-proxy-win32-bad-')); context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(extractCliProxyArchive(Buffer.from('PK\x03\x04truncated'), 'win32-x64', path.join(root, 'bad')), err => {
    assert.match(err.message, /CLIProxyAPI 制品格式无效或压缩包已损坏/);
    assert.doesNotMatch(err.message, /ADM-ZIP/i);
    return true;
  });
});
