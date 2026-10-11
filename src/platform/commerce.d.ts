import type { PluginBridge } from '@commerce/plugin-sdk';
declare global {
  interface Window {
    commerceDesktop?: { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; onChanged(callback: () => void): () => void; onAI?(callback: (event: import('./harness-client').ChatEvent) => void): () => void };
    commercePlugin?: PluginBridge & { id: string };
  }
}
export {};
