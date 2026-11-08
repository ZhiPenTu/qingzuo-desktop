import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootCommerceKernel } from '../../desktop/kernel.mjs';
test('real Harness profile loads only our seven protected system services and disposes their effects', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'commerce-kernel-'));
  const calls = [];
  try {
    const k = await bootCommerceKernel({ home, installAnchor: path.resolve('package.json'), invoke: async (...args) => { calls.push(args); return ['test']; } });
    assert.deepEqual([...k.systems.keys()], ['home', 'market', 'plugins', 'settings', 'updates', 'credentials', 'sandbox']);
    assert.deepEqual(await k.systems.get('home').invoke('list', {}), ['test']); assert.equal(calls[0][0], 'home');
    assert.equal(k.ctx.get('agents'), undefined); assert.equal(k.ctx.get('webserver'), undefined);
    const registered = await k.reconcile([{ id: 'local.fixture', enabled: true, services: { provides: ['local.echo'] } }]);
    assert.deepEqual(registered, ['local.echo']);
    assert.ok(k.tools.has('local.echo'));
    assert.deepEqual(await k.call('tool', 'local.echo', 'echo', { text: 'hello' }, 'local.fixture'), ['test']);
    assert.equal(calls.at(-1)[0], 'sandbox');
    const cleared = await k.reconcile([]); assert.equal(k.tools.size, 0); assert.deepEqual(cleared, []);
    await assert.rejects(k.call('tool', 'local.echo', 'echo', {}, 'local.fixture'));
    const reinstalled = await k.reconcile([{ id: 'local.fixture', enabled: true, services: { provides: ['local.echo'] } }]);
    assert.deepEqual(reinstalled, ['local.echo']);
    assert.ok(k.tools.has('local.echo'));
    assert.deepEqual(await k.call('tool', 'local.echo', 'echo', { text: 'hello-again' }, 'local.fixture'), ['test']);
    await k.dispose(); assert.equal(k.systems.size, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('the kernel host disposes its tree before exiting on a shutdown message', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'commerce-kernel-shutdown-'));
  const child = fork(path.resolve('desktop/kernel-host.mjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    const ready = await bootChild(child, home);
    assert.equal(ready.systems.length, 7);
    const started = Date.now();
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    child.send({ type: 'shutdown' });
    const [code] = await exited;
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 5000);
  } finally {
    await stopChild(child);
    await rm(home, { recursive: true, force: true });
  }
});

test('a signal during profile boot still exits with the documented code', {
  skip: process.platform === 'win32' ? 'Windows has no POSIX signal exit contract; shutdown uses IPC there.' : false,
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'commerce-kernel-signal-'));
  const child = fork(path.resolve('desktop/kernel-host.mjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    child.send({ type: 'init', options: { home, installAnchor: path.resolve('package.json') } });
    await waitForProfile(home);
    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    assert.equal(signal, null);
    assert.equal(code, 0);
  } finally {
    await stopChild(child);
    await rm(home, { recursive: true, force: true });
  }
});

test('a shutdown message during profile boot waits for the boot to settle', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'commerce-kernel-early-'));
  const child = fork(path.resolve('desktop/kernel-host.mjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    child.send({ type: 'init', options: { home, installAnchor: path.resolve('package.json') } });
    await waitForProfile(home);
    child.send({ type: 'shutdown' });
    const [code, signal] = await once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    assert.equal(signal, null);
    assert.equal(code, 0);
  } finally {
    await stopChild(child);
    await rm(home, { recursive: true, force: true });
  }
});

async function bootChild(child, home) {
  child.send({ type: 'init', options: { home, installAnchor: path.resolve('package.json') } });
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(20000) });
  assert.equal(message.type, 'ready');
  return message;
}

async function waitForProfile(home) {
  const patch = path.join(home, 'profiles', 'commerce-desktop', 'cordis.patch.yml');
  const deadline = Date.now() + 10000;
  for (;;) {
    try { await access(patch); return; } catch {}
    if (Date.now() > deadline) throw new Error('内核 Profile 未在预期时间内写入。');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}
