import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AISettings } from './AISettings';

interface MockStatus {
  mode: string;
  address: string;
  model: string;
  running: boolean;
  verified: string[];
  ready?: boolean;
  error: string | null;
}

const unconfigured: MockStatus = { mode: 'external', address: 'http://127.0.0.1:8317', model: '', running: true, verified: [], error: null };
const enabled: MockStatus = { mode: 'external', address: 'https://api.deepseek.com', model: 'deepseek-flash', running: true, verified: ['deepseek-flash'], ready: true, error: null };

function mockDesktop(options: { status?: MockStatus; setup?: (args: Record<string, unknown>) => unknown } = {}) {
  let status = structuredClone(options.status ?? unconfigured);
  const invoke = vi.fn(async (method: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'ai.status') return structuredClone(status);
    if (method === 'ai.setup') {
      if (options.setup) return options.setup(args ?? {});
      status = { ...enabled, address: String(args?.address ?? enabled.address), model: String(args?.model || 'deepseek-flash'), verified: [String(args?.model || 'deepseek-flash')] };
      return { ok: true, status: structuredClone(status) };
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

it('connects and enables the assistant with one action using the provider recommendation', async () => {
  const invoke = mockDesktop(); const onOpenChat = vi.fn(), onOpenImage = vi.fn();
  render(<AISettings imageAvailable onOpenChat={onOpenChat} onOpenImage={onOpenImage} />);
  fireEvent.change(await screen.findByLabelText('访问密钥'), { target: { value: 'sk-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '连接并启用' }));
  await screen.findByLabelText('AI 助手状态');
  expect(invoke).toHaveBeenCalledWith('ai.setup', { address: 'https://api.deepseek.com', apiKey: 'sk-secret', preferredModels: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-chat'] });
  expect(screen.getByText('AI 助手已连接 DeepSeek')).toBeTruthy();
  expect(screen.getByText('DeepSeek Flash')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '开始 AI 对话' }));
  fireEvent.click(screen.getByRole('button', { name: '配置图像服务' }));
  expect(onOpenChat).toHaveBeenCalledOnce(); expect(onOpenImage).toHaveBeenCalledOnce();
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
  const { ready: _ready, ...legacyEnabled } = enabled;
  mockDesktop({ status: legacyEnabled }); render(<AISettings />);
  await screen.findByLabelText('AI 助手状态');
  expect(screen.getByText('AI 助手已连接 DeepSeek')).toBeTruthy();
});

it('surfaces a saved but unverified configuration with one completion action', async () => {
  mockDesktop({ status: { ...unconfigured, model: 'team-private-chat', verified: [] } }); render(<AISettings />);
  await screen.findByText('已保存，尚未启用');
  expect(screen.getByRole('button', { name: '完成启用' })).toBeTruthy();
  expect(screen.getByLabelText('服务地址')).toBeTruthy();
  expect(screen.getByLabelText('指定模型（可选）')).toHaveProperty('value', 'team-private-chat');
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

it('offers discovered chat models after a failed tool check and never selects one silently', async () => {
  const invoke = mockDesktop({ setup: () => ({ ok: false, code: 'model_incompatible', message: '这个模型不支持 AI 助手所需的工具调用，请选择其他模型。', models: [{ id: 'team-private-chat', title: '私有对话模型' }, { id: 'gpt-image-2.5' }] }) });
  render(<AISettings />);
  fireEvent.change(await screen.findByLabelText('访问密钥'), { target: { value: 'sk-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '连接并启用' }));
  const select = await screen.findByLabelText('可用模型');
  expect(screen.getByRole('option', { name: '私有对话模型 · team-private-chat' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'gpt-image-2.5' })).toBeNull();
  expect((select as HTMLSelectElement).value).toBe('');
  fireEvent.change(select, { target: { value: 'team-private-chat' } });
  expect((screen.getByLabelText('指定模型（可选）') as HTMLInputElement).value).toBe('team-private-chat');
  expect(screen.getByRole('button', { name: '重新验证' })).toBeTruthy();
  expect(invoke.mock.calls.filter(([method]) => method === 'ai.setup')).toHaveLength(1);
});

it('supports a custom OpenAI-compatible address and explicit model', async () => {
  const invoke = mockDesktop({ setup: args => ({ ok: true, status: { ...enabled, address: String(args.address), model: String(args.model), ready: true } }) });
  render(<AISettings />);
  fireEvent.click(await screen.findByRole('button', { name: /自定义服务/ }));
  await screen.findByLabelText('服务地址');
  fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://gateway.example.com/v1' } });
  fireEvent.change(screen.getByLabelText('指定模型（可选）'), { target: { value: 'team-private-chat' } });
  fireEvent.change(screen.getByLabelText('访问密钥'), { target: { value: 'sk-custom' } });
  fireEvent.click(screen.getByRole('button', { name: '连接并启用' }));
  await screen.findByLabelText('AI 助手状态');
  expect(invoke).toHaveBeenCalledWith('ai.setup', { address: 'https://gateway.example.com/v1', apiKey: 'sk-custom', preferredModels: [], model: 'team-private-chat' });
  expect(screen.getByText('team-private-chat')).toBeTruthy();
});

it('retries a failed settings read without replacing the saved configuration', async () => {
  let attempts = 0;
  const invoke = vi.fn(async (method: string) => {
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
