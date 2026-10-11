import { readFile, writeFile, mkdir, lstat, copyFile, realpath, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import semver from 'semver';
import { canonicalOutputPath } from './update-cli-proxy.mjs';

const metadataFile = 'desktop/upstream/harness.json';
const markerFile = '.harness-candidate.json';
const family = name => /^@deepseek-ai\/dsh(?:-|$)/.test(name);
const cordis = name => /^@deepseek-ai\/cordis(?:-|$)/.test(name);
const exact = value => typeof value === 'string' && semver.valid(value) === value;
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); };
const check = (id, ok, detail) => ({ id, status: ok ? 'passed' : 'failed', detail });
const protectedInputs = ['package.json', 'package-lock.json', 'packages/platform-bundle/package.json', metadataFile, 'desktop/upstream/cli-proxy.json', markerFile];

export async function assertHarnessReportPath(filename, { source, directory, sources = [] }) {
  const output = await canonicalOutputPath(filename);
  for (const root of new Set([source, directory, ...sources].filter(Boolean))) for (const input of protectedInputs) {
    if (output === await canonicalOutputPath(path.join(root, input))) throw new Error('Harness report must not overwrite a protected input: ' + input);
  }
}

const saveReport = async (filename, report, roots) => { await assertHarnessReportPath(filename, roots); await save(filename, report); };

export async function readHarnessState(directory) {
  const [metadata, pkg, lock, bundle] = await Promise.all([
    json(path.join(directory, metadataFile)), json(path.join(directory, 'package.json')),
    json(path.join(directory, 'package-lock.json')), json(path.join(directory, 'packages/platform-bundle/package.json')),
  ]);
  return { metadata, pkg, lock, bundle };
}

// This check intentionally needs no npm registry or installed Harness packages.
// Lock integrity means coherent exact pins + registry SRI records; npm ci is the
// separate gate that actually verifies the downloaded tarballs against those SRI.
export function inspectHarnessState({ metadata, pkg, lock, bundle }) {
  const checks = [], expected = metadata.version;
  checks.push(check('metadata', metadata.schemaVersion === 1 && exact(expected), 'Canonical Harness version must be an exact semver.'));
  const declared = Object.keys(pkg.dependencies ?? {}).filter(family).sort();
  checks.push(check('family-members', JSON.stringify(declared) === JSON.stringify([...metadata.packages].sort()), 'Every direct dsh/dsh-* dependency must be listed in the canonical package family.'));
  checks.push(check('family-production-dependencies', ![...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})].some(family), 'The runtime Harness family must be declared only as exact production dependencies.'));
  checks.push(check('cordis-members', JSON.stringify(Object.keys(pkg.dependencies ?? {}).filter(cordis).sort()) === JSON.stringify([...metadata.cordisPackages].sort()), 'Every direct Cordis sibling must be listed for independent candidate metadata resolution.'));
  checks.push(check('lock-format', lock.lockfileVersion >= 3 && !!lock.packages?.[''], 'npm lockfile v3 with root/workspace records is required.'));
  for (const name of metadata.packages) {
    const wanted = pkg.dependencies?.[name], record = lock.packages?.['node_modules/' + name];
    checks.push(check('direct:' + name, exact(wanted) && wanted === expected && lock.packages?.['']?.dependencies?.[name] === expected && record?.version === expected,
      `${name}: manifest=${wanted}, lock=${record?.version}, required=${expected}`));
  }
  checks.push(check('bundle-peer', bundle.peerDependencies?.['@deepseek-ai/dsh'] === expected && lock.packages?.['packages/platform-bundle']?.peerDependencies?.['@deepseek-ai/dsh'] === expected,
    'The platform bundle peer and its lock workspace record must follow the whole family.'));
  for (const name of metadata.cordisPackages) {
    const wanted = pkg.dependencies?.[name], record = lock.packages?.['node_modules/' + name];
    checks.push(check('cordis-pin:' + name, exact(wanted) && record?.version === wanted && lock.packages?.['']?.dependencies?.[name] === wanted,
      `${name} has its own exact version; it does not share the Harness version.`));
  }
  const relevant = Object.entries(lock.packages ?? {}).filter(([location]) => /(?:^|\/)node_modules\/(?:@deepseek-ai\/|node-addon-require-builtin(?:\/|$|-))/.test(location));
  for (const [location, record] of relevant) {
    const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (family(name)) checks.push(check('resolved-family:' + location, record.version === expected, `${location} must resolve to ${expected}, including nested copies.`));
    if (!record.link) checks.push(check('integrity:' + location, /^https:\/\/registry\.npmjs\.org\//.test(record.resolved ?? '') && /^sha512-[A-Za-z0-9+/]{86}==$/.test(record.integrity ?? ''), `${location} must have an npm registry tarball and SHA-512 SRI.`));
    for (const [section, dependencies] of Object.entries({ dependencies: record.dependencies, peerDependencies: record.peerDependencies })) {
      for (const [dependency, range] of Object.entries(dependencies ?? {})) {
        if (!cordis(dependency) && dependency !== metadata.nativeAdapter.package) continue;
        const resolved = resolveLockPackage(lock, location, dependency);
        const optional = section === 'peerDependencies' && record.peerDependenciesMeta?.[dependency]?.optional;
        checks.push(check('range:' + location + ':' + dependency, (!resolved && optional) || !!resolved && semver.satisfies(resolved.version, range),
          `${location} ${section} ${dependency}@${range}; resolved=${resolved?.version ?? 'absent (optional)'}`));
      }
    }
  }
  const native = metadata.nativeAdapter;
  checks.push(check('native-pin', exact(native.version) && pkg.overrides?.[native.package] === native.version && lock.packages?.['node_modules/' + native.package]?.version === native.version,
    'The native loader override and lock must match the reviewed source version.'));
  checks.push(check('native-source', /^[a-f0-9]{40}$/.test(native.commit ?? '') && /^[a-f0-9]{64}$/.test(native.sha256 ?? ''),
    'The unchanged native source requires a pinned commit and SHA-256.'));
  checks.push(check('native-electron', pkg.devDependencies?.electron === native.electron && lock.packages?.['node_modules/electron']?.version === native.electron,
    `Electron must remain at the reviewed ${native.electron} until native runtime validation is updated.`));
  return { schemaVersion: 1, component: 'harness', version: expected, status: checks.every(item => item.status === 'passed') ? 'checked' : 'failed', checks,
    pending: ['Installed public exports and UI build', 'Old JSONL restore, tool approval and cancel contracts', 'Node and Electron native loader runtime probes', 'Packaged desktop acceptance on macOS 15 / Windows 10'] };
}

function resolveLockPackage(lock, location, name) {
  let cursor = location;
  for (;;) {
    const record = lock.packages?.[(cursor ? cursor + '/' : '') + 'node_modules/' + name];
    if (record) return record;
    if (!cursor) return undefined;
    const next = cursor.lastIndexOf('/node_modules/');
    cursor = next >= 0 ? cursor.slice(0, next) : '';
  }
}

export async function inspectInstalledHarness(directory, { metadata, lock }) {
  directory = await realpath(directory);
  const checks = [], supports = (values, current) => !values?.length || (!values.includes('!' + current) && (values.every(value => value.startsWith('!')) || values.includes(current)));
  for (const [location, record] of Object.entries(lock.packages ?? {})) {
    const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!family(name) && !cordis(name) && !name.startsWith(metadata.nativeAdapter.package)) continue;
    if (record.optional && (!supports(record.os, process.platform) || !supports(record.cpu, process.arch))) continue;
    const packageDirectory = path.join(directory, location);
    try {
      const resolved = await realpath(packageDirectory), relative = path.relative(directory, resolved);
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
        checks.push(check('installed-isolation:' + location, false, `${location} resolves outside the isolated candidate.`)); continue;
      }
      const installed = await json(path.join(packageDirectory, 'package.json'));
      checks.push(check('installed-version:' + location, installed.name === name && installed.version === record.version,
        `${location}: installed=${installed.version}, lock=${record.version}`));
    } catch (error) { checks.push(check('installed-version:' + location, false, `${location}: installed package unavailable (${error.code ?? error.message}).`)); }
  }
  return checks;
}

export function harnessRelease(metadata, packument) {
  const tags = packument['dist-tags'] ?? {}, channel = metadata.channel ?? semver.prerelease(metadata.version)?.[0] ?? 'latest';
  const candidate = tags[channel];
  if (candidate && !semver.valid(candidate)) throw new Error('Registry returned a non-semver channel version.');
  return { current: metadata.version, channel, candidate: candidate ?? null, newer: !!candidate && semver.gt(candidate, metadata.version), tags };
}

export async function npmPackument(name, fetcher = fetch) {
  const response = await fetcher('https://registry.npmjs.org/' + encodeURIComponent(name), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`npm registry ${name}: HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 48 * 1024 ** 2) throw new Error(`npm metadata for ${name} exceeds 48 MiB.`); chunks.push(chunk); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (result.name !== name || !result.versions || typeof result.versions !== 'object') throw new Error(`Invalid npm package metadata for ${name}.`);
  return result;
}

// Cordis siblings have independent release numbers. Select from npm manifests
// using actual candidate dependency/peer ranges, then let npm's solver and the
// resolved lock audit verify the complete transitive graph.
export async function resolveCordisVersions(manifests, directNames, getPackument) {
  const initial = new Map(directNames.map(name => [name, []]));
  const requirements = (target, entries) => {
    for (const manifest of entries) for (const section of ['dependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) if (cordis(name)) {
        if (!semver.validRange(range)) throw new Error(`Unsupported Cordis range ${name}@${range} in ${manifest.name}.`);
        const values = target.get(name) ?? []; values.push({ from: manifest.name, range }); target.set(name, values);
      }
    }
  };
  requirements(initial, manifests);
  const packuments = new Map(); let attempts = 0;
  const choose = async selected => {
    if (++attempts > 10000) throw new Error('Cordis resolution exceeded the review limit; manual dependency review required.');
    const constraints = new Map([...initial].map(([name, values]) => [name, [...values]]));
    requirements(constraints, [...selected.values()]);
    for (const [name, manifest] of selected) if (!(constraints.get(name) ?? []).every(({ range }) => semver.satisfies(manifest.version, range))) return null;
    const next = [...constraints].filter(([name]) => !selected.has(name)).sort((a, b) => b[1].length - a[1].length)[0];
    if (!next) return { selected, constraints };
    const [name, ranges] = next;
    if (!packuments.has(name)) packuments.set(name, await getPackument(name));
    const versions = Object.keys(packuments.get(name).versions).filter(version => semver.valid(version) && ranges.every(({ range }) => semver.satisfies(version, range))).sort(semver.rcompare);
    for (const version of versions) {
      const manifest = packuments.get(name).versions[version];
      if (manifest.name !== name || manifest.version !== version) throw new Error(`Invalid Cordis package manifest ${name}@${version}.`);
      const result = await choose(new Map([...selected, [name, manifest]]));
      if (result) return result;
    }
    return null;
  };
  const result = await choose(new Map());
  if (!result) throw new Error('No compatible Cordis sibling versions satisfy the candidate npm metadata.');
  return { versions: Object.fromEntries([...result.selected].filter(([name]) => directNames.includes(name)).map(([name, item]) => [name, item.version])), constraints: Object.fromEntries(result.constraints) };
}

export function isolatedEnvironment(directory, inherited = process.env) {
  const validation = path.join(directory, '.validation');
  const env = { PATH: inherited.PATH, HOME: path.join(validation, 'home'), TMPDIR: path.join(validation, 'tmp'), TEMP: path.join(validation, 'tmp'), TMP: path.join(validation, 'tmp'),
    LANG: inherited.LANG ?? 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', CI: '1', npm_config_registry: 'https://registry.npmjs.org',
    npm_config_userconfig: path.join(validation, 'empty.npmrc'), npm_config_cache: path.join(validation, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_ignore_scripts: 'true' };
  // Required by Windows process creation, without inheriting API keys or profiles.
  for (const name of ['SystemRoot', 'COMSPEC', 'PATHEXT', 'DEVELOPER_DIR']) if (inherited[name]) env[name] = inherited[name];
  return env;
}

async function prepareEnvironment(directory) {
  const env = isolatedEnvironment(directory);
  await Promise.all([env.HOME, env.TMPDIR, env.npm_config_cache].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(env.npm_config_userconfig, '');
  return env;
}

export async function runCommand(command, args, { directory, env, timeout = 600000, quiet = false } = {}) {
  if (command === 'npm') {
    const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(file => file?.endsWith('npm-cli.js'));
    let cli;
    for (const file of candidates) if (await access(file).then(() => true, () => false)) { cli = file; break; }
    if (!cli) throw new Error('Cannot locate npm-cli.js beside the running Node installation.');
    command = process.execPath; args = [cli, ...args];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '', expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, timeout);
    const capture = chunk => { const text = chunk.toString(); output = (output + text).slice(-64000); if (!quiet) process.stderr.write(text); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (expired || code !== 0) reject(Object.assign(new Error(`${command} ${args.join(' ')} ${expired ? 'timed out' : `failed (${code})`}`), { output })); else resolve(output); });
  });
}

export function candidateFileAllowed(name) {
  const normalized = name.replaceAll('\\', '/');
  return !/(?:^|\/)(?:\.git|node_modules|\.cache|\.validation|output|dist|release|build|\.commerce-dev|\.venv(?:-packaging)?|profiles)(?:\/|$)/.test(normalized)
    && !/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|(?:credentials?|secrets?)\.(?:json|ya?ml|toml|db|sqlite))$/.test(normalized)
    && !/^(?:resources\/generated|native\/sandbox\/target)\//.test(normalized)
    && !/\.(?:pem|p12|key|tsbuildinfo)$/.test(normalized);
}

async function copyCandidate(source, directory) {
  source = await realpath(source); directory = path.resolve(directory);
  if (directory === source) throw new Error('Candidate directory cannot be the live checkout.');
  await mkdir(path.dirname(directory), { recursive: true });
  try { await lstat(directory); throw new Error('Candidate directory already exists; select a new empty path.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(directory);
  const env = await prepareEnvironment(directory);
  const files = (await runCommand('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { directory: source, env, quiet: true })).split('\0').filter(Boolean);
  for (const name of files.filter(candidateFileAllowed)) {
    const file = path.join(source, name), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Candidate source cannot contain a symlink: ${name}.`);
    if (!stat.isFile()) continue;
    const destination = path.join(directory, name); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(file, destination);
  }
  await save(path.join(directory, markerFile), { schemaVersion: 1, source, createdAt: new Date().toISOString() });
  return env;
}

export async function prepareCandidate({ source, directory, version, getPackument = npmPackument, runner = runCommand }) {
  if (!exact(version)) throw new Error('prepare requires an exact --version, never a tag or version range.');
  const original = await readHarnessState(source);
  if (inspectHarnessState(original).status === 'failed') throw new Error('Current Harness pins are inconsistent; run check before preparing a candidate.');
  const metadataCache = new Map();
  const get = async name => { if (!metadataCache.has(name)) metadataCache.set(name, Promise.resolve(getPackument(name))); return metadataCache.get(name); };
  const manifests = [];
  for (const name of original.metadata.packages) {
    const manifest = (await get(name)).versions[version];
    if (!manifest || manifest.name !== name || manifest.version !== version) throw new Error(`${name}@${version} is not published; whole-family preparation stopped.`);
    manifests.push(manifest);
  }
  const resolved = await resolveCordisVersions(manifests, original.metadata.cordisPackages, get);
  const native = original.metadata.nativeAdapter;
  for (const manifest of manifests) {
    const range = manifest.dependencies?.[native.package] ?? manifest.peerDependencies?.[native.package];
    if (range && !semver.satisfies(native.version, range)) throw new Error(`${manifest.name} requires ${native.package}@${range}; the pinned native source requires manual review.`);
  }
  const env = await copyCandidate(source, directory);
  const pkg = structuredClone(original.pkg), bundle = structuredClone(original.bundle), metadata = structuredClone(original.metadata);
  for (const name of metadata.packages) pkg.dependencies[name] = version;
  for (const [name, pin] of Object.entries(resolved.versions)) pkg.dependencies[name] = pin;
  metadata.version = version; bundle.peerDependencies['@deepseek-ai/dsh'] = version;
  await save(path.join(directory, 'package.json'), pkg);
  await save(path.join(directory, 'packages/platform-bundle/package.json'), bundle);
  await save(path.join(directory, metadataFile), metadata);
  await runner('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { directory, env });
  const report = inspectHarnessState(await readHarnessState(directory));
  report.operation = 'prepare'; report.directory = path.resolve(directory); report.previousVersion = original.metadata.version;
  report.cordis = resolved; report.createdAt = new Date().toISOString();
  report.metadata = manifests.map(item => ({ name: item.name, version: item.version, integrity: item.dist?.integrity, tarball: item.dist?.tarball }));
  await saveReport(path.join(directory, 'harness-prepare-report.json'), report, { source, directory });
  return report;
}

async function assertCandidate(directory) {
  directory = await realpath(directory);
  const marker = await json(path.join(directory, markerFile)).catch(() => null);
  if (marker?.schemaVersion !== 1 || !marker.source || directory === await realpath(marker.source)) throw new Error('validate requires an isolated directory produced by prepare.');
  const deps = await lstat(path.join(directory, 'node_modules')).catch(() => null);
  if (deps?.isSymbolicLink()) throw new Error('Candidate node_modules must not link to the live checkout.');
  return directory;
}

const nativeProbe = `const n = require('node-addon-require-builtin'); const raw = n.requireBuiltin('internal/modules/esm/loader'); const loader = raw?.getOrInitializeCascadedLoader(); if (!loader || typeof loader.getOrCreateModuleJob !== 'function' && typeof loader.getModuleJobForImport !== 'function') throw new Error('Unsupported internal module loader'); console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,binding:n.getBindingInfo()}));`;

export async function validateCandidate({ directory, offline = false, runner = runCommand }) {
  directory = await assertCandidate(directory);
  const state = await readHarnessState(directory), report = inspectHarnessState(state);
  report.operation = 'validate'; report.directory = directory; report.createdAt = new Date().toISOString();
  report.pending = ['Packaged desktop acceptance on macOS 15 / Windows 10'];
  if (report.status === 'failed') return report;
  const env = await prepareEnvironment(directory), logs = path.join(directory, '.validation/logs'); await mkdir(logs, { recursive: true });
  const step = async (id, command, args, extraEnv = {}) => {
    try {
      const output = await runner(command, args, { directory, env: { ...env, ...extraEnv } });
      await writeFile(path.join(logs, id + '.log'), output); report.checks.push(check(id, true, `${command} ${args.join(' ')}; log=.validation/logs/${id}.log`));
      return true;
    } catch (error) {
      await writeFile(path.join(logs, id + '.log'), error.output ?? error.message); report.checks.push(check(id, false, `${error.message}; log=.validation/logs/${id}.log`)); report.status = 'failed';
      return false;
    }
  };
  const native = state.metadata.nativeAdapter;
  const supportedTargets = native.supportedTargets ?? ['darwin-arm64', 'win32-x64'];
  report.checks.push(check('native-target', supportedTargets.includes(process.platform + '-' + process.arch) && Number(process.versions.node.split('.')[0]) === native.nodeMajor,
    `Native validation requires ${supportedTargets.join(' or ')}, Node ${native.nodeMajor}; got ${process.platform}/${process.arch}, Node ${process.versions.node}.`));
  if (report.checks.at(-1).status === 'failed') { report.status = 'failed'; return report; }
  if (!offline && !await step('npm-ci', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])) return report;
  if (offline) {
    const available = await access(path.join(directory, 'node_modules/@deepseek-ai/dsh/package.json')).then(() => true, () => false);
    report.checks.push(check('offline-prerequisites', available, 'Offline validation requires this candidate’s installed node_modules.'));
    if (!available) { report.status = 'failed'; return report; }
  }
  const installedChecks = await inspectInstalledHarness(directory, state); report.checks.push(...installedChecks);
  if (installedChecks.some(item => item.status === 'failed')) { report.status = 'failed'; return report; }
  const archive = path.join(directory, '.cache/harness-native', native.commit, 'source.tgz');
  if (offline && process.platform === 'darwin') {
    const digest = await readFile(archive).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => null);
    report.checks.push(check('offline-native-source', digest === native.sha256, 'Offline native build requires the already cached, pinned source archive.'));
    if (digest !== native.sha256) { report.status = 'failed'; return report; }
  }
  if (!await step('native-build', process.execPath, ['scripts/build-harness-native.mjs'])) return report;
  if (!await step('native-node', process.execPath, ['-e', nativeProbe])) return report;
  const require = createRequire(path.join(directory, 'package.json'));
  let electron;
  try { electron = require('electron'); await access(electron); } catch {
    if (offline) { report.checks.push(check('native-electron-runtime', false, 'Offline validation requires the candidate Electron binary.')); report.status = 'failed'; return report; }
    if (!await step('electron-download', process.execPath, ['node_modules/electron/install.js'])) return report;
    try { electron = require('electron'); await access(electron); } catch (error) { report.checks.push(check('native-electron-runtime', false, error.message)); report.status = 'failed'; return report; }
  }
  if (!await step('native-electron-runtime', electron, ['-e', nativeProbe], { ELECTRON_RUN_AS_NODE: '1' })) return report;
  const exportsProbe = `const meta=JSON.parse(await (await import('node:fs/promises')).readFile('desktop/upstream/harness.json','utf8'));for(const item of meta.publicExports){const root=await import(item.module);for(const name of item.names)if(typeof root[name]!=='function')throw new Error(item.module+' missing public export '+name);}for(const name of meta.serviceModules)await import(name);`;
  if (!await step('public-service-exports', process.execPath, ['--input-type=module', '-e', exportsProbe])) return report;
  // tsc/Vite exercise UI root exports and their implicit runtime dependencies;
  // Node cannot import the package's public root because it legitimately has CSS.
  if (!await step('ui-and-build', 'npm', ['run', 'build'])) return report;
  if (!await step('kernel-and-session-contracts', process.execPath, ['--test', 'tests/platform/kernel.test.mjs', 'tests/platform/ai-chat.test.mjs', 'tests/platform/ai-harness-adapter.test.mjs', 'tests/platform/harness-session-compatibility.test.mjs', 'tests/platform/harness-pending-session.test.mjs'])) return report;
  if (!await step('planning-contracts', process.execPath, ['--test', '--test-name-pattern=Harness', 'tests/platform/ai.test.mjs'])) return report;
  if (!await step('ui-contracts', 'npm', ['exec', '--', 'vitest', 'run', 'src/platform/AIChat.test.tsx'])) return report;
  report.status = 'validated';
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const [operation = 'check', ...rest] = args, options = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--offline') options.offline = true;
    else if (['--directory', '--report', '--version'].includes(flag) && rest[index + 1] && !rest[index + 1].startsWith('--')) options[flag.slice(2)] = rest[++index];
    else throw new Error('Unknown or incomplete option: ' + flag);
  }
  const source = process.cwd(), directory = path.resolve(options.directory ?? (operation === 'prepare' ? path.join(source, 'output/upstream', 'harness-' + (options.version ?? 'candidate')) : source));
  const candidateSource = await json(path.join(directory, markerFile)).then(marker => typeof marker.source === 'string' ? marker.source : undefined, () => undefined);
  const roots = { source, directory, sources: [candidateSource] };
  // Preflight sits outside the error-report handler: a rejected report path
  // must never be reused as a destination for the failure report itself.
  if (options.report) await assertHarnessReportPath(path.resolve(options.report), roots);
  if (operation === 'validate') await assertHarnessReportPath(path.join(directory, 'harness-validation-report.json'), roots);
  if (operation === 'prepare') await assertHarnessReportPath(path.join(directory, 'harness-prepare-report.json'), roots);
  await assertHarnessReportPath(path.join(source, 'output/upstream', 'harness-' + operation + '-failure.json'), roots);
  let report;
  try {
  if (operation === 'check') report = inspectHarnessState(await readHarnessState(directory));
  else if (operation === 'check-upstream') {
    const state = await readHarnessState(directory); report = inspectHarnessState(state);
    report.release = harnessRelease(state.metadata, await npmPackument('@deepseek-ai/dsh')); report.operation = operation;
  } else if (operation === 'prepare') {
    report = await prepareCandidate({ source, directory, version: options.version });
  } else if (operation === 'validate') {
    if (!options.directory) throw new Error('validate requires --directory PATH from prepare.');
    report = await validateCandidate({ directory, offline: !!options.offline });
    await saveReport(path.join(directory, 'harness-validation-report.json'), report, roots);
  } else throw new Error('Expected check, check-upstream, prepare --version VERSION, or validate --directory PATH.');
  } catch (error) {
    report = { schemaVersion: 1, component: 'harness', operation, status: 'failed', version: options.version, directory, error: error.message, checks: [] };
    const failureReport = options.report ?? path.join(source, 'output/upstream', 'harness-' + operation + '-failure.json');
    await saveReport(path.resolve(failureReport), report, roots); report.report = path.resolve(failureReport);
  }
  if (options.report) await saveReport(path.resolve(options.report), report, roots);
  console.log(JSON.stringify({ operation, status: report.status, version: report.version, checks: report.checks.length,
    failed: report.checks.filter(item => item.status === 'failed'), error: report.error,
    release: report.release, directory: report.directory, report: options.report ? path.resolve(options.report) : report.report ?? (report.operation === 'prepare' ? path.join(report.directory, 'harness-prepare-report.json') : report.operation === 'validate' ? path.join(report.directory, 'harness-validation-report.json') : undefined), pending: report.pending }, null, 2));
  if (report.status === 'failed') process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
