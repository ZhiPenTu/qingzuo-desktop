import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, TARGET } from '../../desktop/security.mjs';

test('legacy assistant declarations still validate after the chat runtime was removed', () => {
  const manifest = validateManifest({
    name: 'official.legacy',
    version: '1.4.0',
    commerce: {
      manifestVersion: 1,
      id: 'official.legacy',
      title: '旧助手插件',
      description: '仍带对话声明的已安装插件',
      api: '^1.13.0',
      ui: 'ui/index.html',
      permissions: { ai: ['assistant', 'text'] },
      services: { provides: ['legacy.ocr'] },
      backend: { type: 'node', entry: { [TARGET]: 'backend/index.mjs' } },
      assistant: {
        tools: [{
          name: 'legacy_ocr',
          title: '识别文字',
          description: '读取图片中的文字',
          service: 'legacy.ocr',
          method: 'ocr.run',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        }],
      },
    },
  }, TARGET);
  assert.deepEqual(manifest.permissions.ai, ['assistant', 'text']);
  assert.equal(manifest.assistant.tools[0].name, 'legacy_ocr');
});
