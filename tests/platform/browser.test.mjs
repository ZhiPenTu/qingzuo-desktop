import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedBrowserUrl, normalizeBrowserUrl } from '../../desktop/browser-policy.mjs';
import { candidateKey, normalizeCandidateUrl, publicCandidate, safeFilename } from '../../desktop/browser-detector.mjs';
import { validateManifest } from '../../packages/plugin-sdk/manifest.mjs';

test('browser navigation accepts complete HTTP(S) URLs and rejects non-web schemes', () => {
  assert.equal(normalizeBrowserUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.equal(normalizeBrowserUrl(' http://127.0.0.1:8080/ '), 'http://127.0.0.1:8080/');
  for (const value of ['', 'example.com', 'javascript:alert(1)', 'file:///tmp/page.html', 'data:text/html,hello', 'https://user:pass@example.com']) {
    assert.equal(isAllowedBrowserUrl(value), false, value);
    assert.throws(() => normalizeBrowserUrl(value), /HTTP 或 HTTPS/);
  }
});

test('browser media candidates keep private source URLs out of public state', () => {
  const sourceUrl = 'https://cdn.example/video.mp4?token=secret';
  assert.equal(normalizeCandidateUrl(sourceUrl, 'https://example.com/page'), sourceUrl);
  assert.equal(normalizeCandidateUrl('blob:https://example.com/id', 'https://example.com/page'), null);
  assert.equal(normalizeCandidateUrl('https://user:pass@example.com/video.mp4', 'https://example.com/page'), null);
  assert.equal(safeFilename('我的/视频', sourceUrl, 'video'), '我的_视频.mp4');
  const publicValue = publicCandidate({ id: 'candidate-1', tabId: 'browser-1', type: 'video', title: '视频', pageUrl: 'https://example.com', sourceUrl, thumbnailUrl: null, status: 'ready', reason: null });
  assert.equal(publicValue.id, 'candidate-1');
  assert.equal('sourceUrl' in publicValue, false);
  const privateThumbnail = publicCandidate({ id: 'candidate-2', tabId: 'browser-1', type: 'image', title: '图片', pageUrl: 'https://example.com/page?session=secret', sourceUrl, thumbnailUrl: 'https://cdn.example/image.jpg?token=secret', status: 'ready', reason: null });
  assert.equal(privateThumbnail.pageUrl, 'https://example.com/page');
  assert.equal('thumbnailUrl' in privateThumbnail, false);
  assert.equal(candidateKey({ sourceUrl, type: 'video', title: '视频', pageUrl: 'https://example.com', thumbnailUrl: null }), candidateKey({ sourceUrl, type: 'video', title: '其他标题', pageUrl: 'https://different.example', thumbnailUrl: null }));
});

test('browser permission declarations are explicit and validated', () => {
  const base = { name: 'fixture', version: '0.1.0', commerce: { manifestVersion: 1, id: 'local.browser', title: 'Browser', description: '', api: '^1.0.0', ui: 'ui/index.html', permissions: { browser: ['detect', 'download'] } } };
  assert.deepEqual(validateManifest(base).permissions.browser, ['detect', 'download']);
  assert.throws(() => validateManifest({ ...base, commerce: { ...base.commerce, permissions: { browser: ['read'] } } }), /浏览器权限/);
});

