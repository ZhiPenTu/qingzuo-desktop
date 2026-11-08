import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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
    child.send({ type: 'init', options: { home, installAnchor: path.resolve('package.json') } });
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(20000) });
    assert.equal(ready.type, 'ready');
    assert.equal(ready.systems.length, 7);
    const started = Date.now();
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    child.send({ type: 'shutdown' });
    const [code] = await exited;
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 5000);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(home, { recursive: true, force: true });
  }
});
