import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('official site filters plugins by platform, official and community trust tier', async () => {
  const html = await readFile(new URL('../../site/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://qingzuo.example/', runScripts: 'outside-only' });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.console = { ...console, warn() {} };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.fetch = async url => {
    if (String(url).includes('/releases/latest')) return { ok: false, status: 404 };
    return {
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        plugins: [
          { id: 'platform.fixture', title: '内置工具', description: '底座维护', category: '效率工具', version: '1.0.0', tier: 'platform', official: true },
          { id: 'official.fixture', title: '官方工具', description: '官方维护', category: '效率工具', version: '1.0.0', tier: 'official', official: true },
          { id: 'community.fixture', title: '社区工具', description: '社区维护', category: '效率工具', version: '1.0.0', tier: 'community', official: false },
          { id: 'official.legacy', title: '旧目录工具', description: '兼容旧目录', category: '效率工具', version: '1.0.0' },
          { id: 'official.demoted', title: '旧降级工具', description: '显式旧字段', category: '效率工具', version: '1.0.0', official: false },
        ],
      }),
    };
  };

  await import('../../site/assets/site.js');
  await new Promise(resolve => setTimeout(resolve, 20));

  const filterButtons = () => [...document.querySelectorAll('[data-market-filters] button')];
  for (const label of ['全部', '底座内置', '官方社区', '第三方']) {
    assert.ok(filterButtons().some(button => button.textContent.startsWith(label)), label);
  }
  assert.ok(!filterButtons().some(button => /内置插件|社区插件|官方插件|非官方插件/.test(button.textContent)));

  const grid = document.querySelector('[data-market-grid]');
  filterButtons().find(button => button.textContent.startsWith('底座内置')).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.match(grid.textContent, /内置工具/);
  assert.doesNotMatch(grid.textContent, /官方工具|社区工具|旧目录工具/);

  filterButtons().find(button => button.textContent.startsWith('第三方')).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.match(grid.textContent, /社区工具/);
  assert.match(grid.textContent, /旧降级工具/);
  assert.doesNotMatch(grid.textContent, /内置工具|官方工具|旧目录工具/);

  filterButtons().find(button => button.textContent.startsWith('官方社区')).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.match(grid.textContent, /官方工具/);
  assert.match(grid.textContent, /旧目录工具/);
  assert.doesNotMatch(grid.textContent, /内置工具|社区工具|旧降级工具/);
});
