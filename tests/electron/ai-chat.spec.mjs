import { test, expect, _electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { installMarketFixture, prepareMarketFixture } from './market-fixture.mjs';

const assistantPlugin = {
  id: 'official.ai-assistant',
  title: 'AI 助手',
  description: '在独立插件界面中使用共享 AI 服务',
  category: '效率工具',
  tier: 'platform',
  api: '^1.10.0',
  manifest: {
    ui: 'ui/index.html',
    settings: { title: 'AI 设置', entry: 'settings/index.html' },
  },
  files: {
    'ui/index.html': '<!doctype html><meta charset="utf-8"><h1>AI 对话</h1>',
    'settings/index.html': '<!doctype html><meta charset="utf-8"><h1>AI 设置</h1>',
  },
};

test('official AI assistant bridge uses market trust, native secrets, host-only approvals and persistent sessions', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-chat-desktop-'));
  const cli = path.resolve('packages/plugin-sdk/cli.mjs');
  execFileSync(process.execPath, [cli, 'create', 'chat-echo', '--native'], { cwd: temporary });
  const manifestPath = path.join(temporary, 'chat-echo/package.json');
  const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
  pkg.commerce.assistant = {
    tools: [{
      name: 'echo',
      title: '运行回声',
      description: 'Return given text',
      service: 'local.chat-echo',
      method: 'echo',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 100 } },
        required: ['text'],
        additionalProperties: false,
      },
    }],
  };
  await writeFile(manifestPath, JSON.stringify(pkg));
  const artifact = path.join(temporary, 'fixture.ecplugin');
  execFileSync(process.execPath, [cli, 'pack', path.dirname(manifestPath), artifact]);

  let round = 0;
  const requests = [];
  const server = createServer(async (request, response) => {
    let input = '';
    for await (const bytes of request) input += bytes;
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        data: [
          { id: 'gpt-image-2.5', type: 'image' },
          { id: 'fixture-tool-model', display_name: 'Fixture Tool Model' },
        ],
      }));
      return;
    }
    const body = JSON.parse(input);
    requests.push(body);
    if (!body.stream) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      return;
    }
    round += 1;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const tool = round === 1
      ? { name: 'list_plugins', arguments: '{}' }
      : round === 2
        ? { name: 'call_plugin', arguments: JSON.stringify({ pluginId: 'local.chat-echo', tool: 'echo', args: { text: '真实沙箱回声' } }) }
        : null;
    response.write('data: ' + JSON.stringify({
      choices: [{
        delta: tool
          ? { tool_calls: [{ index: 0, id: 'call-' + round, function: tool }] }
          : { content: '**插件已调用**，真实沙箱回声。' },
        finish_reason: null,
      }],
    }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + server.address().port;
  const market = await prepareMarketFixture([assistantPlugin]);

  let app;
  let serverClosed = false;
  const executablePath = process.env.QINGZUO_HOST_EXECUTABLE;
  async function launch() {
    app = await _electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: [
        ...(executablePath ? [] : [process.cwd()]),
        '--user-data-dir=' + path.join(temporary, 'profile'),
      ],
    });
    const page = await app.firstWindow();
    await expect(page.getByText('工具服务已就绪')).toBeVisible();
    return page;
  }
  const pageFor = prefix => app.context().pages().find(candidate => candidate.url().startsWith(prefix));

  try {
    let page = await launch();
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, artifact);
    await page.evaluate(() => window.commerceDesktop.invoke('plugins.import'));
    await expect.poll(async () => {
      const plugin = (await page.evaluate(() => window.commerceDesktop.invoke('status'))).plugins
        .find(candidate => candidate.id === 'local.chat-echo');
      return plugin && { source: plugin.source, tier: plugin.tier };
    }).toEqual({ source: 'local', tier: 'community' });

    await installMarketFixture(app, page, market, ['official.ai-assistant']);
    await expect.poll(async () => {
      const plugin = (await page.evaluate(() => window.commerceDesktop.invoke('status'))).plugins
        .find(candidate => candidate.id === 'official.ai-assistant');
      return plugin && { source: plugin.source, tier: plugin.tier, enabled: plugin.enabled };
    }).toEqual({ source: 'market', tier: 'platform', enabled: true });

    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 设置', exact: true }).click();
    await expect.poll(() => pageFor('commerce-plugin://official.ai-assistant/settings/')).toBeTruthy();
    const settings = pageFor('commerce-plugin://official.ai-assistant/settings/');
    await expect(settings.getByRole('heading', { name: 'AI 设置', exact: true })).toBeVisible();

    const textPrompt = app.waitForEvent('window', { timeout: 10000 });
    const textSetup = settings.evaluate(serviceAddress => window.commercePlugin.invoke(
      'firstParty.assistant.settings.beginTextSetup',
      { address: serviceAddress },
    ), address);
    const textPromptPage = await textPrompt;
    await expect(textPromptPage.getByRole('heading', { name: '连接 AI 服务', exact: true })).toBeVisible();
    await textPromptPage.getByLabel('访问密钥', { exact: true }).fill('electron-text-secret');
    await textPromptPage.getByRole('button', { name: '连接并验证', exact: true }).click();
    const textSetupResult = await textSetup;
    expect(textSetupResult.ok).toBe(true);
    expect(textSetupResult.models.map(model => model.id)).toContain('fixture-tool-model');

    const settingsStatus = await settings.evaluate(() => window.commercePlugin.invoke('firstParty.assistant.settings.status'));
    expect(settingsStatus).toMatchObject({ mode: 'external', address, connected: true, ready: true });
    expect(JSON.stringify(settingsStatus)).not.toContain('electron-text-secret');
    expect(await settings.evaluate(() => window.commercePlugin.invoke('firstParty.assistant.settings.models')))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fixture-tool-model' })]));
    expect(await settings.evaluate(() => window.commercePlugin.invoke(
      'firstParty.assistant.settings.testModel',
      { model: 'fixture-tool-model' },
    ))).toMatchObject({ ok: true, model: 'fixture-tool-model', response: 'OK' });

    const imagePrompt = app.waitForEvent('window', { timeout: 10000 });
    const imageSetup = settings.evaluate(() => window.commercePlugin.invoke(
      'firstParty.assistant.settings.beginImageKeySetup',
      { provider: 'google' },
    ));
    const imagePromptPage = await imagePrompt;
    await expect(imagePromptPage.getByRole('heading', { name: '配置共享图像服务', exact: true })).toBeVisible();
    await imagePromptPage.getByLabel('Google 官方访问密钥', { exact: true }).fill('electron-image-secret');
    await imagePromptPage.getByRole('button', { name: '保存密钥', exact: true }).click();
    expect(await imageSetup).toMatchObject({ google: { configured: true } });
    expect(await settings.evaluate(() => window.commercePlugin.invoke('firstParty.assistant.settings.imageStatus')))
      .toMatchObject({ google: { configured: true } });
    expect(await settings.evaluate(() => window.commercePlugin.invoke('firstParty.assistant.settings.imageModels')))
      .toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ id: 'gemini-nano-banana-2.1' })]) });
    await settings.evaluate(() => window.commercePlugin.invoke(
      'firstParty.assistant.settings.clearImageKey',
      { provider: 'google' },
    ));
    expect(await settings.evaluate(() => window.commercePlugin.invoke('firstParty.assistant.settings.imageStatus')))
      .toMatchObject({ google: { configured: false } });

    await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
    await expect.poll(() => pageFor('commerce-plugin://official.ai-assistant/ui/')).toBeTruthy();
    const chat = pageFor('commerce-plugin://official.ai-assistant/ui/');
    await expect(chat.getByRole('heading', { name: 'AI 对话', exact: true })).toBeVisible();
    const tools = await chat.evaluate(() => window.commercePlugin.invoke('firstParty.assistant.chat.tools'));
    const echoPlugin = tools.find(plugin => plugin.id === 'local.chat-echo');
    expect(echoPlugin?.tools).toEqual(expect.arrayContaining([{ name: 'echo', title: '运行回声' }]));
    expect(JSON.stringify(echoPlugin)).not.toContain('parameters');
    await chat.evaluate(() => {
      window.__assistantEvents = [];
      window.commercePlugin.onAI(event => window.__assistantEvents.push(event));
    });
    const created = await chat.evaluate(() => window.commercePlugin.invoke(
      'firstParty.assistant.chat.create',
      { model: 'fixture-tool-model' },
    ));
    expect(created).toMatchObject({ state: 'idle', model: 'fixture-tool-model' });
    expect(created).not.toHaveProperty('approvals');
    const chatId = created.id;

    await app.evaluate(({ dialog }) => {
      globalThis.__approvalOptions = [];
      globalThis.__releaseApproval = null;
      dialog.showMessageBox = async (_window, options) => {
        if (options?.title === '确认 AI 插件调用') {
          globalThis.__approvalOptions.push(options);
          return new Promise(resolve => {
            globalThis.__releaseApproval = () => resolve({ response: 1 });
          });
        }
        return { response: 1 };
      };
    });
    const sending = chat.evaluate(id => window.commercePlugin.invoke(
      'firstParty.assistant.chat.send',
      { id, text: '请调用回声插件', model: 'fixture-tool-model' },
    ), chatId);
    await expect.poll(() => app.evaluate(() => globalThis.__approvalOptions.length)).toBe(1);

    const waiting = await chat.evaluate(id => window.commercePlugin.invoke('firstParty.assistant.chat.status', { id }), chatId);
    expect(waiting).toMatchObject({ id: chatId, state: 'running', waitingForApproval: true });
    expect(waiting).not.toHaveProperty('approvals');
    expect(JSON.stringify(waiting)).not.toContain('真实沙箱回声');
    const approvalOptions = await app.evaluate(() => globalThis.__approvalOptions[0]);
    expect(approvalOptions.message).toContain('运行回声');
    expect(approvalOptions.detail).toContain('真实沙箱回声');
    await expect(chat.evaluate(id => window.commercePlugin.invoke(
      'firstParty.assistant.chat.approve',
      { id, approvalId: 'forbidden', approve: true },
    ), chatId)).rejects.toThrow(/第一方能力未授权/);

    await app.evaluate(() => globalThis.__releaseApproval());
    await sending;
    await expect.poll(async () => (
      await chat.evaluate(id => window.commercePlugin.invoke('firstParty.assistant.chat.status', { id }), chatId)
    ).state).toBe('idle');
    const completed = await chat.evaluate(id => window.commercePlugin.invoke('firstParty.assistant.chat.status', { id }), chatId);
    const toolRecord = completed.history.find(entry => entry.role === 'tool' && entry.tool === 'call_plugin');
    expect(toolRecord).toMatchObject({ tool: 'call_plugin', pluginId: 'local.chat-echo', state: 'succeeded' });
    expect(toolRecord).not.toHaveProperty('text');
    const events = await chat.evaluate(() => window.__assistantEvents);
    expect(events.some(event => event.type === 'assistant-delta')).toBe(true);
    expect(events.some(event => event.type === 'assistant')).toBe(true);
    expect(events.every(event => event.type === 'assistant-delta' || event.type === 'assistant')).toBe(true);
    expect(events.every(event => !('approvals' in event))).toBe(true);

    const second = await chat.evaluate(() => window.commercePlugin.invoke(
      'firstParty.assistant.chat.create',
      { model: 'fixture-tool-model' },
    ));
    await chat.evaluate(id => window.commercePlugin.invoke('firstParty.assistant.chat.delete', { id }), second.id);
    expect(await chat.evaluate(() => window.commercePlugin.invoke('firstParty.assistant.chat.list'))).toHaveLength(1);
    expect(requests.filter(request => request.stream)).toHaveLength(3);

    if (process.env.QINGZUO_UI_EVIDENCE_DIR) {
      await settings.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI设置插件.png') });
      await chat.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI对话插件.png') });
    }

    await app.close();
    app = null;
    await new Promise(resolve => server.close(resolve));
    serverClosed = true;

    page = await launch();
    await expect.poll(async () => {
      const plugin = (await page.evaluate(() => window.commerceDesktop.invoke('status'))).plugins
        .find(candidate => candidate.id === 'official.ai-assistant');
      return plugin && { source: plugin.source, tier: plugin.tier };
    }).toEqual({ source: 'market', tier: 'platform' });
    await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
    await expect.poll(() => pageFor('commerce-plugin://official.ai-assistant/ui/')).toBeTruthy();
    const restored = pageFor('commerce-plugin://official.ai-assistant/ui/');
    const chats = await restored.evaluate(() => window.commercePlugin.invoke('firstParty.assistant.chat.list'));
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ id: chatId, state: 'idle' });
  } finally {
    await app?.close().catch(() => {});
    await market.restore();
    if (!serverClosed) await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
