import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function nextVersion(current, requested) {
  if (requested) {
    if (!SEMVER.test(requested)) throw new Error('目标版本号必须是 X.Y.Z 正式版本：' + requested);
    return requested;
  }
  const matched = SEMVER.exec(current);
  if (!matched) throw new Error('当前版本号不是 X.Y.Z 正式版本：' + current);
  return `${matched[1]}.${matched[2]}.${Number(matched[3]) + 1}`;
}

// 底座版本号同时存在于 package.json、package-lock.json 与发布说明首行，
// 三处必须一起更新，否则打标签的发布流水线会判定版本不一致。
export async function bumpVersion(base, requested) {
  const packagePath = path.join(base, 'package.json');
  const lockPath = path.join(base, 'package-lock.json');
  const guidePath = path.join(base, 'docs', 'release-guide.md');
  const packageJSON = JSON.parse(await readFile(packagePath, 'utf8'));
  const lockfile = JSON.parse(await readFile(lockPath, 'utf8'));
  const current = packageJSON.version;
  const next = nextVersion(current, requested);
  if (next === current) throw new Error('目标版本与当前版本相同：' + current);
  if (lockfile.version !== current) throw new Error(`package-lock.json 版本与 package.json 不一致：${current}`);
  if (lockfile.packages?.['']?.version !== current) throw new Error(`package-lock.json 根包版本与 package.json 不一致：${current}`);
  const guide = await readFile(guidePath, 'utf8');
  if (!guide.includes('底座版本 ' + current)) throw new Error('docs/release-guide.md 未找到底座版本 ' + current);
  packageJSON.version = next;
  lockfile.version = next;
  lockfile.packages[''].version = next;
  await writeFile(packagePath, JSON.stringify(packageJSON, null, 2) + '\n');
  await writeFile(lockPath, JSON.stringify(lockfile, null, 2) + '\n');
  await writeFile(guidePath, guide.replace('底座版本 ' + current, '底座版本 ' + next));
  return { current, next };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--target');
  const requested = index > -1 ? process.argv[index + 1] : undefined;
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(await bumpVersion(base, requested)));
}
