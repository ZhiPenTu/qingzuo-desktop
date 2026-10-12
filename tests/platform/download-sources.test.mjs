import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DownloadSourceService,
  MAX_CUSTOM_MIRRORS,
  normalizeCustomMirrorUrl,
  rewriteDownloadUrl,
} from '../../desktop/download-sources.mjs';

test('normalizes custom HTTPS mirror prefixes and rejects unsafe or built-in URLs', () => {
  assert.equal(normalizeCustomMirrorUrl('https://mirror.example.com/proxy'), 'https://mirror.example.com/proxy/');
  assert.equal(normalizeCustomMirrorUrl('https://mirror.example.com///'), 'https://mirror.example.com/');
  assert.throws(() => normalizeCustomMirrorUrl('http://mirror.example.com/'), /HTTPS/);
  assert.throws(() => normalizeCustomMirrorUrl('https://localhost/'), /本机或内网/);
  assert.throws(() => normalizeCustomMirrorUrl('https://127.0.0.1/'), /本机或内网/);
  assert.throws(() => normalizeCustomMirrorUrl('https://gh-proxy.com/'), /内置源/);
});

test('rewrites GitHub URLs for built-in and custom download sources', () => {
  const releaseUrl = 'https://github.com/ZhiPenTu/qingzuo-desktop/releases/download/v0.3.2/CommerceTools-0.3.2-mac-arm64.zip';
  const rawUrl = 'https://raw.githubusercontent.com/ZhiPenTu/qingzuo-desktop/main/catalog.json';
  const apiUrl = 'https://api.github.com/repos/ZhiPenTu/qingzuo-desktop/releases/latest';

  assert.equal(rewriteDownloadUrl(releaseUrl, 'github'), releaseUrl);
  assert.equal(rewriteDownloadUrl(releaseUrl, 'gh-proxy'), `https://gh-proxy.com/${releaseUrl}`);
  assert.equal(rewriteDownloadUrl(releaseUrl, 'gh-fast'), `https://ghfast.top/${releaseUrl}`);
  assert.equal(
    rewriteDownloadUrl(releaseUrl, 'custom:https://mirror.example.com/gh'),
    `https://mirror.example.com/gh/${releaseUrl}`,
  );
  assert.equal(
    rewriteDownloadUrl(rawUrl, 'gitcode'),
    'https://raw.gitcode.com/ZhiPenTu/qingzuo-desktop/raw/main/catalog.json',
  );
  assert.equal(
    rewriteDownloadUrl(apiUrl, 'gitcode'),
    'https://api.gitcode.com/api/v5/repos/ZhiPenTu/qingzuo-desktop/releases/latest',
  );
});

test('persists download sources, manages custom mirrors, and falls back when the active source fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-download-sources-'));
  try {
    let notifications = 0;
    const calls = [];
    const service = new DownloadSourceService({
      root,
      changed: () => { notifications += 1; },
      fetchImpl: async url => {
        calls.push(String(url));
        if (String(url).startsWith('https://mirror.example.com/')) {
          throw new Error('mirror offline');
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await service.initialize();
    assert.equal(service.snapshot().source, 'github');

    const afterAdd = await service.addCustomMirror('https://mirror.example.com');
    assert.equal(afterAdd.source, 'custom:https://mirror.example.com/');
    assert.deepEqual(afterAdd.customMirrors, ['https://mirror.example.com/']);
    assert.ok(notifications > 0);

    const response = await service.fetch('https://api.github.com/repos/ZhiPenTu/qingzuo-desktop/releases/latest');
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^https:\/\/mirror\.example\.com\//);
    assert.match(calls[1], /^https:\/\/gh-proxy\.com\//);
    assert.equal(service.snapshot().source, 'gh-proxy');
    assert.match(service.snapshot().notice ?? '', /已自动切换至 GitHub 镜像 · gh-proxy\.com/);

    const reloaded = new DownloadSourceService({ root });
    const snapshot = await reloaded.initialize();
    assert.equal(snapshot.source, 'gh-proxy');
    assert.deepEqual(snapshot.customMirrors, ['https://mirror.example.com/']);

    await reloaded.setSource('custom:https://mirror.example.com/');
    const afterRemove = await reloaded.removeCustomMirror('https://mirror.example.com/');
    assert.equal(afterRemove.source, 'github');
    assert.deepEqual(afterRemove.customMirrors, []);

    for (let index = 0; index < MAX_CUSTOM_MIRRORS; index++) {
      await reloaded.addCustomMirror(`https://mirror-${index}.example.com/`);
    }
    await assert.rejects(() => reloaded.addCustomMirror('https://mirror-extra.example.com/'), /最多可添加/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
