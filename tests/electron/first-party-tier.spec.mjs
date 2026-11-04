import { test, expect, _electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installMarketFixture, prepareMarketFixture } from './market-fixture.mjs';

const assistantPlugin = {
  id: 'official.ai-assistant',
  title: 'AI 助手',
  description: '在独立插件界面中使用共享 AI 服务',
  category: '效率工具',
  tier: 'official',
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

test('an installed official first-party plugin upgrades to platform when the reviewed catalog changes', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-tier-desktop-'));
  const market = await prepareMarketFixture([assistantPlugin]);
  const executablePath = process.env.QINGZUO_HOST_EXECUTABLE;
  let app;
  try {
    app = await _electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: [
        ...(executablePath ? [] : [process.cwd()]),
        '--user-data-dir=' + path.join(temporary, 'profile'),
      ],
    });
    const page = await app.firstWindow();
    await expect(page.getByText('工具服务已就绪')).toBeVisible();
    const installed = async () => (await page.evaluate(() => window.commerceDesktop.invoke('status')))
      .plugins.find(candidate => candidate.id === 'official.ai-assistant');

    await installMarketFixture(app, page, market, ['official.ai-assistant']);
    await expect.poll(async () => (await installed())?.tier).toBe('official');

    await page.evaluate(() => window.commerceDesktop.invoke('view.open', { id: 'official.ai-assistant', settings: true }));
    await expect.poll(() => app.context().pages()
      .find(candidate => candidate.url().startsWith('commerce-plugin://official.ai-assistant/settings/'))).toBeTruthy();
    const settings = app.context().pages()
      .find(candidate => candidate.url().startsWith('commerce-plugin://official.ai-assistant/settings/'));
    const invokeSettings = () => settings.evaluate(async () => {
      try {
        return { ok: true, value: await window.commercePlugin.invoke('firstParty.assistant.settings.imageStatus') };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) };
      }
    });

    expect(await invokeSettings()).toMatchObject({ ok: false });

    await installMarketFixture(app, page, {
      ...market,
      catalog: { ...market.catalog, plugins: market.catalog.plugins.map(plugin => ({ ...plugin, tier: 'platform' })) },
    }, []);

    const upgraded = await invokeSettings();
    expect(upgraded.ok).toBe(true);
    expect(upgraded.value).toBeTruthy();
    await expect.poll(async () => (await installed())?.tier).toBe('platform');
  } finally {
    await app?.close();
    await market.restore();
    await rm(temporary, { recursive: true, force: true });
  }
});
