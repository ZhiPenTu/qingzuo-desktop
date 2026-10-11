import harness from '../../desktop/upstream/harness.json';
export const HARNESS_UI_VERSION = harness.version;
export interface ToolApproval { id: string; pluginId: string; pluginTitle: string; title: string; tool: string; args: Record<string, unknown>; detail?: Record<string, unknown> | null }
export interface ChatMessage { role: 'user' | 'assistant' | 'tool'; text: string; id?: string; tool?: string; pluginId?: string; args?: Record<string, unknown>; state?: string }
export interface ChatSession { id: string; title?: string; model?: string; state: 'idle' | 'running'; partial?: string; history: ChatMessage[]; error?: string | null; approvals?: ToolApproval[] }
export interface ChatSummary { id: string; title: string; state: 'idle' | 'running'; updated: number }
export interface ChatPlugin { id: string; title: string; description: string; tools: { name: string; title: string }[] }
export type ChatEvent = { type: 'assistant-delta'; chatId: string; text: string; partial?: string } | { type: 'assistant'; chatId: string; session: ChatSession } | { type: 'approvals'; chatId: string; approvals: ToolApproval[] } | { type: 'navigate'; chatId: string; pluginId: string };
export function chatInvoke<Value>(operation: string, args?: unknown): Promise<Value> {
  if (!window.commerceDesktop) return Promise.reject(new Error('请在轻作桌面应用中使用 AI 对话。'));
  return window.commerceDesktop.invoke<Value>('ai.chat.' + operation, args);
}
