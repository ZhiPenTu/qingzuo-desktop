import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLI_PROXY_REPOSITORY = 'router-for-me/CLIProxyAPI';
export const CLI_PROXY_MANIFEST = new URL('../desktop/upstream/cli-proxy.json', import.meta.url);
const platforms = { 'darwin-arm64': 'darwin_aarch64.tar.gz', 'win32-x64': 'windows_amd64.zip' };
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digestPattern = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function caseInsensitiveDirectory(directory) {
  if (process.platform === 'win32') return true;
  for (const name of await readdir(directory)) {
    if (!/[a-zA-Z]/.test(name)) continue;
    const variant = name.replace(/[a-zA-Z]/, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
    const original = await lstat(path.join(directory, name));
    try {
      const alternate = await lstat(path.join(directory, variant));
      return original.dev === alternate.dev && original.ino === alternate.ino;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  // Empty directories cannot expose their case behavior without creating a
  // probe. Conservatively reject case-only output aliases on macOS.
  return process.platform === 'darwin';
}

// Used by every upgrade report writer before it touches protected inputs.
// realpath resolves existing file aliases and symlinked parent directories;
// missing output suffixes inherit the containing directory's case behavior.
export async function canonicalOutputPath(filename) {
  const absolute = filename instanceof URL ? fileURLToPath(filename) : path.resolve(filename);
  let cursor = absolute; const missing = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      const foldCase = missing.length && await caseInsensitiveDirectory(existing);
      const result = path.join(existing, ...missing.map(part => foldCase ? part.toLowerCase() : part));
      return process.platform === 'win32' ? result.toLowerCase() : result;
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(cursor) === cursor) throw error;
      missing.unshift(path.basename(cursor)); cursor = path.dirname(cursor);
    }
  }
}

export async function assertDistinctOutputPaths(filenames) {
  const resolved = await Promise.all(filenames.map(canonicalOutputPath));
  if (new Set(resolved).size !== resolved.length) throw new Error('CLIProxyAPI pin, candidate and report must use separate files.');
  return resolved;
}

function stableVersion(value) {
  const version = String(value).replace(/^v/, '');
  if (!versionPattern.test(version)) throw new Error('CLIProxyAPI version must be a stable numeric release (for example 8.0.23).');
  return version;
}
function artifactName(version, target) { return `CLIProxyAPI_${version}_${platforms[target]}`; }
export function cliProxyAssetUrl(version, name) {
  return `https://github.com/${CLI_PROXY_REPOSITORY}/releases/download/v${stableVersion(version)}/${name}`;
}
export function validateCliProxyManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.repository !== CLI_PROXY_REPOSITORY) throw new Error('Invalid CLIProxyAPI manifest repository or schema.');
  const version = stableVersion(manifest.version);
  if (manifest.version !== version || manifest.tag !== 'v' + version || manifest.releaseUrl !== `https://github.com/${CLI_PROXY_REPOSITORY}/releases/tag/v${version}`) throw new Error('CLIProxyAPI release metadata does not match the version.');
  if (manifest.checksums?.name !== 'checksums.txt' || !digestPattern.test(manifest.checksums.sha256)) throw new Error('CLIProxyAPI checksum metadata is invalid.');
  if (Object.keys(manifest.artifacts || {}).sort().join(',') !== Object.keys(platforms).sort().join(',')) throw new Error('CLIProxyAPI manifest must contain both supported targets.');
  for (const target of Object.keys(platforms)) {
    const artifact = manifest.artifacts[target];
    if (artifact?.name !== artifactName(version, target) || !digestPattern.test(artifact.sha256)) throw new Error(`Invalid CLIProxyAPI artifact for ${target}.`);
  }
  return manifest;
}
export async function readCliProxyManifest(filename = CLI_PROXY_MANIFEST) {
  return validateCliProxyManifest(JSON.parse(await readFile(filename, 'utf8')));
}
export function parseCliProxyChecksums(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-fA-F0-9]{64})\s+[ *]?([^\s/\\]+)$/.exec(line);
    if (!match || entries.has(match[2])) throw new Error('Invalid or duplicate entry in official CLIProxyAPI checksums.txt.');
    entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}
export function verifyCliProxyArtifact(bytes, artifact) {
  if (hash(bytes) !== artifact.sha256) throw new Error(`CLIProxyAPI SHA-256 mismatch: ${artifact.name}.`);
  return bytes;
}
async function download(url, { request, limit, headers = {}, onProgress = () => {} }) {
  const response = await request(url, { headers, signal: AbortSignal.timeout(120000), redirect: 'follow' });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`CLIProxyAPI upstream request failed (${response.status}): ${url}`); }
  const length = response.headers.get('content-length');
  const total = length !== null && Number.isSafeInteger(Number(length)) ? Number(length) : 0;
  onProgress({ transferred: 0, total });
  if (length !== null && Number(length) > limit) { await response.body?.cancel(); throw new Error('CLIProxyAPI upstream response exceeds the download limit.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('CLIProxyAPI upstream response is empty.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) { await reader.cancel(); throw new Error('CLIProxyAPI upstream response exceeds the download limit.'); }
      onProgress({ transferred: size, total });
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
function requiredAsset(release, name, version) {
  const matches = release.assets.filter(asset => asset.name === name);
  if (matches.length !== 1 || matches[0].browser_download_url !== cliProxyAssetUrl(version, name)) throw new Error(`Missing, duplicate or unofficial CLIProxyAPI asset: ${name}.`);
  return matches[0];
}
export async function inspectCliProxyRelease({ version, request = fetch } = {}) {
  const desired = version === undefined ? null : stableVersion(version);
  const endpoint = `https://api.github.com/repos/${CLI_PROXY_REPOSITORY}/releases/${desired ? 'tags/v' + desired : 'latest'}`;
  const apiBytes = await download(endpoint, { request, limit: 2 * 1024 ** 2, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'qingzuo-upstream-check' } });
  const release = JSON.parse(apiBytes.toString('utf8'));
  if (release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error('CLIProxyAPI must be an official published stable release.');
  const resolved = stableVersion(release.tag_name);
  if (release.tag_name !== 'v' + resolved || (desired && desired !== resolved)) throw new Error('CLIProxyAPI release tag does not match the requested version.');
  const checksumAsset = requiredAsset(release, 'checksums.txt', resolved);
  for (const target of Object.keys(platforms)) requiredAsset(release, artifactName(resolved, target), resolved);
  const checksumBytes = await download(checksumAsset.browser_download_url, { request, limit: 1024 ** 2 });
  const checksums = parseCliProxyChecksums(checksumBytes.toString('utf8'));
  const artifacts = Object.fromEntries(Object.keys(platforms).map(target => {
    const name = artifactName(resolved, target), sha256 = checksums.get(name);
    if (!sha256) throw new Error(`Official CLIProxyAPI checksum is missing: ${name}.`);
    return [target, { name, sha256 }];
  }));
  return validateCliProxyManifest({ schemaVersion: 1, repository: CLI_PROXY_REPOSITORY, version: resolved, tag: release.tag_name, releaseUrl: `https://github.com/${CLI_PROXY_REPOSITORY}/releases/tag/${release.tag_name}`, checksums: { name: 'checksums.txt', sha256: hash(checksumBytes) }, artifacts });
}
async function atomicJson(filename, value) {
  const destination = filename instanceof URL ? fileURLToPath(filename) : path.resolve(filename);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = destination + `.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n'); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
}
export async function verifiedCliProxyDownload(manifest, target, { request = fetch, cacheDirectory = '.cache/cli-proxy', onProgress = () => {} } = {}) {
  validateCliProxyManifest(manifest);
  const artifact = manifest.artifacts[target];
  if (!artifact) throw new Error(`CLIProxyAPI does not support target ${target}.`);
  const filename = path.resolve(cacheDirectory, artifact.name);
  let bytes;
  try { bytes = await readFile(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes) { onProgress({ transferred: bytes.length, total: bytes.length }); return { bytes: verifyCliProxyArtifact(bytes, artifact), filename, cached: true }; }
  bytes = verifyCliProxyArtifact(await download(cliProxyAssetUrl(manifest.version, artifact.name), { request, limit: 128 * 1024 ** 2, onProgress }), artifact);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes);
  return { bytes, filename, cached: false };
}
export function validateCliProxyCompatibility(evidence, manifest) {
  if (!evidence || evidence.schemaVersion !== 1 || evidence.component !== 'CLIProxyAPI' || evidence.version !== manifest.version) throw new Error('CLIProxyAPI validation report does not match the candidate version.');
  for (const target of Object.keys(platforms)) {
    if (evidence.artifacts?.[target] !== manifest.artifacts[target].sha256 || evidence.checks?.[target] !== 'passed') throw new Error(`CLIProxyAPI validation requires matching artifact and passed smoke test: ${target}.`);
  }
  if (evidence.checks?.proxyContracts !== 'passed') throw new Error('CLIProxyAPI validation requires passed proxy contract tests.');
  return evidence;
}
export async function updateCliProxy({ mode = 'check', version, request = fetch, manifestPath = CLI_PROXY_MANIFEST, cacheDirectory = '.cache/cli-proxy', candidatePath = '.cache/upstream/cli-proxy-candidate.json', reportPath = '.cache/upstream/cli-proxy-report.json', validationReportPath, now = () => new Date().toISOString() } = {}) {
  if (!['validate-pin', 'check', 'prepare', 'apply'].includes(mode)) throw new Error('Unknown CLIProxyAPI update mode.');
  await assertDistinctOutputPaths([manifestPath, candidatePath, reportPath, ...(validationReportPath ? [validationReportPath] : [])]);
  const pinned = await readCliProxyManifest(manifestPath);
  if (mode === 'validate-pin') {
    const { PROXY_VERSION } = await import('../desktop/ai-proxy.mjs');
    if (PROXY_VERSION !== pinned.version) throw new Error('CLIProxyAPI runtime version does not match the pinned manifest.');
    const report = { schemaVersion: 1, component: 'CLIProxyAPI', checkedAt: now(), mode, pinnedVersion: pinned.version, releaseUrl: pinned.releaseUrl, artifacts: pinned.artifacts, pinValidated: true, archiveVerification: 'pending', pinApplied: false };
    await atomicJson(reportPath, report); return report;
  }
  const candidate = await inspectCliProxyRelease({ version, request });
  // Never silently accept an upstream replacement of an already pinned release.
  if (candidate.version === pinned.version && JSON.stringify(candidate) !== JSON.stringify(pinned)) throw new Error('Official CLIProxyAPI metadata changed for the pinned version; investigate before updating.');
  if (mode === 'apply') {
    if (!validationReportPath) throw new Error('CLIProxyAPI --apply requires --validation-report with passed contract and both platform smoke tests.');
    validateCliProxyCompatibility(JSON.parse(await readFile(validationReportPath, 'utf8')), candidate);
  }
  const verified = [];
  if (mode !== 'check') {
    for (const target of Object.keys(platforms)) {
      const result = await verifiedCliProxyDownload(candidate, target, { request, cacheDirectory });
      verified.push({ target, name: candidate.artifacts[target].name, sha256: candidate.artifacts[target].sha256, cached: result.cached });
    }
    // Both artifacts must verify before any candidate or tracked pin is written.
    await atomicJson(candidatePath, candidate);
    if (mode === 'apply') await atomicJson(manifestPath, candidate);
  }
  const report = { schemaVersion: 1, component: 'CLIProxyAPI', checkedAt: now(), mode, pinnedVersion: pinned.version, candidateVersion: candidate.version, updateAvailable: candidate.version !== pinned.version, releaseUrl: candidate.releaseUrl, checksums: candidate.checksums, artifacts: candidate.artifacts, archiveVerification: mode === 'check' ? 'pending' : 'passed', verified, pinApplied: mode === 'apply', compatibility: mode === 'apply' ? 'passed' : 'pending', validationReportPath: mode === 'apply' ? path.resolve(validationReportPath) : null, candidatePath: mode === 'check' ? null : path.resolve(candidatePath) };
  await atomicJson(reportPath, report);
  return report;
}
function argumentsFor(argv) {
  const options = {}; let selectedMode = false;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (['--validate-pin', '--check', '--prepare', '--apply'].includes(option)) {
      if (selectedMode) throw new Error('Choose exactly one CLIProxyAPI update mode.');
      options.mode = option.slice(2); selectedMode = true;
    } else if (['--version', '--report', '--candidate', '--validation-report'].includes(option)) {
      const value = argv[++index]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
      options[{ '--version': 'version', '--report': 'reportPath', '--candidate': 'candidatePath', '--validation-report': 'validationReportPath' }[option]] = value;
    } else throw new Error(`Unknown CLIProxyAPI update option: ${option}.`);
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await updateCliProxy(argumentsFor(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
