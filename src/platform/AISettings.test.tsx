import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AISettings } from './AISettings';

function mockDesktop(model = '') {
  let status = { mode: 'external', address: 'http://127.0.0.1:8317', model, running: true, verified: [] as string[], error: null };
  const invoke = vi.fn(async (method: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'ai.status') return { ...status };
    if (method === 'ai.configure') { status = { ...status, ...args }; return { ...status }; }
    if (method === 'ai.models') return [{ id: 'fixture-model' }, { id: 'gpt-image-2.5' }];
    if (method === 'ai.verify') { status.verified = [status.model]; return status; }
    return { saved: true };
  });
  window.commerceDesktop = { invoke, onChanged: () => () => {} } as NonNullable<Window['commerceDesktop']>;
  return invoke;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); delete window.commerceDesktop; });

it('starts with hierarchy and only shows the selected configuration level', async () => {
  mockDesktop(); const onOpenChat = vi.fn(), onOpenImage = vi.fn();
  render(<AISettings imageAvailable onOpenImage={onOpenImage} onOpenChat={onOpenChat} />);
  expect(screen.getByLabelText('配置概览')).toBeTruthy();
  expect(screen.queryByLabelText('代理访问密钥')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '打开对话' })); expect(onOpenChat).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '图像 API' }));
  fireEvent.click(screen.getByRole('button', { name: '配置图像 API' })); expect(onOpenImage).toHaveBeenCalledOnce();
});

it('offers only the external proxy connection and exposes no account, OAuth or provider surface', async () => {
  mockDesktop(); render(<AISettings />);
  for (const removed of ['账户与 API', '轻作内置管理', 'OAuth 登录', 'API Key 接入', '启动代理', '停止代理', '检查代理更新']) {
    expect(screen.queryByRole('button', { name: removed })).toBeNull();
    expect(screen.queryByText(removed)).toBeNull();
  }
  fireEvent.click(screen.getByRole('button', { name: '代理连接' }));
  await screen.findByLabelText('代理地址');
  expect(screen.getByLabelText('代理访问密钥')).toBeTruthy();
});

it('configures external connection with address and key and saves on demand', async () => {
  const invoke = mockDesktop(); render(<AISettings />);
  fireEvent.click(screen.getByRole('button', { name: '代理连接' }));
  await screen.findByDisplayValue('http://127.0.0.1:8317');
  fireEvent.change(screen.getByLabelText('代理地址'), { target: { value: 'https://api.deepseek.com' } });
  fireEvent.change(screen.getByLabelText('代理访问密钥'), { target: { value: 'sk-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '保存连接设置' }));
  await screen.findByText('连接设置已保存');
  expect(invoke).toHaveBeenCalledWith('ai.configure', { mode: 'external', address: 'https://api.deepseek.com', model: '', apiKey: 'sk-secret' });
});

it('requires explicit saving to apply address and key changes', async () => {
  const invoke = mockDesktop(); render(<AISettings />);
  fireEvent.click(screen.getByRole('button', { name: '代理连接' }));
  await screen.findByDisplayValue('http://127.0.0.1:8317');
  fireEvent.change(screen.getByLabelText('代理地址'), { target: { value: 'http://127.0.0.1:9000' } });
  expect(screen.getByRole('status').textContent).toContain('连接方式尚未应用');
  expect(invoke.mock.calls.some(([method]) => method === 'ai.configure')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '保存连接设置' }));
  await screen.findByText('连接设置已保存');
  expect(invoke).toHaveBeenCalledWith('ai.configure', expect.objectContaining({ address: 'http://127.0.0.1:9000' }));
});

it('does not replace an existing image-model selection silently', async () => {
  const invoke = mockDesktop('gpt-image-2.5'); render(<AISettings />);
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
