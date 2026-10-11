import test from 'node:test';
import assert from 'node:assert/strict';
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
