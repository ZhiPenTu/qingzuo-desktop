import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AISettings } from './AISettings';

function mockDesktop(mode: 'builtin' | 'external' = 'builtin', model = '') {
  let status = { mode, address: 'http://127.0.0.1:8317', model, version: '8.0.23', running: false, verified: [] as string[], error: null };
  const invoke = vi.fn(async (method: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'ai.status') return { ...status };
    if (method === 'ai.configure') { status = { ...status, ...args }; return { ...status }; }
    if (method === 'ai.models') return [{ id: 'fixture-model' }, { id: 'gpt-image-2.5' }];
    if (method === 'ai.accounts') return [{ name: 'fixture-account', provider: 'codex', status: 'active' }];
    if (method === 'ai.login') return { state: 'fixture-login', status: 'wait' };
    if (method === 'ai.loginStatus') return { status: args?.cancel ? 'canceled' : 'ok' };
    if (method === 'ai.verify') { status.verified = [status.model]; return status; }
    return { saved: true };
  });
  window.commerceDesktop = { invoke, onChanged: () => () => {} } as NonNullable<Window['commerceDesktop']>;
  return invoke;
}
async function accounts() {
  fireEvent.click(screen.getByRole('button', { name: '账户与 API' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '登录 Codex' }).hasAttribute('disabled')).toBe(false));
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); delete window.commerceDesktop; });

it('starts with hierarchy and only shows the selected configuration level', async () => {
  mockDesktop(); const onOpenChat = vi.fn(), onOpenImage = vi.fn();
  render(<AISettings imageAvailable onOpenImage={onOpenImage} onOpenChat={onOpenChat} />);
  expect(screen.getByLabelText('配置概览')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '登录 Codex' })).toBeNull();
  expect(screen.queryByLabelText('提供商 API Key')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '打开对话' })); expect(onOpenChat).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '图像 API' }));
  fireEvent.click(screen.getByRole('button', { name: '配置图像 API' })); expect(onOpenImage).toHaveBeenCalledOnce();
});
it('separates OAuth from API keys and clears unsubmitted credentials on navigation', async () => {
  const invoke = mockDesktop(); render(<AISettings />); await accounts();
  expect(screen.getByRole('button', { name: '登录 Claude' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '登录 Antigravity' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'API Key 接入' }));
  fireEvent.change(screen.getByLabelText('提供商 API Key'), { target: { value: ' fixture-secret ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并接入服务' }));
  await waitFor(() => expect((screen.getByLabelText('提供商 API Key') as HTMLInputElement).value).toBe(''));
  expect(invoke).toHaveBeenCalledWith('ai.provider', { provider: 'compatible', apiKey: 'fixture-secret', baseURL: 'https://api.deepseek.com/v1', models: ['deepseek-chat'] });
  fireEvent.change(screen.getByLabelText('提供商 API Key'), { target: { value: 'unsaved' } });
  fireEvent.click(screen.getByRole('button', { name: '默认模型' }));
  fireEvent.click(screen.getByRole('button', { name: '账户与 API' }));
  expect((screen.getByLabelText('提供商 API Key') as HTMLInputElement).value).toBe('');
  expect(invoke.mock.calls.some(([method]) => method === 'ai.configure')).toBe(false);
});
it('requires explicit saving to change an external connection', async () => {
  const invoke = mockDesktop('external'); render(<AISettings />);
  fireEvent.click(screen.getByRole('button', { name: '账户与 API' }));
  await screen.findByText('外部模式：账户与 OAuth 在外部管理端配置。');
  expect(screen.getByRole('button', { name: '登录 Codex' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '代理连接' }));
  fireEvent.click(screen.getByRole('radio', { name: /轻作内置管理/ }));
  expect(invoke.mock.calls.some(([method]) => method === 'ai.configure')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '保存连接设置' }));
  await screen.findByText('连接设置已保存'); await accounts();
  expect(invoke).toHaveBeenCalledWith('ai.configure', expect.objectContaining({ mode: 'builtin' }));
});
it('cancels a pending OAuth session without a paid request', async () => {
  const invoke = mockDesktop(); render(<AISettings />); await accounts();
  fireEvent.click(screen.getByRole('button', { name: '登录 Codex' }));
  await screen.findByText('正在等待 Codex 浏览器授权…');
  await waitFor(() => expect(screen.getByRole('button', { name: '取消登录' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '取消登录' }));
  await screen.findByText('登录已取消'); expect(invoke).toHaveBeenCalledWith('ai.loginStatus', { state: 'fixture-login', cancel: true });
});
it('keeps OAuth polling across sections and refreshes after success', async () => {
  const invoke = mockDesktop(); render(<AISettings />); await accounts(); vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: '登录 Codex' })); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '默认模型' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  fireEvent.click(screen.getByRole('button', { name: '账户与 API' }));
  expect(screen.getByText('fixture-account')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(invoke.mock.calls.filter(([method]) => method === 'ai.loginStatus')).toHaveLength(1);
});
it('does not replace an existing image-model selection silently', async () => {
  const invoke = mockDesktop('builtin', 'gpt-image-2.5'); render(<AISettings />);
  fireEvent.click(screen.getByRole('button', { name: '默认模型' }));
  await screen.findByText(/当前选择的是图像模型/);
  expect((screen.getByLabelText('助手型号') as HTMLSelectElement).value).toBe('gpt-image-2.5');
  expect(screen.getByRole('button', { name: '验证连接与工具调用' }).hasAttribute('disabled')).toBe(true);
  expect(invoke.mock.calls.some(([method]) => method === 'ai.configure')).toBe(false);
});
it('confirms paid connection tests and never tests greyed image models', async () => {
  const invoke = mockDesktop(), confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); render(<AISettings />);
  fireEvent.click(screen.getByRole('button', { name: '默认模型' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '获取模型' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '获取模型' })); await screen.findByRole('option', { name: 'fixture-model' });
  expect(screen.getByRole('option', { name: 'gpt-image-2.5' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('助手型号'), { target: { value: 'fixture-model' } });
  fireEvent.click(screen.getByRole('button', { name: '验证连接与工具调用' })); expect(confirm).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.some(([method]) => method === 'ai.verify')).toBe(false);
  confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: '验证连接与工具调用' }));
  await screen.findByText('模型连接及工具调用验证通过');
  expect(invoke.mock.calls.filter(([method]) => method === 'ai.verify')).toHaveLength(1);
});
