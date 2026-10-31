import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DebugLogService,
  MIN_DEBUG_LOG_BYTES,
  MAX_DEBUG_LOG_MESSAGE_LENGTH,
} from '../../desktop/debug-logging.mjs';

async function temporaryRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'qingzuo-debug-log-'));
}

async function logFiles(directory) {
  return (await readdir(directory)).filter(name => name.startsWith('qingzuo-debug-')).sort();
}

test('debug logging starts disabled, persists its configuration, and records all scopes', async () => {
  const root = await temporaryRoot();
  try {
    const received = [];
    const service = new DebugLogService({ root, onEntry: entry => received.push(entry), now: () => Date.parse('2026-10-31T08:30:12.345Z') });
    await service.initialize();
    assert.equal(service.snapshot().enabled, false);

    await service.configure({ enabled: true, maxBytes: 2 * MIN_DEBUG_LOG_BYTES });
    service.record({ scope: 'app', source: 'app', level: 'info', message: 'base message' });
    service.record({ scope: 'plugin', source: 'plugin/demo', level: 'warn', message: 'plugin message' });
    service.record({ scope: 'browser', source: 'tab/demo', level: 'error', message: 'browser message' });
    await service.flush();

    assert.deepEqual(received.map(entry => entry.scope), ['app', 'plugin', 'browser']);
    const state = service.snapshot();
    assert.equal(state.enabled, true);
    assert.equal(state.maxBytes, 2 * MIN_DEBUG_LOG_BYTES);
    assert.ok(state.currentFile);
    assert.ok(state.storedBytes > 0);

    const restarted = new DebugLogService({ root });
    await restarted.initialize();
    assert.equal(restarted.snapshot().enabled, true);
    assert.equal(restarted.snapshot().directory, state.directory);
    assert.equal(restarted.snapshot().maxBytes, state.maxBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('debug logging enforces the size limit by deleting the oldest owned files', async () => {
  const root = await temporaryRoot();
  try {
    const service = new DebugLogService({ root, activeFileChunk: 64 * 1024, now: () => Date.parse('2026-10-31T08:31:00.000Z') });
    await service.initialize();
    await service.configure({ enabled: true, maxBytes: MIN_DEBUG_LOG_BYTES });
    service.record({ scope: 'app', source: 'oldest', level: 'info', message: 'oldest-marker' });
    await service.flush();

    for (let index = 0; index < 45; index += 1) {
      service.record({
        scope: index % 2 ? 'plugin' : 'browser',
        source: index % 2 ? 'plugin/demo' : 'tab/demo',
        level: 'info',
        message: `fresh-${index}:` + 'x'.repeat(MAX_DEBUG_LOG_MESSAGE_LENGTH - 32),
      });
      await service.flush();
    }

    const files = await logFiles(service.snapshot().directory);
    const sizes = await Promise.all(files.map(name => stat(path.join(service.snapshot().directory, name)).then(info => info.size)));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    assert.ok(files.length > 1);
    assert.ok(total <= MIN_DEBUG_LOG_BYTES, `${total} should not exceed ${MIN_DEBUG_LOG_BYTES}`);
    assert.equal(service.snapshot().storedBytes, total);
    const contents = await Promise.all(files.map(name => readFile(path.join(service.snapshot().directory, name), 'utf8')));
    assert.equal(contents.some(value => value.includes('oldest-marker')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('debug logging ignores unrelated files and writes nothing while disabled', async () => {
  const root = await temporaryRoot();
  try {
    const service = new DebugLogService({ root });
    await service.initialize();
    const unrelated = path.join(root, 'logs', 'keep-me.txt');
    await service.configure({ enabled: true });
    await writeFile(unrelated, 'user file');
    service.record({ scope: 'app', source: 'test', level: 'info', message: 'enabled-marker' });
    await service.flush();

    await service.configure({ enabled: false });
    assert.equal(service.record({ scope: 'app', source: 'test', level: 'info', message: 'disabled-marker' }), null);
    await service.flush();

    assert.equal(await readFile(unrelated, 'utf8'), 'user file');
    const contents = await Promise.all((await logFiles(service.snapshot().directory)).map(name => readFile(path.join(service.snapshot().directory, name), 'utf8')));
    assert.equal(contents.some(value => value.includes('enabled-marker')), true);
    assert.equal(contents.some(value => value.includes('disabled-marker')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('debug logging rejects invalid retention limits and relative directories', async () => {
  const root = await temporaryRoot();
  try {
    const service = new DebugLogService({ root });
    await service.initialize();
    await assert.rejects(service.configure({ enabled: true, maxBytes: MIN_DEBUG_LOG_BYTES - 1 }), /1 MB/);
    await assert.rejects(service.configure({ directory: 'relative/logs' }), /目录无效/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
