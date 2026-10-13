import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { downloadArtifact, downloadUpdateArchive, cachedFile, parseBlockmap, planDelta, pruneCache, pruneUpdateCaches, validateArtifact } from '../../desktop/update-download.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const artifact = (bytes, name = 'update.zip') => ({ url: `https://github.com/ZhiPenTu/LabelEdit/releases/download/v0.2.4/${name}`, size: bytes.length, sha256: digest(bytes) });
const mapOf = blocks => gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: blocks.map(b => b.length), checksums: blocks.map(digest) }] }));
async function fixture(t) {
 const cache = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-download-'));
 const routes = new Map(), requests = []; let ignoreRange = false;
 const server = createServer((req, res) => {
  const bytes = routes.get(req.url); requests.push({ url: req.url, range: req.headers.range });
  if (!bytes) { res.writeHead(404).end(); return; }
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
  if (range && !ignoreRange) {
   const start = Number(range[1]), end = Number(range[2]);
   if (end >= bytes.length) { res.writeHead(416).end(); return; }
   res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 }); res.end(bytes.subarray(start, end + 1));
  } else { res.writeHead(200, { 'content-length': bytes.length }); res.end(bytes); }
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(cache, { recursive: true, force: true }); });
 return { cache, requests, routes, ignore: () => { ignoreRange = true; }, options: { fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options) }, add(bytes, name) { const item = artifact(bytes, name); routes.set(new URL(item.url).pathname, bytes); return item; } };
}

test('full download verifies bytes and reuses a validated cache with zero HTTP requests', async t => {
 const f = await fixture(t), bytes = Buffer.alloc(10000, 3), item = f.add(bytes);
 const states = []; const file = await downloadArtifact(item, f.cache, state => states.push(state), f.options);
 assert.deepEqual(await readFile(file), bytes); assert.equal(states.at(-1).progress, 100);
 f.requests.length = 0;
 await downloadArtifact(item, f.cache, state => states.push(state), f.options);
 assert.equal(f.requests.length, 0); assert.equal(states.at(-1).mode, 'cached');
 await writeFile(file, 'damaged'); await downloadArtifact(item, f.cache, () => {}, f.options);
 assert.equal(f.requests.length, 1);
});

test('interrupted downloads resume with an exact HTTP Range; servers ignoring Range safely restart', async t => {
 const f = await fixture(t), bytes = Buffer.alloc(300000, 8), item = f.add(bytes);
 const controller = new AbortController();
 await assert.rejects(downloadArtifact(item, f.cache, state => { if (state.transferred > 0) controller.abort(new Error('stopped')); }, { ...f.options, signal: controller.signal }), /stopped/);
 const partial = cachedFile(f.cache, item) + '.part', size = (await stat(partial)).size;
 assert.ok(size > 0 && size < bytes.length);
 f.requests.length = 0;
 await downloadArtifact(item, f.cache, () => {}, f.options);
 assert.equal(f.requests[0].range, `bytes=${size}-${bytes.length - 1}`);
 assert.deepEqual(await readFile(cachedFile(f.cache, item)), bytes);
 await rm(cachedFile(f.cache, item)); await writeFile(partial, bytes.subarray(0, 20)); f.ignore();
 const states = []; f.requests.length = 0;
 await downloadArtifact(item, f.cache, state => states.push(state), f.options);
 assert.equal(f.requests.length, 2); assert.ok(states.some(state => state.fallbackReason));
 assert.deepEqual(await readFile(cachedFile(f.cache, item)), bytes);
});

test('damaged or overlong downloads never become a validated cache entry', async t => {
 const f = await fixture(t), item = f.add(Buffer.from('payload'));
 await assert.rejects(downloadArtifact({ ...item, sha256: '0'.repeat(64) }, f.cache, () => {}, f.options), /校验失败/);
 await assert.rejects(stat(cachedFile(f.cache, { ...item, sha256: '0'.repeat(64) })));
 await assert.rejects(downloadArtifact({ ...item, url: 'https://evil.example/update' }, f.cache), /无效/);
});

test('real range requests download only changed blocks and reconstruct the exact target archive', async t => {
 const f = await fixture(t), oldBlocks = [Buffer.alloc(1000, 1), Buffer.alloc(2000, 2), Buffer.alloc(1000, 3)];
 const newBlocks = [oldBlocks[2], Buffer.alloc(600, 4), oldBlocks[0], oldBlocks[1]];
 const old = f.add(Buffer.concat(oldBlocks), 'old.zip'); old.blockmap = f.add(mapOf(oldBlocks), 'old.zip.blockmap');
 const next = f.add(Buffer.concat(newBlocks), 'next.zip'); next.blockmap = f.add(mapOf(newBlocks), 'next.zip.blockmap');
 await downloadUpdateArchive(old, f.cache, () => {}, f.options); f.requests.length = 0;
 const states = []; const file = await downloadUpdateArchive(next, f.cache, state => states.push(state), f.options);
 assert.deepEqual(await readFile(file), Buffer.concat(newBlocks));
 assert.deepEqual(f.requests.filter(r => r.url.endsWith('/next.zip')), [{ url: new URL(next.url).pathname, range: 'bytes=1000-1599' }]);
 assert.equal(states.at(-1).total, 600); assert.equal(states.at(-1).reusedBytes, 4000);
});

test('a corrupt baseline or unavailable byte ranges falls back to full download without activating corrupt output', async t => {
 const f = await fixture(t), blocks = [Buffer.alloc(1000, 1), Buffer.alloc(1000, 2)];
 const old = f.add(Buffer.concat(blocks), 'old.zip'); old.blockmap = f.add(mapOf(blocks), 'old.zip.blockmap');
 const changed = [blocks[0], Buffer.alloc(100, 3)], next = f.add(Buffer.concat(changed), 'next.zip'); next.blockmap = f.add(mapOf(changed), 'next.zip.blockmap');
 await downloadUpdateArchive(old, f.cache, () => {}, f.options); f.ignore();
 const states = []; await downloadUpdateArchive(next, f.cache, state => states.push(state), f.options);
 assert.ok(states.some(s => s.fallbackReason?.includes('差量下载不可用')));
 assert.deepEqual(await readFile(cachedFile(f.cache, next)), Buffer.concat(changed));
 await writeFile(cachedFile(f.cache, next), 'corrupt');
 const third = f.add(Buffer.concat(blocks), 'third.zip'); third.blockmap = f.add(mapOf(blocks), 'third.zip.blockmap');
 await rm(cachedFile(f.cache, third));
 await downloadUpdateArchive(third, f.cache, () => {}, f.options);
 assert.deepEqual(await readFile(cachedFile(f.cache, third)), Buffer.concat(blocks));
});

test('invalid blockmaps are bounded and cache cleanup preserves only needed complete artifacts', async t => {
 const f = await fixture(t);
 assert.throws(() => parseBlockmap(mapOf([Buffer.from('a')]), 2), /不匹配/);
 assert.throws(() => parseBlockmap(Buffer.from('not gzip'), 1));
 assert.deepEqual(planDelta([{ start: 0, size: 1, checksum: 'a' }], [{ start: 0, size: 2, checksum: 'a' }]), [{ copy: false, start: 0, size: 2 }]);
 const keep = 'a'.repeat(64), stale = 'b'.repeat(64);
 await writeFile(path.join(f.cache, keep + '.bin'), 'keep'); await writeFile(path.join(f.cache, stale + '.bin'), 'stale');
 await pruneCache(f.cache, [keep]); await assert.rejects(stat(path.join(f.cache, stale + '.bin'))); assert.equal((await readFile(path.join(f.cache, keep + '.bin'))).toString(), 'keep');
});

test('interrupted differential reconstruction resumes at the remaining changed byte range', async t => {
 const f = await fixture(t), shared = Buffer.alloc(100000, 1), oldBlocks = [shared, Buffer.alloc(100000, 2)];
 const old = f.add(Buffer.concat(oldBlocks), 'old.zip'); old.blockmap = f.add(mapOf(oldBlocks), 'old.zip.blockmap');
 const nextBlocks = [shared, Buffer.alloc(300000, 3), shared], next = f.add(Buffer.concat(nextBlocks), 'next.zip'); next.blockmap = f.add(mapOf(nextBlocks), 'next.zip.blockmap');
 await downloadUpdateArchive(old, f.cache, () => {}, f.options);
 const controller = new AbortController();
 await assert.rejects(downloadUpdateArchive(next, f.cache, state => { if (state.transferred > 0) controller.abort(new Error('interrupted')); }, { ...f.options, signal: controller.signal }), /interrupted/);
 const written = (await stat(cachedFile(f.cache, next) + '.delta')).size; assert.ok(written > shared.length && written < next.size);
 f.requests.length = 0;
 const file = await downloadUpdateArchive(next, f.cache, () => {}, f.options);
 assert.deepEqual(await readFile(file), Buffer.concat(nextBlocks));
 assert.equal(f.requests.find(r => r.url.endsWith('/next.zip')).range, `bytes=${written}-399999`);
});

test('incorrect blockmap reuse is caught by the final hash and safely falls back to full download', async t => {
 const f = await fixture(t), blocks = [Buffer.alloc(1000, 1), Buffer.alloc(1000, 2)];
 const old = f.add(Buffer.concat(blocks), 'old.zip'); old.blockmap = f.add(mapOf(blocks), 'old.zip.blockmap');
 await downloadUpdateArchive(old, f.cache, () => {}, f.options);
 const next = f.add(Buffer.alloc(2000, 4), 'next.zip'); next.blockmap = f.add(mapOf(blocks), 'next.zip.blockmap');
 const states = []; await downloadUpdateArchive(next, f.cache, s => states.push(s), f.options);
 assert.ok(states.some(s => s.fallbackReason?.includes('差量下载不可用')));
 assert.deepEqual(await readFile(cachedFile(f.cache, next)), Buffer.alloc(2000, 4));
});

test('validateArtifact accepts releases from both LabelEdit and qingzuo-desktop repositories', () => {
  const sha256 = 'a'.repeat(64);
  assert.doesNotThrow(() => validateArtifact({ url: 'https://github.com/ZhiPenTu/LabelEdit/releases/download/v0.2.7/app.zip', sha256, size: 100 }));
  assert.doesNotThrow(() => validateArtifact({ url: 'https://github.com/ZhiPenTu/qingzuo-desktop/releases/download/v0.2.8/app.zip', sha256, size: 100 }));
  assert.throws(() => validateArtifact({ url: 'https://github.com/Other/qingzuo-desktop/releases/download/v0.2.8/app.zip', sha256, size: 100 }));
  assert.throws(() => validateArtifact({ url: 'https://malicious.example/app.zip', sha256, size: 100 }));
});

test('pruneUpdateCaches safely removes stale archives and components while preserving baseline and active hashes', async t => {
  const f = await fixture(t);
  const updatesDir = f.cache;
  const archivesDir = path.join(updatesDir, 'archives');
  const componentsDir = path.join(updatesDir, 'components');
  await mkdir(archivesDir, { recursive: true });
  await mkdir(componentsDir, { recursive: true });

  const activeHash = '1'.repeat(64);
  const baseHash = '2'.repeat(64);
  const baseMapHash = '3'.repeat(64);
  const staleArchive = '4'.repeat(64);
  const staleComponent = '5'.repeat(64);

  await writeFile(path.join(archivesDir, 'baseline.json'), JSON.stringify({
    sha256: baseHash,
    blockmap: { sha256: baseMapHash }
  }));
  await writeFile(path.join(archivesDir, baseHash + '.bin'), 'base');
  await writeFile(path.join(archivesDir, baseMapHash + '.bin'), 'basemap');
  await writeFile(path.join(archivesDir, activeHash + '.bin'), 'active');
  await writeFile(path.join(archivesDir, staleArchive + '.bin'), 'stale-archive-content');
  await writeFile(path.join(componentsDir, staleComponent + '.bin'), 'stale-comp-content');

  const { freedBytes } = await pruneUpdateCaches(updatesDir, [activeHash]);
  assert.ok(freedBytes > 0);

  // Protected files remain
  assert.equal((await readFile(path.join(archivesDir, baseHash + '.bin'))).toString(), 'base');
  assert.equal((await readFile(path.join(archivesDir, baseMapHash + '.bin'))).toString(), 'basemap');
  assert.equal((await readFile(path.join(archivesDir, activeHash + '.bin'))).toString(), 'active');

  // Stale files are deleted
  await assert.rejects(stat(path.join(archivesDir, staleArchive + '.bin')));
  await assert.rejects(stat(path.join(componentsDir, staleComponent + '.bin')));
});
