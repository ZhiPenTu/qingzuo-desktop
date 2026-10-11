import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareAiProxy } from './prepare-ai-proxy.mjs';
import { readCliProxyManifest } from './update-cli-proxy.mjs';
import { ProxyRuntime } from '../desktop/ai-proxy.mjs';
import { verifyMacRuntime } from './verify-macos-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const targets = ['darwin-arm64', 'win32-x64'];
const artifactHashes = manifest => Object.fromEntries(targets.map(target => [target, manifest.artifacts[target].sha256]));

export function combineProxyValidation(manifest, reports) {
  const artifacts = artifactHashes(manifest);
  for (const target of targets) {
    const matches = reports.filter(report => report.target === target);
    assert.equal(matches.length, 1, 'A unique smoke report is required for ' + target);
    const report = matches[0];
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.component, 'CLIProxyAPI');
    assert.equal(report.version, manifest.version, 'Smoke report version differs from the candidate');
    assert.deepEqual(report.artifacts, artifacts, 'Smoke report artifact hashes differ from the candidate');
    assert.equal(report.checks.proxyContracts, 'passed');
    assert.equal(report.checks[target], 'passed');
  }
  return { schemaVersion: 1, component: 'CLIProxyAPI', version: manifest.version, artifacts,
    checks: { proxyContracts: 'passed', 'darwin-arm64': 'passed', 'win32-x64': 'passed' } };
}

export async function validateProxyCandidate(manifest) {
  const target = process.platform + '-' + process.arch;
  assert.ok(targets.includes(target), 'Unsupported CLIProxyAPI validation platform: ' + target);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-validation-'));
  let proxy;
  try {
    const resources = path.join(temporary, 'resources');
    await prepareAiProxy(resources, manifest);
    const binary = path.join(resources, 'cli-proxy-api' + (process.platform === 'win32' ? '.exe' : ''));
    if (process.platform === 'darwin') await verifyMacRuntime(resources);
    const credentialValues = new Map();
    proxy = new ProxyRuntime({ root: path.join(temporary, 'profile'), binary,
      credentials: { get: async (owner, name) => credentialValues.get(owner + ':' + name),
        set: async (owner, name, value) => credentialValues.set(owner + ':' + name, value) },
      openExternal: async () => { throw new Error('Smoke validation cannot open OAuth or external accounts.'); } });
    await proxy.initialize();
    await Promise.all([proxy.start(), proxy.start()]);
    assert.equal(proxy.status().running, true);
    assert.deepEqual(await proxy.accounts(), []);
    const connection = await proxy.connection();
    assert.ok(connection.base.startsWith('http://127.0.0.1:'));
    const unauthorized = await fetch(connection.base + '/v1/models', { signal: AbortSignal.timeout(15000) });
    assert.equal(unauthorized.status, 401); await unauthorized.body?.cancel();
    const management = await fetch(connection.base + '/v0/management/auth-files', {
      headers: { Authorization: 'Bearer ' + connection.key }, signal: AbortSignal.timeout(15000) });
    assert.equal(management.status, 401); await management.body?.cancel();
    assert.deepEqual(await proxy.models(), []);
    await proxy.stop(); assert.equal(proxy.status().running, false);
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const contracts = spawnSync(process.execPath, ['--test', '--test-name-pattern=proxy address boundary',
      'tests/platform/ai.test.mjs'], {
      cwd: root, env, stdio: 'inherit', timeout: 120000 });
    if (contracts.status !== 0) throw new Error('Proxy adapter contracts failed: ' + (contracts.error?.message || contracts.status));
    // The image contracts use injected/local HTTP fixtures and send no model requests.
    const images = spawnSync(process.execPath, ['--test', 'tests/platform/ai-proxy-images.test.mjs'], {
      cwd: root, env, stdio: 'inherit', timeout: 120000 });
    if (images.status !== 0) throw new Error('Proxy image contracts failed: ' + (images.error?.message || images.status));
    return { schemaVersion: 1, component: 'CLIProxyAPI', version: manifest.version, target,
      artifacts: artifactHashes(manifest), checks: { proxyContracts: 'passed', [target]: 'passed' } };
  } finally { await proxy?.stop(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2); let manifestFile, reportFile, combine = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--manifest') manifestFile = args[++index];
    else if (args[index] === '--report') reportFile = args[++index];
    else if (args[index] === '--combine') {
      while (index + 1 < args.length && !args[index + 1].startsWith('--')) combine.push(args[++index]);
      if (!combine.length) throw new Error('--combine requires platform report files.');
    } else throw new Error('Unknown option: ' + args[index]);
  }
  if (!reportFile) throw new Error('--report FILE is required.');
  const protectedFiles = [fileURLToPath(new URL('../desktop/upstream/cli-proxy.json', import.meta.url)), manifestFile,
    ...combine].filter(Boolean).map(file => path.resolve(file));
  assert.ok(!protectedFiles.includes(path.resolve(reportFile)), 'The validation report must not overwrite its manifest or input reports.');
  await rm(reportFile, { force: true });
  const manifest = await readCliProxyManifest(manifestFile);
  await mkdir(path.dirname(path.resolve(reportFile)), { recursive: true });
  let result;
  try {
    result = combine.length ? combineProxyValidation(manifest, await Promise.all(combine.map(async file => JSON.parse(await readFile(file, 'utf8')))))
      : await validateProxyCandidate(manifest);
  } catch (error) {
    await writeFile(reportFile, JSON.stringify({ schemaVersion: 1, component: 'CLIProxyAPI', version: manifest.version,
      target: process.platform + '-' + process.arch, artifacts: artifactHashes(manifest), status: 'failed', error: error.message }, null, 2) + '\n');
    throw error;
  }
  await writeFile(reportFile, JSON.stringify(result, null, 2) + '\n');
  console.log('CLIProxyAPI validation report: ' + path.resolve(reportFile));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
