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
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'gpt-image-2.5', type: 'image' }, { id: 'fixture-tool-model', display_name: 'Fixture Tool Model' }] }));
      return;
    }
    const body = JSON.parse(input); requests.push(body);
    if (!body.stream) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return; }
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
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, '工具中心.png') });
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); dialog.showMessageBox = async () => ({ response: 1 }); }, artifact);
    await page.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '选择一个服务商', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '共享图像能力', exact: true })).toBeVisible();
    await expect(page.getByText('AI 批图', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '配置共享密钥', exact: true }).click();
    const googleImageRow = page.locator('.ai-image-key-row').filter({ has: page.getByLabel('Google 官方访问密钥', { exact: true }) });
    await page.getByLabel('Google 官方访问密钥', { exact: true }).fill('fixture-google-image');
    await googleImageRow.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.ai-image-provider-row').filter({ hasText: 'Google 官方' })).toContainText('已配置');
    await expect(page.getByRole('list', { name: '可用图片模型', exact: true })).toContainText('Nano Banana 2.1');
    expect((await page.evaluate(() => window.commerceDesktop.invoke('ai.imageStatus'))).google).toMatchObject({ configured: true, source: 'dedicated' });
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, '共享图像能力.png') });
    await googleImageRow.getByRole('button', { name: '清除', exact: true }).click();
    await expect(page.locator('.ai-image-provider-row').filter({ hasText: 'Google 官方' })).toContainText('未配置');
    await page.getByRole('button', { name: /自定义服务/ }).click();
    await page.getByLabel('服务地址', { exact: true }).fill('http://127.0.0.1:' + server.address().port);
    await page.getByLabel('访问密钥', { exact: true }).fill('fixture');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(1, 1));
    for (const [width, height] of [[1440, 900], [1280, 720], [700, 900], [390, 844]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height]);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720));
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI设置连接向导.png') });
    await page.getByRole('button', { name: '连接并启用', exact: true }).click();
    await expect(page.getByLabel('AI 助手状态', { exact: true })).toBeVisible();
    await expect(page.getByText('AI 助手已连接 自定义服务', { exact: true })).toBeVisible();
    await expect(page.getByText('已读取 2 个模型，AI 对话和插件会选择可用的文本模型自行接入。', { exact: true })).toBeVisible();
    const modelList = page.getByRole('list', { name: '可用模型列表', exact: true });
    await expect(modelList).toContainText('Fixture Tool Model');
    await expect(modelList).toContainText('gpt-image-2.5');
    const imageModelList = page.getByRole('list', { name: '可用图片模型', exact: true });
    await expect(imageModelList).toContainText('gpt-image-2.5');
    await page.getByRole('button', { name: '测试模型 fixture-tool-model', exact: true }).click();
    await expect(page.getByText(/连接正常 · \d+ ms/)).toBeVisible();
    await expect(page.getByText('回复：OK', { exact: true })).toBeVisible();
    expect(requests.some(request => !request.stream && request.model === 'fixture-tool-model')).toBe(true);
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI模型目录与测试.png') });
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) {
      await imageModelList.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, '可用图片模型.png') });
    }
    if (process.env.QINGZUO_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI设置概览.png') });
    await expect(page.getByRole('button', { name: '登录 Codex' })).not.toBeVisible();
    for (const [width, height] of [[1440, 900], [1280, 720], [700, 900], [390, 844]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height]);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const geometry = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
      expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720));
    await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
    await expect(page.locator('.commerce-heading')).toHaveCount(0); await expect(page.locator('.commerce-topbar')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '今天，想让工作轻一点？' })).toBeVisible();
    await expect(page.getByLabel('对话模型', { exact: true })).toHaveValue('fixture-tool-model');
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
