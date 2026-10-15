export interface CapturedError {
  timestamp: number;
  message: string;
  stack?: string;
  source?: string;
}

export interface EnvironmentContext {
  appVersion?: string;
  system?: {
    platform?: string;
    arch?: string;
    osRelease?: string;
    electron?: string;
  };
  kernelReady?: boolean;
  kernelError?: string | null;
  plugins?: { id: string; version?: string; title?: string }[];
}

const MAX_ERRORS = 10;
const errorBuffer: CapturedError[] = [];
const listeners = new Set<(error: CapturedError) => void>();

export function cleanErrorMessage(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason ?? '未知错误');
  return raw
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    .replace(/^Error:\s*/, '')
    .trim();
}

export function recordError(reason: unknown, source = 'app'): CapturedError {
  const message = cleanErrorMessage(reason);
  const stack = reason instanceof Error && reason.stack ? reason.stack : undefined;
  const entry: CapturedError = {
    timestamp: Date.now(),
    message: message || '未知错误',
    stack,
    source,
  };

  errorBuffer.push(entry);
  if (errorBuffer.length > MAX_ERRORS) {
    errorBuffer.shift();
  }

  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {}
  }

  return entry;
}

export function getRecentErrors(): CapturedError[] {
  return [...errorBuffer];
}

export function getLatestError(): CapturedError | undefined {
  return errorBuffer.length > 0 ? errorBuffer[errorBuffer.length - 1] : undefined;
}

export function clearRecentErrors(): void {
  errorBuffer.length = 0;
}

export function subscribeErrors(callback: (error: CapturedError) => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function formatIssueMarkdown(options: {
  error?: CapturedError | null;
  userDescription?: string;
  env?: EnvironmentContext;
  recentErrors?: CapturedError[];
}): string {
  const { error, userDescription, env, recentErrors } = options;
  const lines: string[] = [];

  lines.push('### 报错信息');
  lines.push(error?.message ? `\`${error.message}\`` : '*(用户主动提交反馈)*');
  lines.push('');

  if (error?.stack) {
    lines.push('### 详细堆栈');
    lines.push('```');
    lines.push(error.stack.trim());
    lines.push('```');
    lines.push('');
  }

  lines.push('### 运行环境');
  lines.push(`- 轻作版本: v${env?.appVersion ?? '未知'}`);
  if (env?.system) {
    const { platform = '未知', arch = '未知', osRelease = '', electron = '' } = env.system;
    lines.push(`- 操作系统: ${platform} (${arch}) ${osRelease}`.trim());
    if (electron) lines.push(`- Electron: v${electron}`);
  } else {
    lines.push(`- 平台环境: ${typeof navigator !== 'undefined' ? navigator.userAgent : '非浏览器环境'}`);
  }
  lines.push(`- 工具服务: ${env?.kernelReady ? '运行中' : '未就绪'}${env?.kernelError ? ` (异常: ${env.kernelError})` : ''}`);
  const pluginSummary = env?.plugins?.length
    ? env.plugins.map(p => `${p.title || p.id}${p.version ? ` (v${p.version})` : ''}`).join(', ')
    : '无已安装工具';
  lines.push(`- 已安装工具: ${pluginSummary}`);
  lines.push('');

  const history = (recentErrors ?? errorBuffer).filter(item => item !== error);
  if (history.length > 0) {
    lines.push('### 最近异常记录');
    for (const item of history.slice(-3)) {
      const time = new Date(item.timestamp).toLocaleTimeString();
      lines.push(`- [${time}] [${item.source ?? 'app'}] ${item.message}`);
    }
    lines.push('');
  }

  lines.push('### 问题描述与复现步骤');
  lines.push(userDescription?.trim() ? userDescription.trim() : '（请在此补充发生问题时的具体操作）');
  lines.push('');

  return lines.join('\n');
}

const GITHUB_REPO = 'https://github.com/ZhiPenTu/qingzuo-desktop';
const MAX_URL_BODY_LENGTH = 1800;

export function buildIssueUrl(options: {
  title?: string;
  body: string;
  repo?: string;
}): string {
  const repo = options.repo || GITHUB_REPO;
  const title = options.title ? options.title.slice(0, 100) : '提交报错与反馈';

  let body = options.body;
  if (body.length > MAX_URL_BODY_LENGTH) {
    body = body.slice(0, MAX_URL_BODY_LENGTH) + '\n\n*(诊断信息较长，完整内容已同步复制至剪贴板，可直接在下方粘贴补充)*';
  }

  const params = new URLSearchParams({
    title,
    body,
  });

  return `${repo.replace(/\/+$/, '')}/issues/new?${params.toString()}`;
}

let initialized = false;
export function initGlobalErrorTracking(): () => void {
  if (typeof window === 'undefined' || initialized) return () => {};
  initialized = true;

  const errorHandler = (event: ErrorEvent) => {
    recordError(event.error || event.message, 'window.error');
  };

  const rejectionHandler = (event: PromiseRejectionEvent) => {
    recordError(event.reason, 'window.unhandledrejection');
  };

  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', rejectionHandler);

  return () => {
    window.removeEventListener('error', errorHandler);
    window.removeEventListener('unhandledrejection', rejectionHandler);
    initialized = false;
  };
}
