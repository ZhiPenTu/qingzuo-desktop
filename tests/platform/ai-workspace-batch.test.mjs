import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BatchRuntime } from '../../desktop/ai-batches.mjs';
import { WorkspaceRuntime } from '../../desktop/workspace.mjs';

const plugin = { id: 'official.wechat-studio', title: '公众号 AI 工作台', permissions: { files: true, workspace: true, ai: ['image-edit'] } };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('AI batches can write generated images into an article workspace with explicit confirmation', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-batch-workspace-'));
  const selected = path.join(base, 'selected');
  await mkdir(path.join(selected, 'drafts', '20261103-demo'), { recursive: true });
  const workspace = new WorkspaceRuntime({
    root: path.join(base, 'state'),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    files: null,
  });
  await workspace.initialize();
  await workspace.pick(plugin);
  const editor = {
    resolve: async () => ({ model: { id: 'fake' }, parameters: {} }),
    assertSelection: async () => {},
    generate: async () => ({ bytes: png, mime: 'image/png' }),
  };
  const files = { async get() { throw new Error('not used'); }, directory() { throw new Error('not used'); } };
  let confirmed = 0;
  const runtime = new BatchRuntime(path.join(base, 'batches'), files, editor, () => {}, workspace, async (_plugin, _batch, target) => {
    confirmed += 1;
    assert.equal(target, 'drafts/20261103-demo');
    return true;
  });
  try {
    await runtime.initialize();
    const created = await runtime.create(plugin, { mode: 'generate', modelId: 'fake', items: [{ prompt: '画一张图' }] });
    const started = await runtime.start(plugin, { id: created.id, revision: created.revision, workspacePath: 'drafts/20261103-demo' });
    assert.equal(started.workspacePath, 'drafts/20261103-demo');
    let current = started;
    for (let index = 0; index < 100 && current.state !== 'finished'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      current = runtime.get(plugin, created.id);
    }
    assert.equal(current.state, 'finished');
    assert.equal(confirmed, 1);
    assert.equal(current.items[0].state, 'succeeded');
    assert.ok(current.items[0].output);
    const filesNow = await workspace.list(plugin, { path: 'drafts/20261103-demo' });
    assert.ok(filesNow.some(file => file.path.endsWith(current.items[0].output)));
    const another = await runtime.create(plugin, { mode: 'generate', modelId: 'fake', items: [{ prompt: '再来一张' }] });
    await assert.rejects(runtime.start(plugin, { id: another.id, revision: another.revision }), /输出目录/);
  } finally {
    await runtime.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test('AI batches run only one generation for concurrent starts of the same batch', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-batch-workspace-'));
  const selected = path.join(base, 'selected');
  await mkdir(path.join(selected, 'drafts', '20261103-demo'), { recursive: true });
  const workspace = new WorkspaceRuntime({
    root: path.join(base, 'state'),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    files: null,
  });
  await workspace.initialize();
  await workspace.pick(plugin);
  let generations = 0;
  const editor = {
    resolve: async () => ({ model: { id: 'fake' }, parameters: {} }),
    assertSelection: async () => {},
    generate: async () => {
      generations += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { bytes: png, mime: 'image/png' };
    },
  };
  let confirmations = 0;
  const runtime = new BatchRuntime(
    path.join(base, 'batches'),
    { async get() { throw new Error('not used'); }, directory() { throw new Error('not used'); } },
    editor,
    () => {},
    workspace,
    async () => { confirmations += 1; return true; },
  );
  try {
    await runtime.initialize();
    const created = await runtime.create(plugin, { mode: 'generate', modelId: 'fake', items: [{ prompt: '只生成一次' }] });
    const [first, second] = await Promise.all([
      runtime.start(plugin, { id: created.id, revision: created.revision, workspacePath: 'drafts/20261103-demo' }),
      runtime.start(plugin, { id: created.id, revision: created.revision, workspacePath: 'drafts/20261103-demo' }),
    ]);
    assert.equal(first.id, created.id);
    assert.equal(second.id, created.id);
    assert.equal(confirmations, 1);
    let current = runtime.get(plugin, created.id);
    for (let index = 0; index < 100 && current.state !== 'finished'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      current = runtime.get(plugin, created.id);
    }
    assert.equal(current.state, 'finished');
    assert.equal(current.items[0].state, 'succeeded');
    assert.equal(generations, 1);
  } finally {
    await runtime.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});
