import { describe, expect, it } from 'vitest';
import { assistantModelLabel, isChatModel, normalizeAIAddress, providerForAddress } from './ai-providers';

describe('AI provider presets', () => {
  it('matches saved addresses with or without the v1 suffix', () => {
    expect(normalizeAIAddress('https://api.siliconflow.cn/v1/')).toBe('https://api.siliconflow.cn');
    expect(providerForAddress('https://api.siliconflow.cn/v1')?.name).toBe('硅基流动');
    expect(providerForAddress('https://api.deepseek.com/')).toMatchObject({ name: 'DeepSeek' });
    expect(providerForAddress('https://custom.example.com/v1')).toBeNull();
  });

  it('excludes non-chat catalogs and labels known models without exposing raw ids', () => {
    for (const id of ['text-embedding-3-large', 'rerank-v2', 'whisper-large-v3', 'gpt-image-2.5', 'nano-banana-pro', 'seedance-video']) {
      expect(isChatModel({ id })).toBe(false);
    }
    expect(isChatModel({ id: 'deepseek-flash' })).toBe(true);
    expect(isChatModel({ id: 'deepseek-v4-flash' })).toBe(true);
    expect(isChatModel({ id: 'gpt-5.4', type: 'language' })).toBe(true);
    expect(assistantModelLabel('https://api.deepseek.com', 'deepseek-v4-flash')).toBe('DeepSeek · DeepSeek V4 Flash');
    expect(assistantModelLabel('https://api.deepseek.com', 'deepseek-flash')).toBe('DeepSeek · DeepSeek Flash');
    expect(assistantModelLabel('https://custom.example.com', 'team-private-chat')).toBe('team-private-chat');
  });
});
