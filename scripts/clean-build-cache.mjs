#!/usr/bin/env node
// 清理可再生的构建产物，保留依赖、虚拟环境和最新安装包，避免下次构建重新下载或编译。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release', 'desktop');
const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const optionValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const dryRun = hasFlag('--dry-run');
const deep = hasFlag('--deep');
const pruneReleases = hasFlag('--releases');
const keepReleases = Math.max(1, Number(optionValue('--keep-releases', deep ? '1' : '2')) || 1);

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`用法：node scripts/clean-build-cache.mjs [选项]

默认清理：
  native/sandbox/target 下的 debug/incremental

选项：
  --releases             清理 release/desktop 中的旧安装包
  --keep-releases <数量> 每个平台/架构保留最近几个版本，默认 2
  --deep                 删除整个 native debug 目录；配合 --releases 时保留 1 个版本并删除解包目录
  --dry-run              只列出将要删除的内容和大小
  --help                 显示本帮助

始终保留：
  node_modules、.venv、.models、dist、build、Cargo 注册表与最新安装包。`);
  process.exit(0);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function directorySize(directory) {
  let total = 0;
  const stack = [directory];
  const seenInodes = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    let entry;
    try {
      entry = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      let children = [];
      try {
        children = fs.readdirSync(current);
      } catch {
        continue;
      }
      for (const child of children) stack.push(path.join(current, child));
    } else if (entry.isFile()) {
      if (entry.nlink > 1) {
        const inode = `${entry.dev}:${entry.ino}`;
        if (seenInodes.has(inode)) continue;
        seenInodes.add(inode);
      }
      total += typeof entry.blocks === 'number' && entry.blocks > 0
        ? entry.blocks * 512
        : entry.size;
    }
  }
  return total;
}

function remove(target, label = target) {
  const bytes = directorySize(target);
  console.log(`${dryRun ? '将删除' : '删除'} ${label} (${formatBytes(bytes)})`);
  if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
  return bytes;
}

function parseVersion(version) {
  const [main, ...rest] = version.split('-');
  const numbers = main.split('.').map((part) => Number.parseInt(part, 10) || 0);
  while (numbers.length < 3) numbers.push(0);
  return {
    numbers: numbers.slice(0, 3),
    prerelease: rest.length > 0 ? rest.join('-').split('.') : [],
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) {
      return leftPart.localeCompare(rightPart);
    }
    return leftNumber - rightNumber;
  }
  return 0;
}

const artifactPattern = /^(?<product>.+?)-(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-(?<platform>mac|win|linux)-(?<arch>[0-9A-Za-z]+)\.(?<extension>dmg|zip|exe|msi|AppImage|deb|rpm)(?<blockmap>\.blockmap)?$/;

function releasePlan() {
  if (!fs.existsSync(releaseDir)) return { removals: [], unpacked: [] };
  const entries = fs.readdirSync(releaseDir, { withFileTypes: true });
  const groups = new Map();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(artifactPattern);
    if (!match) continue;
    const key = `${match.groups.product}|${match.groups.platform}|${match.groups.arch}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      name: entry.name,
      version: match.groups.version,
      path: path.join(releaseDir, entry.name),
    });
  }

  const keptByGroup = new Map();
  for (const [key, files] of groups.entries()) {
    const versions = [...new Set(files.map((file) => file.version))]
      .sort((left, right) => compareVersions(right, left))
      .slice(0, keepReleases);
    keptByGroup.set(key, new Set(versions));
  }

  const removals = [];
  for (const [key, files] of groups.entries()) {
    const keptVersions = keptByGroup.get(key);
    for (const file of files) {
      if (!keptVersions.has(file.version)) removals.push(file.path);
    }
  }

  const unpacked = deep
    ? entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(releaseDir, entry.name))
    : [];

  return { removals, unpacked };
}

function nativeDebugDirectories() {
  const targetDir = path.join(root, 'native', 'sandbox', 'target');
  if (!fs.existsSync(targetDir)) return [];
  const directories = [path.join(targetDir, 'debug')];
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'debug' || entry.name === 'release') continue;
    directories.push(path.join(targetDir, entry.name, 'debug'));
  }
  return directories.filter((directory) => fs.existsSync(directory));
}

const removals = [];
const failures = [];

for (const debugDir of nativeDebugDirectories()) {
  const target = deep ? debugDir : path.join(debugDir, 'incremental');
  if (fs.existsSync(target)) removals.push(target);
}

console.log('清理 native 构建缓存：');
let totalBytes = 0;
if (removals.length === 0) {
  console.log('  没有找到可清理的 debug 缓存。');
} else {
  for (const target of removals) {
    try {
      totalBytes += remove(target, path.relative(root, target));
    } catch (error) {
      failures.push(`${path.relative(root, target)}: ${error.message}`);
    }
  }
}

if (pruneReleases) {
  console.log('');
  console.log(`清理 release/desktop（每个平台/架构保留最近 ${keepReleases} 个版本）：`);
  const plan = releasePlan();
  if (plan.removals.length === 0 && plan.unpacked.length === 0) {
    console.log('  没有找到可清理的旧安装包。');
  }
  for (const target of plan.removals) {
    try {
      totalBytes += remove(target, path.relative(root, target));
    } catch (error) {
      failures.push(`${path.relative(root, target)}: ${error.message}`);
    }
  }
  for (const target of plan.unpacked) {
    try {
      totalBytes += remove(target, path.relative(root, target));
    } catch (error) {
      failures.push(`${path.relative(root, target)}: ${error.message}`);
    }
  }
}

console.log('');
console.log(`${dryRun ? '预计清理' : '已清理'} ${formatBytes(totalBytes)} 缓存。`);
console.log('已保留 node_modules、.venv、.models、dist、build 和最新安装包。');

if (failures.length > 0) {
  console.error('以下内容删除失败：');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
