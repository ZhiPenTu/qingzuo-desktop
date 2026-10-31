import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AISettings } from './AISettings';

interface MockStatus {
  mode: string;
  address: string;
  running: boolean;
  model?: string;
  verified?: string[];
  ready?: boolean;
  error: string | null;
}

const unconfigured: MockStatus = { mode: 'external', address: 'http://127.0.0.1:8317', running: true, ready: false, error: null };
const enabled: MockStatus = { mode: 'external', address: 'https://api.deepseek.com', running: true, ready: true, error: null };
const unconfiguredImages = {
  google: { configured: false, source: 'none' },
  openai: { configured: false, source: 'none' },
  proxy: { configured: false },
};

function mockDesktop(options: { status?: MockStatus; setup?: (args: Record<string, unknown>) => unknown; models?: () => unknown; imageStatus?: typeof unconfiguredImages; configureImage?: (args: Record<string, unknown>) => unknown } = {}) {
  let status = structuredClone(options.status ?? unconfigured);
  let imageStatus = structuredClone(options.imageStatus ?? unconfiguredImages);
  const invoke = vi.fn(async (method: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'ai.status') return structuredClone(status);
    if (method === 'ai.setup') {
      if (options.setup) return options.setup(args ?? {});
      status = { ...enabled, address: String(args?.address ?? enabled.address) };
      return { ok: true, status: structuredClone(status), models: [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }] };
    }
    if (method === 'ai.models') return options.models ? options.models() : [{ id: 'deepseek-flash', title: 'DeepSeek Flash' }, { id: 'deepseek-chat', title: 'DeepSeek Chat' }];
    if (method === 'ai.imageStatus') return structuredClone(imageStatus);
    if (method === 'ai.configureImage') {
      if (options.configureImage) return options.configureImage(args ?? {});
      imageStatus = { ...imageStatus, [String(args?.provider)]: { configured: true, source: 'dedicated' } };
      return structuredClone(imageStatus);
    }
    if (method === 'openExternal') return true;
    throw new Error('unexpected method ' + method);
  });
  window.commerceDesktop = { invoke, onChanged: () => () => {} } as NonNullable<Window['commerceDesktop']>;
  return invoke;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); delete window.commerceDesktop; });

it('starts on a single-page provider wizard without the old configuration hierarchy', async () => {
  mockDesktop(); render(<AISettings />);
  await screen.findByRole('heading', { name: '选择一个服务商' });
  expect(screen.getByRole('button', { name: /DeepSeek/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: /^OpenAI/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /硅基流动/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /自定义服务/ })).toBeTruthy();
  expect(screen.getByLabelText('访问密钥')).toBeTruthy();
  expect(screen.queryByText('配置概览')).toBeNull();
  expect(screen.queryByRole('button', { name: '代理连接' })).toBeNull();
  expect(screen.queryByLabelText('AI 助手状态')).toBeNull();
  expect(screen.queryByRole('heading', { name: '图像编辑' })).toBeNull();
  expect(screen.getByRole('heading', { name: '共享图像能力' })).toBeTruthy();
  expect(screen.queryByText(/AI 批图/)).toBeNull();
});

it('shows the key on demand and opens the provider key page', async () => {
  const invoke = mockDesktop(); render(<AISettings />);
  const key = await screen.findByLabelText('访问密钥') as HTMLInputElement;
  expect(key.type).toBe('password');
  fireEvent.change(key, { target: { value: 'sk-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '显示访问密钥' }));
  expect(key.type).toBe('text');
  fireEvent.click(screen.getByRole('button', { name: '隐藏访问密钥' }));
  expect(key.type).toBe('password');
  fireEvent.click(screen.getByRole('button', { name: '如何获取' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('openExternal', { url: 'https://platform.deepseek.com/api_keys' }));
});

it('connects without choosing a model and reads the available model catalog', async () => {
  const invoke = mockDesktop(); const onOpenChat = vi.fn();
  render(<AISettings onOpenChat={onOpenChat} />);
  fireEvent.change(await screen.findByLabelText('访问密钥'), { target: { value: 'sk-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '连接并启用' }));
  await screen.findByLabelText('AI 助手状态');
  expect(invoke).toHaveBeenCalledWith('ai.setup', { address: 'https://api.deepseek.com', apiKey: 'sk-secret' });
  expect(invoke).toHaveBeenCalledWith('ai.models', undefined);
  expect(screen.getByText('AI 助手已连接 DeepSeek')).toBeTruthy();
  expect(screen.getByText('已读取 2 个模型，AI 对话和插件会选择可用的文本模型自行接入。')).toBeTruthy();
  expect(screen.queryByLabelText('指定模型（可选）')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '开始 AI 对话' }));
  expect(onOpenChat).toHaveBeenCalledOnce();
});

it('configures shared image credentials without naming a plugin', async () => {
  const invoke = mockDesktop(); render(<AISettings />);
  await screen.findByRole('heading', { name: '共享图像能力' });
  expect(screen.getByText('兼容服务').closest('.ai-image-provider-row')?.textContent).toContain('未配置');
  fireEvent.click(screen.getByRole('button', { name: '配置共享密钥' }));
  const key = await screen.findByLabelText('Google 官方访问密钥') as HTMLInputElement;
  expect(key.type).toBe('password');
  fireEvent.change(key, { target: { value: 'image-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '显示Google 官方访问密钥' }));
  expect(key.type).toBe('text');
  fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0]);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai.configureImage', { provider: 'google', apiKey: 'image-secret' }));
  await screen.findByText('已配置');
  expect(screen.queryByText(/AI 批图/)).toBeNull();
});

it('shows a shared compatible connection and lets an old image key be cleared', async () => {
  const invoke = mockDesktop({
    imageStatus: {
      google: { configured: true, source: 'legacy' },
      openai: { configured: true, source: 'inherited' },
      proxy: { configured: true },
    },
    configureImage: () => ({
      google: { configured: false, source: 'none' },
      openai: { configured: true, source: 'inherited' },
      proxy: { configured: true },
    }),
  });
  render(<AISettings />);
  await waitFor(() => expect(screen.getByText('兼容服务').closest('.ai-image-provider-row')?.textContent).toContain('已配置'));
  expect(screen.getByText('正在使用旧版保存的密钥')).toBeTruthy();
  expect(screen.getByText('沿用上方连接')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '配置共享密钥' }));
  fireEvent.click(screen.getByRole('button', { name: '清除' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai.configureImage', { provider: 'google', clear: true }));
});

it('shows a concise enabled state and lets the user replace the service', async () => {
  mockDesktop({ status: enabled }); render(<AISettings />);
  await screen.findByLabelText('AI 助手状态');
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: '开始 AI 对话' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更换服务' }));
  await screen.findByRole('heading', { name: '选择一个服务商' });
  expect((screen.getByLabelText('访问密钥') as HTMLInputElement).placeholder).toContain('留空继续使用已保存的密钥');
  expect(screen.getByRole('button', { name: '连接并启用' })).toBeTruthy();
});

it('recognizes an older enabled status without the ready field', async () => {
  const { ready: _ready, ...legacyEnabled } = { ...enabled, model: 'deepseek-flash', verified: ['deepseek-flash'] };
  mockDesktop({ status: legacyEnabled }); render(<AISettings />);
  await screen.findByLabelText('AI 助手状态');
  expect(screen.getByText('AI 助手已连接 DeepSeek')).toBeTruthy();
});

it('surfaces a saved but unverified configuration with one completion action', async () => {
  mockDesktop({ status: { ...unconfigured, model: 'team-private-chat', verified: [] } }); render(<AISettings />);
  await screen.findByText('已保存，尚未启用');
  expect(screen.getByRole('button', { name: '完成启用' })).toBeTruthy();
  expect(screen.getByLabelText('服务地址')).toBeTruthy();
  expect(screen.queryByLabelText('指定模型（可选）')).toBeNull();
});

it.each([
  ['invalid_key', '访问密钥无效，请检查后重新粘贴。'],
  ['forbidden', '这个密钥没有调用所选服务的权限，请在服务商后台检查权限。'],
  ['incompatible_address', '服务地址不兼容，请检查是否填写了 OpenAI 兼容接口地址。'],
  ['rate_limited', '请求过于频繁或额度不足，请稍后再试，或检查服务商账户。'],
  ['network_timeout', '连接超时，请检查网络后重试。'],
])('renders actionable %s failures without raw status codes', async (code, message) => {
  mockDesktop({ setup: () => ({ ok: false, code, message }) }); render(<AISettings />);
  fireEvent.change(await screen.findByLabelText('访问密钥'), { target: { value: 'sk-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '连接并启用' }));
  await screen.findByText(message);
  expect(screen.getByText(message).textContent).not.toMatch(/\b(401|403|404|429)\b/);
  expect(screen.queryByLabelText('AI 助手状态')).toBeNull();
});

it('supports a custom OpenAI-compatible address without a model field', async () => {
  const invoke = mockDesktop({
    setup: args => ({ ok: true, status: { ...enabled, address: String(args.address), ready: true } }),
    models: () => [{ id: 'team-private-chat', title: '私有对话模型' }, { id: 'team-private-json', title: '私有 JSON 模型' }],
  });
  render(<AISettings />);
  fireEvent.click(await screen.findByRole('button', { name: /自定义服务/ }));
  await screen.findByLabelText('服务地址');
  fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://gateway.example.com/v1' } });
  fireEvent.change(screen.getByLabelText('访问密钥'), { target: { value: 'sk-custom' } });
  fireEvent.click(screen.getByRole('button', { name: '连接并启用' }));
  await screen.findByLabelText('AI 助手状态');
  expect(invoke).toHaveBeenCalledWith('ai.setup', { address: 'https://gateway.example.com/v1', apiKey: 'sk-custom' });
  expect(screen.getByText('已读取 2 个模型，AI 对话和插件会选择可用的文本模型自行接入。')).toBeTruthy();
});

it('retries a failed settings read without replacing the saved configuration', async () => {
  let attempts = 0;
  const invoke = vi.fn(async (method: string) => {
    if (method === 'ai.imageStatus') return unconfiguredImages;
    if (method !== 'ai.status') throw new Error('unexpected');
    attempts++;
    if (attempts === 1) throw new Error('fixture read failure');
    return enabled;
  });
  window.commerceDesktop = { invoke, onChanged: () => () => {} } as NonNullable<Window['commerceDesktop']>;
  render(<AISettings />);
  await screen.findByText('暂时无法读取 AI 设置');
  expect(screen.getByText(/原有设置不会因此被修改/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
  await screen.findByLabelText('AI 助手状态');
  expect(attempts).toBe(2);
});
