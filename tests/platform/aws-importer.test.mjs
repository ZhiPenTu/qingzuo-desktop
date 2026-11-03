import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import YAML from 'yaml';
import { WorkspaceRuntime } from '../../desktop/workspace.mjs';
import { AwsImporter } from '../../desktop/aws-importer.mjs';

const plugin = {
  id: 'official.wechat-studio',
  title: '公众号 AI 工作台',
  permissions: { workspace: true, files: true, wechat: ['draft'] },
};

async function setup() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-aws-'));
  const selected = path.join(base, 'selected');
  await mkdir(selected, { recursive: true });
  const workspace = new WorkspaceRuntime({
    root: path.join(base, 'state'),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    files: null,
  });
  await workspace.initialize();
  await workspace.pick(plugin);
  const accounts = {
    state: { accounts: [] },
    imported: async list => list.map(item => ({ name: item.name, action: 'added' })),
  };
  const importer = new AwsImporter({
    workspace,
    files: null,
    accounts,
    confirmImport: async () => true,
    request: async () => new Response(buildZip(), { status: 200 }),
  });
  return { base, selected, workspace, importer, accounts };
}

function buildZip(extra = []) {
  const zip = new AdmZip();
  zip.addFile('config.yaml', Buffer.from(YAML.stringify({
    title: '测试品牌',
    wechat_appid: 'wx1234567890',
    wechat_appsecret: 'wechat-secret',
    wechat_name: '测试公众号',
    writing_model: { api_key: 'model-secret', model: 'demo' },
    nested: [{ secretKey: 'array-secret', keep: 'visible' }],
    image_model: { accessToken: 'image-token', baseURL: 'https://private.example', model: 'image-demo' },
  })));
  zip.addFile('writing-spec.md', Buffer.from('# 写作规范\n'));
  zip.addFile('presets/formatting/main.css', Buffer.from('.main{}'));
  zip.addFile('presets/cover-styles/cover.md', Buffer.from('# 封面'));
  zip.addFile('presets/components/card.yaml', Buffer.from('name: card\n'));
  zip.addFile('other/ignored.txt', Buffer.from('ignored'));
  for (const name of extra) zip.addFile(name, Buffer.from('bad'));
  return zip.toBuffer();
}

test('AWS import previews config and imports presets without exposing secrets', async () => {
  const f = await setup();
  try {
    const preview = await f.importer.import(plugin, { url: 'https://example.com/bundle.aws', dryRun: true });
    assert.equal(preview.config.action, 'missing-local');
    assert.equal(preview.accounts[0].appIdMasked.includes('wx123'), false);
    assert.ok(preview.accounts[0].appIdMasked);
    assert.ok(preview.presets.some(item => item.path.endsWith('formatting')));
    assert.ok(preview.presets.some(item => item.path.endsWith('components')));
    assert.ok(preview.ignored.includes('other'));
    await assert.rejects(f.importer.import(plugin, { url: 'https://example.com/bundle.aws', dryRun: false }), /确认/);
    const applied = await f.importer.import(plugin, { url: 'https://example.com/bundle.aws', dryRun: false, confirmSecrets: true });
    assert.equal(applied.applied, true);
    assert.equal(applied.importedAccounts, 1);
    assert.equal(await f.workspace.readText(plugin, { path: '.aws-article/writing-spec.md' }), '# 写作规范\n');
    assert.equal(await f.workspace.readText(plugin, { path: '.aws-article/presets/formatting/main.css' }), '.main{}');
    assert.equal(await f.workspace.readText(plugin, { path: '.aws-article/presets/components/card.yaml' }), 'name: card\n');
    const config = YAML.parse(await f.workspace.readText(plugin, { path: '.aws-article/config.yaml' }));
    assert.equal(config.wechat_appid, undefined);
    assert.equal(config.wechat_appsecret, undefined);
    assert.equal(config.writing_model, undefined);
    assert.equal(config.image_model, undefined);
    assert.deepEqual(config.nested, [{ keep: 'visible' }]);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('AWS import requires host confirmation and leaves local files unchanged when cancelled', async () => {
  const f = await setup();
  try {
    await f.workspace.mkdir(plugin, { path: '.aws-article/presets/formatting' });
    await f.workspace.writeText(plugin, {
      path: '.aws-article/presets/formatting/main.css',
      text: '.local{}',
      overwrite: false,
    });
    await f.workspace.writeText(plugin, {
      path: '.aws-article/writing-spec.md',
      text: '# 本地规范\n',
      overwrite: false,
    });
    const importer = new AwsImporter({
      workspace: f.workspace,
      files: null,
      accounts: f.accounts,
      confirmImport: async () => false,
      request: async () => new Response(buildZip(), { status: 200 }),
    });
    await assert.rejects(
      importer.import(plugin, { url: 'https://example.com/bundle.aws', dryRun: false, confirmSecrets: true }),
      /取消/,
    );
    assert.equal(await f.workspace.readText(plugin, { path: '.aws-article/presets/formatting/main.css' }), '.local{}');
    assert.equal(await f.workspace.readText(plugin, { path: '.aws-article/writing-spec.md' }), '# 本地规范\n');
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('AWS import rejects account credentials for a workspace-only plugin', async () => {
  const f = await setup();
  try {
    const workspaceOnly = { ...plugin, permissions: { workspace: true, files: true } };
    await assert.rejects(
      f.importer.import(workspaceOnly, { url: 'https://example.com/bundle.aws', dryRun: false, confirmSecrets: true }),
      /草稿能力/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('AWS import rolls file changes back when account persistence fails', async () => {
  const f = await setup();
  try {
    await f.workspace.mkdir(plugin, { path: '.aws-article/presets/formatting' });
    await f.workspace.writeText(plugin, {
      path: '.aws-article/presets/formatting/main.css',
      text: '.before{}',
      overwrite: false,
    });
    await f.workspace.writeText(plugin, {
      path: '.aws-article/writing-spec.md',
      text: '# 旧规范\n',
      overwrite: false,
    });
    const importer = new AwsImporter({
      workspace: f.workspace,
      files: null,
      accounts: {
        state: { accounts: [] },
        imported: async () => { throw new Error('credential store unavailable'); },
      },
      confirmImport: async () => true,
      request: async () => new Response(buildZip(), { status: 200 }),
    });
    await assert.rejects(
      importer.import(plugin, { url: 'https://example.com/bundle.aws', dryRun: false, confirmSecrets: true }),
      /credential store unavailable/,
    );
    assert.equal(await f.workspace.readText(plugin, { path: '.aws-article/presets/formatting/main.css' }), '.before{}');
    assert.equal(await f.workspace.readText(plugin, { path: '.aws-article/writing-spec.md' }), '# 旧规范\n');
    await assert.rejects(f.workspace.readText(plugin, { path: '.aws-article/config.yaml' }), /ENOENT/);
    const entries = await readdir(path.join(f.selected, '.aws-article'));
    assert.equal(entries.some(name => name.startsWith('.import-')), false);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('AWS import rejects path traversal and symlink-like archives', async () => {
  const f = await setup();
  try {
    const traversalZip = new AdmZip();
    traversalZip.addFile('aa/escape.txt', Buffer.from('bad'));
    const traversalBytes = Buffer.from(traversalZip.toBuffer().toString('latin1').replaceAll('aa/escape.txt', '../escape.txt'), 'latin1');
    const bad = new AwsImporter({
      workspace: f.workspace,
      files: null,
      accounts: f.accounts,
      request: async () => new Response(traversalBytes, { status: 200 }),
    });
    await assert.rejects(bad.import(plugin, { url: 'https://example.com/bad.aws', dryRun: true }), /越界|绝对|无效/);
    const symlinkZip = new AdmZip();
    const entry = symlinkZip.addFile('link', Buffer.from('target'));
    entry.attr = (0o120777 << 16) >>> 0;
    const symlinkImporter = new AwsImporter({ workspace: f.workspace, files: null, accounts: f.accounts, request: async () => new Response(symlinkZip.toBuffer(), { status: 200 }) });
    await assert.rejects(symlinkImporter.import(plugin, { url: 'https://example.com/link.aws', dryRun: true }), /符号链接/);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
