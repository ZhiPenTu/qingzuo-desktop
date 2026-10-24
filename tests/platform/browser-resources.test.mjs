import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicResource, readImageResource, resourceFilename } from '../../desktop/browser-resources.mjs';

const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];
const privateResolve = async () => [{ address: '10.0.0.8', family: 4 }];
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('page resources never reach loopback, private or local hosts', async () => {
  for (const address of ['http://127.0.0.1:8080/image.jpg', 'http://localhost/image.jpg', 'http://[::1]/image.jpg', 'http://10.0.0.8/a.jpg', 'http://router.local/a.jpg', 'file:///etc/passwd', 'https://user:pass@cdn.example/a.jpg']) {
    await assert.rejects(assertPublicResource(address, publicResolve), /图片地址/, address);
  }
  await assert.rejects(assertPublicResource('https://cdn.example/a.jpg', privateResolve), /不可访问/);
  assert.equal((await assertPublicResource('https://cbu01.alicdn.com/img/a.jpg', publicResolve)).origin, 'https://cbu01.alicdn.com');
});

test('image transfer keeps the page referer, bounds size and returns file metadata', async () => {
  let captured = null;
  const resource = await readImageResource({ address: 'https://cbu01.alicdn.com/img/abc.jpg?v=1', referer: 'https://detail.1688.com/offer/1.html', resolve: publicResolve, fetch: async (url, init) => { captured = { url, init }; return new Response(png, { headers: { 'content-type': 'image/jpeg; charset=binary' } }); } });
  assert.equal(captured.url, 'https://cbu01.alicdn.com/img/abc.jpg?v=1');
  assert.equal(captured.init.headers.Referer, 'https://detail.1688.com/offer/1.html');
  assert.equal(captured.init.credentials, 'include');
  assert.equal(resource.mime, 'image/jpeg');
  assert.equal(resource.name, 'abc.jpg');
  assert.deepEqual(resource.bytes, png);

  await assert.rejects(readImageResource({ address: 'https://cbu01.alicdn.com/a.jpg', referer: 'https://detail.1688.com/', resolve: publicResolve, fetch: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) }), /不是图片/);
  await assert.rejects(readImageResource({ address: 'https://cbu01.alicdn.com/a.jpg', referer: 'https://detail.1688.com/', resolve: publicResolve, maxBytes: 2, fetch: async () => new Response(png, { headers: { 'content-type': 'image/png' } }) }), /超过/);
  await assert.rejects(readImageResource({ address: 'https://cbu01.alicdn.com/a.jpg', referer: 'https://detail.1688.com/', resolve: publicResolve, fetch: async () => new Response('', { status: 403 }) }), /403/);
  await assert.rejects(readImageResource({ address: 'https://cbu01.alicdn.com/a.jpg', referer: 'https://detail.1688.com/', resolve: publicResolve, fetch: async () => new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } }) }), /为空/);
  assert.match(resourceFilename('https://cbu01.alicdn.com/img/abc.jpg', 'image/jpeg'), /^abc\.jpg$/);
  assert.equal(resourceFilename('https://cbu01.alicdn.com/a', 'image/png'), 'image-' + resourceFilename('https://cbu01.alicdn.com/a', 'image/png').slice(6));
  assert.match(resourceFilename('https://cbu01.alicdn.com/a', 'image/png'), /^image-[0-9a-f]{8}\.png$/);
});
