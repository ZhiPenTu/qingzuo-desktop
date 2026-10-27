import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Boxes, Store, Puzzle, Settings, RefreshCw, ArrowRight, Plus, X, Search, ShieldCheck, AlertCircle, Monitor, Moon, Sun, LoaderCircle, Upload, Sparkles, MessageCircle, FileText, Image, Globe, Bug, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardAction } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { PluginCard, pluginInstallActive, toolCategory, type Plugin, type ToolEntry } from './PluginCard';
import gt from 'semver/functions/gt';
import type { DownloadSourceState, PluginInstallState, SystemDiagnostics } from './commerce';
import type { BrowserStatus } from './commerce';
import { BrowserTabStrip, BrowserWorkspace } from './BrowserWorkspace';
import { IssueReportDialog } from './IssueReportDialog';
import { recordError, getLatestError, type CapturedError } from './error-tracker';
import { useTheme } from '../theme/ThemeProvider';
import { cn } from '@/lib/utils';
import brandIcon from '@/assets/qingzuo.png';
import workspaceArt from '@/assets/workspace.png';
import { version } from '../../package.json';
import { UpdateCard, type UpdateState } from './UpdateCard';
import { AISettings } from './AISettings';
import { HARNESS_UI_VERSION } from './harness-client';
const AIChat = lazy(() => import('./AIChat'));
type Page = 'home' | 'market' | 'plugins' | 'chat' | 'ai' | 'settings';
interface ComponentUpdateState {
  status: string;
  currentVersion?: string;
  candidateVersion?: string | null;
  /** Older/experimental main-process builds use `version` for the candidate. */
  version?: string | null;
  updateAvailable?: boolean;
  canUpdate?: boolean;
  compatibility?: string;
  error?: string | null;
}
interface Status { version: string; system?: SystemDiagnostics; kernel: { ready: boolean; error: string | null; version: string; systems: { id: string; title: string; protected: boolean }[] }; plugins: Plugin[]; pluginInstalls?: PluginInstallState[]; tabs: string[]; browser?: BrowserStatus; update: UpdateState; downloadSource?: DownloadSourceState; componentUpdates?: { harness?: ComponentUpdateState }; migration?: { id: string; title: string; enabled: boolean } | null }
const navigation = [{ id: 'chat', title: 'AI 对话', icon: MessageCircle }, { id: 'home', title: '工具中心', icon: Boxes }, { id: 'market', title: '插件市场', icon: Store }, { id: 'plugins', title: '插件管理', icon: Puzzle }, { id: 'settings', title: '设置', icon: Settings }] as const;
const shellPageIds = ['home', 'market', 'plugins', 'chat', 'ai', 'settings'] as const;
const isShellPage = (id: string) => shellPageIds.includes(id as (typeof shellPageIds)[number]);
const defaultDownloadSource: DownloadSourceState = { source: 'github', customMirrors: [], gitcodeAvailable: true, notice: null };
const BROWSER_PANE_MIN_WIDTH = 360;
const BROWSER_MAIN_MIN_WIDTH = 320;
const BROWSER_PANE_DEFAULT_WIDTH = 640;
const emptyBrowser: BrowserStatus = { open: false, activeTabId: null, tabs: [], candidates: [], downloads: [] };
const preview: Status = { version, kernel: { ready: false, error: null, version: HARNESS_UI_VERSION, systems: [] }, plugins: [], tabs: [], browser: emptyBrowser, downloadSource: defaultDownloadSource, update: { status: 'idle', version: null, notes: '', error: null, progress: 0, transferred: 0, total: 0 } };
const isLabel = (id: string) => id === 'official.labeledit';
const isCutout = (id: string) => id === 'official.removebg';
const tabIconFor = (id: string) => (id === 'browser' ? Globe : isLabel(id) ? FileText : isCutout(id) ? Image : Puzzle);
const pageCopy = {
  home: ['让日常工作，轻一点。', '把顺手的工具放在一起，专注每一次创作。'],
  market: ['让工作台，多一点可能。', '找到适合你的工具，按需安装，独立更新。'],
  plugins: ['每一件工具，都井井有条。', '管理已安装工具的状态、设置和版本。'],
  ai: ['AI 设置', '先接入账户，再选择助手模型。图像编辑单独配置。'],
  chat: ['AI 对话', '说一句话，让工具替你完成。'],
  settings: ['按你的习惯，轻松工作。', '选择舒适的外观，管理轻作与已安装的工具。'],
} as const;
export default function Platform() {
  const desktop = Boolean(window.commerceDesktop);
  const [status, setStatus] = useState<Status | null>(desktop ? null : preview);
  const [page, setPage] = useState<Page | string>('home');
  const [browserPaneOpen, setBrowserPaneOpen] = useState(false);
  const [browserPaneWidth, setBrowserPaneWidth] = useState<number | null>(() => {
    try {
      const saved = window.localStorage.getItem('qingzuo.browserPaneWidth');
      const parsed = saved ? parseInt(saved, 10) : null;
      return parsed && Number.isFinite(parsed) && parsed >= BROWSER_PANE_MIN_WIDTH ? parsed : null;
    } catch {
      return null;
    }
  });
  const [browserPaneResizing, setBrowserPaneResizing] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startingPluginId, setStartingPluginId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem('qingzuo.sidebarCollapsed') === '1'; }
    catch { return false; }
  });
  const pendingInstalls = useRef(new Set<string>());
  const browserPaneRef = useRef<HTMLElement>(null);
  const browserResizeRef = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null);
  const [market, setMarket] = useState<ToolEntry[]>([]);
  const [marketState, setMarketState] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading');
  const [marketMessage, setMarketMessage] = useState('');
  const [marketRevision, setMarketRevision] = useState(0);
  const [marketCheckedAt, setMarketCheckedAt] = useState<number | null>(null);
  const marketCache = useRef<{ items: ToolEntry[]; checkedAt: number; source: string } | null>(null);
  const marketRequest = useRef(0);
  const [pluginCheckBusy, setPluginCheckBusy] = useState(false);
  const [pluginCheckError, setPluginCheckError] = useState<string | null>(null);
  const [customMirrorDialogOpen, setCustomMirrorDialogOpen] = useState(false);
  const [customMirrorInput, setCustomMirrorInput] = useState('');
  const [customMirrorError, setCustomMirrorError] = useState<string | null>(null);
  const [customMirrorBusy, setCustomMirrorBusy] = useState(false);
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [issueDialogError, setIssueDialogError] = useState<CapturedError | null>(null);
  const openIssueReport = (err?: unknown, source = '平台') => {
    const captured = err ? recordError(err, source) : (getLatestError() || null);
    setIssueDialogError(captured);
    setIssueDialogOpen(true);
  };
  const surface = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();
  const formatError = (reason: unknown) => {
    const cleaned = (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').replace(/^Error:\s*/, '');
    return /^ADM-ZIP:/i.test(cleaned) ? '插件包格式无效或文件未下载完整，请重新下载或选择有效的 .ecplugin / .zip 插件包。' : cleaned;
  };
  const refresh = useCallback(async () => { if (window.commerceDesktop) try { setStatus(await window.commerceDesktop.invoke<Status>('status')); } catch (e) { recordError(e, '刷新状态'); setError(formatError(e)); } }, []);
  useEffect(() => { void refresh(); return window.commerceDesktop?.onChanged(() => { void refresh(); }); }, [refresh]);
  useEffect(() => window.commerceDesktop?.onBrowserResize?.(({ width }) => {
    if (Number.isFinite(width)) {
      const next = Math.round(width);
      setBrowserPaneWidth(next);
      try { window.localStorage.setItem('qingzuo.browserPaneWidth', String(next)); } catch { /* storage is optional */ }
    }
  }), []);
  useEffect(() => window.commerceDesktop?.onBrowserPane?.(() => setBrowserPaneOpen(true)), []);
  const showChatPlugin = useCallback((id: string) => { setPage(id); setQuery(''); setCategory('all'); }, []);
  useEffect(() => window.commerceDesktop?.onAI?.(event => { if (event.type === 'navigate') showChatPlugin(event.pluginId); }), [showChatPlugin]);
  const run = async (method: string, args?: unknown) => {
    const installId = method === 'market.install' && args && typeof args === 'object' && 'id' in args && typeof args.id === 'string' ? args.id : null;
    if (installId && (pendingInstalls.current.has(installId) || pluginInstallActive(status?.pluginInstalls?.find(job => job.id === installId)))) return;
    if (installId) { pendingInstalls.current.add(installId); setStartingPluginId(installId); }
    setBusy(true); setError(null);
    try { const value = await window.commerceDesktop?.invoke(method, args); await refresh(); return value; }
    catch (e) { recordError(e, '平台操作'); setError(formatError(e)); throw e; }
    finally { setBusy(false); if (installId) { pendingInstalls.current.delete(installId); setStartingPluginId(null); } }
  };
  const act = (method: string, args?: unknown) => { void run(method, args).catch(() => {}); };
  const downloadSourceState = status?.downloadSource ?? defaultDownloadSource;
  const formatCustomMirrorLabel = (mirror: string) => {
    try { return `自定义镜像 · ${new URL(mirror).host}`; }
    catch { return '自定义镜像'; }
  };
  const handleDownloadSourceChange = async (nextSource: string) => {
    if (!window.commerceDesktop) {
      setStatus(prev => prev ? { ...prev, downloadSource: { ...(prev.downloadSource ?? defaultDownloadSource), source: nextSource, notice: null } } : prev);
      return;
    }
    try {
      await run('downloadSource.set', { source: nextSource });
      setMarketRevision(value => value + 1);
    } catch {
      // Error is already surfaced by run().
    }
  };
  const closeCustomMirrorDialog = useCallback(() => {
    if (customMirrorBusy) return;
    setCustomMirrorDialogOpen(false);
    setCustomMirrorError(null);
  }, [customMirrorBusy]);
  useEffect(() => {
    if (!customMirrorDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeCustomMirrorDialog();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [customMirrorDialogOpen, closeCustomMirrorDialog]);
  const submitCustomMirror = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = customMirrorInput.trim();
    if (!trimmed || customMirrorBusy) return;
    setCustomMirrorBusy(true);
    setCustomMirrorError(null);
    try {
      if (window.commerceDesktop) {
        await window.commerceDesktop.invoke('downloadSource.addCustomMirror', { url: trimmed });
        await refresh();
      } else {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
          throw new Error('请填写以 https:// 开头的镜像站地址。');
        }
        parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/';
        const normalized = parsed.toString();
        setStatus(prev => {
          if (!prev) return prev;
          const current = prev.downloadSource ?? defaultDownloadSource;
          const customMirrors = current.customMirrors.includes(normalized) ? current.customMirrors : [...current.customMirrors, normalized];
          return { ...prev, downloadSource: { ...current, source: `custom:${normalized}`, customMirrors, notice: null } };
        });
      }
      setMarketRevision(value => value + 1);
      setCustomMirrorInput('');
      setCustomMirrorDialogOpen(false);
    } catch (reason) {
      setCustomMirrorError(formatError(reason));
    } finally {
      setCustomMirrorBusy(false);
    }
  };
  const removeCustomMirror = async (mirror: string) => {
    if (customMirrorBusy) return;
    setCustomMirrorBusy(true);
    setCustomMirrorError(null);
    try {
      if (window.commerceDesktop) {
        await window.commerceDesktop.invoke('downloadSource.removeCustomMirror', { url: mirror });
        await refresh();
      } else {
        setStatus(prev => {
          if (!prev) return prev;
          const current = prev.downloadSource ?? defaultDownloadSource;
          const customMirrors = current.customMirrors.filter(item => item !== mirror);
          const source = current.source === `custom:${mirror}` ? 'github' : current.source;
          return { ...prev, downloadSource: { ...current, source, customMirrors, notice: null } };
        });
      }
      setMarketRevision(value => value + 1);
    } catch (reason) {
      setCustomMirrorError(formatError(reason));
    } finally {
      setCustomMirrorBusy(false);
    }
  };
  async function navigate(next: string, settings = false) {
    try {
      if (page === 'market' && next !== 'market') { marketCache.current = null; marketRequest.current++; }
      if (isShellPage(next)) await window.commerceDesktop?.invoke('view.hide');
      else await run('view.open', { id: next, settings });
      setPage(next); setQuery(''); setCategory('all');
    } catch (e) { setError(formatError(e)); }
  }
  const openBrowserPane = async () => {
    try {
      await run('browser.open');
      setBrowserPaneOpen(true);
    } catch {
      // Error is already surfaced by run().
    }
  };
  const hideBrowserPane = async () => {
    try {
      await window.commerceDesktop?.invoke('browser.hide');
    } finally {
      setBrowserPaneOpen(false);
    }
  };
  const browserPaneLimits = () => {
    const bodyWidth = document.querySelector<HTMLElement>('.commerce-body')?.getBoundingClientRect().width || window.innerWidth;
    const sidebarWidth = document.querySelector<HTMLElement>('.commerce-sidebar')?.getBoundingClientRect().width || (sidebarCollapsed ? 72 : 208);
    return { min: BROWSER_PANE_MIN_WIDTH, max: Math.max(BROWSER_PANE_MIN_WIDTH, bodyWidth - sidebarWidth - BROWSER_MAIN_MIN_WIDTH) };
  };
  const currentBrowserPaneWidth = () => {
    const width = browserPaneRef.current?.getBoundingClientRect().width;
    const limits = browserPaneLimits();
    const defaultWidth = Math.min(limits.max, Math.max(limits.min, Math.min(2400, Math.round(window.innerWidth * 0.48)) || BROWSER_PANE_DEFAULT_WIDTH));
    return width && width > 0 ? width : defaultWidth;
  };
  const setBrowserPaneWidthWithinBounds = (width: number) => {
    const { min, max } = browserPaneLimits();
    const next = Math.round(Math.min(max, Math.max(min, width)));
    setBrowserPaneWidth(next);
    try { window.localStorage.setItem('qingzuo.browserPaneWidth', String(next)); } catch { /* storage is optional */ }
  };
  const beginBrowserResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const startWidth = currentBrowserPaneWidth();
    const limits = browserPaneLimits();
    browserResizeRef.current = { startX: event.clientX, startWidth, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    void window.commerceDesktop?.invoke('browser.resize.start', { startX: event.clientX, startWidth, minWidth: limits.min, maxWidth: limits.max });
    setBrowserPaneResizing(true);
    event.preventDefault();
  };
  const moveBrowserResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = browserResizeRef.current;
    if (!resize) return;
    setBrowserPaneWidthWithinBounds(resize.startWidth - (event.clientX - resize.startX));
    void window.commerceDesktop?.invoke('browser.resize.move', { x: event.clientX });
    event.preventDefault();
  };
  const endBrowserResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = browserResizeRef.current;
    if (!resize) return;
    browserResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(resize.pointerId)) event.currentTarget.releasePointerCapture?.(resize.pointerId);
    void window.commerceDesktop?.invoke('browser.resize.stop');
    setBrowserPaneResizing(false);
  };
  const handleBrowserResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); setBrowserPaneWidthWithinBounds(currentBrowserPaneWidth() + 24); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); setBrowserPaneWidthWithinBounds(currentBrowserPaneWidth() - 24); }
    else if (event.key === 'Home') { event.preventDefault(); setBrowserPaneWidthWithinBounds(browserPaneLimits().max); }
    else if (event.key === 'End') { event.preventDefault(); setBrowserPaneWidthWithinBounds(browserPaneLimits().min); }
  };
  const loadMarket = useCallback(async (force = false) => {
    if (!window.commerceDesktop) {
      setMarketState('unavailable'); setMarketMessage('在轻作桌面应用中浏览并安装更多工具。');
      return [];
    }
    const source = status?.downloadSource?.source ?? 'github';
    const cached = marketCache.current;
    if (!force && cached && cached.source === source && Date.now() - cached.checkedAt < 60_000) {
      setMarket(cached.items); setMarketCheckedAt(cached.checkedAt); setMarketMessage(''); setMarketState('ready');
      return cached.items;
    }
    setMarketState('loading'); setMarketMessage('');
    const requestId = ++marketRequest.current;
    const value = await window.commerceDesktop.invoke<{ items: ToolEntry[]; message?: string }>('market.list');
    if (requestId !== marketRequest.current) return [];
    const items = Array.isArray(value.items) ? value.items : [];
    const checkedAt = Date.now();
    marketCache.current = { items, checkedAt, source };
    setMarket(items); setMarketCheckedAt(checkedAt); setMarketMessage(value.message || ''); setMarketState(value.message ? 'unavailable' : 'ready');
    return items;
  }, [status?.downloadSource?.source]);
  useEffect(() => {
    if (page !== 'market') return;
    let active = true;
    void loadMarket().catch(e => { if (active) { setMarketMessage(formatError(e)); setMarketState('error'); } });
    return () => { active = false; marketCache.current = null; marketRequest.current++; };
  }, [page, marketRevision, loadMarket]);
  const checkPluginUpdates = async () => {
    if (pluginCheckBusy || !desktop) return;
    setPluginCheckBusy(true); setPluginCheckError(null);
    try { await loadMarket(true); }
    catch (reason) { setPluginCheckError(formatError(reason)); }
    finally { setPluginCheckBusy(false); }
  };
  useEffect(() => {
    const element = surface.current;
    if (!element || isShellPage(page) || typeof ResizeObserver === 'undefined') return;
    const update = () => { const rect = element.getBoundingClientRect(); void window.commerceDesktop?.invoke('view.bounds', { x: rect.x, y: rect.y, width: rect.width, height: rect.height }); };
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, [page]);
  const plugins = status?.plugins ?? [];
  const installFor = (id: string): PluginInstallState | undefined => startingPluginId === id ? { id, version: null, status: 'checking', progress: null, transferred: 0, total: 0, error: null } : status?.pluginInstalls?.find(job => job.id === id);
  const migrationInstall = status?.migration ? installFor(status.migration.id) : undefined;
  const migrationRunning = pluginInstallActive(migrationInstall);
  const migrationProgress = migrationInstall?.status === 'downloading' && migrationInstall.progress !== null ? Math.min(100, Math.max(0, migrationInstall.progress)) : null;
  const migrationPhase = migrationInstall ? ({ checking: '正在检查插件版本…', downloading: '正在下载插件…', verifying: '正在校验插件签名…', installing: '正在安装插件…', syncing: '正在刷新工具…', installed: '', error: '' }[migrationInstall.status]) : '';
  const marketById = useMemo(() => new Map(market.map(entry => [entry.id, entry])), [market]);
  const pluginUpdates = useMemo(() => plugins.filter(plugin => {
    const candidate = marketById.get(plugin.id);
    try { return Boolean(candidate && gt(candidate.version, plugin.version)); } catch { return false; }
  }), [plugins, marketById]);
  const entries = page === 'market' ? market : page === 'plugins' ? plugins.map(plugin => {
    const candidate = marketById.get(plugin.id);
    return candidate ? { ...candidate, enabled: plugin.enabled, source: plugin.source, local: plugin.local, missing: plugin.missing, settings: plugin.settings, error: plugin.error } as Plugin : plugin;
  }) : plugins;
  const categories = useMemo(() => [...new Set(entries.map(toolCategory))], [entries]);
  const results = useMemo(() => entries.filter(p => (category === 'all' || toolCategory(p) === category) && `${p.title} ${p.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [entries, category, query]);
  const title = navigation.find(n => n.id === page)?.title ?? (page === 'ai' ? pageCopy.ai[0] : plugins.find(p => p.id === page)?.title ?? '工具');
  const shellPage = isShellPage(page);
  const copy = pageCopy[page as Page];
  const toggleSidebar = () => setSidebarCollapsed(current => {
    const next = !current;
    try { window.localStorage.setItem('qingzuo.sidebarCollapsed', next ? '1' : '0'); } catch { /* storage is optional */ }
    return next;
  });
  const renderWorkspaceTabs = () => status?.tabs.length ? <div className="commerce-windowbar-tabs" role="tablist" aria-label="已打开的工具">
    <button type="button" role="tab" aria-selected={shellPage} className={cn('commerce-tool-tab', 'commerce-tool-tab-shell', shellPage && 'is-active')} onClick={() => void navigate('home')}>
      <Boxes className="commerce-tab-icon" /><span className="commerce-tab-title">{shellPage ? title : '工具中心'}</span>
    </button>
    {status.tabs.map(id => {
      const TabIcon = tabIconFor(id); const toolTitle = plugins.find(p => p.id === id)?.title ?? id; const isInstalling = pluginInstallActive(installFor(id)); const isActive = page === id;
      return <div key={id} role="tab" tabIndex={0} aria-selected={isActive} className={cn('commerce-tool-tab', isActive && 'is-active', isInstalling && 'is-disabled')} onClick={() => { if (!isInstalling) void navigate(id); }} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !isInstalling) { e.preventDefault(); void navigate(id); } }}>
        <TabIcon className="commerce-tab-icon" /><span className="commerce-tab-title">{toolTitle}</span>
        <button type="button" className="commerce-tab-close" aria-label="关闭工具" title="关闭" disabled={isInstalling} onClick={e => { e.stopPropagation(); void run('view.close', { id }).then(() => { if (page === id) setPage('home'); }).catch(() => {}); }}><X /></button>
      </div>;
    })}
  </div> : <span className="commerce-windowbar-context">{title}</span>;
  return <div className="commerce-shell">
    <div className="commerce-windowbar">
      <div className="commerce-windowbar-title"><img src={brandIcon} alt="" /><span>轻作 · Qingzuo</span></div>
      <Button variant="ghost" size="icon-sm" className="commerce-windowbar-sidebar-toggle" aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} onClick={toggleSidebar}>{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button>
      {renderWorkspaceTabs()}
      <div className="commerce-windowbar-drag" aria-hidden="true" />
      {browserPaneOpen && status?.browser?.open ? <BrowserTabStrip embedded status={status.browser} busy={busy} onAction={run} /> : null}
      <Button variant="ghost" size="icon-sm" className="commerce-windowbar-browser-toggle" aria-label={browserPaneOpen ? '隐藏浏览器面板' : '打开浏览器面板'} title={browserPaneOpen ? '隐藏浏览器面板' : '打开浏览器面板'} onClick={() => void (browserPaneOpen ? hideBrowserPane() : openBrowserPane())}>{browserPaneOpen ? <PanelRightClose /> : <PanelRightOpen />}</Button>
    </div>
    <div className="commerce-body">
      <aside className={cn('commerce-sidebar', sidebarCollapsed && 'is-collapsed')}>
        <div className="commerce-sidebar-head">
          <div className="commerce-brand"><div><strong>轻作</strong><span>QINGZUO</span></div></div>
        </div>
        <nav aria-label="主导航">{navigation.map(({ id, title: label, icon: Icon }) => <Button key={id} variant={page === id ? 'secondary' : 'ghost'} aria-label={label} aria-current={page === id ? 'page' : undefined} className={cn('commerce-nav', id === 'settings' && 'commerce-nav-bottom')} onClick={() => void navigate(id)}><Icon data-icon="inline-start" /><span>{label}</span></Button>)}</nav>
        <div className="commerce-sidebar-footer"><span className={cn('connection-dot', status?.kernel.ready && 'connected')} /><span>{desktop ? status?.kernel.ready ? '工具服务已就绪' : '正在启动工具服务' : '浏览器界面预览'}</span><small>v{status?.version ?? version}</small></div>
      </aside>
      <div className={cn('commerce-main', page === 'chat' && 'commerce-chat-main')}>
      <div className="commerce-main-content">
      {error ? <Alert variant="destructive" className="commerce-alert"><AlertCircle /><AlertDescription className="flex items-center justify-between gap-3 flex-wrap"><span>{error}</span><Button variant="outline" size="sm" onClick={() => openIssueReport(error, '平台操作')}>反馈此问题</Button></AlertDescription></Alert> : null}
      {status?.migration ? <Alert className="commerce-alert"><Puzzle /><AlertDescription>
        LabelEdit 已独立发布。原有配置和文件保留，重新安装需要联网下载一次。<Button variant="outline" size="sm" disabled={busy || migrationRunning} onClick={() => act('market.install', { id: status.migration!.id })}>恢复 LabelEdit</Button><Button variant="ghost" size="sm" disabled={busy || migrationRunning} onClick={() => act('migration.dismiss')}>稍后从市场安装</Button>
        {migrationRunning ? <div className="plugin-update-progress" role="status" aria-label="LabelEdit 恢复状态" aria-live="polite" aria-busy="true">
          <Progress value={migrationProgress} indeterminate={migrationProgress === null} className="relative" aria-label="LabelEdit 恢复进度" />
          <span className="plugin-update-hint"><LoaderCircle className="animate-spin" />{migrationPhase}{migrationProgress !== null ? ` ${Math.floor(migrationProgress)}%` : ''}</span>
          {migrationInstall?.status === 'downloading' && (migrationInstall.transferred > 0 || migrationInstall.total > 0) ? <span className="plugin-update-hint">{(migrationInstall.transferred / 1024 ** 2).toFixed(1)} MB{migrationInstall.total > 0 ? ` / ${(migrationInstall.total / 1024 ** 2).toFixed(1)} MB` : ''}</span> : null}
        </div> : null}
        {migrationInstall?.status === 'error' ? <p className="mt-2 text-destructive">{migrationInstall.error || 'LabelEdit 恢复失败，请重试。'}</p> : null}
      </AlertDescription></Alert> : null}
      {status?.kernel.error ? <Alert variant="destructive" className="commerce-alert"><AlertCircle /><AlertDescription className="flex items-center justify-between gap-3 flex-wrap"><span>{status.kernel.error}</span><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => act('kernel.retry')}>重新启动工具服务</Button><Button variant="outline" size="sm" onClick={() => openIssueReport(status.kernel.error, '工具服务')}>反馈报错</Button></div></AlertDescription></Alert> : null}
      {!status ? <main className="commerce-content"><Skeleton className="h-12 w-64" /><Skeleton className="h-64 w-full" /></main> : page === 'chat' ? <main className="commerce-chat-content"><Suspense fallback={<Skeleton className="m-6 h-96 flex-1" />}><AIChat onSettings={() => void navigate('ai')} onOpenPlugin={showChatPlugin} /></Suspense></main> : shellPage ? <main className="commerce-content"><div className="commerce-content-inner">
        <div className="commerce-heading"><h1>{copy[0]}</h1><p>{copy[1]}</p></div>
        {page === 'home' ? <section className="workspace-feature"><img src={workspaceArt} alt="" /><div><h2>开始你的下一件小事</h2><p>{plugins.length ? <>从编辑一张标签，到处理一张商品图片。<br />让重复的工作更简单，把时间留给创作。</> : <>推荐 LabelEdit：PDF 编辑与文字识别。<br />推荐 AI 抠图：处理商品图片，按需安装。</>}</p><div className="workspace-feature-actions"><Button onClick={() => void navigate('market')}><Store data-icon="inline-start" />浏览插件市场<ArrowRight data-icon="inline-end" /></Button><Button variant="outline" onClick={() => void openBrowserPane()}><Globe data-icon="inline-start" />打开浏览器</Button></div></div></section> : null}
        {['home', 'market', 'plugins'].includes(page) ? <>
          <div className="tool-section-heading"><div><h2>{page === 'home' ? '我的工具' : title}</h2><span>{entries.length} 款工具</span></div><div className="commerce-page-actions"><InputGroup className="commerce-search"><InputGroupInput aria-label="搜索工具" placeholder="搜索工具名称或用途" value={query} onChange={e => setQuery(e.target.value)} /><InputGroupAddon><Search /></InputGroupAddon></InputGroup>{page === 'market' ? <Button variant="outline" size="sm" disabled={!desktop || busy} onClick={() => act('plugins.import')}><Upload data-icon="inline-start" />导入插件</Button> : null}</div></div>
          {page === 'plugins' ? <div className="plugin-check-toolbar" role="status">
            <div><strong>{pluginUpdates.length ? `发现 ${pluginUpdates.length} 个插件更新` : marketCheckedAt ? '所有插件均为最新版本' : '检查插件是否有新版本'}</strong>{marketCheckedAt ? <span>上次检查 {new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(marketCheckedAt)}</span> : null}</div>
            <Button variant="outline" size="sm" disabled={!desktop || busy || pluginCheckBusy} onClick={() => void checkPluginUpdates()}>{pluginCheckBusy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}检查插件更新</Button>
          </div> : null}
          {page === 'plugins' && pluginCheckError ? <Alert variant="destructive"><AlertCircle /><AlertDescription>{pluginCheckError}</AlertDescription></Alert> : null}
          {page === 'market' && categories.length ? <div className="market-filters" role="group" aria-label="工具分类">{['all', ...categories].map(item => <Button key={item} variant={category === item ? 'default' : 'outline'} aria-pressed={category === item} onClick={() => setCategory(item)}>{item === 'all' ? '全部工具' : item}</Button>)}</div> : null}
          {page === 'market' && marketState === 'loading' ? <div className="market-loading" role="status"><LoaderCircle className="animate-spin" />正在加载插件目录…</div> : page === 'market' && (marketState === 'error' || marketState === 'unavailable') ? <Empty className="market-empty"><EmptyHeader><Store /><EmptyTitle>{marketState === 'error' ? '暂时无法加载插件市场' : desktop ? '插件目录尚未就绪' : '在桌面应用中发现更多工具'}</EmptyTitle><EmptyDescription>{marketMessage}</EmptyDescription></EmptyHeader>{desktop ? <Button variant="outline" onClick={() => setMarketRevision(value => value + 1)}><RefreshCw data-icon="inline-start" />重新加载</Button> : null}</Empty> : <>
            <div className={cn('commerce-grid', page === 'market' ? 'market-grid' : 'tool-list')}>{results.map(entry => <PluginCard key={entry.id} entry={entry} installed={plugins.find(p => p.id === entry.id)} mode={page as 'home' | 'market' | 'plugins'} disabled={!desktop || busy} ready={status.kernel.ready} install={installFor(entry.id)} onOpen={settings => void navigate(entry.id, settings)} onAction={act} />)}</div>
            {!results.length ? <Empty><EmptyHeader><Search /><EmptyTitle>{query || category !== 'all' ? '没有找到工具' : '这里还没有工具'}</EmptyTitle><EmptyDescription>{query || category !== 'all' ? '换个关键词或分类，试试其他工具。' : '前往插件市场，或导入本地插件。'}</EmptyDescription></EmptyHeader>{query || category !== 'all' ? <Button variant="outline" onClick={() => { setQuery(''); setCategory('all'); }}>清除筛选</Button> : null}</Empty> : null}
          </>}
          {page === 'home' ? <button className="workspace-discover" onClick={() => void navigate('market')}><span className="discover-icon"><Plus /></span><span><strong>去插件市场，发现更多顺手工具</strong><small>按需扩展你的工作台，工具可以独立安装与更新。</small></span><ArrowRight /></button> : null}
          <div className="commerce-info"><ShieldCheck /><div><strong>{page === 'market' ? '每个工具都会先校验来源' : '你的工作台，由你掌握'}</strong><p>{page === 'market' ? '市场里的工具都来自已校验的发布目录，安装前会自动检查一遍。' : '本地工具在本机处理文件，联网工具按你的授权访问服务。'}</p></div></div>
        </> : null}
        {page === 'ai' ? <AISettings imageAvailable={desktop && plugins.some(plugin => plugin.id === 'official.ai-image' && plugin.enabled && !plugin.missing.length) && status.kernel.ready} onOpenImage={() => void navigate('official.ai-image', true)} onOpenChat={() => void navigate('chat')} /> : null}
        {page === 'settings' ? <div className="commerce-settings">
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>AI 助手</CardTitle>
              <CardDescription>统一管理助手模型、连接方式与图像 API Key。</CardDescription>
              <CardAction className="self-center">
                <Button variant="outline" onClick={() => void navigate('ai')}><Sparkles data-icon="inline-start" />打开 AI 设置<ArrowRight data-icon="inline-end" /></Button>
              </CardAction>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>外观</CardTitle>
              <CardDescription>为工作台选择舒适的显示方式。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="theme-options" role="group" aria-label="主题">
                {([{ value: 'light', label: '浅色', icon: Sun }, { value: 'dark', label: '深色', icon: Moon }, { value: 'system', label: '跟随系统', icon: Monitor }] as const).map(({ value, label, icon: Icon }) => (
                  <Button key={value} variant={theme === value ? 'secondary' : 'outline'} aria-pressed={theme === value} onClick={() => setTheme(value)}>
                    <Icon />{label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className="download-source-card">
            <div className="download-source-row">
              <div className="download-source-copy">
                <CardTitle role="heading" aria-level={2}>切换下载源</CardTitle>
                <CardDescription>下载会优先使用所选渠道；某个渠道不可用时会自动换用其他渠道。</CardDescription>
                {downloadSourceState.notice ? <p className="download-source-notice" role="status">{downloadSourceState.notice}</p> : null}
              </div>
              <div className="download-source-actions">
                <select className="download-source-select" aria-label="切换下载源" value={downloadSourceState.source} disabled={busy || customMirrorBusy} onChange={event => void handleDownloadSourceChange(event.target.value)}>
                  <option value="github">GitHub 官方源</option>
                  <option value="gitcode" disabled={downloadSourceState.gitcodeAvailable === false}>GitCode 国内源</option>
                  <option value="gh-proxy">GitHub 镜像 · gh-proxy.com</option>
                  <option value="gh-fast">GitHub 镜像 · ghfast.top</option>
                  {downloadSourceState.customMirrors.map(mirror => <option key={mirror} value={`custom:${mirror}`}>{formatCustomMirrorLabel(mirror)}</option>)}
                </select>
                <Button type="button" variant="outline" className="download-source-add-btn" disabled={busy || customMirrorBusy} onClick={() => { setCustomMirrorError(null); setCustomMirrorDialogOpen(true); }}>添加自定义源</Button>
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>关于轻作</CardTitle>
              <CardDescription>版本信息与本地服务状态。</CardDescription>
              <CardAction className="self-center">
                <Button variant="outline" size="sm" onClick={() => openIssueReport()}><Bug data-icon="inline-start" />提交反馈与报错</Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <dl className="runtime-info">
                <div><dt>版本</dt><dd>v{status.version}</dd></div>
                <div><dt>工具服务</dt><dd><span className={cn('runtime-service-dot', status.kernel.ready && 'is-ready')} />{status.kernel.ready ? '运行中' : desktop ? '启动中' : '浏览器预览不启动工具服务'}</dd></div>
              </dl>
              <div className="runtime-components" aria-label="轻作更新">
                <UpdateCard version={status.version} update={status.update} disabled={!desktop || busy} onAction={act} />
              </div>
            </CardContent>
          </Card>{customMirrorDialogOpen ? <div className="custom-mirror-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeCustomMirrorDialog(); }}><div className="custom-mirror-dialog" role="dialog" aria-modal="true" aria-labelledby="custom-mirror-dialog-title"><div className="custom-mirror-dialog-head"><div><p className="custom-mirror-dialog-eyebrow">切换下载源</p><h2 id="custom-mirror-dialog-title">添加自定义下载源</h2></div><Button type="button" variant="ghost" size="icon-sm" aria-label="关闭" title="关闭" disabled={customMirrorBusy} onClick={closeCustomMirrorDialog}><X /></Button></div><p className="custom-mirror-dialog-description">填写一个以 https:// 开头的镜像站地址，选中后立即生效。</p><form className="custom-mirror-form" onSubmit={event => void submitCustomMirror(event)}><input className="custom-mirror-input" type="url" value={customMirrorInput} onChange={event => { setCustomMirrorInput(event.target.value); if (customMirrorError) setCustomMirrorError(null); }} placeholder="镜像站地址，例如 https://mirror.example.com/" aria-label="镜像站地址，例如 https://mirror.example.com/" disabled={customMirrorBusy} autoFocus />{customMirrorError ? <p className="custom-mirror-error" role="alert">{customMirrorError}</p> : null}{downloadSourceState.customMirrors.length > 0 ? <div className="custom-mirror-list-section"><span className="custom-mirror-list-label">已添加的自定义源</span><ul className="custom-mirror-list">{downloadSourceState.customMirrors.map(mirror => <li key={mirror} className="custom-mirror-item"><span>{mirror}</span><Button type="button" variant="ghost" size="icon-xs" aria-label="删除自定义源" title="删除自定义源" disabled={customMirrorBusy} onClick={() => void removeCustomMirror(mirror)}><X /></Button></li>)}</ul></div> : null}<div className="custom-mirror-dialog-footer"><Button type="button" variant="outline" disabled={customMirrorBusy} onClick={closeCustomMirrorDialog}>取消</Button><Button type="submit" disabled={!customMirrorInput.trim() || customMirrorBusy}>添加并切换</Button></div></form></div></div> : null}</div> : null}
      </div></main> : <div ref={surface} className={cn('commerce-plugin-surface', !status.kernel.ready && 'opacity-50')} />}
      </div>
      </div>
      {browserPaneOpen ? <aside ref={browserPaneRef} className={cn('commerce-browser-pane', browserPaneResizing && 'is-resizing')} aria-label="浏览器面板" style={browserPaneWidth ? { flexBasis: `${Math.min(browserPaneLimits().max, Math.max(browserPaneLimits().min, browserPaneWidth))}px` } : undefined}>
        <div
          className="commerce-browser-resizer"
          role="separator"
          tabIndex={0}
          aria-label="调整浏览器面板宽度"
          aria-orientation="vertical"
          aria-valuemin={browserPaneLimits().min}
          aria-valuemax={browserPaneLimits().max}
          aria-valuenow={Math.round(browserPaneWidth ? Math.min(browserPaneLimits().max, Math.max(browserPaneLimits().min, browserPaneWidth)) : currentBrowserPaneWidth())}
          onPointerDown={beginBrowserResize}
          onPointerMove={moveBrowserResize}
          onPointerUp={endBrowserResize}
          onPointerCancel={endBrowserResize}
          onLostPointerCapture={endBrowserResize}
          onKeyDown={handleBrowserResizeKeyDown}
          onDoubleClick={() => {
            setBrowserPaneWidth(null);
            try { window.localStorage.removeItem('qingzuo.browserPaneWidth'); } catch { /* storage is optional */ }
          }}
        />
        <BrowserWorkspace showTabs={false} status={status?.browser ?? emptyBrowser} busy={busy} onAction={run} />
      </aside> : null}
      <IssueReportDialog
        open={issueDialogOpen}
        onClose={() => setIssueDialogOpen(false)}
        initialError={issueDialogError}
        env={{
          appVersion: status?.version,
          system: status?.system,
          kernelReady: status?.kernel.ready,
          kernelError: status?.kernel.error,
          plugins: status?.plugins.map(p => ({ id: p.id, version: p.version, title: p.title })),
        }}
      />
    </div>
  </div>;
}
