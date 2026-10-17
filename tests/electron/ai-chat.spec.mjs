import { test, expect, _electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

test('host chat uses public Harness tools, explicit confirmation, sandbox services and persistent sessions', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-chat-desktop-'));
  const cli = path.resolve('packages/plugin-sdk/cli.mjs');
  execFileSync(process.execPath, [cli, 'create', 'chat-echo', '--native'], { cwd: temporary });
  const manifestPath = path.join(temporary, 'chat-echo/package.json');
  const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
  pkg.commerce.assistant = { tools: [{ name: 'echo', title: '运行回声', description: 'Return given text', service: 'local.chat-echo', method: 'echo', parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 100 } }, required: ['text'], additionalProperties: false } }] };
  await writeFile(manifestPath, JSON.stringify(pkg));
  const artifact = path.join(temporary, 'fixture.ecplugin');
  execFileSync(process.execPath, [cli, 'pack', path.dirname(manifestPath), artifact]);
  let round = 0; const requests = [];
  const server = createServer(async (request, response) => {
    let input = ''; for await (const bytes of request) input += bytes;
    const body = JSON.parse(input); requests.push(body);
    if (!body.stream) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'connection_check', arguments: '{"ok":true}' } }] } }] })); return; }
    round++; response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const tool = round === 1 ? { name: 'list_plugins', arguments: '{}' } : round === 2 ? { name: 'call_plugin', arguments: JSON.stringify({ pluginId: 'local.chat-echo', tool: 'echo', args: { text: '真实沙箱回声' } }) } : null;
    response.write('data: ' + JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'call-' + round, function: tool }] } : { content: '**插件已调用**，真实沙箱回声。' }, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app, chatId;
  const executablePath = process.env.QINGZUO_HOST_EXECUTABLE;
  async function launch() {
    app = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [process.cwd()]), '--user-data-dir=' + path.join(temporary, 'profile')] });
    const page = await app.firstWindow(); await expect(page.getByText('工具服务已就绪')).toBeVisible(); return page;
  }
  try {
    let page = await launch();
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); dialog.showMessageBox = async () => ({ response: 1 }); }, artifact);
    await page.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
    await page.evaluate(async address => { await window.commerceDesktop.invoke('ai.configure', { mode: 'external', address, apiKey: 'fixture', model: 'fixture-tool-model' }); await window.commerceDesktop.invoke('ai.verify'); }, 'http://127.0.0.1:' + server.address().port);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 设置', exact: true }).click();
    await expect(page.getByLabel('配置概览', { exact: true })).toBeVisible();
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI设置概览.png') });
    await expect(page.getByRole('button', { name: '登录 Codex' })).not.toBeVisible();
    await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
    await expect(page.locator('.commerce-heading')).toHaveCount(0); await expect(page.locator('.commerce-topbar')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '今天，想让工作轻一点？' })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720));
    await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI对话改版.png') });
    await page.getByRole('button', { name: '规划商品图', exact: true }).click();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('打开 AI 批图，帮我规划白底商品图');
    expect(requests.filter(request => request.stream)).toHaveLength(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(700, 900));
    await page.getByRole('button', { name: '历史对话', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '历史对话', exact: true })).toBeVisible();
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI对话历史抽屉.png') });
    await page.getByRole('button', { name: '关闭面板', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('打开 AI 批图，帮我规划白底商品图');
    const geometry = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth, height: window.innerHeight, composerBottom: document.querySelector('.ai-composer').getBoundingClientRect().bottom }));
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width); expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.height);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(390, 844));
    await expect(page.getByRole('button', { name: '历史对话', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    const narrow = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth })); expect(narrow.documentWidth).toBeLessThanOrEqual(narrow.width);
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI对话窄屏.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720));
    await page.getByLabel('消息', { exact: true }).fill('请调用回声插件'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认调用', exact: true })).toBeVisible();
    await expect(page.getByLabel('插件调用参数')).toContainText('真实沙箱回声');
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, '插件调用确认.png') });
    chatId = (await page.evaluate(() => window.commerceDesktop.invoke('ai.chat.list')))[0].id;
    const before = await page.evaluate(id => window.commerceDesktop.invoke('ai.chat.status', { id }), chatId);
    expect(before.approvals).toHaveLength(1); expect(round).toBe(2);
    await page.getByRole('button', { name: '确认调用', exact: true }).click();
    await expect(page.getByRole('log')).toContainText('插件已调用');
    await expect.poll(async () => (await page.evaluate(id => window.commerceDesktop.invoke('ai.chat.status', { id }), chatId)).state).toBe('idle');
    const completed = await page.evaluate(id => window.commerceDesktop.invoke('ai.chat.status', { id }), chatId);
    expect(completed.history.find(entry => entry.tool === 'call_plugin').text).toContain('真实沙箱回声');
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI对话界面.png') });
    await page.getByRole('button', { name: '新建对话', exact: true }).click(); await expect(page.getByRole('log')).not.toContainText('插件已调用');
    await page.getByRole('button', { name: '历史对话', exact: true }).click();
    await expect(page.getByRole('button', { name: '请调用回声插件', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '请调用回声插件', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('log')).toContainText('插件已调用');
    await app.close(); page = await launch();
    const chats = await page.evaluate(() => window.commerceDesktop.invoke('ai.chat.list')); expect(chats).toHaveLength(2);
    const restored = await page.evaluate(id => window.commerceDesktop.invoke('ai.chat.status', { id }), chatId); expect(restored.history).toEqual(completed.history); expect(restored.approvals).toEqual([]);
    await page.evaluate(() => window.commerceDesktop.invoke('plugins.enable', { id: 'local.chat-echo', enabled: false }));
    expect((await page.evaluate(() => window.commerceDesktop.invoke('ai.chat.tools'))).some(plugin => plugin.id === 'local.chat-echo')).toBe(false);
    expect(requests.filter(request => request.stream)).toHaveLength(3);
  } finally {
    await app?.close().catch(() => {}); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true });
  }
});
