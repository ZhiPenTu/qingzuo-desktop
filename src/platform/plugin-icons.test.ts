import { describe, expect, it } from 'vitest';
import { resolvePluginIcon } from './plugin-icons';

describe('built-in plugin icons', () => {
  it('provides artwork for the first-party plugins without a packaged icon', () => {
    for (const id of ['official.ai-assistant', 'official.diagnostics']) {
      expect(resolvePluginIcon(id, undefined, { tier: 'platform', source: 'market' })).toBeTruthy();
    }
  });

  it('keeps untrusted or local plugins on the category fallback', () => {
    for (const trust of [{ tier: 'community', source: 'market' }, { tier: 'platform', source: 'local' }] as const) {
      expect(resolvePluginIcon('official.diagnostics', undefined, trust)).toBeUndefined();
    }
  });

  it('always prefers an icon supplied by the plugin or the reviewed catalog', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    expect(resolvePluginIcon('official.diagnostics', icon, { tier: 'platform', source: 'market' })).toBe(icon);
  });
});
