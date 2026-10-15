import type { PluginBridge } from '@commerce/plugin-sdk';
export interface PluginInstallState {
  id: string;
  version: string | null;
  status: 'checking' | 'downloading' | 'verifying' | 'installing' | 'syncing' | 'installed' | 'error';
  progress: number | null;
  transferred: number;
  total: number;
  error: string | null;
}
export interface DownloadSourceState {
  source: string;
  customMirrors: string[];
  gitcodeAvailable: boolean;
  notice?: string | null;
}
export interface SystemDiagnostics {
  platform: string;
  arch: string;
  osRelease: string;
  electron: string;
}
declare global {
  interface Window {
    commerceDesktop?: { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; onChanged(callback: () => void): () => void; onAI?(callback: (event: import('./harness-client').ChatEvent) => void): () => void };
    commercePlugin?: PluginBridge & { id: string };
  }
}
