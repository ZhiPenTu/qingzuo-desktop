import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { boundedDownload } from '../../desktop/plugin-manager.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const requests = [];
  return {
    requests,
    request: async (url, options) => {
      requests.push(String(url));
      return fetch('http://127.0.0.1:' + server.address().port + new URL(url).pathname, options);
    },
    idleTimeoutMs: 600, totalTimeoutMs: 3000,
  };
}

test('healthy streamed downloads can outlast the idle deadline and report initial, throttled and final bytes', async t => {
  const bytes = Buffer.from('abcdefg'), states = [];
  const options = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-length': bytes.length });
    let position = 0;
    res.write(bytes.subarray(position, ++position));
    const timer = setInterval(() => {
      res.write(bytes.subarray(position, ++position));
      if (position === bytes.length) { clearInterval(timer); res.end(); }
    }, 100);
    res.on('close', () => clearInterval(timer));
  });
  const started = Date.now();
  const result = await boundedDownload('https://fixture.example/plugin', 100, undefined, { ...options, idleTimeoutMs: 350, onProgress: state => states.push(state) });
  assert.deepEqual(result, bytes); assert.ok(Date.now() - started > 350);
  assert.deepEqual(states[0], { transferred: 0, total: 7 });
  assert.deepEqual(states.at(-1), { transferred: 7, total: 7 });
  assert.ok(states.length >= 3 && states.length <= 4);
  assert.ok(states.slice(1).every((state, index) => state.transferred >= states[index].transferred));
});

test('stalled streams fail on idle timeout and release the connection', async t => {
  let closed;
  const close = new Promise(resolve => { closed = resolve; });
  const options = await fixture(t, (_req, res) => { res.writeHead(200); res.write('a'); res.on('close', closed); });
  await assert.rejects(boundedDownload('https://fixture.example/stalled', 100, undefined, { ...options, idleTimeoutMs: 120 }), /长时间没有响应/);
  await close;
});

test('healthy streams remain bounded by an overall deadline', async t => {
  const options = await fixture(t, (_req, res) => {
    res.writeHead(200); res.write('a');
    const timer = setInterval(() => res.write('a'), 50);
    res.on('close', () => clearInterval(timer));
  });
  await assert.rejects(boundedDownload('https://fixture.example/endless', 100, undefined, { ...options, totalTimeoutMs: 180 }), /最长允许时间/);
});

test('external cancellation retains its reason and works before and during a request', async t => {
  const options = await fixture(t, (_req, res) => { res.writeHead(200); res.write('a'); });
  const before = new AbortController(), reason = new Error('application closing'); before.abort(reason);
  await assert.rejects(boundedDownload('https://fixture.example/plugin', 100, before.signal, options), error => error === reason);
  assert.equal(options.requests.length, 0);
  const during = new AbortController();
  await assert.rejects(boundedDownload('https://fixture.example/plugin', 100, during.signal, { ...options, onProgress: () => during.abort(reason) }), error => error === reason);
});

test('both declared and streamed size limits cancel the body', { timeout: 5000 }, async t => {
  const closed = new Set(), closing = [];
  const options = await fixture(t, (req, res) => {
    closing.push(new Promise(resolve => res.on('close', () => { closed.add(req.url); resolve(); })));
    res.writeHead(200, req.url === '/declared' ? { 'content-length': 1000 } : {});
    res.write('oversized');
  });
  await assert.rejects(boundedDownload('https://fixture.example/declared', 4, undefined, options), /内容过大/);
  await assert.rejects(boundedDownload('https://fixture.example/streamed', 4, undefined, options), /内容过大/);
  await Promise.all(closing);
  assert.ok(closed.has('/declared') && closed.has('/streamed'));
});

test('redirects preserve HTTPS, reject URL credentials and have a finite hop limit', async t => {
  const options = await fixture(t, (req, res) => {
    const locations = { '/good': 'https://fixture.example/result', '/insecure': 'http://fixture.example/result', '/credentials': 'https://name:password@fixture.example/result', '/loop': '/loop' };
    if (locations[req.url]) { res.writeHead(302, { location: locations[req.url] }); res.end(); }
    else res.end('safe');
  });
  assert.equal((await boundedDownload('https://fixture.example/good', 100, undefined, options)).toString(), 'safe');
  for (const address of ['insecure', 'credentials']) await assert.rejects(boundedDownload('https://fixture.example/' + address, 100, undefined, options), /HTTPS/);
  await assert.rejects(boundedDownload('https://fixture.example/loop', 100, undefined, options), /重定向无效/);
  assert.equal(options.requests.filter(address => address.endsWith('/loop')).length, 6);
});
