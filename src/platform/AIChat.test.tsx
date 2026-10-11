import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AIChat from './AIChat';
import type { ChatEvent, ChatSession } from './harness-client';

function fixture(verified = true) {
  let session: ChatSession = { id: 'fixture-chat', title: '测试对话', model: 'fixture-model', state: 'idle', history: [] };
  let listener: (event: ChatEvent) => void = () => {};
  const invoke = vi.fn(async (method: string, args?: Record<string, unknown>) => {
    if (method === 'ai.status') return { model: 'fixture-model', verified: verified ? ['fixture-model'] : [] };
    if (method === 'ai.chat.list') return [{ id: session.id, title: session.title, state: session.state, updated: 1 }];
    if (method === 'ai.chat.tools') return [{ id: 'local.fixture', title: '示例插件', description: '', tools: [{ name: 'open', title: '打开插件' }] }];
    if (method === 'ai.chat.status' || method === 'ai.chat.create') return structuredClone(session);
    if (method === 'ai.chat.send') { session = { ...session, state: 'running', history: [...session.history, { role: 'user', text: String(args?.text) }] }; return structuredClone(session); }
    if (method === 'ai.chat.cancel') { session = { ...session, state: 'idle', approvals: [] }; return structuredClone(session); }
    return {};
  });
  window.commerceDesktop = { invoke, onChanged: () => () => {}, onAI: callback => { listener = callback; return () => { listener = () => {}; }; } } as NonNullable<Window['commerceDesktop']>;
  return { invoke, emit: (event: ChatEvent) => act(() => listener(event)) };
}
const onOpenPlugin = vi.fn();
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete window.commerceDesktop; localStorage.clear(); });
it('requires model validation and never sends or approves on mount', async () => {
  const { invoke } = fixture(false), settings = vi.fn(); render(<AIChat onSettings={settings} onOpenPlugin={onOpenPlugin} />);
  await screen.findByText(/先接入文本账户/); fireEvent.change(screen.getByLabelText('消息'), { target: { value: 'hello' } });
  expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(true);
  expect(invoke.mock.calls.some(([method]) => method === 'ai.chat.send' || method === 'ai.chat.approve')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '配置文本助手' })); expect(settings).toHaveBeenCalledOnce();
});
it('streams upstream Markdown, handles IME, stops and retains history', async () => {
  const { invoke, emit } = fixture(); render(<AIChat onSettings={vi.fn()} onOpenPlugin={onOpenPlugin} />);
  await waitFor(() => expect(localStorage.getItem('qingzuo.ai-chat.selected.v1')).toBe('fixture-chat')); fireEvent.change(screen.getByLabelText('消息'), { target: { value: '你好' } });
  fireEvent.keyDown(screen.getByLabelText('消息'), { key: 'Enter', isComposing: true }); expect(invoke.mock.calls.some(([method]) => method === 'ai.chat.send')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByRole('button', { name: '停止' });
  emit({ type: 'assistant-delta', chatId: 'fixture-chat', text: '**收到**你的需求' });
  expect(screen.getByText('收到').tagName).toBe('STRONG');
  fireEvent.click(screen.getByRole('button', { name: '停止' })); await screen.findByRole('button', { name: '发送' });
  expect(screen.getByText('你好')).toBeTruthy(); expect(invoke).toHaveBeenCalledWith('ai.chat.cancel', { id: 'fixture-chat' });
});
it('renders exact tool approval parameters and prevents duplicate confirmations', async () => {
  const { invoke, emit } = fixture(); render(<AIChat onSettings={vi.fn()} onOpenPlugin={onOpenPlugin} />); await waitFor(() => expect(localStorage.getItem('qingzuo.ai-chat.selected.v1')).toBe('fixture-chat'));
  emit({ type: 'approvals', chatId: 'fixture-chat', approvals: [{ id: 'approval-id', pluginId: 'local.fixture', pluginTitle: '示例插件', title: '运行工具', tool: 'echo', args: { prompt: '保留文字' }, detail: { model: 'fixture-image', imageCount: 2 } }] });
  expect(screen.getByLabelText('插件调用参数').textContent).toContain('保留文字'); expect(screen.getByLabelText('插件调用参数').textContent).toContain('fixture-image');
  expect(invoke.mock.calls.some(([method]) => method === 'ai.chat.approve')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '确认调用' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '确认调用' })).toBeNull());
  expect(invoke).toHaveBeenCalledWith('ai.chat.approve', { id: 'fixture-chat', approvalId: 'approval-id', approve: true });
  expect(invoke.mock.calls.filter(([method]) => method === 'ai.chat.approve')).toHaveLength(1);
});
it('ignores other sessions and unsubscribes when leaving the view', async () => {
  const { emit } = fixture(); const { unmount } = render(<AIChat onSettings={vi.fn()} onOpenPlugin={onOpenPlugin} />); await waitFor(() => expect(localStorage.getItem('qingzuo.ai-chat.selected.v1')).toBe('fixture-chat'));
  emit({ type: 'assistant-delta', chatId: 'other-chat', text: 'foreign' }); expect(screen.queryByText('foreign')).toBeNull();
  unmount(); emit({ type: 'navigate', chatId: 'fixture-chat', pluginId: 'local.fixture' }); expect(onOpenPlugin).not.toHaveBeenCalled();
});
it('fills and focuses suggestions without sending, and shows plugin capabilities on demand', async () => {
  const { invoke } = fixture(); render(<AIChat onSettings={vi.fn()} onOpenPlugin={onOpenPlugin} />);
  await screen.findByText('fixture-model');
  fireEvent.click(screen.getByRole('button', { name: '规划商品图' }));
  expect((screen.getByLabelText('消息') as HTMLTextAreaElement).value).toBe('打开 AI 批图，帮我规划白底商品图');
  expect(document.activeElement).toBe(screen.getByLabelText('消息'));
  expect(invoke.mock.calls.some(([method]) => method === 'ai.chat.send' || method === 'ai.chat.approve')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '可调用 1 个插件' }));
  await screen.findByRole('dialog', { name: '可调用插件' });
  expect(screen.getByText('示例插件')).toBeTruthy(); expect(screen.getByText('打开插件')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '关闭面板' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect((screen.getByLabelText('消息') as HTMLTextAreaElement).value).toBe('打开 AI 批图，帮我规划白底商品图');
});
it('keeps history in a dismissible drawer and restores focus without losing the draft', async () => {
  const { invoke } = fixture(); render(<AIChat onSettings={vi.fn()} onOpenPlugin={onOpenPlugin} />);
  await waitFor(() => expect(localStorage.getItem('qingzuo.ai-chat.selected.v1')).toBe('fixture-chat'));
  expect(screen.queryByRole('navigation', { name: '历史对话' })).toBeNull();
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '保留草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
  const dialog = await screen.findByRole('dialog', { name: '历史对话' });
  expect(screen.getByRole('button', { name: '测试对话' })).toBeTruthy();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '历史对话' }));
  expect((screen.getByLabelText('消息') as HTMLTextAreaElement).value).toBe('保留草稿');
  fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
  fireEvent.click(await screen.findByRole('button', { name: '测试对话' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai.chat.create', undefined));
});
