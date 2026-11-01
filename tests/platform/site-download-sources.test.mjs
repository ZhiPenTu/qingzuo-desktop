import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeDownloadSource,
  rewriteGitHubUrl,
} from '../../site/assets/download-sources.js';

test('normalizes official site download source selections', () => {
  assert.equal(normalizeDownloadSource('gh-proxy'), 'gh-proxy');
  assert.equal(normalizeDownloadSource('gh-fast'), 'gh-fast');
  assert.equal(normalizeDownloadSource('gitcode'), 'gitcode');
  assert.equal(normalizeDownloadSource('unknown'), 'github');
  assert.equal(normalizeDownloadSource(null), 'github');
});

test('rewrites release assets and API requests for each official site mirror', () => {
  const asset =
    'https://github.com/ZhiPenTu/qingzuo-desktop/releases/download/v0.6.13/CommerceTools-0.6.13-mac-arm64.dmg';
  const api = 'https://api.github.com/repos/ZhiPenTu/qingzuo-desktop/releases/latest';

  assert.equal(rewriteGitHubUrl(asset, 'github'), asset);
  assert.equal(rewriteGitHubUrl(asset, 'gh-proxy'), `https://gh-proxy.com/${asset}`);
  assert.equal(rewriteGitHubUrl(asset, 'gh-fast'), `https://ghfast.top/${asset}`);
  assert.equal(
    rewriteGitHubUrl(asset, 'gitcode'),
    'https://gitcode.com/ZhiPenTu/qingzuo-desktop/releases/download/v0.6.13/CommerceTools-0.6.13-mac-arm64.dmg'
  );
  assert.equal(
    rewriteGitHubUrl(api, 'gitcode'),
    'https://api.gitcode.com/api/v5/repos/ZhiPenTu/qingzuo-desktop/releases/latest'
  );
});

test('leaves non-GitHub URLs untouched', () => {
  const url = 'https://example.com/qingzuo.dmg';
  assert.equal(rewriteGitHubUrl(url, 'gh-proxy'), url);
});

test('handles gist hosts: prefixed mirrors wrap them, gitcode falls back to the original', () => {
  const gist = 'https://gist.githubusercontent.com/ZhiPenTu/abc123/raw/snippet.txt';
  assert.equal(rewriteGitHubUrl(gist, 'gh-proxy'), `https://gh-proxy.com/${gist}`);
  assert.equal(rewriteGitHubUrl(gist, 'gh-fast'), `https://ghfast.top/${gist}`);
  // GitCode 没有对应的 gist 镜像规则，保持原始地址而不是拼出错误的镜像路径。
  assert.equal(rewriteGitHubUrl(gist, 'gitcode'), gist);
  assert.equal(rewriteGitHubUrl(gist, 'github'), gist);
});

test('invalid URLs are returned unchanged rather than throwing', () => {
  assert.equal(rewriteGitHubUrl('not a url', 'gh-proxy'), 'not a url');
});
