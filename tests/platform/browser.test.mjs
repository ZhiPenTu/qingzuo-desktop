import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedBrowserUrl, normalizeBrowserUrl, ownedBrowserTabs } from '../../desktop/browser-policy.mjs';
import { candidateKey, normalizeCandidateUrl, publicCandidate, safeFilename } from '../../desktop/browser-detector.mjs';
import { allowedBrowserOrigin, allowedHeaderName, validateManifest, API_VERSION } from '../../packages/plugin-sdk/manifest.mjs';
import { buildActionScript, buildSnapshotScript, buildWaitScript, validateAction, validateWait } from '../../desktop/browser-automation.mjs';

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

test('page automation requires declared origins plus the automate capability', () => {
  const base = { name: 'fixture', version: '0.1.0', commerce: { manifestVersion: 1, id: 'local.automate', title: 'Automate', description: '', api: '^1.3.0', ui: 'ui/index.html', permissions: { browser: ['automate'], browserOrigins: ['https://detail.1688.com'] } } };
  const manifest = validateManifest(base);
  assert.equal(API_VERSION, '1.5.0');
  assert.deepEqual(manifest.permissions.browserOrigins, ['https://detail.1688.com']);
  assert.equal(allowedBrowserOrigin(manifest, 'https://detail.1688.com/offer/1.html').origin, 'https://detail.1688.com');
  assert.throws(() => allowedBrowserOrigin(manifest, 'https://s.1688.com/other'), /没有操作此页面的权限/);
  assert.throws(() => allowedBrowserOrigin(manifest, 'https://user:pass@detail.1688.com/'), /没有操作此页面的权限/);
  assert.throws(() => validateManifest({ ...base, commerce: { ...base.commerce, permissions: { browserOrigins: ['https://detail.1688.com'] } } }), /需要同时申请/);
  for (const origins of [['https://detail.1688.com/'], ['https://detail.1688.com/path'], ['file:///tmp'], ['https://a.example', 'https://a.example']]) {
    assert.throws(() => validateManifest({ ...base, commerce: { ...base.commerce, permissions: { browser: ['automate'], browserOrigins: origins } } }), /浏览器页面权限/, String(origins));
  }
});

test('automation-only plugins can only observe the tabs they opened', () => {
  const tabs = [
    { id: 'browser-1', owner: 'official.shein-full', title: '1688', url: 'https://detail.1688.com/offer/1.html' },
    { id: 'browser-2', title: '用户的其它标签页', url: 'https://example.com/private' },
    { id: 'browser-3', owner: 'other.plugin', title: '别的插件', url: 'https://example.com/other' },
  ];
  assert.deepEqual(ownedBrowserTabs(tabs, 'official.shein-full').map(tab => tab.id), ['browser-1']);
  assert.deepEqual(ownedBrowserTabs(tabs, 'unknown.plugin'), []);
  assert.deepEqual(ownedBrowserTabs(tabs, ''), []);
  assert.deepEqual(ownedBrowserTabs(null, 'official.shein-full'), []);
});

test('custom request headers must be declared and never override transport headers', () => {
  const base = { name: 'fixture', version: '0.1.0', commerce: { manifestVersion: 1, id: 'local.headers', title: 'Headers', description: '', api: '^1.3.0', ui: 'ui/index.html', permissions: { network: ['https://openapi.sheincorp.com'], networkHeaders: ['x-lt-openKeyId', 'x-lt-timestamp', 'x-lt-signature'], credentials: ['shein.secret'], storage: true } } };
  const manifest = validateManifest(base);
  assert.equal(allowedHeaderName(manifest, 'x-lt-signature'), 'x-lt-signature');
  assert.equal(allowedHeaderName(manifest, 'X-LT-Timestamp'), 'X-LT-Timestamp');
  assert.throws(() => allowedHeaderName(manifest, 'x-other'), /未授权/);
  assert.throws(() => allowedHeaderName(manifest, 'authorization'), /请求头无效/);
  assert.throws(() => validateManifest({ ...base, commerce: { ...base.commerce, permissions: { ...base.commerce.permissions, networkHeaders: ['Authorization'] } } }), /请求头权限/);
  assert.throws(() => validateManifest({ ...base, commerce: { ...base.commerce, permissions: { ...base.commerce.permissions, networkHeaders: ['bad header'] } } }), /请求头权限/);
  assert.equal(manifest.permissions.storage, true);
});

test('page actions and waits reject unsafe identifiers and keep user text inert', () => {
  assert.deepEqual(validateAction({ action: 'click', ref: 'qz-12' }), { action: 'click', ref: 'qz-12' });
  assert.deepEqual(validateAction({ action: 'scroll', value: -800 }), { action: 'scroll', value: -800 });
  for (const input of [{ action: 'click', ref: 'qz-1"]' }, { action: 'eval' }, { action: 'type', ref: 'qz-1', value: 5 }, { action: 'scroll', value: 1e9 }]) assert.throws(() => validateAction(input), /无效|不受支持/);
  const injected = "x'); window.pwned = 1; ('";
  assert.doesNotThrow(() => new Function(buildActionScript({ action: 'type', ref: 'qz-3', value: injected })));
  assert.ok(buildActionScript({ action: 'type', ref: 'qz-3', value: injected }).includes('const VALUE = ' + JSON.stringify(injected) + ';'));
  assert.doesNotThrow(() => new Function(buildWaitScript(validateWait({ selector: '.price' }))));
  assert.throws(() => validateWait({ selector: '.price{color:red}' }), /等待条件无效/);
  assert.throws(() => validateWait({}), /等待条件无效/);
  const snapshot = buildSnapshotScript();
  assert.match(snapshot, /password/);
  assert.doesNotThrow(() => new Function(snapshot));
});

