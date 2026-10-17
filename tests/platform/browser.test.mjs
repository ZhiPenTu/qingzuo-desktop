import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedBrowserUrl, normalizeBrowserUrl } from '../../desktop/browser-policy.mjs';

test('browser navigation accepts complete HTTP(S) URLs and rejects non-web schemes', () => {
  assert.equal(normalizeBrowserUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.equal(normalizeBrowserUrl(' http://127.0.0.1:8080/ '), 'http://127.0.0.1:8080/');
  for (const value of ['', 'example.com', 'javascript:alert(1)', 'file:///tmp/page.html', 'data:text/html,hello', 'https://user:pass@example.com']) {
    assert.equal(isAllowedBrowserUrl(value), false, value);
    assert.throws(() => normalizeBrowserUrl(value), /HTTP 或 HTTPS/);
  }
});

