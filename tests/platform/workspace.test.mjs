import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileBroker } from '../../desktop/brokers.mjs';
import { publicWorkspaceError, WorkspaceRuntime } from '../../desktop/workspace.mjs';

const plugin = { id: 'official.wechat-studio', title: '公众号 AI 工作台', permissions: { workspace: true, files: true } };

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-workspace-'));
  const selected = path.join(base, 'selected');
  await mkdir(selected, { recursive: true });
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) };
  const runtime = new WorkspaceRuntime({ root: path.join(base, 'state'), dialog, files: null });
  await runtime.initialize();
  await runtime.pick(plugin);
  return { base, selected, runtime };
}

test('workspace persists per-plugin access and keeps paths relative', async () => {
  const { base, selected, runtime } = await fixture();
  try {
    assert.deepEqual(await runtime.status(plugin), { name: 'selected', available: true });
    await runtime.mkdir(plugin, { path: 'drafts/20261103-demo' });
    await runtime.writeText(plugin, { path: 'drafts/20261103-demo/draft.md', text: '# 草稿', overwrite: false });
    assert.equal(await runtime.readText(plugin, { path: 'drafts/20261103-demo/draft.md' }), '# 草稿');
    await assert.rejects(runtime.writeText(plugin, { path: 'drafts/20261103-demo/draft.md', text: '# 重复' }), /已存在/);
    await runtime.writeText(plugin, { path: 'drafts/20261103-demo/draft.md', text: '# 新草稿', overwrite: true });
    assert.equal(await runtime.readText(plugin, { path: 'drafts/20261103-demo/draft.md' }), '# 新草稿');
    const entries = await runtime.list(plugin, { recursive: true });
    assert.ok(entries.some(entry => entry.path === 'drafts/20261103-demo/draft.md'));
    assert.ok(entries.every(entry => !path.isAbsolute(entry.path)));

    const url = await runtime.url(plugin, { path: 'drafts/20261103-demo/draft.md' });
    const token = new URL(url).pathname.split('/').pop();
    const file = await runtime.urlFile(plugin, token);
    assert.match(await readFile(file.filename, 'utf8'), /新草稿/);
    runtime.releaseUrls(plugin.id);
    await assert.rejects(runtime.urlFile(plugin, token), /失效/);

    const restarted = new WorkspaceRuntime({ root: path.join(base, 'state'), dialog: null, files: null });
    await restarted.initialize();
    assert.deepEqual(await restarted.status(plugin), { name: 'selected', available: true });
    assert.equal(await restarted.readText(plugin, { path: 'drafts/20261103-demo/draft.md' }), '# 新草稿');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('workspace rejects traversal, secrets, symlinks and other plugins', async () => {
  const { base, selected, runtime } = await fixture();
  try {
    await assert.rejects(runtime.writeText(plugin, { path: '../escape.md', text: 'x' }), /路径无效/);
    await assert.rejects(runtime.writeText(plugin, { path: 'drafts/escape\\x.md', text: 'x' }), /路径无效/);
    await assert.rejects(runtime.writeText(plugin, { path: '.aws-article/aws.env', text: 'WECHAT=secret' }), /不可访问/);
    await assert.rejects(runtime.writeText(plugin, { path: 'drafts/private.key', text: 'secret' }), /不可访问/);
    await assert.rejects(runtime.writeText(plugin, { path: 'drafts/.git/config', text: 'secret' }), /不可访问/);
    await assert.rejects(runtime.writeText(plugin, { path: 'drafts/.npmrc', text: '//registry.npmjs.org/:_authToken=secret' }), /不可访问/);
    await assert.rejects(runtime.writeText(plugin, { path: 'drafts/.netrc', text: 'machine example.com password secret' }), /不可访问/);
    await assert.rejects(runtime.writeText(plugin, { path: 'drafts/credentials.json', text: '{"token":"secret"}' }), /不可访问/);
    await mkdir(path.join(selected, 'drafts'), { recursive: true });
    const outside = path.join(base, 'outside.md');
    await writeFile(outside, 'outside');
    await symlink(outside, path.join(selected, 'drafts', 'link.md'));
    await assert.rejects(runtime.readText(plugin, { path: 'drafts/link.md' }), /符号链接/);
    assert.ok((await runtime.list(plugin, { path: 'drafts' })).every(entry => entry.name !== 'link.md'));
    const other = { ...plugin, id: 'official.other', title: 'Other' };
    assert.deepEqual(await runtime.status(other), { name: '', available: false, reason: 'not-picked' });
    await assert.rejects(runtime.list(other), /请先选择工作文件夹/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('workspace serializes concurrent writes without silently overwriting', async () => {
  const { base, runtime } = await fixture();
  try {
    const results = await Promise.allSettled([
      runtime.writeText(plugin, { path: 'drafts/race.md', text: 'first', overwrite: false }),
      runtime.writeText(plugin, { path: 'drafts/race.md', text: 'second', overwrite: false }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const value = await runtime.readText(plugin, { path: 'drafts/race.md' });
    assert.ok(value === 'first' || value === 'second');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('workspace requires reauthorization after the directory is replaced', async () => {
  const { base, selected, runtime } = await fixture();
  try {
    await runtime.writeText(plugin, { path: 'drafts/keep.md', text: 'ok' });
    await rm(selected, { recursive: true, force: true });
    await mkdir(selected, { recursive: true });
    const status = await runtime.status(plugin);
    assert.equal(status.available, false);
    assert.equal(status.reason, 'moved');
    await assert.rejects(runtime.readText(plugin, { path: 'drafts/keep.md' }), /重新授权/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('workspace refuses to authorize the filesystem root', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-workspace-'));
  const runtime = new WorkspaceRuntime({
    root: path.join(base, 'state'),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path.parse(base).root] }) },
    files: null,
  });
  try {
    await runtime.initialize();
    await assert.rejects(runtime.pick(plugin), /根目录/);
    assert.deepEqual(await runtime.status(plugin), { name: '', available: false, reason: 'not-picked' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('workspace preserves an incompatible index as .corrupt and drops old access', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-workspace-'));
  const state = path.join(base, 'state');
  await mkdir(state, { recursive: true });
  const original = JSON.stringify({
    schemaVersion: 99,
    plugins: { [plugin.id]: { filename: base, name: '旧目录', dev: 1, ino: 1 } },
  }, null, 2) + '\n';
  await writeFile(path.join(state, 'workspaces.json'), original);
  const logs = [];
  try {
    const runtime = new WorkspaceRuntime({ root: state, dialog: null, files: null, log: message => logs.push(message) });
    await runtime.initialize();
    const corrupt = (await readdir(state)).find(name => name.startsWith('workspaces.json.corrupt-'));
    assert.ok(corrupt);
    assert.equal(await readFile(path.join(state, corrupt), 'utf8'), original);
    assert.deepEqual(await runtime.status(plugin), { name: '', available: false, reason: 'not-picked' });
    assert.match(logs.join('\n'), /格式不兼容/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('workspace writeFile rejects file tokens owned by another plugin', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-workspace-'));
  const selected = path.join(base, 'selected');
  await mkdir(selected, { recursive: true });
  const files = new FileBroker(path.join(base, 'files'), null);
  const runtime = new WorkspaceRuntime({
    root: path.join(base, 'state'),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    files,
  });
  const other = { ...plugin, id: 'official.other', title: 'Other' };
  try {
    await files.initialize();
    await runtime.initialize();
    await runtime.pick(plugin);
    await runtime.pick(other);
    const token = await files.create(plugin, Buffer.from([137, 80, 78, 71]), 'source.png', 'image/png');
    await assert.rejects(runtime.writeFile(other, { token: token.token, path: 'drafts/stolen.png' }), /文件未授权/);
    await assert.rejects(runtime.writeFile(plugin, {
      token: '00000000-0000-4000-8000-000000000000',
      path: 'drafts/missing.png',
    }), /文件未授权/);
    assert.ok((await runtime.list(other, { recursive: true })).every(entry => entry.path !== 'drafts/stolen.png'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('workspace public errors never expose absolute paths', () => {
  const missing = Object.assign(new Error("ENOENT: no such file or directory, lstat '/Users/tuzhipeng/Documents/private/workspace'"), {
    code: 'ENOENT',
    path: '/Users/tuzhipeng/Documents/private/workspace',
  });
  assert.equal(publicWorkspaceError(missing).message, '文件或目录不存在。');
  assert.doesNotMatch(publicWorkspaceError(new Error('无法读取 /Users/tuzhipeng/Documents/private/workspace/drafts/a.md')).message, /\/Users\//);
  assert.match(publicWorkspaceError(new Error('无法读取 /Users/tuzhipeng/Documents/private/workspace/drafts/a.md')).message, /\[工作区路径\]/);
});
