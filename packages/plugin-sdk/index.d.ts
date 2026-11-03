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
export type CredentialEnvironment = 'production' | 'sandbox';
/** `appId` 是可公开的标识；`secretKey` 永远不会返回给插件。 */
export interface CredentialRecord { id: string; label: string; appId: string; environment: CredentialEnvironment; createdAt: number; updatedAt: number; hasSecret: boolean; grants?: number }
export interface CredentialCandidate { id: string; label: string; environment: CredentialEnvironment; appIdMasked: string; granted: boolean }
export interface CredentialAccess { id: string; label: string; appId: string; environment: CredentialEnvironment }
export interface CredentialGrant { pluginId: string; title: string; confirmedAt: number }
export interface CredentialInput { label: string; appId: string; secretKey: string; environment?: CredentialEnvironment }
export interface CredentialPatch { label?: string; appId?: string; secretKey?: string; environment?: CredentialEnvironment }
export type DownloadPermission = 'use' | 'manage';
export type DownloadStatus = 'queued' | 'probing' | 'downloading' | 'paused' | 'completed' | 'failed' | 'canceled';
export type DownloadMode = 'segmented' | 'single';
export interface DownloadProbe { hostname: string; filename: string; size: number | null; mime: string; supportsRange: boolean; resumable: boolean; mode: DownloadMode }
export interface DownloadPreferences { directoryName: string; directoryAvailable: boolean; concurrency: number }
export interface DownloadTask {
  id: string; ownerId: string; ownerTitle: string; filename: string | null; hostname: string;
  directoryName: string; status: DownloadStatus; mode: DownloadMode; progress: number;
  transferred: number; total: number; speed: number; error: string | null;
  createdAt: number; updatedAt: number; completedAt: number | null;
  canPause: boolean; canResume: boolean; canCancel: boolean; canRemove: boolean; canReveal: boolean;
}
export interface PluginBridge { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; onDispose(callback: () => void): () => void; onAI?(callback: (event: AIEvent) => void): () => void; onBrowser?(callback: (event: BrowserEvent) => void): () => void }
export interface PluginManifest {
  manifestVersion: 1; id: string; title: string; description: string; api: string;
  ui: string; category?: string; releaseNotes?: string; icon?: string;
  permissions: { files?: boolean; storage?: boolean; credentials?: string[]; credentialVault?: 'use' | 'manage'; downloads?: DownloadPermission; network?: string[]; networkHeaders?: string[]; browserOrigins?: string[]; ai?: ('assistant' | 'image-edit' | 'text')[]; browser?: ('detect' | 'download' | 'automate')[]; workspace?: boolean; mcp?: 'read'[]; wechat?: ('draft' | 'publish' | 'list')[] };
  services?: { provides?: string[]; requires?: string[] };
  assistant?: { tools: { name: string; title: string; description: string; service: string; method: string; parameters: AssistantToolSchema }[] };
  backend?: { type: 'node' | 'executable'; entry: Record<string, string> };
  settings?: { title: string; entry: string };
}
export interface AssistantToolSchema { type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean'; description?: string; properties?: Record<string, AssistantToolSchema>; required?: string[]; additionalProperties?: false; items?: AssistantToolSchema; enum?: (string | number | boolean)[]; maxLength?: number; maxItems?: number; minimum?: number; maximum?: number }
export function createPluginClient(bridge?: PluginBridge): {
  invoke<T = unknown>(method: string, args?: unknown): Promise<T>;
  files: { pick(options?: { extensions?: string[] }): Promise<FileToken | null>; pickMany(options?: { extensions?: string[] }): Promise<FileToken[]>; pickDirectory(): Promise<DirectoryGrant | null>; read(token: string): Promise<{ data: string; mime: string }>; create(options: { data: string; filename: string; mime: string }): Promise<FileToken>; url(token: string): Promise<string>; release(token: string): Promise<void>; save(token: string, filename: string): Promise<boolean> };
  credentials: { set(name: string, value: string): Promise<void>; status(name: string): Promise<boolean>; clear(name: string): Promise<void>;
    records: {
      /** `manage` 返回全部凭证；`use` 只返回已授权的凭证。 */
      list(): Promise<CredentialRecord[]>;
      /** 返回全部凭证的掩码信息，用于让用户选择。 */
      browse(): Promise<CredentialCandidate[]>;
      /** 首次使用会触发主进程确认，授权长期有效；返回可直接用于 network 的 AppID。 */
      request(id: string): Promise<CredentialAccess>;
      revoke(id: string): Promise<void>;
      create(input: CredentialInput): Promise<CredentialRecord>;
      update(id: string, patch: CredentialPatch): Promise<CredentialRecord>;
      remove(id: string): Promise<void>;
      grants(id: string): Promise<CredentialGrant[]>;
      revokeGrant(id: string, pluginId: string): Promise<void>;
    } };
  downloads: {
    probe(options: { url: string }): Promise<DownloadProbe>;
    pickDirectory(): Promise<DirectoryGrant | null>;
    preferences(): Promise<DownloadPreferences>;
    configure(options: { directoryToken?: string; concurrency?: number }): Promise<DownloadPreferences>;
    start(options: { url: string; filename?: string; directoryToken?: string; concurrency?: number }): Promise<DownloadTask>;
    list(options?: { all?: boolean }): Promise<DownloadTask[]>;
    get(id: string): Promise<DownloadTask>;
    pause(id: string): Promise<DownloadTask>;
    resume(id: string, options?: { directoryToken?: string }): Promise<DownloadTask>;
    cancel(id: string): Promise<DownloadTask>;
    remove(id: string): Promise<void>;
    reveal(id: string): Promise<boolean>;
  };
  workspace: {
    pick(): Promise<{ name: string } | null>;
    status(): Promise<WorkspaceStatus>;
    revoke(): Promise<void>;
    list(options?: { path?: string; recursive?: boolean }): Promise<WorkspaceEntry[]>;
    readText(options: { path: string; maxBytes?: number }): Promise<string>;
    readFile(options: { path: string; maxBytes?: number }): Promise<{ data: string; mime: string; size: number }>;
    writeText(options: { path: string; text: string; overwrite?: boolean }): Promise<{ path: string; size: number }>;
    writeFile(options: { path: string; token: string; overwrite?: boolean }): Promise<{ path: string; size: number }>;
    writeBase64(options: { path: string; data: string; mime: string; overwrite?: boolean }): Promise<{ path: string; size: number }>;
    mkdir(options: { path: string }): Promise<void>;
    rename(options: { from: string; to: string }): Promise<void>;
    remove(options: { path: string; recursive?: boolean }): Promise<void>;
    url(options: { path: string }): Promise<string>;
    importBundle(options: { fileToken?: string; url?: string; dryRun?: boolean; confirmSecrets?: boolean }): Promise<WorkspaceBundlePreview | WorkspaceBundleResult>;
  };
  mcp: {
    servers(): Promise<McpServerSummary[]>;
    tools(options: { serverId: string }): Promise<McpToolSummary[]>;
    grant(options: { serverId: string; toolNames: string[] }): Promise<void>;
    revoke(options?: { serverId?: string; toolNames?: string[] }): Promise<void>;
    call(options: { serverId: string; toolName: string; args?: unknown }): Promise<McpCallResult>;
  };
  wechat: {
    accounts(): Promise<WechatAccountSummary[]>;
    verify(options: { accountId: string }): Promise<{ ok: true }>;
    createDraft(options: { accountId: string; article: WechatArticleInput }): Promise<{ mediaId: string }>;
    publish(options: { accountId: string; mediaId: string }): Promise<{ publishId: string }>;
    publishStatus(options: { accountId: string; publishId?: string; mediaId?: string }): Promise<WechatPublishStatus>;
    list(options: { accountId: string; type: 'draft' | 'published'; offset?: number; count?: number }): Promise<WechatListResult>;
  };
  network: { request(options: { url: 'https://api.remove.bg/v1.0/removebg'; fileToken: string; credential: string | { record: string }; taskId?: string }): Promise<FileToken>; request(options: NetworkRequest & { responseType: 'file' }): Promise<{ status: number; mime: string; file: FileToken }>; request(options: NetworkRequest & { responseType?: 'data' }): Promise<{ status: number; mime: string; data: string }>; sign(options: { credential: string | { record: string }; algorithm: 'hmac-sha256' | 'sha256'; message: string; keySuffix?: string }): Promise<{ algorithm: 'hmac-sha256' | 'sha256'; encoding: 'base64'; digest: string }> };
  browser: { status(): Promise<BrowserStatus>; rescan(tabId?: string): Promise<BrowserStatus>; download(options: { candidateIds: string[]; mode?: 'single' | 'batch' }): Promise<BrowserStatus>; cancel(id: string): Promise<BrowserStatus>; open(url: string): Promise<{ tabId: string; url: string; title: string }>; snapshot(options?: { tabId?: string }): Promise<BrowserSnapshot>; act(options: BrowserAction): Promise<BrowserActionResult>; waitFor(options: BrowserWaitOptions): Promise<{ tabId: string; url: string; ok: boolean; elapsed: number }>; saveResource(options: { url: string; tabId?: string }): Promise<FileToken & { tabId: string }>; onEvent(callback: (event: BrowserEvent) => void): () => void };
  storage: { get<T = unknown>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<boolean>; keys(): Promise<string[]>; remove(key: string): Promise<boolean>; saveFile(options: { data: string; filename: string; mime: string }): Promise<StorageFile>; readFile(token: string): Promise<{ data: string; mime: string }>; removeFile(token: string): Promise<boolean> };
  services: { call<T = unknown>(service: string, method: string, args?: unknown): Promise<T> };
  tasks: { cancel(id: string): Promise<void> };
  ai: { models(options?: { source?: ImageSource }): Promise<ImageModel[]>; textModels(): Promise<TextModelCatalog>; complete(options: CompleteOptions): Promise<CompleteResult>; batch: { create(options: BatchInput): Promise<ImageBatch>; list(): Promise<ImageBatch[]>; get(options: { id: string }): Promise<ImageBatch>; revise(options: { id: string; revision: number; prompts: string[] }): Promise<ImageBatch>; start(options: { id: string; revision: number; directoryToken?: string; workspacePath?: string; retryFailed?: boolean }): Promise<ImageBatch>; cancel(options: { id: string }): Promise<ImageBatch>; preview(options: { id: string; itemId: string; original?: boolean }): Promise<FileToken> }; assistant: { send(options: { text: string; batchId?: string; model?: string }): Promise<AssistantStatus>; status(): Promise<AssistantStatus>; cancel(): Promise<AssistantStatus> }; onEvent(callback: (event: AIEvent) => void): () => void };
  registerTool(value: { title: string }): Promise<void>; registerSettings(value: { title: string }): Promise<void>;
  onDispose(callback: () => void): () => void;
};
export interface NetworkRequest {
  url: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; json?: unknown;
  multipart?: { fields?: Record<string, string>; files?: { field: string; token: string }[] };
  headers?: Record<string, string>;
  credential?: string | { record: string }; credentialHeader?: 'Authorization' | 'X-Api-Key'; taskId?: string;
  responseType?: 'data' | 'file'; filename?: string;
}
export interface DirectoryGrant { token: string; name: string }
export interface WorkspaceStatus { name: string; available: boolean; reason?: 'not-picked' | 'missing' | 'moved' | 'denied' }
export interface WorkspaceEntry { path: string; name: string; kind: 'file' | 'directory'; size?: number; mtime: number }
export interface WorkspaceBundlePreview {
  presets: { path: string; action: 'add' | 'replace'; files: string[] }[];
  config: { action: 'missing-local' | 'preserve-local'; added: string[]; changed: string[] };
  writingSpec: 'add' | 'replace';
  accounts: { name: string; appIdMasked: string; action: 'add' | 'update' | 'conflict' }[];
  ignored: string[];
  warnings: string[];
}
export interface WorkspaceBundleResult { applied: true; preview: WorkspaceBundlePreview; importedAccounts: number }
export type McpServerStatus = 'ready' | 'auth-required' | 'error' | 'disabled';
export interface McpServerSummary { id: string; name: string; status: McpServerStatus; toolCount: number }
export interface McpToolSummary { name: string; title: string; description: string; readOnly: boolean }
export interface McpCallResult { content: unknown; isError?: boolean }
export interface WechatAccountSummary { id: string; name: string; appIdMasked: string; verified: boolean }
export interface WechatArticleAsset { placeholder: string; path: string }
export interface WechatArticleInput {
  articleDir: string; title: string; author: string; digest: string; html: string;
  cover: WechatArticleAsset; assets: WechatArticleAsset[];
  needOpenComment?: boolean; onlyFansCanComment?: boolean; contentSourceUrl?: string;
}
export interface WechatPublishStatus { publishId?: string | null; status: 'pending' | 'success' | 'failed' | 'unknown'; failIdx?: number; articleUrl?: string; error?: string }
export interface WechatListItem { mediaId: string; title: string; status: 'draft' | 'published' | 'failed' | 'unknown'; updatedAt?: number; articleUrl?: string }
export interface WechatListResult { items: WechatListItem[]; total: number }
export type ImageSource = 'official' | 'proxy';
export interface ImageModel { id: string; source?: ImageSource; provider: 'google' | 'openai' | 'compatible'; title: string; sizes: string[]; ratios?: string[]; qualities?: string[] }
export interface BatchInput { mode?: 'edit' | 'generate'; source?: ImageSource; modelId: string; parameters?: { size?: string; ratio?: string; quality?: string }; prompt: string; concurrency?: number; items: { token?: string; prompt?: string }[] }
export interface TextModel { id: string; title: string }
/** defaultModel 是当前目录中的首个文本模型，仅作为兼容回退；插件应允许用户从 models 中自行选择。 */
export interface TextModelCatalog { models: TextModel[]; defaultModel: string }
/** 文本补全的消息片段：文字，或一张供模型理解的图片（https 地址或 png/jpeg/webp 的 base64 data URL）。 */
export type MessagePart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface CompleteOptions { model?: string; messages: { role: 'system' | 'user' | 'assistant'; content: string | MessagePart[] }[]; temperature?: number; maxTokens?: number; responseFormat?: { type: 'text' | 'json_object' } }
export interface CompleteResult { content: string; model: string; finishReason?: string | null }
export interface ImageBatch { schemaVersion: 1; id: string; owner: string; revision: number; created: number; state: 'draft' | 'running' | 'canceling' | 'interrupted' | 'finished' | 'canceled'; mode: 'edit' | 'generate'; source?: ImageSource; modelId: string; parameters: Record<string, string>; concurrency: number; workspacePath?: string | null; items: { id: string; name: string; mime: string | null; prompt: string; state: 'pending' | 'running' | 'unknown' | 'failed' | 'save-failed' | 'succeeded'; error: string | null; output: string | null; outputMime?: string }[] }
export interface AssistantStatus { id?: string; model?: string; state: 'idle' | 'running'; history: { role: 'user' | 'assistant'; text: string }[]; error?: string | null }
export type AIEvent = { type: 'batch'; batch: ImageBatch } | { type: 'assistant'; session: AssistantStatus } | { type: 'assistant-delta'; text: string };
