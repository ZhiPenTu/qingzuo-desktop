import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WechatAccountStore, WechatRuntime, sanitizeWechatHtml } from '../../desktop/wechat.mjs';

const plugin = { id: 'official.wechat-studio', title: '公众号 AI 工作台', permissions: { files: true, workspace: true, wechat: ['draft', 'publish', 'list'] } };

function credentials() {
  const values = new Map();
  return {
    async get(namespace, name) { return values.get(namespace + ':' + name) ?? null; },
    async set(namespace, name, value) { values.set(namespace + ':' + name, value); },
    async clear(namespace, name) { values.delete(namespace + ':' + name); },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-wechat-'));
  const workspaceRoot = path.join(root, 'workspace');
  const articleDir = 'drafts/20261103-demo';
  await mkdir(path.join(workspaceRoot, articleDir), { recursive: true });
  await writeFile(path.join(workspaceRoot, articleDir, 'cover.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(path.join(workspaceRoot, articleDir, 'body.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const workspace = {
    async resolveExisting(_plugin, relative) {
      const filename = path.join(workspaceRoot, relative);
      const { lstat } = await import('node:fs/promises');
      return { filename, info: await lstat(filename) };
    },
  };
  const store = new WechatAccountStore({ root: path.join(root, 'accounts'), credentials: credentials() });
  await store.initialize();
  const account = await store.create({ name: '测试公众号', appId: 'wx1234567890', appSecret: 'secret' });
  const calls = [];
  let tokenCalls = 0;
  const request = async (address, options = {}) => {
    const url = new URL(address);
    calls.push({ url, options });
    if (url.pathname === '/cgi-bin/token') {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: 'token-' + tokenCalls, expires_in: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/cgi-bin/material/add_material') return new Response(JSON.stringify({ media_id: 'thumb-1' }), { status: 200 });
    if (url.pathname === '/cgi-bin/media/uploadimg') return new Response(JSON.stringify({ url: 'https://mmbiz.qpic.cn/body.png' }), { status: 200 });
    if (url.pathname === '/cgi-bin/draft/add') return new Response(JSON.stringify({ media_id: 'draft-1' }), { status: 200 });
    if (url.pathname === '/cgi-bin/freepublish/submit') return new Response(JSON.stringify({ publish_id: 'publish-1' }), { status: 200 });
    if (url.pathname === '/cgi-bin/freepublish/get') return new Response(JSON.stringify({ publish_status: 0, article_detail: { item: [{ article_url: 'https://mp.weixin.qq.com/s/demo' }] } }), { status: 200 });
    if (url.pathname === '/cgi-bin/draft/batchget' || url.pathname === '/cgi-bin/freepublish/batchget') return new Response(JSON.stringify({ total_count: 0, item: [] }), { status: 200 });
    throw new Error('unexpected WeChat endpoint ' + url.pathname);
  };
  let confirmations = 0;
  const runtime = new WechatRuntime({
    store,
    workspace,
    files: null,
    confirm: async info => { confirmations += 1; assert.equal(info.accountName, '测试公众号'); assert.equal(info.mode, 'publish'); return true; },
    request,
    root: path.join(root, 'receipts'),
  });
  await runtime.initialize();
  return { root, account, runtime, calls, get confirmations() { return confirmations; }, articleDir };
}

test('WeChat draft uploads cover and body assets, then publishes with confirmation and no duplicate submit', async () => {
  const f = await fixture();
  try {
    const article = {
      articleDir: f.articleDir,
      title: '测试文章',
      author: '轻作',
      digest: '摘要',
      html: '<p>正文</p><img src="qingzuo-asset:body" alt="">',
      cover: { placeholder: 'cover', path: f.articleDir + '/cover.png' },
      assets: [{ placeholder: 'body', path: f.articleDir + '/body.png' }],
    };
    const draft = await f.runtime.createDraft(plugin, { accountId: f.account.id, article });
    assert.equal(draft.mediaId, 'draft-1');
    const draftCall = f.calls.find(call => call.url.pathname === '/cgi-bin/draft/add');
    assert.ok(draftCall);
    const body = JSON.parse(draftCall.options.body);
    assert.match(body.articles[0].content, /https:\/\/mmbiz\.qpic\.cn\/body\.png/);
    assert.doesNotMatch(body.articles[0].content, /qingzuo-asset/);
    const published = await f.runtime.publish(plugin, { accountId: f.account.id, mediaId: draft.mediaId });
    assert.equal(published.publishId, 'publish-1');
    const again = await f.runtime.publish(plugin, { accountId: f.account.id, mediaId: draft.mediaId });
    assert.equal(again.publishId, 'publish-1');
    assert.equal(f.confirmations, 1);
    assert.equal(f.calls.filter(call => call.url.pathname === '/cgi-bin/freepublish/submit').length, 1);
    const status = await f.runtime.publishStatus(plugin, { accountId: f.account.id, publishId: published.publishId });
    assert.equal(status.status, 'success');
    assert.equal(status.articleUrl, 'https://mp.weixin.qq.com/s/demo');
    const list = await f.runtime.list(plugin, { accountId: f.account.id, type: 'draft' });
    assert.deepEqual(list, { total: 0, items: [] });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('WeChat rejects executable HTML, external images and missing placeholders', () => {
  assert.doesNotMatch(sanitizeWechatHtml('<script>alert(1)</script><p>ok</p>', new Map()).html, /script/);
  assert.throws(() => sanitizeWechatHtml('<img src="https://evil.example/x.png">', new Map()), /工作区资产占位符/);
  assert.throws(() => sanitizeWechatHtml('<img src="qingzuo-asset:missing">', new Map()), /不存在/);
  assert.throws(() => sanitizeWechatHtml('<picture><source src="https://evil.example/x.png"><img src="qingzuo-asset:body"></picture>', new Map([['body', 'drafts/body.png']])), /资源标签/);
  assert.equal(sanitizeWechatHtml('<p>ok</p>').html, '<p>ok</p>');
});

test('WeChat keeps profile and mini-program embeds while dropping unsafe attributes', () => {
  const html = '<mp-common-profile data-pluginname="mpprofile" data-nickname="轻作" data-avatar="https://evil.example/a.png" class="profile" leaf="1" onclick="alert(1)"></mp-common-profile><mp-common-miniprogram data-miniprogram-appid="wx123" data-miniprogram-path="pages/index" textvalue="打开小程序" linktype="text"></mp-common-miniprogram>';
  const output = sanitizeWechatHtml(html, new Map()).html;
  assert.match(output, /<mp-common-profile/);
  assert.match(output, /data-nickname="轻作"/);
  assert.match(output, /class="profile"/);
  assert.doesNotMatch(output, /onclick/);
  assert.match(output, /<mp-common-miniprogram/);
  assert.match(output, /textvalue="打开小程序"/);
  assert.match(output, /linktype="text"/);
});

test('WeChat treats an explicit publish rejection as failed rather than unknown', async () => {
  const f = await fixture();
  try {
    const runtime = new WechatRuntime({
      store: f.runtime.store,
      workspace: f.runtime.workspace,
      files: null,
      confirm: async () => true,
      root: f.root + '/rejected-receipts',
      request: async address => {
        const url = new URL(address);
        if (url.pathname === '/cgi-bin/token') return new Response(JSON.stringify({ access_token: 'token', expires_in: 7200 }), { status: 200 });
        if (url.pathname === '/cgi-bin/freepublish/submit') return new Response(JSON.stringify({ errcode: 48001, errmsg: 'api unauthorized' }), { status: 200 });
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });
    await runtime.initialize();
    runtime.drafts.set('draft-rejected', {
      mediaId: 'draft-rejected',
      accountId: f.account.id,
      title: '测试拒绝',
      createdAt: Date.now(),
    });
    await assert.rejects(runtime.publish(plugin, { accountId: f.account.id, mediaId: 'draft-rejected' }), /未开通/);
    assert.equal(runtime.receipts.get(f.account.id + ':draft-rejected').state, 'failed');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('WeChat recovers an interrupted submitting receipt as unknown without resubmitting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-wechat-'));
  const accountId = 'wx-abcdef123456';
  const mediaId = 'draft-restart';
  const key = accountId + ':' + mediaId;
  await writeFile(path.join(root, 'wechat-publish-receipts.json'), JSON.stringify({
    schemaVersion: 1,
    receipts: [{ key, accountId, mediaId, title: '重启发布', state: 'submitting', publishId: null, createdAt: 1 }],
  }));
  let requests = 0;
  let confirmations = 0;
  const runtime = new WechatRuntime({
    store: { find() { throw new Error('should not look up the account'); } },
    workspace: null,
    files: null,
    confirm: async () => { confirmations += 1; return true; },
    request: async () => { requests += 1; throw new Error('must not submit'); },
    root,
  });
  try {
    await runtime.initialize();
    runtime.drafts.set(mediaId, { mediaId, accountId, title: '重启发布', createdAt: 1 });
    const receipt = runtime.receipts.get(key);
    assert.equal(receipt.state, 'unknown');
    assert.match(receipt.error, /公众号后台核对/);
    await assert.rejects(runtime.publish(plugin, { accountId, mediaId }), /结果未知/);
    assert.equal(confirmations, 0);
    assert.equal(requests, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WeChat serializes concurrent publishes into a single submission', async () => {
  const f = await fixture();
  try {
    const mediaId = 'draft-concurrent';
    f.runtime.drafts.set(mediaId, { mediaId, accountId: f.account.id, title: '并发发布', createdAt: Date.now() });
    const results = await Promise.all([
      f.runtime.publish(plugin, { accountId: f.account.id, mediaId }),
      f.runtime.publish(plugin, { accountId: f.account.id, mediaId }),
    ]);
    assert.deepEqual(results.map(result => result.publishId), ['publish-1', 'publish-1']);
    assert.equal(f.confirmations, 1);
    assert.equal(f.calls.filter(call => call.url.pathname === '/cgi-bin/freepublish/submit').length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('WeChat records a transport error as unknown and blocks resubmission', async () => {
  const f = await fixture();
  const mediaId = 'draft-reset';
  const root = path.join(f.root, 'reset-receipts');
  let submits = 0;
  const runtime = new WechatRuntime({
    store: f.runtime.store,
    workspace: f.runtime.workspace,
    files: null,
    confirm: async () => true,
    root,
    request: async address => {
      const url = new URL(address);
      if (url.pathname === '/cgi-bin/token') return new Response(JSON.stringify({ access_token: 'token', expires_in: 7200 }), { status: 200 });
      if (url.pathname === '/cgi-bin/freepublish/submit') {
        submits += 1;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      throw new Error('unexpected WeChat endpoint ' + url.pathname);
    },
  });
  try {
    await runtime.initialize();
    runtime.drafts.set(mediaId, { mediaId, accountId: f.account.id, title: '传输中断', createdAt: Date.now() });
    await assert.rejects(runtime.publish(plugin, { accountId: f.account.id, mediaId }), /socket hang up/);
    const receipt = runtime.receipts.get(f.account.id + ':' + mediaId);
    assert.equal(receipt.state, 'unknown');
    assert.match(receipt.error, /网络中断|结果未知/);
    const saved = JSON.parse(await readFile(path.join(root, 'wechat-publish-receipts.json'), 'utf8'));
    assert.equal(saved.receipts.find(item => item.key === f.account.id + ':' + mediaId).state, 'unknown');
    await assert.rejects(runtime.publish(plugin, { accountId: f.account.id, mediaId }), /结果未知/);
    assert.equal(submits, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
