import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectHarnessState, inspectInstalledHarness, readHarnessState, resolveCordisVersions, harnessRelease, isolatedEnvironment, candidateFileAllowed, prepareCandidate, validateCandidate, npmPackument } from '../../scripts/harness-upstream.mjs';

const integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
const record = (name, version, extra = {}) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`, integrity, ...extra });
function state() {
  const dependencies = { '@deepseek-ai/dsh': '1.0.0-alpha.1', '@deepseek-ai/dsh-client-ui-primitives': '1.0.0-alpha.1', '@deepseek-ai/cordis': '4.0.0', '@deepseek-ai/cordis-plugin-group': '1.0.0' };
  return {
    metadata: { schemaVersion: 1, version: '1.0.0-alpha.1', packages: Object.keys(dependencies).filter(name => name.includes('/dsh')), cordisPackages: Object.keys(dependencies).filter(name => name.includes('/cordis')), nativeAdapter: { package: 'node-addon-require-builtin', version: '0.1.6', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), electron: '44.0.0', nodeMajor: 24 } },
    pkg: { name: 'fixture-upstream', private: true, dependencies, devDependencies: { electron: '44.0.0' }, overrides: { 'node-addon-require-builtin': '0.1.6' } },
    bundle: { name: '@commerce/platform-bundle', peerDependencies: { '@deepseek-ai/dsh': '1.0.0-alpha.1' } },
    lock: { lockfileVersion: 3, packages: { '': { dependencies: { ...dependencies } }, 'packages/platform-bundle': { peerDependencies: { '@deepseek-ai/dsh': '1.0.0-alpha.1' } },
      ...Object.fromEntries(Object.entries(dependencies).map(([name, version]) => ['node_modules/' + name, record(name, version, name === '@deepseek-ai/dsh' ? { peerDependencies: { '@deepseek-ai/cordis': '^4.0.0', 'node-addon-require-builtin': '^0.1.6' } } : {})])),
      'node_modules/node-addon-require-builtin': record('node-addon-require-builtin', '0.1.6'), 'node_modules/electron': record('electron', '44.0.0') } },
  };
}
const failed = value => inspectHarnessState(value).checks.filter(item => item.status === 'failed').map(item => item.id);

test('offline audit checks the real exact family, workspace peer, Cordis graph and native pins', async () => {
  const real = await readHarnessState(path.resolve('.'));
  assert.equal(inspectHarnessState(real).status, 'checked');
  assert.equal(inspectHarnessState(state()).status, 'checked');
});

test('offline audit rejects partial family upgrades, stale workspace lock and hidden nested Harness copies', () => {
  const partial = state(); partial.pkg.dependencies['@deepseek-ai/dsh'] = '1.0.0-alpha.2'; assert.ok(failed(partial).includes('direct:@deepseek-ai/dsh'));
  const floating = state(); floating.pkg.dependencies['@deepseek-ai/dsh'] = '^1.0.0-alpha.1'; assert.ok(failed(floating).includes('direct:@deepseek-ai/dsh'));
  const unlisted = state(); unlisted.pkg.dependencies['@deepseek-ai/dsh-tools'] = '1.0.0-alpha.1'; assert.ok(failed(unlisted).includes('family-members'));
  const dev = state(); dev.pkg.devDependencies['@deepseek-ai/dsh-tools'] = '^1.0.0-alpha.2'; assert.ok(failed(dev).includes('family-production-dependencies'));
  const peer = state(); peer.lock.packages['packages/platform-bundle'].peerDependencies['@deepseek-ai/dsh'] = '0.9.0'; assert.ok(failed(peer).includes('bundle-peer'));
  const nested = state(); nested.lock.packages['node_modules/third-party/node_modules/@deepseek-ai/dsh-tools'] = record('@deepseek-ai/dsh-tools', '0.9.0'); assert.ok(failed(nested).includes('resolved-family:node_modules/third-party/node_modules/@deepseek-ai/dsh-tools'));
});

test('offline audit refuses missing SRI, unofficial tarballs and incompatible Cordis/native runtime changes', () => {
  for (const mutate of [value => delete value.lock.packages['node_modules/@deepseek-ai/dsh'].integrity, value => { value.lock.packages['node_modules/@deepseek-ai/dsh'].resolved = 'https://example.com/dsh.tgz'; }]) {
    const value = state(); mutate(value); assert.ok(failed(value).includes('integrity:node_modules/@deepseek-ai/dsh'));
  }
  const cordis = state(); cordis.lock.packages['node_modules/@deepseek-ai/dsh'].peerDependencies['@deepseek-ai/cordis'] = '^5.0.0'; assert.ok(failed(cordis).some(id => id.endsWith(':@deepseek-ai/cordis')));
  const native = state(); native.pkg.overrides['node-addon-require-builtin'] = '0.1.7'; assert.ok(failed(native).includes('native-pin'));
  const runtime = state(); runtime.pkg.devDependencies.electron = '45.0.0'; assert.ok(failed(runtime).includes('native-electron'));
  const source = state(); source.metadata.nativeAdapter.sha256 = 'unreviewed'; assert.ok(failed(source).includes('native-source'));
});

test('upstream discovery follows alpha and never marks an older latest tag as an upgrade', () => {
  const metadata = { version: '0.2.1-alpha.1', channel: 'alpha' }, packument = { 'dist-tags': { latest: '0.2.0-rc.2', alpha: '0.2.1-alpha.2' } };
  assert.deepEqual(harnessRelease(metadata, packument), { current: metadata.version, channel: 'alpha', candidate: '0.2.1-alpha.2', newer: true, tags: packument['dist-tags'] });
  assert.equal(harnessRelease({ ...metadata, channel: 'latest' }, packument).newer, false);
  assert.equal(harnessRelease(metadata, { 'dist-tags': {} }).candidate, null);
});

test('Cordis resolver uses candidate ranges and backtracks independent group versions instead of sharing dsh pins', async () => {
  const packuments = {
    '@deepseek-ai/cordis': { versions: { '4.0.0': { name: '@deepseek-ai/cordis', version: '4.0.0' }, '4.1.0': { name: '@deepseek-ai/cordis', version: '4.1.0' }, '5.0.0': { name: '@deepseek-ai/cordis', version: '5.0.0' } } },
    '@deepseek-ai/cordis-plugin-group': { versions: { '1.0.0': { name: '@deepseek-ai/cordis-plugin-group', version: '1.0.0', peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' } }, '2.0.0': { name: '@deepseek-ai/cordis-plugin-group', version: '2.0.0', peerDependencies: { '@deepseek-ai/cordis': '^5.0.0' } } } },
  };
  const manifests = [{ name: '@deepseek-ai/dsh', version: '1.0.0-alpha.2', dependencies: { '@deepseek-ai/cordis': '^4.0.0' } }];
  const resolved = await resolveCordisVersions(manifests, Object.keys(packuments), async name => packuments[name]);
  assert.deepEqual(resolved.versions, { '@deepseek-ai/cordis': '4.1.0', '@deepseek-ai/cordis-plugin-group': '1.0.0' });
  assert.ok(resolved.constraints['@deepseek-ai/cordis'].some(item => item.from === '@deepseek-ai/cordis-plugin-group'));
  await assert.rejects(resolveCordisVersions([...manifests, { name: 'other', peerDependencies: { '@deepseek-ai/cordis': '^3.0.0' } }], Object.keys(packuments), async name => packuments[name]), /No compatible Cordis/);
});

test('isolated processes retain required executable paths and omit user profiles, keys and npm config', () => {
  const env = isolatedEnvironment('/candidate', { PATH: '/bin', HOME: '/production', CODEX_HOME: '/codex', OPENAI_API_KEY: 'real-key', DSH_HOME: '/real-harness', npm_config_userconfig: '/real-npmrc', HTTPS_PROXY: 'https://user:secret@example.com' });
  assert.equal(env.PATH, '/bin'); assert.equal(env.HOME, '/candidate/.validation/home');
  for (const name of ['CODEX_HOME', 'OPENAI_API_KEY', 'DSH_HOME', 'HTTPS_PROXY']) assert.equal(env[name], undefined);
  assert.equal(env.npm_config_userconfig, '/candidate/.validation/empty.npmrc');
  for (const name of ['.env', '.env.local', '.npmrc', 'credentials.json', 'secrets.yaml', 'output/upstream/profile.json', 'resources/generated/secret.json', 'profile.key']) assert.equal(candidateFileAllowed(name), false, name);
  for (const name of ['desktop/credentials.mjs', 'tests/platform/credentials.test.mjs', 'docs/harness-integration.md', 'desktop/upstream/harness.json']) assert.equal(candidateFileAllowed(name), true, name);
});

async function sourceFixture(context) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-harness-upgrade-')), source = path.join(home, 'source'); await mkdir(source);
  const initial = state();
  for (const [name, value] of [['desktop/upstream/harness.json', initial.metadata], ['package.json', initial.pkg], ['package-lock.json', initial.lock], ['packages/platform-bundle/package.json', initial.bundle]]) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true }); await writeFile(path.join(source, name), JSON.stringify(value));
  }
  await mkdir(path.join(source, 'desktop'), { recursive: true }); await writeFile(path.join(source, 'desktop/credentials.mjs'), 'export const fixture = true;');
  await writeFile(path.join(source, '.env'), 'OPENAI_API_KEY=production-key'); await writeFile(path.join(source, '.npmrc'), '//registry.npmjs.org/:_authToken=production-token');
  execFileSync('git', ['init', '--quiet'], { cwd: source });
  context.after(() => rm(home, { recursive: true, force: true }));
  return { source, directory: path.join(home, 'candidate'), initial };
}
function registry(initial, version, nativeRange) {
  return Object.fromEntries([...initial.metadata.packages.map(name => [name, { name, versions: { [version]: { name, version, peerDependencies: { '@deepseek-ai/cordis': '^4.0.0', ...(nativeRange ? { 'node-addon-require-builtin': nativeRange } : {}) } } } }]),
    ['@deepseek-ai/cordis', { name: '@deepseek-ai/cordis', versions: { '4.1.0': { name: '@deepseek-ai/cordis', version: '4.1.0' } } }],
    ['@deepseek-ai/cordis-plugin-group', { name: '@deepseek-ai/cordis-plugin-group', versions: { '1.1.0': { name: '@deepseek-ai/cordis-plugin-group', version: '1.1.0', peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' } } } }],
  ]);
}

test('prepare stages the full exact family and lock in a persistent isolated candidate; source and secrets stay untouched', async context => {
  const fixture = await sourceFixture(context), before = await readFile(path.join(fixture.source, 'package.json')), version = '1.0.0-alpha.2', packuments = registry(fixture.initial, version);
  const calls = [];
  const report = await prepareCandidate({ ...fixture, version, getPackument: async name => packuments[name], runner: async (command, args, options) => {
    calls.push({ command, args, options }); assert.equal(options.directory, fixture.directory); assert.equal(command, 'npm'); assert.ok(args.includes('--package-lock-only')); assert.ok(args.includes('--ignore-scripts'));
    const state = await readHarnessState(options.directory);
    state.lock.packages[''].dependencies = { ...state.pkg.dependencies };
    state.lock.packages['packages/platform-bundle'].peerDependencies = { ...state.bundle.peerDependencies };
    for (const [name, pin] of Object.entries(state.pkg.dependencies)) state.lock.packages['node_modules/' + name].version = pin;
    await writeFile(path.join(options.directory, 'package-lock.json'), JSON.stringify(state.lock)); return 'fixture npm lock updated';
  } });
  assert.equal(report.status, 'checked'); assert.equal(report.version, version); assert.equal(calls.length, 1);
  const staged = await readHarnessState(fixture.directory);
  assert.ok(staged.metadata.packages.every(name => staged.pkg.dependencies[name] === version));
  assert.equal(staged.pkg.dependencies['@deepseek-ai/cordis'], '4.1.0'); assert.equal(staged.bundle.peerDependencies['@deepseek-ai/dsh'], version);
  assert.deepEqual(await readFile(path.join(fixture.source, 'package.json')), before);
  assert.equal(await readFile(path.join(fixture.directory, 'desktop/credentials.mjs'), 'utf8'), 'export const fixture = true;');
  await assert.rejects(access(path.join(fixture.directory, '.env'))); await assert.rejects(access(path.join(fixture.directory, '.npmrc')));
  assert.equal(JSON.parse(await readFile(path.join(fixture.directory, 'harness-prepare-report.json'), 'utf8')).version, version);
});

test('prepare stops before staging if any family member is unpublished or requires unreviewed native source', async context => {
  const fixture = await sourceFixture(context), version = '1.0.0-alpha.2', packuments = registry(fixture.initial, version);
  delete packuments['@deepseek-ai/dsh-client-ui-primitives'].versions[version];
  const options = { ...fixture, version, getPackument: async name => packuments[name], runner: async () => assert.fail('npm must not run') };
  await assert.rejects(prepareCandidate(options), /not published/); await assert.rejects(access(fixture.directory));
  Object.assign(packuments, registry(fixture.initial, version, '^0.2.0'));
  await assert.rejects(prepareCandidate(options), /pinned native source/); await assert.rejects(access(fixture.directory));
  await assert.rejects(prepareCandidate({ ...options, version: 'latest' }), /exact --version/);
});

test('validate refuses the live checkout and linked installed dependencies before running commands', async context => {
  const fixture = await sourceFixture(context);
  await assert.rejects(validateCandidate({ directory: fixture.source }), /isolated directory/);
  await mkdir(fixture.directory); await writeFile(path.join(fixture.directory, '.harness-candidate.json'), JSON.stringify({ schemaVersion: 1, source: fixture.source }));
  await symlink(fixture.source, path.join(fixture.directory, 'node_modules'));
  await assert.rejects(validateCandidate({ directory: fixture.directory, runner: async () => assert.fail('No validation commands may run') }), /must not link/);
});

test('installed graph audit rejects stale Harness copies and modules resolving outside the candidate', async context => {
  const fixture = await sourceFixture(context), current = fixture.initial;
  await mkdir(fixture.directory); await mkdir(path.join(fixture.directory, 'node_modules/@deepseek-ai/dsh'), { recursive: true });
  await writeFile(path.join(fixture.directory, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.9.0' }));
  let checks = await inspectInstalledHarness(fixture.directory, current);
  assert.ok(checks.some(item => item.id === 'installed-version:node_modules/@deepseek-ai/dsh' && item.status === 'failed' && /installed=0.9.0/.test(item.detail)));
  current.metadata.nativeAdapter.nodeMajor = Number(process.versions.node.split('.')[0]);
  current.metadata.nativeAdapter.supportedTargets = [process.platform + '-' + process.arch];
  for (const [name, value] of [['desktop/upstream/harness.json', current.metadata], ['package.json', current.pkg], ['package-lock.json', current.lock], ['packages/platform-bundle/package.json', current.bundle], ['.harness-candidate.json', { schemaVersion: 1, source: fixture.source }]]) {
    await mkdir(path.dirname(path.join(fixture.directory, name)), { recursive: true }); await writeFile(path.join(fixture.directory, name), JSON.stringify(value));
  }
  const report = await validateCandidate({ directory: fixture.directory, offline: true, runner: async () => assert.fail('Stale installed packages must block before running any contracts.') });
  assert.equal(report.status, 'failed');
  assert.ok(report.checks.some(item => item.id === 'installed-version:node_modules/@deepseek-ai/dsh' && item.status === 'failed'));
  await symlink(fixture.source, path.join(fixture.directory, 'node_modules/@deepseek-ai/cordis'));
  checks = await inspectInstalledHarness(fixture.directory, current);
  assert.ok(checks.some(item => item.id === 'installed-isolation:node_modules/@deepseek-ai/cordis' && item.status === 'failed'));
});

test('registry access validates npm package identity and bounds metadata', async () => {
  const name = '@deepseek-ai/dsh';
  await assert.rejects(npmPackument(name, async () => Response.json({ name: 'other', versions: {} })), /Invalid npm package metadata/);
  await assert.rejects(npmPackument(name, async () => new Response('', { status: 404 })), /HTTP 404/);
  const value = await npmPackument(name, async url => { assert.equal(url, 'https://registry.npmjs.org/%40deepseek-ai%2Fdsh'); return Response.json({ name, versions: {} }); });
  assert.equal(value.name, name);
});
