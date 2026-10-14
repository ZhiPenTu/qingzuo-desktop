import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { _electron, expect } from '@playwright/test';
import { buildComponentArtifacts } from './component-artifacts.mjs';
import { componentManifestName } from '../desktop/update-components.mjs';
import { launchMacInstaller, verifyMacBundle } from '../desktop/mac-update.mjs';

if (process.platform !== 'darwin') process.exit(0);
if (!process.env.QINGZUO_BASELINE_ZIP) throw new Error('Verified v0.2.5 Release ZIP required.');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-legacy-mac-'));
const baseline = await readFile(process.env.QINGZUO_BASELINE_ZIP);
assert.equal(createHash('sha256').update(baseline).digest('hex'), '058ab3f992d7cfa11449ab3ac0b3a0272f8f19b8ac765b61725eb7cf677a4b11');
const target = path.join(temporary, 'installed/Qingzuo.app'), profile = path.join(temporary, 'profile');
let app, server;
try {
  execFileSync('/usr/bin/ditto', ['-x', '-k', process.env.QINGZUO_BASELINE_ZIP, path.dirname(target)]);
  const configPath = path.join(target, 'Contents/Resources/commerce/market.json'), config = JSON.parse(await readFile(configPath));
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  await writeFile(configPath, JSON.stringify({ ...config, publicKey, updatePublicKey: publicKey }));
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target]);
  const executablePath = path.join(target, 'Contents/MacOS/Qingzuo');
  app = await _electron.launch({ executablePath, cwd: temporary, args: ['--user-data-dir=' + profile] });
  const page = await app.firstWindow();
  await expect(page.getByText('工具服务已就绪')).toBeVisible();
  expect((await page.evaluate(() => window.commerceDesktop.invoke('status'))).version).toBe('0.2.5');
  const zip = new AdmZip(), artifact = path.join(temporary, 'preserved.ecplugin');
  zip.addFile('package.json', Buffer.from(JSON.stringify({ version: '9.0.0', commerce: { manifestVersion: 1, id: 'local.preserved', title: 'Preserved fixture', description: '', api: '^1.0.0', ui: 'ui/index.html', permissions: { files: true } } })));
  zip.addFile('ui/index.html', Buffer.from('<h1>Preserved fixture</h1>')); await writeFile(artifact, zip.toBuffer());
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); dialog.showMessageBox = async () => ({ response: 1 }); }, artifact);
  await page.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
  await page.evaluate(() => window.commerceDesktop.invoke('plugins.enable', { id: 'official.labeledit', enabled: false }));
  const priorState = await readFile(path.join(profile, 'plugins/state.json'));
  await writeFile(path.join(profile, 'user-document.pdf'), 'preserved user document');
  const { version } = JSON.parse(await readFile('package.json')), output = path.join(temporary, 'components');
  await buildComponentArtifacts({ bundle: path.resolve('release/desktop/mac-arm64/Qingzuo.app'), output, version, privateKey: keys.privateKey });
  const archiveName = 'CommerceTools-' + version + '-mac-arm64.zip', archive = path.join(output, archiveName);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.resolve('release/desktop/mac-arm64/Qingzuo.app'), archive]);
  const archiveBytes = await readFile(archive), archiveArtifact = { url: 'https://github.com/ZhiPenTu/LabelEdit/releases/download/v' + version + '/' + archiveName, size: archiveBytes.length, sha256: createHash('sha256').update(archiveBytes).digest('hex') };
  const name = componentManifestName(version), bytes = await readFile(path.join(output, name));
  const manifestArtifact = { url: 'https://github.com/ZhiPenTu/LabelEdit/releases/download/v' + version + '/' + name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  server = createServer(async (request, response) => {
    try {
      const filename = path.join(output, path.basename(request.url)), info = await stat(filename), range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      if (range) { const start = Number(range[1]), end = Number(range[2]); response.writeHead(206, { 'content-range': 'bytes ' + start + '-' + end + '/' + info.size, 'content-length': end - start + 1 }); createReadStream(filename, { start, end }).pipe(response); }
      else { response.writeHead(200, { 'content-length': info.size }); createReadStream(filename).pipe(response); }
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const moduleURL = pathToFileURL(path.join(target, 'Contents/Resources/app.asar/desktop/main.mjs')).href;
  const prepared = await app.evaluate(async (_, value) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => originalFetch('http://127.0.0.1:' + value.port + new URL(url).pathname, options);
    const vm = process.getBuiltinModule('node:vm');
    const runtime = await vm.runInThisContext('import(' + JSON.stringify(value.moduleURL) + ')', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    const moduleURL = value.moduleURL.replace('/main.mjs', '/update-components.mjs');
    const components = await vm.runInThisContext('import(' + JSON.stringify(moduleURL) + ')', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    const fs = process.getBuiltinModule('node:fs/promises');
    let rejected = false;
    try { components.readComponentManifest(await fs.readFile(value.manifestPath), value.publicKey, value.version); } catch (error) { rejected = /签名验证失败/.test(error.message); }
    if (!rejected) throw new Error('Legacy updater must select full-package fallback before opening the incompatible ASAR component.');
    const states = [];
    const prepared = await runtime.updateService.adapter.download({ version: value.version, components: value.manifestArtifact, artifact: value.archiveArtifact }, state => states.push(state));
    if (!states.some(state => state.fallbackReason)) throw new Error('Expected legacy full-package fallback.');
    return prepared;
  }, { moduleURL, manifestArtifact, archiveArtifact, version, port: server.address().port, publicKey, manifestPath: path.join(output, name) });
  await verifyMacBundle(prepared.prepared, version);
  await assert.rejects(access(path.join(prepared.prepared, 'Contents/Resources/commerce/plugins')));
  assert.deepEqual(await readFile(path.join(profile, 'plugins/state.json')), priorState);
  await app.close(); app = null;
  const waiter = spawn('/bin/sleep', ['1']), helper = await launchMacInstaller({ ...prepared, parent: waiter.pid });
  helper.ref();
  await new Promise((resolve, reject) => helper.once('exit', code => code === 0 ? resolve() : reject(new Error('Replacement failed.'))));
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const relaunchedExecutable = path.join(prepared.target, 'Contents/MacOS/Qingzuo');
  for (const line of processes.split('\n')) if (line.includes(relaunchedExecutable) && line.includes('--user-data-dir=')) { const match = line.match(/^\s*(\d+)/); if (match) process.kill(Number(match[1]), 'SIGTERM'); }
  await new Promise(resolve => setTimeout(resolve, 1000));
  app = await _electron.launch({ executablePath, cwd: temporary, args: ['--user-data-dir=' + profile] });
  const updated = await app.firstWindow();
  await expect(updated.getByText('工具服务已就绪')).toBeVisible();
  const status = await updated.evaluate(() => window.commerceDesktop.invoke('status'));
  expect(status.version).toBe(version);
  expect(status.plugins).toHaveLength(1);
  expect(status.plugins[0]).toMatchObject({ id: 'local.preserved', version: '9.0.0' });
  expect(status.migration).toMatchObject({ id: 'official.labeledit', enabled: false });
  assert.equal(await readFile(path.join(profile, 'user-document.pdf'), 'utf8'), 'preserved user document');
  await mkdir('output/update-validation', { recursive: true });
  await writeFile('output/update-validation/macos-legacy.json', JSON.stringify({ baseline: '0.2.5', version, originalPackagedUpdater: 'passed', componentTrust: 'fixture-key-only', installedPlugins: 'preserved', userDocument: 'preserved', legacyDisabledState: 'preserved', purePlatform: 'passed' }, null, 2));
  console.log('Actual v0.2.5 packaged macOS updater selected the compatible full-package fallback; pure v0.2.7 replacement, installed API 1.0 plugin, user data and disabled restoration state passed.');
} finally { await app?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
