export interface FileToken { token: string; name: string; size: number; mime: string }
export interface BrowserCandidate { id: string; tabId: string; type: 'video' | 'image'; title: string; pageUrl: string; thumbnailUrl?: string; status: 'ready' | 'unresolved' | 'expired'; reason?: string }
export interface BrowserDownloadTask { id: string; candidateId: string; status: 'queued' | 'downloading' | 'completed' | 'failed' | 'canceled'; progress: number; transferred: number; total: number; filename?: string; error?: string }
/** `automate` 插件调用 `browser.status()` 时，`tabs` 只包含它自己打开过的标签页，`candidates` 与 `downloads` 恒为空。 */
export interface BrowserStatus { open: boolean; activeTabId: string | null; tabs: Array<{ id: string; title: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }>; candidates: BrowserCandidate[]; downloads: BrowserDownloadTask[] }
export interface BrowserEvent { type: 'status' | 'loading' | 'candidates' | 'download'; tabId?: string; downloadId?: string }
export interface BrowserNode { ref: string; role: string; name: string; value: string; visible: boolean; rect: { x: number; y: number; width: number; height: number }; checked?: boolean; url?: string }
export interface BrowserSnapshot { tabId: string; url: string; title: string; nodes: BrowserNode[]; truncated: boolean }
export type BrowserAction = { tabId?: string } & ({ action: 'click' | 'hover'; ref: string } | { action: 'type' | 'select'; ref: string; value: string } | { action: 'scroll'; value: number });
export interface BrowserActionResult { tabId: string; url: string; action: 'click' | 'type' | 'select' | 'scroll' | 'hover'; ok: true; value?: string; scrollY?: number }
export interface BrowserWaitOptions { tabId?: string; selector?: string; text?: string; absent?: boolean; timeoutMs?: number }
export interface StorageFile { token: string; name: string; size: number; mime: string }
export interface PluginBridge { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; onDispose(callback: () => void): () => void; onAI?(callback: (event: AIEvent) => void): () => void; onBrowser?(callback: (event: BrowserEvent) => void): () => void }
export interface PluginManifest {
  manifestVersion: 1; id: string; title: string; description: string; api: string;
  ui: string; category?: string; releaseNotes?: string;
  permissions: { files?: boolean; storage?: boolean; credentials?: string[]; network?: string[]; networkHeaders?: string[]; browserOrigins?: string[]; ai?: ('assistant' | 'image-edit')[]; browser?: ('detect' | 'download' | 'automate')[] };
  services?: { provides?: string[]; requires?: string[] };
  assistant?: { tools: { name: string; title: string; description: string; service: string; method: string; parameters: AssistantToolSchema }[] };
  backend?: { type: 'node' | 'executable'; entry: Record<string, string> };
  settings?: { title: string; entry: string };
}
export interface AssistantToolSchema { type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean'; description?: string; properties?: Record<string, AssistantToolSchema>; required?: string[]; additionalProperties?: false; items?: AssistantToolSchema; enum?: (string | number | boolean)[]; maxLength?: number; maxItems?: number; minimum?: number; maximum?: number }
export function createPluginClient(bridge?: PluginBridge): {
  invoke<T = unknown>(method: string, args?: unknown): Promise<T>;
  files: { pick(options?: { extensions?: string[] }): Promise<FileToken | null>; pickMany(options?: { extensions?: string[] }): Promise<FileToken[]>; pickDirectory(): Promise<DirectoryGrant | null>; read(token: string): Promise<{ data: string; mime: string }>; create(options: { data: string; filename: string; mime: string }): Promise<FileToken>; url(token: string): Promise<string>; release(token: string): Promise<void>; save(token: string, filename: string): Promise<boolean> };
  credentials: { set(name: string, value: string): Promise<void>; status(name: string): Promise<boolean>; clear(name: string): Promise<void> };
  network: { request(options: { url: 'https://api.remove.bg/v1.0/removebg'; fileToken: string; credential: string; taskId?: string }): Promise<FileToken>; request(options: NetworkRequest & { responseType: 'file' }): Promise<{ status: number; mime: string; file: FileToken }>; request(options: NetworkRequest & { responseType?: 'data' }): Promise<{ status: number; mime: string; data: string }>; sign(options: { credential: string; algorithm: 'hmac-sha256' | 'sha256'; message: string; keySuffix?: string }): Promise<{ algorithm: 'hmac-sha256' | 'sha256'; encoding: 'base64'; digest: string }> };
  browser: { status(): Promise<BrowserStatus>; rescan(tabId?: string): Promise<BrowserStatus>; download(options: { candidateIds: string[]; mode?: 'single' | 'batch' }): Promise<BrowserStatus>; cancel(id: string): Promise<BrowserStatus>; open(url: string): Promise<{ tabId: string; url: string; title: string }>; snapshot(options?: { tabId?: string }): Promise<BrowserSnapshot>; act(options: BrowserAction): Promise<BrowserActionResult>; waitFor(options: BrowserWaitOptions): Promise<{ tabId: string; url: string; ok: boolean; elapsed: number }>; saveResource(options: { url: string; tabId?: string }): Promise<FileToken & { tabId: string }>; onEvent(callback: (event: BrowserEvent) => void): () => void };
  storage: { get<T = unknown>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<boolean>; keys(): Promise<string[]>; remove(key: string): Promise<boolean>; saveFile(options: { data: string; filename: string; mime: string }): Promise<StorageFile>; readFile(token: string): Promise<{ data: string; mime: string }>; removeFile(token: string): Promise<boolean> };
  services: { call<T = unknown>(service: string, method: string, args?: unknown): Promise<T> };
  tasks: { cancel(id: string): Promise<void> };
  ai: { models(options?: { source?: ImageSource }): Promise<ImageModel[]>; textModels(): Promise<TextModelCatalog>; complete(options: CompleteOptions): Promise<CompleteResult>; batch: { create(options: BatchInput): Promise<ImageBatch>; list(): Promise<ImageBatch[]>; get(options: { id: string }): Promise<ImageBatch>; revise(options: { id: string; revision: number; prompts: string[] }): Promise<ImageBatch>; start(options: { id: string; revision: number; directoryToken: string; retryFailed?: boolean }): Promise<ImageBatch>; cancel(options: { id: string }): Promise<ImageBatch>; preview(options: { id: string; itemId: string; original?: boolean }): Promise<FileToken> }; assistant: { send(options: { text: string; batchId?: string }): Promise<AssistantStatus>; status(): Promise<AssistantStatus>; cancel(): Promise<AssistantStatus> }; onEvent(callback: (event: AIEvent) => void): () => void };
  registerTool(value: { title: string }): Promise<void>; registerSettings(value: { title: string }): Promise<void>;
  onDispose(callback: () => void): () => void;
};
export interface NetworkRequest {
  url: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; json?: unknown;
  multipart?: { fields?: Record<string, string>; files?: { field: string; token: string }[] };
  headers?: Record<string, string>;
  credential?: string; credentialHeader?: 'Authorization' | 'X-Api-Key'; taskId?: string;
  responseType?: 'data' | 'file'; filename?: string;
}
export interface DirectoryGrant { token: string; name: string }
export type ImageSource = 'official' | 'proxy';
export interface ImageModel { id: string; source?: ImageSource; provider: 'google' | 'openai' | 'compatible'; title: string; sizes: string[]; ratios?: string[]; qualities?: string[] }
export interface BatchInput { source?: ImageSource; modelId: string; parameters?: { size?: string; ratio?: string; quality?: string }; prompt: string; concurrency?: number; items: { token: string; prompt?: string }[] }
export interface TextModel { id: string; title: string }
export interface TextModelCatalog { models: TextModel[]; defaultModel: string }
/** 文本补全的消息片段：文字，或一张供模型理解的图片（https 地址或 png/jpeg/webp 的 base64 data URL）。 */
export type MessagePart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface CompleteOptions { model?: string; messages: { role: 'system' | 'user' | 'assistant'; content: string | MessagePart[] }[]; temperature?: number; responseFormat?: { type: 'text' | 'json_object' } }
export interface CompleteResult { content: string; model: string }
export interface ImageBatch { schemaVersion: 1; id: string; owner: string; revision: number; created: number; state: 'draft' | 'running' | 'canceling' | 'interrupted' | 'finished' | 'canceled'; source?: ImageSource; modelId: string; parameters: Record<string, string>; concurrency: number; items: { id: string; name: string; mime: string; prompt: string; state: 'pending' | 'running' | 'unknown' | 'failed' | 'save-failed' | 'succeeded'; error: string | null; output: string | null; outputMime?: string }[] }
export interface AssistantStatus { id?: string; state: 'idle' | 'running'; history: { role: 'user' | 'assistant'; text: string }[]; error?: string | null }
export type AIEvent = { type: 'batch'; batch: ImageBatch } | { type: 'assistant'; session: AssistantStatus } | { type: 'assistant-delta'; text: string };
