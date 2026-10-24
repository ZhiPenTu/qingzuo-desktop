import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileBroker, NetworkBroker, resolveSaveExtension, hasValidSaveExtension, ensureSaveExtension, resolveSaveFilters } from '../../desktop/brokers.mjs';
const plugin = { id: 'local.a', title: 'Fixture', permissions: { files: true, credentials: ['removebg'], network: ['https://api.remove.bg'] } };
test('file tokens are private per plugin and become invalid on disposal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-files-')); const files = new FileBroker(root, {});
  try { const file = await files.create(plugin, Buffer.from('test'), 'a.png', 'image/png'); assert.equal((await files.read(plugin, file.token)).data, Buffer.from('test').toString('base64')); await assert.rejects(files.read({ ...plugin, id: 'local.b' }, file.token)); await files.revoke(plugin.id); await assert.rejects(files.read(plugin, file.token)); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('closing a tool invalidates in-flight file creation and restart removes orphaned temporary files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-file-disposal-')), files = new FileBroker(root, {});
  try {
    const pending = files.create(plugin, Buffer.from('late'), 'late.png', 'image/png');
    await files.revoke(plugin.id);
    await assert.rejects(pending, /失效/);
    assert.equal(files.tokens.size, 0);
    const item = await files.create(plugin, Buffer.from('orphan'), 'orphan.png', 'image/png');
    const filename = (await files.get(plugin, item.token)).filename;
    const restarted = new FileBroker(root, {}); await restarted.initialize();
    await assert.rejects(access(filename));
    const selected = path.join(root, 'selected.png');
    await mkdir(root);
    await writeFile(selected, 'image');
    restarted.dialog = { showOpenDialog: async () => { await restarted.revoke(plugin.id); return { canceled: false, filePaths: [selected] }; } };
    await assert.rejects(restarted.pick(plugin), /失效/);
    assert.equal(restarted.tokens.size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generic response limits distinguish ordinary and private file responses without retrying', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-limits-')), files = new FileBroker(root, {});
  let calls = 0, length = 9 * 1024 ** 2;
  const broker = new NetworkBroker(files, {}, async () => { calls++; return new Response(Buffer.alloc(length)); });
  try {
    const options = { url: 'https://api.remove.bg/data' };
    await assert.rejects(broker.call(plugin, options));
    const result = await broker.call(plugin, { ...options, responseType: 'file' });
    assert.equal(result.file.size, length);
    length = 65 * 1024 ** 2;
    await assert.rejects(broker.call(plugin, { ...options, responseType: 'file' }));
    assert.equal(calls, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('network broker validates endpoint, isolates secrets, saves PNG and never retries failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-net-')); const files = new FileBroker(root, {}); const file = await files.create(plugin, Buffer.from('image'), 'a.png', 'image/png'); let calls = 0;
  const opts = { url: 'https://api.remove.bg/v1.0/removebg', fileToken: file.token, credential: 'removebg' };
  const broker = new NetworkBroker(files, { get: async () => 'fixture-secret' }, async (url, request) => { calls++; assert.equal(url, opts.url); assert.equal(request.redirect, 'error'); assert.equal(request.headers['X-Api-Key'], 'fixture-secret'); return new Response(Buffer.from([137,80,78,71,13,10,26,10,1]), { headers: { 'content-type': 'image/png' } }); });
  try { const result = await broker.call(plugin, opts); assert.equal(result.mime, 'image/png'); assert.equal(calls, 1); await assert.rejects(broker.call(plugin, { ...opts, url: 'https://attacker.example' })); assert.equal(calls, 1);
    const denied = new NetworkBroker(files, { get: async () => 'fixture-secret' }, async () => { calls++; return new Response('', { status: 402 }); }); await assert.rejects(denied.call(plugin, opts), /额度不足/); assert.equal(calls, 2);
    const missing = new NetworkBroker(files, { get: async () => null }, () => { throw new Error('must not fetch'); }); await assert.rejects(missing.call(plugin, opts), /配置/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('cancelled HTTP task is not automatically resubmitted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commerce-cancel-')); const files = new FileBroker(root, {}), file = await files.create(plugin, Buffer.from('image'), 'a.png', 'image/png'); let calls = 0;
  const broker = new NetworkBroker(files, { get: async () => 'fixture-secret' }, async (_url, request) => { calls++; return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))); });
  try { const task = broker.call(plugin, { url: 'https://api.remove.bg/v1.0/removebg', fileToken: file.token, credential: 'removebg', taskId: 'test' }); await new Promise(r => setTimeout(r, 50)); assert.equal(calls, 1); broker.cancel(plugin.id, 'test'); await assert.rejects(task, /取消/); assert.equal(calls, 1); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('generic declared online services use scoped credentials and return bounded data',async()=>{
 const p={...plugin,permissions:{...plugin.permissions,network:['https://tools.example.com']}},broker=new NetworkBroker(null,{get:async()=> 'fixture'},async(url,request)=>{assert.equal(url,'https://tools.example.com/task');assert.equal(request.headers.Authorization,'Bearer fixture');assert.equal(request.body,'{"input":1}');return new Response('{"output":2}');});
 const result=await broker.call(p,{url:'https://tools.example.com/task',method:'POST',json:{input:1},credential:'removebg'});assert.equal(result.status,200);assert.equal(Buffer.from(result.data,'base64').toString(),'{"output":2}');await assert.rejects(broker.call(p,{url:'https://tools.example.com/task',credential:'unscoped'}));
});
test('private resource URLs and release reject other plugin tokens', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-resource-')), files = new FileBroker(root, {});
  try {
    const item = await files.create(plugin, Buffer.from('image'), 'image.png', 'image/png');
    assert.equal(await files.url(plugin, item.token), 'commerce-plugin://' + plugin.id + '/__files/' + item.token);
    await assert.rejects(files.url({ ...plugin, id: 'local.other' }, item.token));
    await assert.rejects(files.release({ ...plugin, id: 'local.other' }, item.token));
    await files.release(plugin, item.token);
    await assert.rejects(files.read(plugin, item.token));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('generic multipart uploads scope credentials, preserve HTTP errors and produce file tokens', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-multipart-')), files = new FileBroker(root, {});
  let calls = 0;
  const broker = new NetworkBroker(files, { get: async () => 'private' }, async (_url, request) => {
    calls++;
    assert.equal(request.headers['X-Api-Key'], 'private');
    assert.equal(request.body.get('format'), 'png');
    assert.equal(await request.body.get('image').text(), 'input');
    return new Response('quota', { status: 402, headers: { 'Content-Type': 'text/plain' } });
  });
  try {
    const input = await files.create(plugin, Buffer.from('input'), 'input.png', 'image/png');
    const options = { url: 'https://api.remove.bg/v1.0/removebg', method: 'POST', credential: 'removebg', credentialHeader: 'X-Api-Key', multipart: { fields: { format: 'png' }, files: [{ field: 'image', token: input.token }] }, responseType: 'file' };
    const result = await broker.call(plugin, options);
    assert.equal(result.status, 402);
    assert.equal(Buffer.from((await files.read(plugin, result.file.token)).data, 'base64').toString(), 'quota');
    await assert.rejects(broker.call(plugin, { ...options, json: {} }));
    await assert.rejects(broker.call({ ...plugin, id: 'local.other' }, options));
    const oversized = await files.create(plugin, Buffer.alloc(26 * 1024 ** 2), 'large', 'application/octet-stream');
    await assert.rejects(broker.call(plugin, { ...options, multipart: { files: [{ field: 'image', token: oversized.token }] } }), /25 MB/);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('save helper functions resolve extensions, validation, and filters', () => {
  assert.equal(resolveSaveExtension('label.pdf', 'application/pdf'), 'pdf');
  assert.equal(resolveSaveExtension('label', 'application/pdf'), 'pdf');
  assert.equal(resolveSaveExtension('文具新大 70.40', 'application/pdf'), 'pdf');
  assert.equal(resolveSaveExtension('image.png', 'image/png'), 'png');
  assert.equal(resolveSaveExtension('image', 'image/png'), 'png');
  assert.equal(resolveSaveExtension('photo.jpeg', 'image/jpeg'), 'jpeg');
  assert.equal(resolveSaveExtension('photo', 'image/jpeg'), 'jpg');
  assert.equal(resolveSaveExtension('photo.webp', 'image/webp'), 'webp');
  assert.equal(resolveSaveExtension('archive.zip', 'application/octet-stream'), 'zip');
  assert.equal(resolveSaveExtension('file', 'application/octet-stream'), null);

  assert.equal(hasValidSaveExtension('label.pdf', 'pdf'), true);
  assert.equal(hasValidSaveExtension('label.PDF', 'pdf'), true);
  assert.equal(hasValidSaveExtension('image.png', 'png'), true);
  assert.equal(hasValidSaveExtension('photo.jpg', 'jpeg'), true);
  assert.equal(hasValidSaveExtension('photo.jpeg', 'jpg'), true);
  assert.equal(hasValidSaveExtension('label', 'pdf'), false);
  assert.equal(hasValidSaveExtension('label.doc', 'pdf'), false);

  assert.equal(ensureSaveExtension('label.pdf', 'pdf'), 'label.pdf');
  assert.equal(ensureSaveExtension('label.PDF', 'pdf'), 'label.PDF');
  assert.equal(ensureSaveExtension('label', 'pdf'), 'label.pdf');
  assert.equal(ensureSaveExtension('label.', 'pdf'), 'label.pdf');
  assert.equal(ensureSaveExtension('label.pdf.', 'pdf'), 'label.pdf');
  assert.equal(ensureSaveExtension('label.PDF.', 'pdf'), 'label.PDF');
  assert.equal(ensureSaveExtension('文具新大 70.40', 'pdf'), '文具新大 70.40.pdf');
  assert.equal(ensureSaveExtension('image.png', 'png'), 'image.png');
  assert.equal(ensureSaveExtension('image', 'png'), 'image.png');

  const pdfFilters = resolveSaveFilters('pdf');
  assert.equal(pdfFilters.length, 2);
  assert.equal(pdfFilters[0].name, 'PDF 文档 (*.pdf)');
  assert.deepEqual(pdfFilters[0].extensions, ['pdf']);
  assert.equal(pdfFilters[1].name, '所有文件 (*.*)');
});

test('FileBroker.save configures save dialog filters and ensures .pdf extension when saving PDF files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-save-test-'));
  const destDir = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-dest-'));
  let showSaveDialogOptions = null;
  const mockDialog = {
    showSaveDialog: async (options) => {
      showSaveDialogOptions = options;
      // Simulate Windows user typing filename without extension
      return { canceled: false, filePath: path.join(destDir, 'exported-label') };
    }
  };
  const files = new FileBroker(root, mockDialog);
  try {
    const pdfContent = Buffer.from('%PDF-1.4 mock content');
    const item = await files.create(plugin, pdfContent, '文具新大 70X40.pdf', 'application/pdf');

    // 1. Save with default suggested name ending in .pdf
    const saved = await files.save(plugin, item.token, '文具新大 70X40 - 已编辑.pdf');
    assert.equal(saved, true);
    assert.equal(showSaveDialogOptions.defaultPath, '文具新大 70X40 - 已编辑.pdf');
    assert.ok(Array.isArray(showSaveDialogOptions.filters));
    assert.equal(showSaveDialogOptions.filters[0].name, 'PDF 文档 (*.pdf)');
    assert.deepEqual(showSaveDialogOptions.filters[0].extensions, ['pdf']);

    // Check that target path on disk got .pdf extension even though dialog returned path without extension
    const savedPdfPath = path.join(destDir, 'exported-label.pdf');
    const savedBytes = await readFile(savedPdfPath);
    assert.deepEqual(savedBytes, pdfContent);

    // 2. Save with filename lacking extension but item having PDF MIME
    const saved2 = await files.save(plugin, item.token, '新标签');
    assert.equal(saved2, true);
    assert.equal(showSaveDialogOptions.defaultPath, '新标签.pdf');

    // Save with filename containing dot dimension (e.g. 70.40) and verify defaultPath is .pdf
    const savedDot = await files.save(plugin, item.token, '文具新大 70.40');
    assert.equal(savedDot, true);
    assert.equal(showSaveDialogOptions.defaultPath, '文具新大 70.40.pdf');

    // 3. User cancels save dialog
    mockDialog.showSaveDialog = async () => ({ canceled: true });
    const canceled = await files.save(plugin, item.token, '文具新大.pdf');
    assert.equal(canceled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  }
});

test('request signing keeps secrets in the main process and rejects undeclared credentials', async () => {
  const signed = { ...plugin, permissions: { ...plugin.permissions, credentials: ['shein.secret'] } };
  const broker = new NetworkBroker(null, { get: async (_id, name) => name === 'shein.secret' ? 'fixture-secret' : null });
  const message = 'openKeyId=key-1&timestamp=1700000000000';
  const hmac = await broker.sign(signed, { credential: 'shein.secret', algorithm: 'hmac-sha256', message });
  assert.equal(hmac.digest, createHmac('sha256', 'fixture-secret').update(message).digest('base64'));
  assert.equal(hmac.encoding, 'base64');
  assert.equal('secret' in hmac, false);
  assert.equal((await broker.sign(signed, { credential: 'shein.secret', algorithm: 'sha256', message: 'abc' })).digest, createHash('sha256').update('abc').digest('base64'));
  await assert.rejects(broker.sign(signed, { credential: 'other', algorithm: 'hmac-sha256', message }), /凭据未授权/);
  await assert.rejects(broker.sign(signed, { credential: 'shein.secret', algorithm: 'md5', message }), /签名算法/);
  await assert.rejects(broker.sign(signed, { credential: 'shein.secret', algorithm: 'hmac-sha256', message: '' }), /签名内容无效/);
  await assert.rejects(new NetworkBroker(null, { get: async () => null }).sign(signed, { credential: 'shein.secret', algorithm: 'hmac-sha256', message }), /配置/);
});

test('signing appends a public suffix to the key without exposing the secret', async () => {
  const scoped = { ...plugin, permissions: { ...plugin.permissions, credentials: ['shein.secret-key'] } };
  const broker = new NetworkBroker(null, { get: async () => 'SECRET' }, async () => new Response('{}'));
  const plain = await broker.sign(scoped, { credential: 'shein.secret-key', algorithm: 'hmac-sha256', message: 'openKeyId&1&/open-api/goods/x' });
  const suffixed = await broker.sign(scoped, { credential: 'shein.secret-key', algorithm: 'hmac-sha256', message: 'openKeyId&1&/open-api/goods/x', keySuffix: 'test1' });
  assert.notEqual(plain.digest, suffixed.digest);
  assert.equal(suffixed.encoding, 'base64');
  assert.equal(JSON.stringify(suffixed).includes('SECRET'), false);
  await assert.rejects(broker.sign(scoped, { credential: 'shein.secret-key', algorithm: 'hmac-sha256', message: 'x', keySuffix: 'bad suffix' }), /签名附加内容无效/);
  await assert.rejects(broker.sign(scoped, { credential: 'shein.secret-key', algorithm: 'sha256', message: 'x', keySuffix: 'a' }), /签名内容无效/);
});

test('declared custom headers reach the request while undeclared ones are refused', async () => {
  const scoped = { ...plugin, permissions: { ...plugin.permissions, network: ['https://openapi.sheincorp.com'], networkHeaders: ['x-lt-openKeyId', 'x-lt-timestamp'] } };
  let captured = null;
  const broker = new NetworkBroker(null, { get: async () => null }, async (_url, request) => { captured = request; return new Response('{"ok":true}'); });
  const result = await broker.call(scoped, { url: 'https://openapi.sheincorp.com/goods/upload-pic', headers: { 'x-lt-openKeyId': 'key-1', 'x-lt-timestamp': '1700000000000' } });
  assert.equal(Buffer.from(result.data, 'base64').toString(), '{"ok":true}');
  assert.equal(captured.headers['x-lt-openKeyId'], 'key-1');
  assert.equal(captured.headers.Accept, 'application/json');
  await assert.rejects(broker.call(scoped, { url: 'https://openapi.sheincorp.com/x', headers: { 'x-other': '1' } }), /未授权/);
  await assert.rejects(broker.call(scoped, { url: 'https://openapi.sheincorp.com/x', headers: { 'x-lt-timestamp': 'a\r\nb' } }), /内容无效/);
  await assert.rejects(broker.call(scoped, { url: 'https://openapi.sheincorp.com/x', headers: ['a'] }), /请求头无效/);
  const jsonBroker = { ...scoped, permissions: { ...scoped.permissions, networkHeaders: ['content-type'] } };
  let jsonHeaders = null;
  const jsonCall = new NetworkBroker(null, { get: async () => null }, async (_url, request) => { jsonHeaders = request.headers; return new Response('{}'); });
  await jsonCall.call(jsonBroker, { url: 'https://openapi.sheincorp.com/x', method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8' }, json: { a: 1 } });
  assert.equal(jsonHeaders['Content-Type'], 'application/json;charset=UTF-8');
  await assert.rejects(jsonCall.call(jsonBroker, { url: 'https://openapi.sheincorp.com/x', method: 'POST', headers: { 'Content-Type': 'text/plain' }, json: { a: 1 } }), /内容无效/);
  await assert.rejects(jsonCall.call(jsonBroker, { url: 'https://openapi.sheincorp.com/x', method: 'POST', headers: { 'Content-Type': 'application/json' }, multipart: { fields: { a: '1' } } }), /内容无效/);
  await assert.rejects(broker.call({ ...scoped, permissions: { ...scoped.permissions, networkHeaders: ['authorization'] } }, { url: 'https://openapi.sheincorp.com/x', headers: { Authorization: 'Bearer x' } }), /请求头无效/);
});
