import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UpdateService, nativeUpdateAdapter } from '../../desktop/update-service.mjs';

const available = { status: 'available', version: '0.2.4', notes: 'latest' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('download returns immediately, prevents overlapping operations, and automatically installs after preparation', async () => {
  const gate = deferred(), states = [], calls = [];
  const service = new UpdateService({
    check: async () => { calls.push('check'); return available; },
    download: async (_release, notify) => { calls.push('download'); notify({ progress: 25, transferred: 25, total: 100 }); await gate.promise; notify({ status: 'extracting' }); return 'prepared'; },
    install: async prepared => { calls.push(prepared); },
  }, () => { states.push({ ...service.state }); });
  assert.throws(() => service.download(), /检查/);
  service.check(); await service.pending;
  assert.equal(service.download(), undefined);
  await Promise.resolve();
  service.check(); service.download();
  assert.equal(service.state.progress, 25);
  assert.deepEqual(calls, ['check', 'download']);
  gate.resolve(); await service.pending;
  assert.deepEqual(calls, ['check', 'download', 'prepared']);
  assert.equal(service.state.status, 'installing');
  assert.ok(states.some(state => state.status === 'extracting'));
  service.check(); service.download();
  assert.deepEqual(calls, ['check', 'download', 'prepared']);
});

test('failed downloads never install, retain the checked version for retry and reset stale progress', async () => {
  let attempts = 0, installs = 0;
  const service = new UpdateService({ check: async () => available,
    download: async (_release, notify) => {
      attempts++;
      if (attempts === 1) {
        notify({ mode: 'components', progress: 45, transferred: 45, total: 100, reusedBytes: 10, fallbackReason: '组件更新暂不可用。' });
        throw new Error('网络中断');
      }
      assert.equal(service.state.progress, 0);
      assert.equal(service.state.mode, null);
      assert.equal(service.state.transferred, 0);
      assert.equal(service.state.total, 0);
      assert.equal(service.state.reusedBytes, 0);
      assert.equal(service.state.fallbackReason, null);
    },
    install: async () => { installs++; },
  }, () => {});
  service.check(); await service.pending;
  service.download(); await service.pending;
  assert.equal(installs, 0); assert.equal(service.state.status, 'error'); assert.equal(service.state.version, '0.2.4');
  assert.equal(service.state.progress, 0);
  assert.equal(service.state.mode, null);
  assert.equal(service.state.transferred, 0);
  assert.equal(service.state.total, 0);
  assert.equal(service.state.reusedBytes, 0);
  assert.equal(service.state.fallbackReason, null);
  service.download(); await service.pending;
  assert.equal(installs, 1); assert.equal(service.state.error, null);
});

test('native updates verify/download before silent install with forced relaunch, and remove progress subscriptions', async () => {
  const updater = new EventEmitter(), calls = [], states = [];
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.2.4', releaseNotes: 'latest' } });
  updater.downloadUpdate = async () => { calls.push('download'); updater.emit('download-progress', { percent: 50, transferred: 5, total: 10 }); };
  updater.quitAndInstall = (...args) => calls.push(args);
  const adapter = nativeUpdateAdapter(updater);
  assert.deepEqual(await adapter.check(), available);
  await adapter.download(available, state => states.push(state));
  await adapter.install();
  assert.deepEqual(calls, ['download', [true, true]]);
  assert.equal(states[0].progress, 50); assert.equal(updater.listenerCount('download-progress'), 0);
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.disableDifferentialDownload, false);
  updater.downloadUpdate = async () => { throw new Error('checksum mismatch'); };
  await assert.rejects(adapter.download(available, () => {}), /checksum/);
  assert.equal(updater.listenerCount('download-progress'), 0);
});

test('cleanCache delegates to adapter cleanCache and rejects while download is in flight', async () => {
  let cleaned = false;
  const adapter = {
    check: async () => available,
    download: async () => 'prepared',
    install: async () => {},
    cleanCache: async () => { cleaned = true; return { freedBytes: 1024 }; },
  };
  const service = new UpdateService(adapter);
  const result = await service.cleanCache();
  assert.equal(cleaned, true);
  assert.equal(result.freedBytes, 1024);

  service.state.status = 'downloading';
  await assert.rejects(service.cleanCache(), /更新进行中/);
});

test('invalid check results fail closed and malformed native progress cannot poison public state', async () => {
  const service = new UpdateService({ check: async () => ({ status: 'available' }) }, () => {});
  service.check(); await service.pending;
  assert.equal(service.state.status, 'error');
  assert.match(service.state.error, /缺少版本信息/);
  const invalidStatus = new UpdateService({ check: async () => ({ status: 'broken' }) }, () => {});
  invalidStatus.check(); await invalidStatus.pending;
  assert.match(invalidStatus.state.error, /无效状态/);

  const updater = new EventEmitter(), states = [];
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.2.4' } });
  updater.downloadUpdate = async () => updater.emit('download-progress', { percent: Number.NaN, transferred: Infinity, total: -1 });
  const adapter = nativeUpdateAdapter(updater);
  await adapter.download({ status: 'available', version: '0.2.4' }, value => states.push(value));
  assert.deepEqual(states[0], { status: 'downloading', progress: 0, transferred: 0, total: 0 });
});
