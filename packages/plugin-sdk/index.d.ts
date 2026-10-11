export interface FileToken { token: string; name: string; size: number; mime: string }
export interface PluginBridge { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; onDispose(callback: () => void): () => void; onAI?(callback: (event: AIEvent) => void): () => void }
export interface PluginManifest {
  manifestVersion: 1; id: string; title: string; description: string; api: string;
  ui: string; category?: string; releaseNotes?: string;
  permissions: { files?: boolean; credentials?: string[]; network?: string[]; ai?: ('assistant' | 'image-edit')[] };
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
  network: { request(options: { url: 'https://api.remove.bg/v1.0/removebg'; fileToken: string; credential: string; taskId?: string }): Promise<FileToken>; request(options: NetworkRequest & { responseType: 'file' }): Promise<{ status: number; mime: string; file: FileToken }>; request(options: NetworkRequest & { responseType?: 'data' }): Promise<{ status: number; mime: string; data: string }> };
  services: { call<T = unknown>(service: string, method: string, args?: unknown): Promise<T> };
  tasks: { cancel(id: string): Promise<void> };
  ai: { models(options?: { source?: ImageSource }): Promise<ImageModel[]>; batch: { create(options: BatchInput): Promise<ImageBatch>; list(): Promise<ImageBatch[]>; get(options: { id: string }): Promise<ImageBatch>; revise(options: { id: string; revision: number; prompts: string[] }): Promise<ImageBatch>; start(options: { id: string; revision: number; directoryToken: string; retryFailed?: boolean }): Promise<ImageBatch>; cancel(options: { id: string }): Promise<ImageBatch>; preview(options: { id: string; itemId: string; original?: boolean }): Promise<FileToken> }; assistant: { send(options: { text: string; batchId?: string }): Promise<AssistantStatus>; status(): Promise<AssistantStatus>; cancel(): Promise<AssistantStatus> }; onEvent(callback: (event: AIEvent) => void): () => void };
  registerTool(value: { title: string }): Promise<void>; registerSettings(value: { title: string }): Promise<void>;
  onDispose(callback: () => void): () => void;
};
export interface NetworkRequest {
  url: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; json?: unknown;
  multipart?: { fields?: Record<string, string>; files?: { field: string; token: string }[] };
  credential?: string; credentialHeader?: 'Authorization' | 'X-Api-Key'; taskId?: string;
  responseType?: 'data' | 'file'; filename?: string;
}
export interface DirectoryGrant { token: string; name: string }
export type ImageSource = 'official' | 'proxy';
export interface ImageModel { id: string; source?: ImageSource; provider: 'google' | 'openai' | 'compatible'; title: string; sizes: string[]; ratios?: string[]; qualities?: string[] }
export interface BatchInput { source?: ImageSource; modelId: string; parameters?: { size?: string; ratio?: string; quality?: string }; prompt: string; concurrency?: number; items: { token: string; prompt?: string }[] }
export interface ImageBatch { schemaVersion: 1; id: string; owner: string; revision: number; created: number; state: 'draft' | 'running' | 'canceling' | 'interrupted' | 'finished' | 'canceled'; source?: ImageSource; modelId: string; parameters: Record<string, string>; concurrency: number; items: { id: string; name: string; mime: string; prompt: string; state: 'pending' | 'running' | 'unknown' | 'failed' | 'save-failed' | 'succeeded'; error: string | null; output: string | null; outputMime?: string }[] }
export interface AssistantStatus { id?: string; state: 'idle' | 'running'; history: { role: 'user' | 'assistant'; text: string }[]; error?: string | null }
export type AIEvent = { type: 'batch'; batch: ImageBatch } | { type: 'assistant'; session: AssistantStatus } | { type: 'assistant-delta'; text: string };
