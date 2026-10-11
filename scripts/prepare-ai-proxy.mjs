import { mkdir, writeFile, readFile, chmod, rm, mkdtemp, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
const versions = {
  'darwin-arm64': { name: 'CLIProxyAPI_8.0.23_darwin_aarch64.tar.gz', sha256: '3c056b42ec4c80d06a74d3c5abf47ae0adb06285e32f5cf31a29bdd07017feb3' },
  'win32-x64': { name: 'CLIProxyAPI_8.0.23_windows_amd64.zip', sha256: 'd2839470df9a3698c9b0a93a6f42f8c569be4a0f74099f7110ba9350f62ca6f7' },
};
export async function prepareAiProxy(destination = 'resources/generated') {
  const target = process.platform + '-' + process.arch, artifact = versions[target]; if (!artifact) return;
  const cached = path.resolve('.cache/cli-proxy', artifact.name); await mkdir(path.dirname(cached), { recursive: true });
  let bytes; try { bytes = await readFile(cached); } catch { const response = await fetch('https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.23/' + artifact.name); if (!response.ok) throw new Error('CLIProxyAPI 下载失败。'); bytes = Buffer.from(await response.arrayBuffer()); }
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('CLIProxyAPI 制品校验失败。');
  await writeFile(cached, bytes);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-'));
  try {
    if (target === 'win32-x64') new AdmZip(bytes).extractAllTo(temporary);
    else await promisify(execFile)('tar', ['-xzf', cached, '-C', temporary]);
    const binary = target === 'win32-x64' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
    await mkdir(destination, { recursive: true }); await copyFile(path.join(temporary, binary), path.join(destination, binary));
    await chmod(path.join(destination, binary), 0o755);
    await copyFile(path.join(temporary, 'LICENSE'), path.join(destination, 'CLIProxyAPI-LICENSE'));
    await writeFile(path.join(destination, 'cli-proxy-version.json'), JSON.stringify({ version: '8.0.23', target, sha256: artifact.sha256 }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
