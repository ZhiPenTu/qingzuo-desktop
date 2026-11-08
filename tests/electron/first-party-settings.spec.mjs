import { test, expect, _electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
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
    ui: 'settings/index.html',
    settings: { title: 'AI 设置', entry: 'settings/index.html' },
    permissions: { ai: ['image-edit', 'text'] },
  },
  files: {
    'settings/index.html': '<!doctype html><meta charset="utf-8"><h1>AI 设置</h1>',
  },
};

test('official AI assistant settings bridge uses market trust and native secrets while chat stays removed', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-ai-settings-desktop-'));
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
    JSON.parse(input);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
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
    const page = await launch();
    await installMarketFixture(app, page, market, ['official.ai-assistant']);
    await expect.poll(async () => {
      const plugin = (await page.evaluate(() => window.commerceDesktop.invoke('status'))).plugins
        .find(candidate => candidate.id === 'official.ai-assistant');
      return plugin && { source: plugin.source, tier: plugin.tier, enabled: plugin.enabled };
    }).toEqual({ source: 'market', tier: 'platform', enabled: true });

    await page.getByRole('button', { name: '工具中心', exact: true }).click();
    await page.getByRole('button', { name: '管理', exact: true }).click();
    await page.getByRole('button', { name: '插件设置', exact: true }).click();
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

    const catalog = await settings.evaluate(() => window.commercePlugin.invoke('ai.textModels'));
    expect(catalog.models.map(model => model.id)).toContain('fixture-tool-model');
    expect(await settings.evaluate(() => window.commercePlugin.invoke('ai.complete', {
      model: 'fixture-tool-model',
      messages: [{ role: 'user', content: 'ping' }],
    }))).toMatchObject({ content: 'OK', model: 'fixture-tool-model' });

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

    await expect(settings.evaluate(() => window.commercePlugin.invoke(
      'firstParty.assistant.chat.send',
      { id: 'removed', text: 'hello' },
    ))).rejects.toThrow(/第一方能力未授权/);
    await expect(settings.evaluate(() => window.commercePlugin.invoke(
      'ai.assistant.send',
      { text: 'hello' },
    ))).rejects.toThrow(/AI 插件接口无效/);
    await expect(page.evaluate(() => window.commerceDesktop.invoke('ai.chat.list'))).rejects.toThrow(/AI 设置接口无效/);

    if (process.env.QINGZUO_UI_EVIDENCE_DIR) {
      await settings.screenshot({ path: path.join(process.env.QINGZUO_UI_EVIDENCE_DIR, 'AI设置插件.png') });
    }
  } finally {
    await app?.close().catch(() => {});
    await market.restore();
    if (!serverClosed) await new Promise(resolve => server.close(resolve));
    serverClosed = true;
    await rm(temporary, { recursive: true, force: true });
  }
});
