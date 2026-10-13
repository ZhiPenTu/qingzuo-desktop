import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from './update-fs.mjs';
import { readFile as readInternalResource } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { checkGitHubRelease } from './updates.mjs';
import { downloadUpdateArchive, pruneUpdateCaches, safeRm, withNoAsar } from './update-download.mjs';
import { prepareComponentUpdate } from './update-components.mjs';

const execute = promisify(execFile);
const bundleID = 'com.commerce.tools.desktop';

export function applicationBundle(executable) {
  const app = path.resolve(executable, '../../..');
  if (!app.endsWith('.app') || path.dirname(executable) !== path.join(app, 'Contents', 'MacOS')) throw new Error('请从已安装的轻作应用中更新。');
  if (app.startsWith('/Volumes/') || app.includes('/AppTranslocation/')) throw new Error('请先将轻作移到“应用程序”文件夹，再重新打开并更新。');
  return app;
}

async function plist(bundle, key) {
  return (await execute('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(bundle, 'Contents/Info.plist')])).stdout.trim();
}

export async function prepareMacUpdate(archive, staging, version, signal) {
  return withNoAsar(async () => {
    const extracted = path.join(staging, 'extracted');
    await mkdir(extracted);
    await execute('/usr/bin/ditto', ['-x', '-k', archive, extracted], { timeout: 5 * 60_000, signal });
    const entries = await readdir(extracted, { withFileTypes: true });
    const bundles = entries.filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
    if (bundles.length !== 1) throw new Error('更新包必须包含一个应用。');
    const bundle = path.join(extracted, bundles[0].name);
    return verifyMacBundle(bundle, version, signal);
  });
}

export async function verifyMacBundle(bundle, version, signal) {
  return withNoAsar(async () => {
    if (await plist(bundle, 'CFBundleIdentifier') !== bundleID || await plist(bundle, 'CFBundleShortVersionString') !== version) throw new Error('更新包的应用标识或版本不匹配。');
    const executable = await plist(bundle, 'CFBundleExecutable');
    if (path.basename(executable) !== executable || !(await stat(path.join(bundle, 'Contents/MacOS', executable))).isFile()) throw new Error('更新包缺少有效的启动程序。');
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 5 * 60_000, signal });
    return bundle;
  });
}

export const DEFAULT_MAC_INSTALL_SCRIPT = `#!/bin/sh
# Trusted main process supplies absolute paths as separate arguments.
trap '' HUP
parent="$1"; target="$2"; prepared="$3"; staging="$4"; receipt="$5"; profile="$6"
backup="$staging/previous.app"
fail() { printf '%s\\n' "$1" > "$receipt"; exit 1; }
printf 'ready\\n'
attempt=0
while kill -0 "$parent" 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 120 ] || fail '等待应用退出超时，请重新下载更新。'
  sleep 1
done
/bin/mv "$target" "$backup" || fail '无法替换旧应用，请检查应用文件夹权限。'
if ! /bin/mv "$prepared" "$target"; then
  /bin/mv "$backup" "$target"
  printf '%s\\n' '更新安装失败，已尝试恢复原版本。' > "$receipt"
  /usr/bin/open -n "$target" --args "--user-data-dir=$profile"
  exit 1
fi
if ! /usr/bin/open -n "$target" --args "--user-data-dir=$profile"; then
  /bin/mv "$target" "$prepared"
  /bin/mv "$backup" "$target"
  printf '%s\\n' '新版启动失败，已尝试恢复原版本。' > "$receipt"
  /usr/bin/open -n "$target" --args "--user-data-dir=$profile"
  exit 1
fi
/bin/rm -f "$receipt"
/bin/rm -rf "$staging"
`;

export async function loadMacInstallScript(customUrl = new URL('./mac-install.sh', import.meta.url)) {
  const previous = process.noAsar;
  process.noAsar = false;
  try {
    return await readInternalResource(customUrl, 'utf8');
  } catch {
    return DEFAULT_MAC_INSTALL_SCRIPT;
  } finally {
    process.noAsar = previous;
  }
}

export async function launchMacInstaller({ target, prepared, staging, receipt, profile, parent = process.pid, scriptContent }) {
  // Copy outside the .app; the helper must survive replacement of app.asar.
  const script = path.join(staging, 'install.sh');
  const content = scriptContent ?? await loadMacInstallScript();
  await writeFile(script, content, { mode: 0o700 });
  const child = spawn('/bin/sh', [script, String(parent), target, prepared, staging, receipt, profile], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('更新安装助手启动超时。')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`更新安装助手已退出（${code}）。`)); });
    child.stdout.once('data', () => { clearTimeout(timer); child.stdout.destroy(); resolve(); });
  });
  child.unref();
  return child;
}

export function macUpdateAdapter({ app, beforeInstall, receipt, publicKey, fetchImpl = globalThis.fetch }) {
  let active;
  return {
    check: () => checkGitHubRelease(app.getVersion(), { fetchImpl }),
    cancel: () => active?.abort(new Error('更新已取消。')),
    async download(release, notify) {
      const controller = new AbortController(); active = controller;
      const target = applicationBundle(app.getPath('exe'));
      let staging;
      try { staging = await mkdtemp(path.join(path.dirname(target), '.qingzuo-update-')); }
      catch { throw new Error('应用所在文件夹不可写，请将轻作移到有写入权限的“应用程序”文件夹后重试。'); }
      try {
        let lastTime = 0, lastStatus, lastMode;
        const progress = value => {
          const state = { status: 'downloading', ...value }, now = Date.now();
          if (now - lastTime >= 150 || state.status !== lastStatus || state.mode !== lastMode || state.progress === 100 || state.fallbackReason) {
            notify(state); lastTime = now; lastStatus = state.status; lastMode = state.mode;
          }
        };
        const options = { signal: controller.signal, fetchImpl }, updates = path.join(app.getPath('userData'), 'updates');
        let prepared;
        if (release.components && publicKey) {
          try {
            prepared = await prepareComponentUpdate({ manifestArtifact: release.components, publicKey, version: release.version, installed: target, staging,
              cache: path.join(updates, 'components'), notify: progress, options });
            await verifyMacBundle(prepared, release.version, controller.signal);
          } catch (error) {
            controller.signal.throwIfAborted();
            try { await safeRm(path.join(staging, 'Qingzuo.app')); } catch {} prepared = null;
            progress({ fallbackReason: '组件更新暂不可用，正在使用安装包更新。', mode: 'full', reusedBytes: 0, progress: 0, transferred: 0, total: release.artifact.size });
          }
        }
        if (!prepared) {
          const archive = await downloadUpdateArchive(release.artifact, path.join(updates, 'archives'), progress, options);
          notify({ status: 'extracting', progress: 100 });
          prepared = await prepareMacUpdate(archive, staging, release.version, controller.signal);
        }
        controller.signal.throwIfAborted();
        return { target, prepared, staging, receipt, profile: app.getPath('userData') };
      } catch (error) { await safeRm(staging); throw error; }
      finally { active = null; }
    },
    async install(prepared) {
      let helper;
      try {
        helper = await launchMacInstaller(prepared);
        await beforeInstall();
        app.quit();
      } catch (error) {
        helper?.kill();
        await safeRm(prepared.staging);
        throw error;
      }
    },
    async cleanCache() {
      return pruneUpdateCaches(path.join(app.getPath('userData'), 'updates'));
    },
  };
}

export async function previousUpdateError(receipt) {
  try { const error = await readFile(receipt, 'utf8'); await safeRm(receipt); return error.trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
