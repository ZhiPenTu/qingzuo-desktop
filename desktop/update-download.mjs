import { createHash } from 'node:crypto';
import { createReadStream, mkdir, open, readFile, rename, rm, stat, writeFile, readdir } from './update-fs.mjs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 ** 3;
export class RangeUnavailable extends Error {}
export function validateArtifact(artifact, limit = MAX_BYTES) {
  if (!artifact || !/^https:\/\/github\.com\/ZhiPenTu\/(?:LabelEdit|qingzuo-desktop)\/releases\/download\/v\d+\.\d+\.\d+\/[A-Za-z0-9._-]+$/.test(artifact.url)
      || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > limit) throw new Error('更新下载信息无效。');
}
export async function withNoAsar(action) {
  const previous = process.noAsar;
  process.noAsar = true;
  try { return await action(); }
  finally { process.noAsar = previous; }
}

export async function safeRm(target) {
  if (!target) return;
  return withNoAsar(async () => {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  });
}

export async function fileDigest(filename) {
  return withNoAsar(async () => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
  });
}
export async function matchesArtifact(filename, artifact) {
  return withNoAsar(async () => {
    try { return (await stat(filename)).size === artifact.size && await fileDigest(filename) === artifact.sha256; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
}
export const cachedFile = (cache, artifact) => path.join(cache, artifact.sha256 + '.bin');
const sizeOf = async filename => { try { return (await stat(filename)).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };

// One bounded HTTP request. Never append a 200 response to a Range request.
// Idle timeout is reset per chunk; cancellation leaves resumable bytes on disk.
async function transfer(artifact, destination, start, end, notify, { fetchImpl = globalThis.fetch, signal } = {}) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer, response, file, received = 0;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('下载超时，可继续下载。')), 60_000); };
  const ranged = start !== 0 || end !== artifact.size;
  try {
    combined.throwIfAborted(); touch();
    response = await fetchImpl(artifact.url, { headers: { 'Accept-Encoding': 'identity', ...(ranged ? { Range: `bytes=${start}-${end - 1}` } : {}) }, signal: combined });
    if (ranged && (response.status === 200 || response.status === 416)) throw new RangeUnavailable('下载服务器暂不支持差量或续传。');
    if (!response.ok || !response.body) throw new Error(`更新下载失败（HTTP ${response.status}），可重试。`);
    if (ranged && (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end - 1}/${artifact.size}`)) throw new RangeUnavailable('下载服务器返回的分段范围不正确。');
    if (!ranged && response.status !== 200) throw new RangeUnavailable('下载响应不完整。');
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== end - start) throw new RangeUnavailable('下载响应大小不正确。');
    file = await open(destination, 'a', 0o600);
    for await (const chunk of response.body) {
      combined.throwIfAborted(); touch(); received += chunk.length;
      if (received > end - start) throw new RangeUnavailable('下载超过预期大小。');
      let written = 0;
      while (written < chunk.length) written += (await file.write(chunk, written, chunk.length - written)).bytesWritten;
      notify(chunk.length);
    }
    if (received !== end - start) throw new Error('连接中断，可继续下载。');
  } catch (error) {
    throw combined.aborted ? combined.reason : error;
  } finally { clearTimeout(timer); await file?.close(); await response?.body?.cancel().catch(() => {}); }
}

export async function downloadArtifact(artifact, cache, notify = () => {}, options = {}) {
  validateArtifact(artifact); await mkdir(cache, { recursive: true, mode: 0o700 });
  const filename = cachedFile(cache, artifact), partial = filename + '.part';
  if (await matchesArtifact(filename, artifact)) { notify({ mode: 'cached', progress: 100, transferred: 0, total: 0, reusedBytes: artifact.size }); return filename; }
  await safeRm(filename);
  let offset = await sizeOf(partial);
  if (offset > artifact.size) { await safeRm(partial); offset = 0; }
  let transferred = offset;
  const progress = count => { transferred += count; notify({ mode: offset ? 'resume' : 'full', progress: transferred / artifact.size * 100, transferred, total: artifact.size, reusedBytes: 0 }); };
  progress(0);
  try {
    if (offset < artifact.size) await transfer(artifact, partial, offset, artifact.size, progress, options);
  } catch (error) {
    if (!(error instanceof RangeUnavailable)) throw error;
    await safeRm(partial); offset = 0; transferred = 0;
    notify({ fallbackReason: '服务器不支持续传，正在重新下载完整更新。' });
    progress(0); await transfer(artifact, partial, 0, artifact.size, progress, options);
  }
  if (!await matchesArtifact(partial, artifact)) { await safeRm(partial); throw new Error('安装包完整性校验失败，请重新下载。'); }
  await rename(partial, filename); return filename;
}

export function parseBlockmap(bytes, size) {
  const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: 32 * 1024 ** 2 }).toString());
  const file = value?.files?.[0];
  if (value?.version !== '2' || !Array.isArray(value.files) || value.files.length !== 1 || file?.offset !== 0 || !Array.isArray(file.sizes) || !Array.isArray(file.checksums)
      || file.sizes.length > 200000 || file.sizes.length !== file.checksums.length) throw new Error('差量索引无效。');
  let total = 0;
  const blocks = file.sizes.map((length, index) => {
    const checksum = file.checksums[index];
    if (!Number.isSafeInteger(length) || length <= 0 || typeof checksum !== 'string' || !checksum.length || checksum.length > 128) throw new Error('差量数据块无效。');
    const block = { start: total, size: length, checksum }; total += length; return block;
  });
  if (total !== size) throw new Error('差量索引大小不匹配。');
  return blocks;
}
export function planDelta(previous, next) {
  const old = new Map(previous.map(block => [block.checksum + ':' + block.size, block.start]));
  const plan = [];
  for (const block of next) {
    const offset = old.get(block.checksum + ':' + block.size);
    const operation = { copy: offset !== undefined, start: offset ?? block.start, size: block.size };
    const last = plan.at(-1);
    if (last && last.copy === operation.copy && last.start + last.size === operation.start) last.size += operation.size;
    else plan.push(operation);
  }
  return plan;
}

async function reconstruct(artifact, base, plan, cache, notify, options) {
  const filename = cachedFile(cache, artifact), partial = filename + '.delta';
  let written = await sizeOf(partial);
  if (written > artifact.size) { await safeRm(partial); written = 0; }
  const total = plan.reduce((sum, op) => sum + (op.copy ? 0 : op.size), 0);
  let transferred = 0, outputOffset = 0;
  const emit = () => notify({ mode: 'delta', progress: total ? transferred / total * 100 : 100, transferred, total, reusedBytes: artifact.size - total });
  for (const op of plan) {
    options.signal?.throwIfAborted();
    const completed = Math.min(op.size, Math.max(0, written - outputOffset));
    outputOffset += op.size;
    if (!op.copy) transferred += completed;
    emit();
    if (completed === op.size) continue;
    if (op.copy) {
      const output = await open(partial, 'a', 0o600);
      try {
        for await (const chunk of createReadStream(base, { start: op.start + completed, end: op.start + op.size - 1 })) {
          options.signal?.throwIfAborted();
          let offset = 0; while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten;
        }
      } finally { await output.close(); }
    } else await transfer(artifact, partial, op.start + completed, op.start + op.size, count => { transferred += count; emit(); }, options);
  }
  if (!await matchesArtifact(partial, artifact)) { await safeRm(partial); throw new RangeUnavailable('差量合成校验未通过。'); }
  await rename(partial, filename); return filename;
}

export async function downloadUpdateArchive(artifact, cache, notify, options = {}) {
  validateArtifact(artifact); await mkdir(cache, { recursive: true, mode: 0o700 });
  if (await matchesArtifact(cachedFile(cache, artifact), artifact)) return downloadArtifact(artifact, cache, notify, options);
  let map, base, plan;
  if (artifact.blockmap) {
    try {
      validateArtifact(artifact.blockmap, 16 * 1024 ** 2);
      map = await downloadArtifact(artifact.blockmap, cache, () => {}, options);
      const next = parseBlockmap(await readFile(map), artifact.size);
      base = JSON.parse(await readFile(path.join(cache, 'baseline.json'), 'utf8'));
      validateArtifact(base); validateArtifact(base.blockmap, 16 * 1024 ** 2);
      if (!await matchesArtifact(cachedFile(cache, base), base) || !await matchesArtifact(cachedFile(cache, base.blockmap), base.blockmap)) throw new Error('本地差量缓存不可用。');
      plan = planDelta(parseBlockmap(await readFile(cachedFile(cache, base.blockmap)), base.size), next);
      if (plan.filter(op => !op.copy).reduce((sum, op) => sum + op.size, 0) >= artifact.size * 0.9) plan = null;
    } catch (error) { options.signal?.throwIfAborted(); notify({ fallbackReason: '差量缓存或索引不可用，正在下载完整更新。' }); }
  }
  let filename;
  if (plan) {
    try { filename = await reconstruct(artifact, cachedFile(cache, base), plan, cache, notify, options); }
    catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof RangeUnavailable)) throw error;
      await safeRm(cachedFile(cache, artifact) + '.delta');
      notify({ fallbackReason: '差量下载不可用，已改为完整更新。' });
    }
  }
  filename ??= await downloadArtifact(artifact, cache, notify, options);
  if (map) {
    await writeFile(path.join(cache, 'baseline.tmp'), JSON.stringify(artifact), { mode: 0o600 });
    await rename(path.join(cache, 'baseline.tmp'), path.join(cache, 'baseline.json'));
  }
  await pruneCache(cache, [artifact.sha256, artifact.blockmap?.sha256, base?.sha256, base?.blockmap?.sha256]);
  return filename;
}

// Keep current/previous validated payloads and recent partial downloads; never
// retain an unbounded history of 400 MB archives. Called after a successful job.
export async function pruneCache(cache, keep = [], maxAge = 7 * 86400000) {
  try {
    for (const name of await readdir(cache)) {
      if (!/^[a-f0-9]{64}\.bin(?:\.part|\.delta)?$/.test(name) || keep.includes(name.slice(0, 64))) continue;
      const filename = path.join(cache, name);
      try {
        const info = await stat(filename);
        if (name.endsWith('.bin') || Date.now() - info.mtimeMs > maxAge) await safeRm(filename);
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

export async function pruneUpdateCaches(updatesDir, activeHashes = []) {
  let freed = 0;
  const archivesDir = path.join(updatesDir, 'archives');
  const componentsDir = path.join(updatesDir, 'components');
  const keep = new Set(activeHashes);

  // If a baseline.json exists, protect its referenced archive and blockmap
  try {
    const baselineRaw = await readFile(path.join(archivesDir, 'baseline.json'), 'utf8');
    const base = JSON.parse(baselineRaw);
    if (base?.sha256) keep.add(base.sha256);
    if (base?.blockmap?.sha256) keep.add(base.blockmap.sha256);
  } catch {}

  for (const dir of [archivesDir, componentsDir]) {
    let entries = [];
    try { entries = await readdir(dir); } catch { continue; }
    for (const name of entries) {
      if (!/^[a-f0-9]{64}\.bin(?:\.part|\.delta)?$/.test(name)) continue;
      const hash = name.slice(0, 64);
      if (keep.has(hash)) continue;
      const filename = path.join(dir, name);
      try {
        const info = await stat(filename);
        await safeRm(filename);
        freed += info.size;
      } catch {}
    }
  }
  return { freedBytes: freed };
}
