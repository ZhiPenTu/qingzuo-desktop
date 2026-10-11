import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readCliProxyManifest } from '../../scripts/update-cli-proxy.mjs';
import { combineProxyValidation } from '../../scripts/validate-cli-proxy.mjs';

test('proxy promotion requires matching successful evidence from both actual target platforms', async () => {
  const manifest = await readCliProxyManifest();
  const artifacts = Object.fromEntries(Object.entries(manifest.artifacts).map(([target, artifact]) => [target, artifact.sha256]));
  const reports = Object.keys(artifacts).map(target => ({ schemaVersion: 1, component: 'CLIProxyAPI',
    version: manifest.version, target, artifacts, checks: { proxyContracts: 'passed', [target]: 'passed' } }));
  assert.equal(combineProxyValidation(manifest, reports).checks['win32-x64'], 'passed');
  assert.throws(() => combineProxyValidation(manifest, reports.slice(0, 1)), /unique smoke report/);
  assert.throws(() => combineProxyValidation(manifest, [...reports, reports[0]]), /unique smoke report/);
  for (const mutate of [report => { report.version = '99.0.0'; },
    report => { report.artifacts['win32-x64'] = '0'.repeat(64); },
    report => { report.checks.proxyContracts = 'failed'; },
    report => { report.checks['win32-x64'] = 'failed'; }]) {
    const altered = structuredClone(reports); mutate(altered[1]);
    assert.throws(() => combineProxyValidation(manifest, altered));
  }
});

test('smoke validation rejects an aliased manifest output before clearing or writing the report', async context => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-report-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source'), alias = path.join(temporary, 'alias'); await mkdir(source);
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = path.join(source, 'pin.json'), bytes = JSON.stringify(await readCliProxyManifest());
  await writeFile(manifest, bytes);
  const result = spawnSync(process.execPath, ['scripts/validate-cli-proxy.mjs', '--manifest', manifest,
    '--report', path.join(alias, 'pin.json')], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /must not overwrite/);
  assert.equal(await readFile(manifest, 'utf8'), bytes);
});
