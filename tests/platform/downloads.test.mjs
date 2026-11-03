import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Downloads, MAX_DOWNLOAD_BYTES, buildSegments, directoryDisplayName, filenameFromDisposition, safeDownloadFilename } from '../../desktop/downloads.mjs';
import { createPluginClient } from '../../packages/plugin-sdk/index.mjs';
import { API_VERSION, validateManifest } from '../../packages/plugin-sdk/manifest.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function streamBody(bytes, {
  signal,
  delayMs = 0,
  chunkSize = 1024,
  failAfter = null,
  onStart = () => {},
  onEnd = () => {},
  onBytes = () => {},
} = {}) {
  const owned = new AbortController();
  const combined = signal ? AbortSignal.any([signal, owned.signal]) : owned.signal;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  return new ReadableStream({
    async start(controller) {
      onStart();
      let offset = 0;
      const abort = () => {
        finish();
        try { controller.error(combined.reason || new Error('aborted')); } catch {}
      };
      if (combined.aborted) return abort();
      combined.addEventListener('abort', abort, { once: true });
      try {
        while (offset < bytes.length) {
          if (delayMs) await delay(delayMs);
          if (combined.aborted) return abort();
          const length = Math.min(chunkSize, bytes.length - offset);
          if (failAfter !== null && offset >= failAfter) throw new Error('fixture connection lost');
          controller.enqueue(bytes.subarray(offset, offset + length));
          offset += length;
          onBytes(length);
        }
        if (failAfter !== null && bytes.length > failAfter) throw new Error('fixture connection lost');
        finish();
        controller.close();
      } catch (error) {
        finish();
        try { controller.error(error); } catch {}
      } finally {
        combined.removeEventListener('abort', abort);
      }
    },
    cancel() { finish(); },
  });
}

function fixtureServer(bytes, options = {}) {
  let etag = options.etag ?? '"fixture-v1"';
  let interruptOnce = Boolean(options.interruptOnce);
  const advertisedTotal = options.reportedSize ?? bytes.length;
  const stats = { active: 0, maxActive: 0, gets: 0, rangeGets: [], fullGets: 0 };
  const headers = (total = advertisedTotal) => {
    const value = {
      'content-length': String(total),
      'content-type': options.mime ?? 'application/octet-stream',
      'content-disposition': options.disposition ?? 'attachment; filename="fixture.bin"',
      etag,
    };
    if (options.lastModified) value['last-modified'] = options.lastModified;
    return value;
  };
  const request = async (_url, requestOptions = {}) => {
    if (requestOptions.signal?.aborted) throw requestOptions.signal.reason;
    const method = requestOptions.method ?? 'GET';
    if (method === 'HEAD') {
      if (options.headStatus && options.headStatus !== 200) return new Response(null, { status: options.headStatus });
      return new Response(null, { status: 200, headers: headers() });
    }
    stats.gets++;
    const range = requestOptions.headers?.Range;
    const probe = range === 'bytes=0-0';
    if (range) stats.rangeGets.push(range);
    if (!range) stats.fullGets++;
    if (options.redirect) return new Response(null, { status: 302, headers: { location: options.redirect } });
    if (probe && options.probe416) {
      return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + advertisedTotal } });
    }
    if (range && range !== 'bytes=0-0' && options.midstreamUnsupported) {
      return new Response(streamBody(bytes, { signal: requestOptions.signal }), { status: 200, headers: headers() });
    }
    if (range && (options.range === false || range === 'bytes=0-0' && options.probeRange === false)) {
      return new Response(streamBody(bytes, { signal: requestOptions.signal, delayMs: probe ? 0 : options.delayMs }), { status: 200, headers: headers() });
    }
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + bytes.length } });
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : bytes.length - 1;
      if (start >= bytes.length) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + advertisedTotal } });
      const selected = bytes.subarray(start, Math.min(end + 1, bytes.length));
      const valueHeaders = headers();
      valueHeaders['content-length'] = String(selected.length);
      valueHeaders['content-range'] = `bytes ${start}-${Math.min(end, bytes.length - 1)}/${advertisedTotal}`;
      const failAfter = interruptOnce && !probe ? Math.min(512, selected.length) : null;
      if (failAfter !== null) interruptOnce = false;
      return new Response(streamBody(selected, {
        signal: requestOptions.signal,
        delayMs: probe ? 0 : options.delayMs,
        chunkSize: options.chunkSize,
        failAfter,
        onStart: () => {
          if (probe) return;
          stats.active++;
          stats.maxActive = Math.max(stats.maxActive, stats.active);
        },
        onEnd: () => {
          if (probe) return;
          stats.active = Math.max(0, stats.active - 1);
        },
      }), { status: 206, headers: valueHeaders });
    }
    return new Response(streamBody(bytes, {
      signal: requestOptions.signal,
      delayMs: options.delayMs,
      chunkSize: options.chunkSize,
      onStart: () => { stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active); },
      onEnd: () => { stats.active = Math.max(0, stats.active - 1); },
    }), { status: 200, headers: headers() });
  };
  return {
    request,
    stats,
    setEtag(value) { etag = value; },
  };
}

function plugin(id = 'local.caller', permission = 'use', source = 'local') {
  return { id, title: id === 'official.downloader' ? '文件下载器' : '调用工具', source, permissions: { downloads: permission } };
}

async function fixture(context, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-downloads-'));
  const directory = path.join(root, 'output');
  await mkdir(directory);
  const server = options.server ?? fixtureServer(options.bytes ?? Buffer.from('fixture'), options);
  const downloads = new Downloads(path.join(root, 'state'), {
    defaultDirectory: directory,
    dialog: options.dialog ?? { showOpenDialog: async () => ({ canceled: false, filePaths: [directory] }) },
    request: server.request,
    minimumSegmentBytes: options.minimumSegmentBytes ?? 1024,
    progressPersistMs: 0,
    freeSpace: options.freeSpace ?? (async () => 1024 ** 3),
    idleTimeoutMs: 5000,
    log: options.log ?? (() => {}),
  });
  await downloads.initialize();
  context.after(async () => {
    await downloads.shutdown().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, server, downloads };
}

async function task(downloads, owner, id) {
  return downloads.get(owner, { id });
}

async function waitFor(downloads, owner, id, statuses = ['completed', 'paused', 'failed', 'canceled'], timeout = 8000) {
  const until = Date.now() + timeout;
  let current;
  while (Date.now() < until) {
    current = await task(downloads, owner, id);
    if (statuses.includes(current.status)) return current;
    await delay(10);
  }
  throw new Error('任务未在预期时间内结束：' + JSON.stringify(current));
}

async function waitForBytes(downloads, owner, id, minimum = 1, timeout = 8000) {
  const until = Date.now() + timeout;
  let current;
  while (Date.now() < until) {
    current = await task(downloads, owner, id);
    if (current.transferred >= minimum) return current;
    await delay(10);
  }
  throw new Error('任务没有在预期时间内产生下载数据：' + JSON.stringify(current));
}

test('filename helpers strip paths, reserved names, controls and support encoded dispositions', () => {
  assert.equal(safeDownloadFilename('../../CON.txt'), '_CON.txt');
  assert.equal(safeDownloadFilename('folder/report.bin'), 'report.bin');
  assert.equal(safeDownloadFilename('bad<>:"|?*\u0000name.zip'), 'bad________name.zip');
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E6%96%87%E4%BB%B6.zip"), '文件.zip');
  assert.equal(filenameFromDisposition('attachment; filename="quoted.bin"'), 'quoted.bin');
  assert.equal(filenameFromDisposition('attachment; filename=plain.bin'), 'plain.bin');
});

test('display-only directory names never expose a filesystem root', () => {
  assert.equal(directoryDisplayName(path.join(path.parse(process.cwd()).root, 'Downloads')), 'Downloads');
  assert.equal(
    directoryDisplayName(path.parse(path.resolve(process.cwd())).root),
    process.platform === 'win32' ? '本地磁盘' : '根目录',
  );
});

test('segments cover the complete byte range without gaps or overlap', () => {
  const segments = buildSegments(10, 4);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, 9);
  assert.ok(segments.every((segment, index) => index === 0 || segment.start === segments[index - 1].end + 1));
  assert.deepEqual(buildSegments(2, 4), [{ start: 0, end: 0, transferred: 0 }, { start: 1, end: 1, transferred: 0 }]);
});

test('probe detects range capability without exposing the download URL', async context => {
  const bytes = Buffer.from('probe-target');
  const { downloads, server } = await fixture(context, {
    bytes,
    disposition: "attachment; filename*=UTF-8''%E6%96%87%E4%BB%B6.bin",
    mime: 'application/octet-stream',
    lastModified: 'Mon, 02 Nov 2026 10:00:00 GMT',
  });
  const owner = plugin();
  const value = await downloads.probe(owner, { url: 'https://downloads.example/private/path?token=signed' });
  assert.deepEqual(value, {
    hostname: 'downloads.example',
    filename: '文件.bin',
    size: bytes.length,
    mime: 'application/octet-stream',
    supportsRange: true,
    resumable: true,
    mode: 'single',
  });
  assert.equal(JSON.stringify(value).includes('signed'), false);
  assert.equal(JSON.stringify(value).includes('/private/path'), false);
  assert.equal(server.stats.rangeGets.includes('bytes=0-0'), true);
});

test('a rejected HEAD request does not block a working Range probe', async context => {
  const bytes = Buffer.from('range-works-without-head'.repeat(4096));
  const { downloads, directory } = await fixture(context, {
    bytes,
    headStatus: 403,
    minimumSegmentBytes: 1,
  });
  const owner = plugin();
  const value = await downloads.probe(owner, { url: 'https://downloads.example/head-denied.bin' });
  assert.equal(value.supportsRange, true);
  const started = await downloads.start(owner, { url: 'https://downloads.example/head-denied.bin', concurrency: 2 });
  const completed = await waitFor(downloads, owner, started.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(await readFile(path.join(directory, completed.filename)), bytes);
});

test('a non-empty 416 probe falls back to one normal download', async context => {
  const bytes = Buffer.from('range-probe-rejected'.repeat(4096));
  const { downloads, directory } = await fixture(context, {
    bytes,
    probe416: true,
    minimumSegmentBytes: 1,
  });
  const owner = plugin();
  const value = await downloads.probe(owner, { url: 'https://downloads.example/range-denied.bin' });
  assert.equal(value.supportsRange, false);
  assert.equal(value.size, bytes.length);
  const started = await downloads.start(owner, { url: 'https://downloads.example/range-denied.bin', concurrency: 4 });
  const completed = await waitFor(downloads, owner, started.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.mode, 'single');
  assert.deepEqual(await readFile(path.join(directory, completed.filename)), bytes);
});

test('range-capable downloads use bounded concurrency and produce the exact file', async context => {
  const bytes = Buffer.alloc(256 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const logs = [];
  const { downloads, directory, server } = await fixture(context, {
    bytes,
    minimumSegmentBytes: 1024,
    delayMs: 2,
    chunkSize: 2048,
    log: (...entry) => logs.push(entry),
  });
  const owner = plugin();
  const started = await downloads.start(owner, { url: 'https://downloads.example/archive.bin', concurrency: 4 });
  const completed = await waitFor(downloads, owner, started.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.mode, 'segmented', JSON.stringify(logs));
  assert.equal(completed.progress, 100);
  assert.equal(completed.transferred, bytes.length);
  assert.ok(server.stats.maxActive > 1 && server.stats.maxActive <= 4, 'expected 2-4 active segments');
  const result = await readFile(path.join(directory, completed.filename));
  assert.equal(createHash('sha256').update(result).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  const serialized = JSON.stringify(completed);
  assert.equal(serialized.includes('downloads.example/archive'), false);
  assert.equal(serialized.includes(directory), false);
});

test('servers without Range support fall back to one normal download', async context => {
  const bytes = Buffer.from('fallback-content'.repeat(512));
  const { downloads, directory, server } = await fixture(context, { bytes, range: false, minimumSegmentBytes: 1 });
  const owner = plugin();
  const started = await downloads.start(owner, { url: 'https://downloads.example/plain.bin', concurrency: 4 });
  const completed = await waitFor(downloads, owner, started.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.mode, 'single');
  assert.equal(completed.transferred, bytes.length);
  assert.equal(server.stats.maxActive, 1);
  assert.deepEqual(await readFile(path.join(directory, completed.filename)), bytes);
});

test('a Range failure during transfer discards segments and restarts as a normal download', async context => {
  const bytes = Buffer.from('midstream-range-fallback'.repeat(2048));
  const { downloads, directory } = await fixture(context, { bytes, minimumSegmentBytes: 1, midstreamUnsupported: true });
  const owner = plugin();
  const started = await downloads.start(owner, { url: 'https://downloads.example/switch.bin', concurrency: 4 });
  const completed = await waitFor(downloads, owner, started.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.mode, 'single');
  assert.equal(completed.transferred, bytes.length);
  assert.deepEqual(await readFile(path.join(directory, completed.filename)), bytes);
});

test('an interrupted range download pauses with resumable offsets and continues later', async context => {
  const bytes = Buffer.alloc(128 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 17) % 253;
  const { downloads, directory, server } = await fixture(context, { bytes, minimumSegmentBytes: 1, interruptOnce: true, chunkSize: 1024 });
  const owner = plugin();
  const started = await downloads.start(owner, { url: 'https://downloads.example/resume.bin', concurrency: 2 });
  const paused = await waitFor(downloads, owner, started.id, ['paused', 'failed'], 10000);
  assert.equal(paused.status, 'paused');
  assert.ok(paused.transferred > 0);
  const before = server.stats.rangeGets.length;
  await downloads.resume(owner, { id: started.id });
  const completed = await waitFor(downloads, owner, started.id, ['completed', 'paused', 'failed'], 10000);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.transferred, bytes.length);
  assert.ok(server.stats.rangeGets.slice(before).some(value => !value.startsWith('bytes=0-')));
  assert.deepEqual(await readFile(path.join(directory, completed.filename)), bytes);
});

test('tasks recover after an application restart and preserve downloaded offsets', async context => {
  const bytes = Buffer.from('restart-resume'.repeat(8192));
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-downloads-restart-'));
  const directory = path.join(root, 'output');
  await mkdir(directory);
  const server = fixtureServer(bytes, { minimumSegmentBytes: 1, delayMs: 2, chunkSize: 1024 });
  let first = null, second = null;
  context.after(async () => {
    await second?.shutdown().catch(() => {});
    await first?.shutdown().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  first = new Downloads(path.join(root, 'state'), {
    defaultDirectory: directory,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    request: server.request,
    minimumSegmentBytes: 1,
    progressPersistMs: 0,
    freeSpace: async () => 1024 ** 3,
  });
  await first.initialize();
  const owner = plugin();
  const started = await first.start(owner, { url: 'https://downloads.example/restart.bin', concurrency: 2 });
  await waitFor(first, owner, started.id, ['downloading']);
  await new Promise(async resolve => {
    for (let index = 0; index < 200; index++) {
      const current = await first.get(owner, { id: started.id }).catch(() => null);
      if ((current?.transferred ?? 0) > 4096) { resolve(); return; }
      await delay(10);
    }
    resolve();
  });
  await first.shutdown();
  const persisted = JSON.parse(await readFile(path.join(root, 'state/state.json'), 'utf8')).tasks[0];
  assert.equal(persisted.status, 'queued');
  second = new Downloads(path.join(root, 'state'), {
    defaultDirectory: directory,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    request: server.request,
    minimumSegmentBytes: 1,
    progressPersistMs: 0,
    freeSpace: async () => 1024 ** 3,
  });
  await second.initialize();
  await second.resumePending();
  const completed = await waitFor(second, owner, started.id, ['completed', 'paused', 'failed'], 15000);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(await readFile(path.join(directory, completed.filename)), bytes);
});

test('restart restores tasks whose Windows directory identity exceeds safe integers', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-downloads-identity-'));
  const directory = path.join(root, 'output');
  const stateRoot = path.join(root, 'state');
  await mkdir(directory);
  await mkdir(stateRoot);
  const id = '11111111-1111-4111-8111-111111111111';
  await writeFile(path.join(stateRoot, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    preferences: { directoryPath: directory, directoryName: 'output', concurrency: 4 },
    tasks: [{
      id,
      ownerId: 'local.caller',
      ownerTitle: '调用工具',
      url: 'https://downloads.example/identity.bin',
      directoryPath: directory,
      directoryDev: '281474976710656',
      directoryIno: '18446744073709551615',
      status: 'paused',
      mode: 'single',
      concurrency: 4,
      hostname: 'downloads.example',
      filename: 'identity.bin',
      requestedFilename: 'identity.bin',
      mime: 'application/octet-stream',
      total: 10,
      transferred: 0,
      segments: [],
      supportsRange: false,
      remoteKnown: true,
      resetRequired: false,
      etag: null,
      lastModified: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
    }],
  }));
  const downloads = new Downloads(stateRoot, {
    defaultDirectory: directory,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    request: async () => new Response(null, { status: 500 }),
  });
  await downloads.initialize();
  context.after(async () => {
    await downloads.shutdown().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await downloads.get(plugin(), { id })).filename, 'identity.bin');
});

test('changed ETag pauses recovery instead of mixing two remote files', async context => {
  const bytes = Buffer.from('remote-version-one'.repeat(4096));
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-downloads-etag-'));
  const directory = path.join(root, 'output');
  await mkdir(directory);
  const server = fixtureServer(bytes, { delayMs: 1, chunkSize: 1024 });
  let first = null, second = null;
  context.after(async () => {
    await second?.shutdown().catch(() => {});
    await first?.shutdown().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  first = new Downloads(path.join(root, 'state'), {
    defaultDirectory: directory,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    request: server.request,
    minimumSegmentBytes: 1,
    progressPersistMs: 0,
    freeSpace: async () => 1024 ** 3,
  });
  await first.initialize();
  const owner = plugin();
  const started = await first.start(owner, { url: 'https://downloads.example/etag.bin', concurrency: 2 });
  await delay(20);
  await first.shutdown();
  server.setEtag('"fixture-v2"');
  second = new Downloads(path.join(root, 'state'), {
    defaultDirectory: directory,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    request: server.request,
    minimumSegmentBytes: 1,
    progressPersistMs: 0,
    freeSpace: async () => 1024 ** 3,
  });
  await second.initialize();
  await second.resumePending();
  const paused = await waitFor(second, owner, started.id, ['paused', 'failed']);
  assert.equal(paused.status, 'paused');
  assert.match(paused.error, /远程文件已更新/);
});

test('a changed remote file requires a new task or an explicit replacement directory', async context => {
  const bytes = Buffer.from('remote-replacement'.repeat(8192));
  const { downloads, directory, server } = await fixture(context, {
    bytes,
    delayMs: 2,
    chunkSize: 1024,
    minimumSegmentBytes: 1,
  });
  const owner = plugin();
  const started = await downloads.start(owner, { url: 'https://downloads.example/replace.bin', concurrency: 2 });
  await waitForBytes(downloads, owner, started.id, 2048);
  await downloads.pause(owner, { id: started.id });
  server.setEtag('"fixture-v2"');
  await downloads.resume(owner, { id: started.id });
  const changed = await waitFor(downloads, owner, started.id, ['paused', 'failed']);
  assert.equal(changed.status, 'paused');
  assert.match(changed.error, /重新创建下载任务/);
  assert.equal(changed.canResume, false);
  await assert.rejects(downloads.resume(owner, { id: started.id }), /重新创建下载任务/);
  const selected = await downloads.pickDirectory(owner);
  await downloads.resume(owner, { id: started.id, directoryToken: selected.token });
  const completed = await waitFor(downloads, owner, started.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(await readFile(path.join(directory, completed.filename)), bytes);
});

test('size limits and insufficient disk space are rejected before writing unbounded data', async context => {
  const bytes = Buffer.from('small');
  const { downloads, server } = await fixture(context, { bytes, reportedSize: MAX_DOWNLOAD_BYTES + 1 });
  const owner = plugin();
  await assert.rejects(downloads.probe(owner, { url: 'https://downloads.example/huge.bin' }), /20 GB/);
  server.stats.gets = 0;
  const target = path.join(path.dirname(downloads.defaultDirectory), 'output');
  const lowDisk = new Downloads(path.join(target, '..', 'low-state'), {
    defaultDirectory: target,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    request: fixtureServer(Buffer.alloc(4096)).request,
    minimumSegmentBytes: 1,
    freeSpace: async () => 10,
  });
  await lowDisk.initialize();
  context.after(async () => { await lowDisk.shutdown().catch(() => {}); });
  const started = await lowDisk.start(owner, { url: 'https://downloads.example/space.bin' });
  const paused = await waitFor(lowDisk, owner, started.id, ['paused', 'failed']);
  assert.equal(paused.status, 'paused');
  assert.match(paused.error, /空间不足/);
});

test('an available path from the downloader can be configured while use-only tools cannot change global settings', async context => {
  const { downloads, directory } = await fixture(context, { bytes: Buffer.from('pick') });
  const manage = plugin('official.downloader', 'manage', 'market');
  const owner = plugin();
  const selected = await downloads.pickDirectory(manage);
  assert.ok(selected?.token);
  const configured = await downloads.configure(manage, { directoryToken: selected.token, concurrency: 2 });
  assert.equal(configured.directoryName, path.basename(directory));
  assert.equal(configured.directoryAvailable, true);
  assert.equal(configured.concurrency, 2);
  await assert.rejects(downloads.configure(owner, { concurrency: 3 }), /官方工具/);
  const localManage = plugin('local.manage', 'manage', 'local');
  await assert.rejects(downloads.configure(localManage, { concurrency: 3 }), /官方工具/);
  const started = await downloads.start(owner, { url: 'https://downloads.example/pick.bin' });
  assert.equal((await waitFor(downloads, owner, started.id)).status, 'completed');
});

test('task ownership is isolated for use permission while a market manager can inspect and control all tasks', async context => {
  const bytes = Buffer.from('ownership');
  const { downloads } = await fixture(context, { bytes, delayMs: 10, minimumSegmentBytes: 1 });
  const first = plugin('local.one');
  const second = plugin('local.two');
  const manage = plugin('official.downloader', 'manage', 'market');
  const started = await downloads.start(first, { url: 'https://downloads.example/owner.bin', concurrency: 1 });
  assert.equal((await waitFor(downloads, first, started.id)).status, 'completed');
  assert.equal((await downloads.list(first)).length, 1);
  assert.equal((await downloads.list(second)).length, 0);
  await assert.rejects(downloads.get(second, { id: started.id }), /任务不可用/);
  const all = await downloads.list(manage, { all: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].ownerId, first.id);
  assert.equal((await downloads.list(plugin('local.manage', 'manage', 'local'), { all: true })).length, 0);
  assert.equal(await downloads.reveal(manage, { id: started.id }), false);
});

test('filename collisions never overwrite an existing user file', async context => {
  const bytes = Buffer.from('new-version');
  const { downloads, directory, server } = await fixture(context, { bytes, disposition: 'attachment; filename="report.bin"', minimumSegmentBytes: 1 });
  await writeFile(path.join(directory, 'report.bin'), 'old-version');
  const owner = plugin();
  const started = await downloads.start(owner, { url: 'https://downloads.example/report.bin', concurrency: 2 });
  const completed = await waitFor(downloads, owner, started.id);
  assert.equal(completed.filename, 'report (1).bin');
  assert.equal(await readFile(path.join(directory, 'report.bin'), 'utf8'), 'old-version');
  assert.deepEqual(await readFile(path.join(directory, 'report (1).bin')), bytes);
  assert.equal(server.stats.active, 0);
});

test('replaced directories pause a resumable task instead of writing to a new location', async context => {
  const bytes = Buffer.from('directory-identity'.repeat(4096));
  const { downloads, directory } = await fixture(context, { bytes, delayMs: 25, minimumSegmentBytes: 1 });
  const owner = plugin();
  const started = await downloads.start(owner, { url: 'https://downloads.example/directory.bin', concurrency: 2 });
  await waitFor(downloads, owner, started.id, ['downloading']);
  await delay(20);
  await downloads.pause(owner, { id: started.id });
  const moved = directory + '-moved';
  await rename(directory, moved);
  await mkdir(directory);
  const resumed = await downloads.resume(owner, { id: started.id });
  assert.equal(resumed.status, 'paused');
  assert.match(resumed.error, /文件夹不可用/);
});

test('empty and unknown-length files complete through the normal path', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-downloads-empty-'));
  const directory = path.join(root, 'output');
  await mkdir(directory);
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const emptyRequest = async (_url, options = {}) => {
    if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '0', 'content-disposition': 'attachment; filename="empty.bin"' } });
    return new Response(null, { status: 416, headers: { 'content-range': 'bytes */0' } });
  };
  const empty = new Downloads(path.join(root, 'empty-state'), {
    defaultDirectory: directory,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    request: emptyRequest,
    minimumSegmentBytes: 1,
  });
  await empty.initialize();
  context.after(async () => { await empty.shutdown().catch(() => {}); });
  const owner = plugin();
  const emptyProbe = await empty.probe(owner, { url: 'https://downloads.example/empty.bin' });
  assert.equal(emptyProbe.size, 0);
  const emptyTask = await empty.start(owner, { url: 'https://downloads.example/empty.bin' });
  const emptyDone = await waitFor(empty, owner, emptyTask.id);
  assert.equal(emptyDone.status, 'completed');
  assert.equal((await stat(path.join(directory, emptyDone.filename))).size, 0);

  const unknownBytes = Buffer.from('unknown-size');
  const unknownRequest = async (_url, options = {}) => {
    if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-disposition': 'attachment; filename="unknown.bin"' } });
    return new Response(streamBody(unknownBytes, { signal: options.signal }), { status: 200 });
  };
  const unknown = new Downloads(path.join(root, 'unknown-state'), {
    defaultDirectory: directory,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    request: unknownRequest,
    minimumSegmentBytes: 1,
  });
  await unknown.initialize();
  context.after(async () => { await unknown.shutdown().catch(() => {}); });
  const unknownProbe = await unknown.probe(owner, { url: 'https://downloads.example/unknown.bin' });
  assert.equal(unknownProbe.size, null);
  const unknownTask = await unknown.start(owner, { url: 'https://downloads.example/unknown.bin' });
  const unknownDone = await waitFor(unknown, owner, unknownTask.id);
  assert.equal(unknownDone.status, 'completed');
  assert.equal(unknownDone.total, unknownBytes.length);
  assert.deepEqual(await readFile(path.join(directory, unknownDone.filename)), unknownBytes);
});

test('private URLs and invalid permissions are rejected before network access', async context => {
  const { downloads, server } = await fixture(context, { bytes: Buffer.from('x') });
  const owner = plugin();
  await assert.rejects(downloads.probe(owner, { url: 'http://downloads.example/file' }), /HTTPS/);
  await assert.rejects(downloads.probe(owner, { url: 'https://127.0.0.1/file' }), /私有网络/);
  await assert.rejects(downloads.probe(plugin('local.none', null), { url: 'https://downloads.example/file' }), /未授权/);
  await assert.rejects(downloads.start(owner, { url: 'https://downloads.example/file', headers: { Authorization: 'secret' } }), /请求无效/);
  await assert.rejects(downloads.start(owner, { url: 'https://downloads.example/file', concurrency: 5 }), /1 到 4/);
  assert.equal(server.stats.gets, 0);
});

test('task IDs and action arguments are validated without throwing internal type errors', async context => {
  const { downloads } = await fixture(context, { bytes: Buffer.from('validated') });
  const owner = plugin();
  const started = await downloads.start(owner, { url: 'https://downloads.example/validate.bin' });
  await assert.rejects(downloads.get(owner, { id: null }), /任务不可用/);
  await assert.rejects(downloads.pause(owner, { id: started.id, unexpected: true }), /任务不可用/);
  await assert.rejects(downloads.resume(owner, { id: 'not-a-task' }), /任务不可用/);
  await waitFor(downloads, owner, started.id);
});

test('redirects are validated per hop and successful redirects keep segmented downloads', async context => {
  const bytes = Buffer.alloc(96 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31) % 251;
  const finalServer = fixtureServer(bytes, { minimumSegmentBytes: 1, delayMs: 1, chunkSize: 1024 });
  const calls = [];
  const request = async (address, options = {}) => {
    calls.push(address);
    const pathname = new URL(address).pathname;
    if (pathname === '/insecure') return new Response(null, { status: 302, headers: { location: 'http://downloads.example/final.bin' } });
    if (pathname === '/private') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/final.bin' } });
    if (pathname === '/loop') return new Response(null, { status: 307, headers: { location: '/loop' } });
    if (pathname === '/start') return new Response(null, { status: 302, headers: { location: '/final.bin' } });
    return finalServer.request(address, options);
  };
  const { downloads, directory } = await fixture(context, { server: { request, stats: finalServer.stats }, minimumSegmentBytes: 1 });
  const owner = plugin();
  await assert.rejects(downloads.probe(owner, { url: 'https://downloads.example/insecure' }), /HTTPS/);
  await assert.rejects(downloads.probe(owner, { url: 'https://downloads.example/private' }), /私有网络/);
  await assert.rejects(downloads.probe(owner, { url: 'https://downloads.example/loop' }), /重定向无效/);
  const loopCalls = calls.filter(address => address === 'https://downloads.example/loop').length;
  assert.equal(loopCalls, 8);
  const started = await downloads.start(owner, { url: 'https://downloads.example/start', concurrency: 4 });
  const completed = await waitFor(downloads, owner, started.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.mode, 'segmented');
  assert.equal(completed.hostname, 'downloads.example');
  assert.deepEqual(await readFile(path.join(directory, completed.filename)), bytes);
});

test('completed records can be removed without deleting files, while uninstall keeps files and removes partials', async context => {
  const bytes = Buffer.from('completed-file'.repeat(4096));
  const { downloads, directory } = await fixture(context, { bytes, minimumSegmentBytes: 1, delayMs: 2, chunkSize: 1024 });
  const owner = plugin();
  const quick = await downloads.start(owner, { url: 'https://downloads.example/completed.bin', concurrency: 2 });
  const completed = await waitFor(downloads, owner, quick.id);
  assert.equal(completed.status, 'completed');
  const completedPath = path.join(directory, completed.filename);
  await downloads.remove(owner, { id: completed.id });
  assert.equal((await downloads.list(owner)).length, 0);
  assert.deepEqual(await readFile(completedPath), bytes);

  const slow = await downloads.start(owner, { url: 'https://downloads.example/partial.bin', concurrency: 2 });
  await waitForBytes(downloads, owner, slow.id, 1024);
  const paused = await downloads.pause(owner, { id: slow.id });
  assert.equal(paused.status, 'paused');
  const partial = path.join(directory, '.' + slow.id + '.part');
  assert.equal((await lstat(partial)).isFile(), true);
  const preserved = await downloads.start(owner, { url: 'https://downloads.example/preserved.bin', concurrency: 1 });
  const preservedDone = await waitFor(downloads, owner, preserved.id);
  const preservedPath = path.join(directory, preservedDone.filename);
  await downloads.forget(owner);
  assert.equal((await downloads.list(owner)).length, 0);
  await assert.rejects(lstat(partial), error => error.code === 'ENOENT');
  assert.deepEqual(await readFile(preservedPath), bytes);
});

test('stopping a caller pauses its work and invalidates its directory grants', async context => {
  const bytes = Buffer.from('stop-owner'.repeat(32768));
  const { downloads, directory } = await fixture(context, { bytes, minimumSegmentBytes: 1, delayMs: 2, chunkSize: 1024 });
  const owner = plugin();
  const selected = await downloads.pickDirectory(owner);
  assert.ok(selected?.token);
  const started = await downloads.start(owner, {
    url: 'https://downloads.example/stop.bin',
    directoryToken: selected.token,
    concurrency: 2,
  });
  await waitForBytes(downloads, owner, started.id, 1024);
  await downloads.stopOwner(owner.id);
  const stopped = await task(downloads, owner, started.id);
  assert.equal(stopped.status, 'paused');
  assert.match(stopped.error, /已停用/);
  await assert.rejects(
    downloads.resume(owner, { id: started.id, directoryToken: selected.token }),
    /授权已失效/,
  );
  assert.ok(directory);
});

test('symlinked partial files and replaced directories never redirect writes', async context => {
  const bytes = Buffer.from('symlink-safety'.repeat(32768));
  const { downloads, directory } = await fixture(context, { bytes, minimumSegmentBytes: 1, delayMs: 2, chunkSize: 1024 });
  const owner = plugin();
  const started = await downloads.start(owner, { url: 'https://downloads.example/symlink.bin', concurrency: 2 });
  await waitForBytes(downloads, owner, started.id, 1024);
  await downloads.pause(owner, { id: started.id });
  const partial = path.join(directory, '.' + started.id + '.part');
  const movedPart = partial + '.moved';
  await rename(partial, movedPart);
  await symlink(movedPart, partial, 'file');
  await downloads.resume(owner, { id: started.id });
  const stopped = await waitFor(downloads, owner, started.id, ['paused', 'failed']);
  assert.equal(stopped.status, 'paused');
  assert.match(stopped.error, /临时文件不可用/);
});

test('manifest and SDK expose the downloads contract at API 1.9', async () => {
  assert.equal(API_VERSION, '1.9.0');
  const base = {
    name: 'fixture',
    version: '0.1.0',
    commerce: {
      manifestVersion: 1,
      id: 'local.downloader',
      title: 'Downloader',
      description: '',
      api: '^1.8.0',
      ui: 'ui/index.html',
      permissions: { downloads: 'use' },
    },
  };
  assert.equal(validateManifest(base).permissions.downloads, 'use');
  assert.equal(validateManifest({
    ...base,
    commerce: { ...base.commerce, id: 'official.downloader', permissions: { downloads: 'manage' } },
  }).permissions.downloads, 'manage');
  assert.throws(() => validateManifest({
    ...base,
    commerce: { ...base.commerce, permissions: { downloads: 'write' } },
  }), /下载权限无效/);

  const calls = [];
  const client = createPluginClient({
    invoke: async (method, args) => {
      calls.push([method, args]);
      return method;
    },
    onDispose: () => () => {},
  });
  await client.downloads.probe({ url: 'https://downloads.example/file' });
  await client.downloads.start({ url: 'https://downloads.example/file', concurrency: 2 });
  await client.downloads.list();
  await client.downloads.resume('task-id', { directoryToken: 'directory-token' });
  await client.downloads.reveal('task-id');
  assert.deepEqual(calls, [
    ['downloads.probe', { url: 'https://downloads.example/file' }],
    ['downloads.start', { url: 'https://downloads.example/file', concurrency: 2 }],
    ['downloads.list', {}],
    ['downloads.resume', { id: 'task-id', directoryToken: 'directory-token' }],
    ['downloads.reveal', { id: 'task-id' }],
  ]);
});
