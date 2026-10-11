import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLI_PROXY_REPOSITORY, cliProxyAssetUrl, inspectCliProxyRelease, parseCliProxyChecksums, readCliProxyManifest, updateCliProxy, validateCliProxyCompatibility, validateCliProxyManifest, verifiedCliProxyDownload } from '../../scripts/update-cli-proxy.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function releaseFixture(version = '8.0.24') {
  const archives = { 'darwin-arm64': Buffer.from('mac fixture'), 'win32-x64': Buffer.from('win fixture') };
  const names = { 'darwin-arm64': `CLIProxyAPI_${version}_darwin_aarch64.tar.gz`, 'win32-x64': `CLIProxyAPI_${version}_windows_amd64.zip` };
  const artifacts = Object.fromEntries(Object.entries(names).map(([target, name]) => [target, { name, sha256: hash(archives[target]) }]));
  const checksumText = Object.entries(artifacts).map(([target, artifact]) => `${hash(archives[target])}  ${artifact.name}`).join('\n') + '\n';
  const release = { tag_name: 'v' + version, draft: false, prerelease: false, assets: ['checksums.txt', ...Object.values(names)].map(name => ({ name, browser_download_url: cliProxyAssetUrl(version, name) })) };
  const manifest = { schemaVersion: 1, repository: CLI_PROXY_REPOSITORY, version, tag: 'v' + version, releaseUrl: `https://github.com/${CLI_PROXY_REPOSITORY}/releases/tag/v${version}`, checksums: { name: 'checksums.txt', sha256: hash(checksumText) }, artifacts };
  const calls = [];
  const fixture = { archives, release, manifest, calls, checksumText };
  fixture.request = async url => {
    calls.push(url);
    if (url.startsWith(`https://api.github.com/repos/${CLI_PROXY_REPOSITORY}/releases/`)) return Response.json(release);
    if (url === cliProxyAssetUrl(version, 'checksums.txt')) return new Response(fixture.checksumText);
    const target = Object.keys(artifacts).find(target => url === cliProxyAssetUrl(version, artifacts[target].name));
    if (target) return new Response(archives[target]);
    throw new Error('Unexpected fixture request: ' + url);
  };
  fixture.evidence = { schemaVersion: 1, component: 'CLIProxyAPI', version, artifacts: Object.fromEntries(Object.entries(artifacts).map(([target, artifact]) => [target, artifact.sha256])), checks: { proxyContracts: 'passed', 'darwin-arm64': 'passed', 'win32-x64': 'passed' } };
  return fixture;
}
async function workspace(context, fixture = releaseFixture()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-upstream-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const options = { request: fixture.request, manifestPath: path.join(root, 'pin.json'), cacheDirectory: path.join(root, 'cache'), candidatePath: path.join(root, 'candidate.json'), reportPath: path.join(root, 'report.json'), now: () => '2026-10-11T00:00:00.000Z' };
  await writeFile(options.manifestPath, JSON.stringify(releaseFixture('8.0.23').manifest));
  return { root, options, fixture };
}

test('current pin has both supported release artifacts and the actual runtime uses its version', async () => {
  const manifest = await readCliProxyManifest();
  assert.deepEqual(Object.keys(manifest.artifacts), ['darwin-arm64', 'win32-x64']);
  assert.equal(manifest.artifacts['darwin-arm64'].name, `CLIProxyAPI_${manifest.version}_darwin_aarch64.tar.gz`);
  assert.equal(manifest.artifacts['win32-x64'].name, `CLIProxyAPI_${manifest.version}_windows_amd64.zip`);
  const { PROXY_VERSION } = await import('../../desktop/ai-proxy.mjs');
  assert.equal(PROXY_VERSION, manifest.version);
});

test('manifest rejects mismatched names, unsupported targets, repository and invalid digests', () => {
  const original = releaseFixture().manifest;
  for (const change of [manifest => { manifest.repository = 'other/fork'; }, manifest => { manifest.artifacts['win32-x64'].name = '../proxy.exe'; }, manifest => { manifest.artifacts['darwin-arm64'].sha256 = 'bad'; }, manifest => { delete manifest.artifacts['win32-x64']; }, manifest => { manifest.version = '8.0.24-beta.1'; }, manifest => { manifest.tag = 'v8.0.23'; }]) {
    const manifest = structuredClone(original); change(manifest);
    assert.throws(() => validateCliProxyManifest(manifest));
  }
});

test('published checksums support standard binary marker and reject ambiguous/malformed entries', () => {
  const digest = 'a'.repeat(64);
  assert.equal(parseCliProxyChecksums(`${digest} *proxy.zip\r\n`).get('proxy.zip'), digest);
  for (const text of [`${digest}  proxy.zip\n${digest}  proxy.zip`, `${digest}  ../proxy.zip`, 'invalid proxy.zip']) assert.throws(() => parseCliProxyChecksums(text), /Invalid or duplicate/);
});

test('check discovers stable release with complete official assets and emits report without downloading archives or changing pin', async context => {
  const { options, fixture } = await workspace(context);
  const before = await readFile(options.manifestPath);
  const report = await updateCliProxy(options);
  assert.equal(report.updateAvailable, true); assert.equal(report.archiveVerification, 'pending'); assert.equal(report.pinApplied, false);
  assert.equal(report.candidateVersion, '8.0.24');
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(await readFile(options.manifestPath), before);
  await assert.rejects(stat(options.candidatePath), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(options.reportPath)).mode, 'check');
});

test('offline pin validation checks runtime version and never calls the network', async context => {
  const { options, fixture } = await workspace(context);
  const current = await readCliProxyManifest(); await writeFile(options.manifestPath, JSON.stringify(current));
  const report = await updateCliProxy({ ...options, mode: 'validate-pin', request: async () => { throw new Error('Must stay offline'); } });
  assert.equal(report.pinValidated, true); assert.equal(report.pinnedVersion, current.version); assert.equal(fixture.calls.length, 0);
  await writeFile(options.manifestPath, JSON.stringify(releaseFixture('999.0.0').manifest));
  await assert.rejects(updateCliProxy({ ...options, mode: 'validate-pin' }), /runtime version does not match/);
});

test('release inspection rejects draft, prerelease, missing or duplicate assets and unofficial URLs', async () => {
  for (const change of [fixture => { fixture.release.draft = true; }, fixture => { fixture.release.prerelease = true; }, fixture => { fixture.release.tag_name = 'v8.0.24-beta.1'; }, fixture => { fixture.release.assets.pop(); }, fixture => { fixture.release.assets.push(fixture.release.assets[1]); }, fixture => { fixture.release.assets[1].browser_download_url = 'https://example.com/proxy.zip'; }, fixture => { fixture.checksumText = fixture.checksumText.split('\n')[0] + '\n'; }]) {
    const fixture = releaseFixture(); change(fixture);
    await assert.rejects(inspectCliProxyRelease({ request: fixture.request }));
  }
  const fixture = releaseFixture();
  await assert.rejects(inspectCliProxyRelease({ version: '8.0.23', request: fixture.request }), /requested version/);
});

test('prepare verifies both archives before writing candidate and leaves pin unchanged', async context => {
  const { options, fixture } = await workspace(context);
  const before = await readFile(options.manifestPath);
  const report = await updateCliProxy({ ...options, mode: 'prepare', version: 'v8.0.24' });
  assert.equal(report.archiveVerification, 'passed'); assert.equal(report.compatibility, 'pending');
  assert.deepEqual(report.verified.map(value => value.target), ['darwin-arm64', 'win32-x64']);
  assert.deepEqual(JSON.parse(await readFile(options.candidatePath)), fixture.manifest);
  assert.deepEqual(await readFile(options.manifestPath), before);
});

test('tampered second archive fails before staging candidate, report or pin', async context => {
  const fixture = releaseFixture(); fixture.archives['win32-x64'] = Buffer.from('tampered archive');
  const { options } = await workspace(context, fixture), before = await readFile(options.manifestPath);
  await assert.rejects(updateCliProxy({ ...options, mode: 'prepare' }), /SHA-256 mismatch/);
  assert.deepEqual(await readFile(options.manifestPath), before);
  await assert.rejects(stat(options.candidatePath), { code: 'ENOENT' });
  await assert.rejects(stat(options.reportPath), { code: 'ENOENT' });
});

test('build download rejects tampered cached archives and never silently replaces cache', async context => {
  const { options, fixture } = await workspace(context);
  const first = await verifiedCliProxyDownload(fixture.manifest, 'darwin-arm64', options);
  await writeFile(first.filename, 'tampered cache'); const calls = fixture.calls.length;
  await assert.rejects(verifiedCliProxyDownload(fixture.manifest, 'darwin-arm64', options), /SHA-256 mismatch/);
  assert.equal(fixture.calls.length, calls); assert.equal(await readFile(first.filename, 'utf8'), 'tampered cache');
  await assert.rejects(verifiedCliProxyDownload(fixture.manifest, 'linux-x64', options), /does not support/);
});

test('apply requires compatibility evidence for exact version, both hashes and passed checks', async context => {
  const { root, options, fixture } = await workspace(context);
  await assert.rejects(updateCliProxy({ ...options, mode: 'apply' }), /requires --validation-report/);
  for (const change of [evidence => { evidence.version = '8.0.23'; }, evidence => { evidence.artifacts['darwin-arm64'] = '0'.repeat(64); }, evidence => { evidence.checks['win32-x64'] = 'pending'; }, evidence => { evidence.checks.proxyContracts = 'failed'; }]) {
    const evidence = structuredClone(fixture.evidence); change(evidence);
    assert.throws(() => validateCliProxyCompatibility(evidence, fixture.manifest), /validation/);
  }
  const validationReportPath = path.join(root, 'validation.json');
  await writeFile(validationReportPath, JSON.stringify(fixture.evidence));
  const report = await updateCliProxy({ ...options, mode: 'apply', validationReportPath });
  assert.equal(report.pinApplied, true); assert.equal(report.compatibility, 'passed');
  assert.deepEqual(await readCliProxyManifest(options.manifestPath), fixture.manifest);
});

test('apply never changes the pin if either archive fails despite valid compatibility evidence', async context => {
  const fixture = releaseFixture(), { root, options } = await workspace(context, fixture);
  const before = await readFile(options.manifestPath), validationReportPath = path.join(root, 'validation.json');
  await writeFile(validationReportPath, JSON.stringify(fixture.evidence));
  fixture.archives['win32-x64'] = Buffer.from('tampered after smoke validation');
  await assert.rejects(updateCliProxy({ ...options, mode: 'apply', validationReportPath }), /SHA-256 mismatch/);
  assert.deepEqual(await readFile(options.manifestPath), before);
  await assert.rejects(stat(options.candidatePath), { code: 'ENOENT' });
  await assert.rejects(stat(options.reportPath), { code: 'ENOENT' });
});

test('custom output paths cannot overwrite the pin or corrupt a staged candidate', async context => {
  const { options, fixture } = await workspace(context), before = await readFile(options.manifestPath);
  for (const change of [{ mode: 'prepare', candidatePath: options.manifestPath }, { reportPath: options.manifestPath }, { mode: 'prepare', reportPath: options.candidatePath }]) {
    await assert.rejects(updateCliProxy({ ...options, ...change }), /separate files/);
  }
  assert.deepEqual(await readFile(options.manifestPath), before); assert.equal(fixture.calls.length, 0);
});

test('already pinned release cannot be silently republished with different checksum metadata', async context => {
  const fixture = releaseFixture('8.0.23'), { options } = await workspace(context, fixture);
  fixture.checksumText += '\n';
  await assert.rejects(updateCliProxy(options), /metadata changed for the pinned version/);
  assert.equal(fixture.calls.length, 2);
});

test('upstream HTTP errors and response limits fail without staging a candidate', async context => {
  const { options } = await workspace(context);
  await assert.rejects(updateCliProxy({ ...options, request: async () => new Response('', { status: 404 }) }), /request failed \(404\)/);
  await assert.rejects(updateCliProxy({ ...options, request: async () => new Response('x', { headers: { 'content-length': String(3 * 1024 ** 2) } }) }), /download limit/);
  await assert.rejects(stat(options.candidatePath), { code: 'ENOENT' });
});
