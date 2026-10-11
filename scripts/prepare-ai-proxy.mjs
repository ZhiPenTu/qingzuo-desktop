import { mkdir, writeFile, chmod, rm, mkdtemp, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { readCliProxyManifest, validateCliProxyManifest, verifiedCliProxyDownload } from './update-cli-proxy.mjs';
export async function prepareAiProxy(destination = 'resources/generated', manifestOverride) {
  const manifest = manifestOverride ? validateCliProxyManifest(manifestOverride) : await readCliProxyManifest(), target = process.platform + '-' + process.arch;
  const artifact = manifest.artifacts[target]; if (!artifact) return;
  const { bytes, filename: cached } = await verifiedCliProxyDownload(manifest, target);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-proxy-'));
  try {
    if (target === 'win32-x64') new AdmZip(bytes).extractAllTo(temporary);
    else await promisify(execFile)('tar', ['-xzf', cached, '-C', temporary]);
    const binary = target === 'win32-x64' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
    await mkdir(destination, { recursive: true }); await copyFile(path.join(temporary, binary), path.join(destination, binary));
    await chmod(path.join(destination, binary), 0o755);
    await copyFile(path.join(temporary, 'LICENSE'), path.join(destination, 'CLIProxyAPI-LICENSE'));
    await writeFile(path.join(destination, 'cli-proxy-version.json'), JSON.stringify({ version: manifest.version, target, sha256: artifact.sha256 }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
