import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('official site filters community plugins by official publisher', async () => {
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
          { id: 'official.fixture', title: '官方工具', description: '官方维护', category: '效率工具', version: '1.0.0' },
          { id: 'community.fixture', title: '社区工具', description: '社区维护', category: '效率工具', version: '1.0.0' },
        ],
      }),
    };
  };

  await import('../../site/assets/site.js');
  await new Promise(resolve => setTimeout(resolve, 20));

  const filterButtons = () => [...document.querySelectorAll('[data-market-filters] button')];
  assert.ok(!filterButtons().some(button => button.textContent.startsWith('内置插件')));
  assert.ok(filterButtons().some(button => button.textContent.startsWith('社区插件')));

  filterButtons().find(button => button.textContent.startsWith('社区插件')).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(filterButtons().some(button => button.textContent.startsWith('官方插件')));
  filterButtons().find(button => button.textContent.startsWith('非官方插件')).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  const grid = document.querySelector('[data-market-grid]');
  assert.match(grid.textContent, /社区工具/);
  assert.doesNotMatch(grid.textContent, /官方工具/);

  filterButtons().find(button => button.textContent.startsWith('官方插件')).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.match(grid.textContent, /官方工具/);
  assert.doesNotMatch(grid.textContent, /社区工具/);
});
