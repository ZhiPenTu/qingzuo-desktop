import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginInstallService } from '../../desktop/plugin-install-service.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fields = ['error', 'id', 'progress', 'status', 'total', 'transferred', 'version'];

test('start acknowledges immediately and deduplicates a long install while status and other plugins remain available', async () => {
  const gate = deferred(), calls = [];
  const service = new PluginInstallService(async (id, notify) => { calls.push(id); notify({ status: 'downloading', version: '2.0.0' }); await gate.promise; });
  const accepted = service.start('local.large');
  assert.deepEqual(accepted, { id: 'local.large', version: null, status: 'checking', progress: null, transferred: 0, total: 0, error: null });
  assert.equal(accepted instanceof Promise, false); assert.equal(calls.length, 0);
  const pending = service.pending.get('local.large');
  await Promise.resolve();
  assert.equal(service.start('local.large').status, 'downloading'); assert.equal(service.pending.get('local.large'), pending);
  assert.throws(() => service.assertAvailable('local.large'), /正在安装或更新/);
  service.assertAvailable('local.other'); assert.equal(service.snapshot()[0].status, 'downloading');
  await Promise.resolve(); assert.deepEqual(calls, ['local.large']);
  gate.resolve(); await pending;
  assert.equal(service.snapshot()[0].status, 'installed'); assert.equal(service.pending.size, 0); service.assertAvailable('local.large');
});

test('phase notifications expose independent scalar snapshots and omit internal values and download paths', async () => {
  const gate = deferred(), events = [];
  const service = new PluginInstallService(async (_id, notify) => {
    notify({ status: 'downloading', version: '2.0.0', progress: 25, transferred: 25, total: 100, url: 'https://private/download', folder: '/private/plugin', pending: gate.promise, id: 'different-plugin' });
    await gate.promise;
    notify({ status: 'verifying', progress: 100, transferred: 100 });
    notify({ status: 'installing' }); notify({ status: 'syncing' });
  }, () => events.push(service.snapshot()));
  const returned = service.start('local.fixture'), pending = service.pending.get('local.fixture');
  returned.status = 'error'; returned.error = 'mutated';
  await Promise.resolve();
  const snapshot = service.snapshot(); snapshot[0].version = 'mutated'; snapshot.splice(0);
  assert.equal(service.snapshot()[0].version, '2.0.0');
  gate.resolve(); await pending;
  assert.deepEqual(events.map(items => items[0].status), ['checking', 'downloading', 'verifying', 'installing', 'syncing', 'installed']);
  for (const items of events) {
    assert.deepEqual(Object.keys(items[0]).sort(), fields); assert.equal(items[0].id, 'local.fixture');
    assert.ok(Object.values(items[0]).every(value => value === null || ['string', 'number'].includes(typeof value)));
    assert.equal(JSON.stringify(items).includes('private'), false);
  }
  assert.deepEqual(service.snapshot()[0], { id: 'local.fixture', version: '2.0.0', status: 'installed', progress: 100, transferred: 100, total: 100, error: null });
});

test('failure preserves the precise error and version, releases the lock and allows a clean retry', async () => {
  let attempts = 0;
  const service = new PluginInstallService(async (_id, notify) => {
    attempts++;
    if (attempts === 1) { notify({ status: 'verifying', version: '2.0.0', progress: 100, transferred: 100, total: 100 }); throw new Error('插件签名无效。'); }
    assert.deepEqual(service.snapshot()[0], { id: 'local.fixture', version: null, status: 'checking', progress: null, transferred: 0, total: 0, error: null });
    notify({ version: '2.0.0', status: 'installing' });
  });
  service.start('local.fixture'); await service.pending.get('local.fixture');
  assert.equal(service.snapshot()[0].error, '插件签名无效。'); assert.equal(service.snapshot()[0].version, '2.0.0'); assert.equal(service.snapshot()[0].status, 'error');
  assert.equal(service.pending.size, 0); service.assertAvailable('local.fixture');
  service.start('local.fixture'); await service.pending.get('local.fixture');
  assert.equal(attempts, 2); assert.equal(service.snapshot()[0].status, 'installed'); assert.equal(service.snapshot()[0].error, null);
});

test('different plugins can download concurrently while each retains its own lock and final state', async () => {
  const gates = new Map([['local.one', deferred()], ['local.two', deferred()]]), calls = [];
  const service = new PluginInstallService(async (id, notify) => { calls.push(id); notify({ status: 'downloading' }); await gates.get(id).promise; });
  service.start('local.one'); service.start('local.two'); await Promise.resolve();
  assert.deepEqual(calls, ['local.one', 'local.two']); assert.equal(service.pending.size, 2);
  const first = service.pending.get('local.one'); gates.get('local.one').resolve(); await first;
  service.assertAvailable('local.one'); assert.throws(() => service.assertAvailable('local.two'), /正在安装或更新/);
  const second = service.pending.get('local.two'); gates.get('local.two').resolve(); await second;
  assert.ok(service.snapshot().every(state => state.status === 'installed'));
});

test('shutdown aborts downloads, drains pending tasks and never permits another installation', async () => {
  const entered = deferred(); let signal;
  const service = new PluginInstallService(async (_id, notify, currentSignal) => {
    signal = currentSignal; notify({ status: 'downloading' }); entered.resolve();
    await new Promise((_resolve, reject) => currentSignal.addEventListener('abort', () => reject(currentSignal.reason), { once: true }));
  });
  service.start('local.fixture'); await entered.promise;
  const shutdown = service.shutdown();
  assert.equal(signal.aborted, true); assert.equal(service.shutdown(), shutdown);
  assert.throws(() => service.start('local.fixture'), /正在退出/); assert.throws(() => service.start('local.other'), /正在退出/);
  assert.throws(() => service.assertAvailable('local.other'), /正在退出/);
  await shutdown;
  assert.equal(service.pending.size, 0); assert.equal(service.snapshot()[0].status, 'error'); assert.equal(service.snapshot()[0].error, '插件安装已取消。');
  assert.throws(() => service.start('local.other'), /正在退出/);
});

test('shutdown waits for an already committing install to finish and cancels jobs not yet started', async () => {
  const gate = deferred(), entered = deferred(); let signal, called = false;
  const service = new PluginInstallService(async (_id, notify, currentSignal) => {
    signal = currentSignal; notify({ status: 'installing' }); entered.resolve(); await gate.promise; notify({ status: 'syncing' });
  });
  service.start('local.fixture'); await entered.promise;
  let drained = false; const shutdown = service.shutdown().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(signal.aborted, true); assert.equal(drained, false); assert.equal(service.pending.size, 1);
  gate.resolve(); await shutdown;
  assert.equal(service.snapshot()[0].status, 'installed'); assert.equal(service.pending.size, 0);
  const queued = new PluginInstallService(async () => { called = true; });
  queued.start('local.queued'); await queued.shutdown();
  assert.equal(called, false); assert.equal(queued.snapshot()[0].status, 'error'); assert.equal(queued.snapshot()[0].error, '插件安装已取消。');
});

test('late phase callbacks cannot overwrite a completed job and malformed public fields fail explicitly', async () => {
  let notify;
  const service = new PluginInstallService(async (_id, callback) => { notify = callback; });
  service.start('local.fixture'); await service.pending.get('local.fixture');
  notify({ status: 'downloading', error: 'late event' }); assert.equal(service.snapshot()[0].status, 'installed');
  const malformed = new PluginInstallService(async (_id, callback) => callback({ progress: Infinity }));
  malformed.start('local.fixture'); await malformed.pending.get('local.fixture');
  assert.equal(malformed.snapshot()[0].status, 'error'); assert.match(malformed.snapshot()[0].error, /安装状态无效：progress/); assert.equal(malformed.pending.size, 0);
});
