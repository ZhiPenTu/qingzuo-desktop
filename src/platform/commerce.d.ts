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
export interface BrowserTabState {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
export interface BrowserCandidate {
  id: string;
  tabId: string;
  type: 'video' | 'image';
  title: string;
  pageUrl: string;
  thumbnailUrl?: string;
  status: 'ready' | 'unresolved' | 'expired';
  reason?: string;
}
export interface BrowserDownloadTask {
  id: string;
  candidateId: string;
  status: 'queued' | 'downloading' | 'completed' | 'failed' | 'canceled';
  progress: number;
  transferred: number;
  total: number;
  filename?: string;
  error?: string;
}
export interface BrowserStatus {
  open: boolean;
  activeTabId: string | null;
  tabs: BrowserTabState[];
  candidates: BrowserCandidate[];
  downloads: BrowserDownloadTask[];
}
declare global {
  interface Window {
    commerceDesktop?: { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; onChanged(callback: () => void): () => void; onBrowserResize?(callback: (value: { width: number }) => void): () => void; onBrowserPane?(callback: (value: { tabId: string; pluginId: string }) => void): () => void; onBrowser?(callback: (event: { type: 'status' | 'loading' | 'candidates' | 'download'; tabId?: string; downloadId?: string }) => void): () => void; onAI?(callback: (event: import('./harness-client').ChatEvent) => void): () => void };
    commercePlugin?: PluginBridge & { id: string };
  }
}
