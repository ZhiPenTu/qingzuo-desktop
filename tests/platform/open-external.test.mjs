import test from 'node:test';
import assert from 'node:assert/strict';

function validateExternalUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('链接无效。');
  }
  return true;
}

test('openExternal allows valid https/http URLs and rejects unsafe protocols', () => {
  assert.equal(validateExternalUrl('https://github.com/ZhiPenTu/qingzuo-desktop/issues/new'), true);
  assert.equal(validateExternalUrl('http://example.com'), true);

  for (const invalid of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,test',
    'about:blank',
    '',
    null,
    undefined,
    123,
    'ftp://example.com',
  ]) {
    assert.throws(() => validateExternalUrl(invalid), /链接无效。/);
  }
});
