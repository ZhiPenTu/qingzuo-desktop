import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { Credentials } from '../../desktop/credentials.mjs';
import { launchSandbox } from '../../desktop/sandbox.mjs';

const launcher = path.resolve('native/sandbox/target/release/commerce-sandbox' + (process.platform === 'win32' ? '.exe' : ''));

test('local credential store scopes entries per plugin and clears them', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'commerce-credentials-')));
  const storePath = path.join(root, 'credentials-vault.json');
  const namespace = 'profile.test:';
  const store = new Credentials(launcher, namespace, storePath);
  const id = 'local.test-' + process.pid;
  const value = 'fixture-not-a-real-key';
  try {
    await store.set(id, 'fixture', value);
    assert.equal(await store.status(id, 'fixture'), true);
    assert.equal(await store.status('local.other-' + process.pid, 'fixture'), false);
    assert.equal(await store.get(id, 'fixture'), value);
    if (process.platform === 'darwin') {
      assert.equal((await stat(storePath)).mode & 0o777, 0o600);
      assert.equal(JSON.parse(await readFile(storePath, 'utf8'))[namespace + id + ':fixture'], value);
    }
    await store.clear(id, 'fixture');
    assert.equal(await store.status(id, 'fixture'), false);
  } finally {
    await store.clear(id, 'fixture');
    await rm(root, { recursive: true, force: true });
  }
});

test('an actual sandboxed process cannot read the host credential file', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'commerce-vault-')));
  const storePath = path.join(root, 'credentials-vault.json');
  const store = new Credentials(launcher, 'profile.sandbox:', storePath);
  const id = 'local.sandbox-vault-' + process.pid;
  const value = 'fixture-vault-boundary-' + process.pid;
  const job = await realpath(await mkdtemp(path.join(os.tmpdir(), 'commerce-vault-job-')));
  let child;
  try {
    await store.set(id, 'fixture', value);
    assert.equal(await store.get(id, 'fixture'), value, 'host must first prove the fixture exists');
    child = await launchSandbox({ executable: launcher, args: ['--credential'], readOnly: [path.dirname(launcher)], writable: [job], cwd: job, launcher });
    let output = '';
    let errors = '';
    let timedOut = false;
    child.stdout.on('data', data => output += data);
    child.stderr.on('data', data => errors += data);
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 10000);
    child.stdin.end(JSON.stringify({ op: 'get', account: 'profile.sandbox:' + id + ':fixture', store: storePath }));
    let result;
    try {
      result = await exited;
      await child.cleanup;
    } finally {
      clearTimeout(timer);
    }
    assert.equal(timedOut, false, 'a hung process does not prove credential isolation');
    assert.equal(result.signal, null, 'the credential probe must complete, not crash');
    assert.equal(output.includes(value), false, 'Seatbelt/AppContainer leaked a host credential');
    if (result.code === 0) {
      assert.deepEqual(JSON.parse(output), { value: null });
    } else {
      assert.equal(result.code, 126, 'the probe must reach the credential API');
      if (process.platform === 'darwin') assert.match(errors, /Operation not permitted|Permission denied/i);
      else assert.match(errors, /os error (?:5|1312)\b/);
    }
    assert.equal(await store.get(id, 'fixture'), value, 'sandbox must not change the host fixture');
  } finally {
    await store.clear(id, 'fixture');
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(job, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
