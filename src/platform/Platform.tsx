import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Boxes, Store, Puzzle, Settings, RefreshCw, ArrowRight, Plus, X, Search, ShieldCheck, AlertCircle, ChevronRight, Monitor, Moon, Sun, LoaderCircle, Upload, Download, Sparkles, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { PluginCard, pluginInstallActive, toolCategory, type Plugin, type ToolEntry } from './PluginCard';
import type { PluginInstallState } from './commerce';
import { useTheme } from '../theme/ThemeProvider';
import { cn } from '@/lib/utils';
import brandIcon from '@/assets/qingzuo.png';
import workspaceArt from '@/assets/workspace.png';
import { version } from '../../package.json';
import { UpdateCard, type UpdateState } from './UpdateCard';
import { AISettings } from './AISettings';
import { HARNESS_UI_VERSION } from './harness-client';
import cliProxyManifest from '../../desktop/upstream/cli-proxy.json';
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
interface Status { version: string; kernel: { ready: boolean; error: string | null; version: string; systems: { id: string; title: string; protected: boolean }[] }; plugins: Plugin[]; pluginInstalls?: PluginInstallState[]; tabs: string[]; update: UpdateState; cliProxy?: ComponentUpdateState; componentUpdates?: { cliProxy?: ComponentUpdateState; harness?: ComponentUpdateState }; migration?: { id: string; title: string; enabled: boolean } | null }
const navigation = [{ id: 'home', title: '工具中心', icon: Boxes }, { id: 'market', title: '插件市场', icon: Store }, { id: 'plugins', title: '插件管理', icon: Puzzle }, { id: 'chat', title: 'AI 对话', icon: MessageCircle }, { id: 'ai', title: 'AI 设置', icon: Sparkles }, { id: 'settings', title: '设置', icon: Settings }] as const;
const preview: Status = { version, kernel: { ready: false, error: null, version: HARNESS_UI_VERSION, systems: [] }, plugins: [], tabs: [], cliProxy: { status: 'idle', currentVersion: cliProxyManifest.version, candidateVersion: null, updateAvailable: false, error: null }, update: { status: 'idle', version: null, notes: '', error: null, progress: 0, transferred: 0, total: 0 } };
const pageCopy = {
  home: ['让日常工作，轻一点。', '把顺手的工具放在一起，专注每一次创作。'],
  market: ['让工作台，多一点可能。', '找到适合你的工具，按需安装，独立更新。'],
  plugins: ['每一件工具，都井井有条。', '管理已安装工具的状态、设置和版本。'],
  ai: ['AI 设置', '先接入账户，再选择助手模型。图像编辑单独配置。'],
  chat: ['AI 对话', 'DeepSeek Harness · 用自然语言调用工具。'],
  settings: ['按你的习惯，轻松工作。', '选择舒适的外观，查看工作台的运行环境与版本更新。'],
} as const;
export default function Platform() {
  const desktop = Boolean(window.commerceDesktop);
  const [status, setStatus] = useState<Status | null>(desktop ? null : preview);
  const [page, setPage] = useState<Page | string>('home');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startingPluginId, setStartingPluginId] = useState<string | null>(null);
  const pendingInstalls = useRef(new Set<string>());
  const [market, setMarket] = useState<ToolEntry[]>([]);
  const [marketState, setMarketState] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading');
  const [marketMessage, setMarketMessage] = useState('');
  const [marketRevision, setMarketRevision] = useState(0);
  const surface = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();
  const refresh = useCallback(async () => { if (window.commerceDesktop) try { setStatus(await window.commerceDesktop.invoke<Status>('status')); } catch (e) { setError(String(e)); } }, []);
  useEffect(() => { void refresh(); return window.commerceDesktop?.onChanged(() => { void refresh(); }); }, [refresh]);
  const showChatPlugin = useCallback((id: string) => { setPage(id); setQuery(''); setCategory('all'); }, []);
  useEffect(() => window.commerceDesktop?.onAI?.(event => { if (event.type === 'navigate') showChatPlugin(event.pluginId); }), [showChatPlugin]);
  const run = async (method: string, args?: unknown) => {
    const installId = method === 'market.install' && args && typeof args === 'object' && 'id' in args && typeof args.id === 'string' ? args.id : null;
    if (installId && (pendingInstalls.current.has(installId) || pluginInstallActive(status?.pluginInstalls?.find(job => job.id === installId)))) return;
    if (installId) { pendingInstalls.current.add(installId); setStartingPluginId(installId); }
    setBusy(true); setError(null);
    try { const value = await window.commerceDesktop?.invoke(method, args); await refresh(); return value; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; }
    finally { setBusy(false); if (installId) { pendingInstalls.current.delete(installId); setStartingPluginId(null); } }
  };
  const act = (method: string, args?: unknown) => { void run(method, args).catch(() => {}); };
  async function navigate(next: string, settings = false) {
    try {
      if (navigation.some(item => item.id === next)) await window.commerceDesktop?.invoke('view.hide');
      else await run('view.open', { id: next, settings });
      setPage(next); setQuery(''); setCategory('all');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => {
    if (page !== 'market') return;
    let active = true;
    setMarket([]); setMarketState('loading'); setMarketMessage('');
    if (!window.commerceDesktop) { setMarketState('unavailable'); setMarketMessage('在轻作桌面应用中浏览签名目录并安装插件。'); return; }
    window.commerceDesktop.invoke<{ items: ToolEntry[]; message?: string }>('market.list').then(value => {
      if (!active) return;
      setMarket(value.items); setMarketMessage(value.message || ''); setMarketState(value.message ? 'unavailable' : 'ready');
    }).catch(e => { if (active) { setMarketMessage(e instanceof Error ? e.message : String(e)); setMarketState('error'); } });
    return () => { active = false; };
  }, [page, marketRevision]);
  useEffect(() => {
    const element = surface.current;
    if (!element || navigation.some(n => n.id === page)) return;
    const update = () => { const rect = element.getBoundingClientRect(); void window.commerceDesktop?.invoke('view.bounds', { x: rect.x, y: rect.y, width: rect.width, height: rect.height }); };
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, [page]);
  const plugins = status?.plugins ?? [];
  const cliProxyState = status?.cliProxy ?? status?.componentUpdates?.cliProxy ?? preview.cliProxy!;
  const cliProxyCurrentVersion = cliProxyState.currentVersion ?? cliProxyManifest.version;
  const cliProxyCandidate = cliProxyState.candidateVersion ?? (cliProxyState.currentVersion ? cliProxyState.version : null);
  const cliProxyChecking = ['checking', 'downloading', 'installing', 'stopping', 'starting', 'rolling-back'].includes(cliProxyState.status);
  const cliProxyResult = cliProxyState.error
    ? cliProxyState.error
    : cliProxyState.updateAvailable || cliProxyState.status === 'available'
      ? cliProxyState.canUpdate === true
        ? `检测到候选版本 v${cliProxyCandidate ?? '最新版本'}，已通过兼容性验证。`
        : `检测到候选版本 v${cliProxyCandidate ?? '最新版本'}，请先完成兼容性验证后再更新。`
      : cliProxyState.status === 'current'
        ? '当前已是最新版本。'
        : cliProxyState.status === 'ready'
          ? `已切换到 v${cliProxyCurrentVersion}，模型需要重新验证。`
        : '只检查官方候选版本，不会替换正在运行的代理。';
  const installFor = (id: string): PluginInstallState | undefined => startingPluginId === id ? { id, version: null, status: 'checking', progress: null, transferred: 0, total: 0, error: null } : status?.pluginInstalls?.find(job => job.id === id);
  const migrationInstall = status?.migration ? installFor(status.migration.id) : undefined;
  const migrationRunning = pluginInstallActive(migrationInstall);
  const migrationProgress = migrationInstall?.status === 'downloading' && migrationInstall.progress !== null ? Math.min(100, Math.max(0, migrationInstall.progress)) : null;
  const migrationPhase = migrationInstall ? ({ checking: '正在检查插件版本…', downloading: '正在下载插件…', verifying: '正在校验插件签名…', installing: '正在安装插件…', syncing: '正在刷新工具…', installed: '', error: '' }[migrationInstall.status]) : '';
  const entries = page === 'market' ? market : plugins;
  const categories = [...new Set(entries.map(toolCategory))];
  const results = entries.filter(p => (category === 'all' || toolCategory(p) === category) && `${p.title} ${p.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const title = navigation.find(n => n.id === page)?.title ?? plugins.find(p => p.id === page)?.title ?? '工具';
  const shellPage = navigation.some(n => n.id === page);
  const copy = pageCopy[page as Page];
  return <div className="commerce-shell">
    <aside className="commerce-sidebar">
      <div className="commerce-brand"><img src={brandIcon} alt="" /><div><strong>轻作</strong><span>QINGZUO</span></div></div>
      <nav aria-label="主导航">{navigation.map(({ id, title: label, icon: Icon }) => <Button key={id} variant={page === id ? 'secondary' : 'ghost'} aria-label={label} aria-current={page === id ? 'page' : undefined} className={cn('commerce-nav', id === 'settings' && 'commerce-nav-bottom')} onClick={() => void navigate(id)}><Icon data-icon="inline-start" /><span>{label}</span></Button>)}</nav>
      <div className="commerce-sidebar-footer"><span className={cn('connection-dot', status?.kernel.ready && 'connected')} /><span>{desktop ? status?.kernel.ready ? 'Harness 内核已连接' : '等待内核启动' : '浏览器界面预览'}</span><small>v{status?.version ?? version}</small></div>
    </aside>
    <div className={cn('commerce-main', page === 'chat' && 'commerce-chat-main')}>
      {page !== 'chat' ? <header className="commerce-topbar"><div className="commerce-breadcrumb"><span>工作台</span><ChevronRight /><strong>{title}</strong></div><Button variant="outline" disabled={!desktop || busy} onClick={() => act('plugins.import')}><Upload data-icon="inline-start" />导入插件</Button></header> : null}
      {status?.tabs.length ? <div className="commerce-tool-tabs" role="tablist" aria-label="已打开的工具">{status.tabs.map(id => <div key={id} className="commerce-tool-tab"><Button role="tab" aria-selected={page === id} disabled={pluginInstallActive(installFor(id))} variant={page === id ? 'secondary' : 'ghost'} size="sm" onClick={() => void navigate(id)}>{plugins.find(p => p.id === id)?.title ?? id}</Button><Button variant="ghost" size="icon-sm" aria-label="关闭工具" onClick={() => { void run('view.close', { id }).then(() => { if (page === id) setPage('home'); }).catch(() => {}); }}><X /></Button></div>)}</div> : null}
      {error ? <Alert variant="destructive" className="commerce-alert"><AlertCircle /><AlertDescription>{error}</AlertDescription></Alert> : null}
      {status?.migration ? <Alert className="commerce-alert"><Puzzle /><AlertDescription>
        LabelEdit 已独立发布。原有配置和文件保留，重新安装需要联网下载一次。<Button variant="outline" size="sm" disabled={busy || migrationRunning} onClick={() => act('market.install', { id: status.migration!.id })}>恢复 LabelEdit</Button><Button variant="ghost" size="sm" disabled={busy || migrationRunning} onClick={() => act('migration.dismiss')}>稍后从市场安装</Button>
        {migrationRunning ? <div className="plugin-update-progress" role="status" aria-label="LabelEdit 恢复状态" aria-live="polite" aria-busy="true">
          <Progress value={migrationProgress} className="relative" aria-label="LabelEdit 恢复进度">{migrationProgress === null ? <div className="plugin-update-shimmer" aria-hidden="true" /> : null}</Progress>
          <span className="plugin-update-hint"><LoaderCircle className="animate-spin" />{migrationPhase}{migrationProgress !== null ? ` ${Math.floor(migrationProgress)}%` : ''}</span>
          {migrationInstall?.status === 'downloading' && (migrationInstall.transferred > 0 || migrationInstall.total > 0) ? <span className="plugin-update-hint">{(migrationInstall.transferred / 1024 ** 2).toFixed(1)} MB{migrationInstall.total > 0 ? ` / ${(migrationInstall.total / 1024 ** 2).toFixed(1)} MB` : ''}</span> : null}
        </div> : null}
        {migrationInstall?.status === 'error' ? <p className="mt-2 text-destructive">{migrationInstall.error || 'LabelEdit 恢复失败，请重试。'}</p> : null}
      </AlertDescription></Alert> : null}
      {status?.kernel.error ? <Alert variant="destructive" className="commerce-alert"><AlertCircle /><AlertDescription>{status.kernel.error}<Button variant="outline" size="sm" onClick={() => act('kernel.retry')}>重新启动内核</Button></AlertDescription></Alert> : null}
      {!status ? <main className="commerce-content"><Skeleton className="h-12 w-64" /><Skeleton className="h-64 w-full" /></main> : page === 'chat' ? <main className="commerce-chat-content"><Suspense fallback={<Skeleton className="m-6 h-96 flex-1" />}><AIChat onSettings={() => void navigate('ai')} onOpenPlugin={showChatPlugin} /></Suspense></main> : shellPage ? <main className="commerce-content"><div className="commerce-content-inner">
        <div className="commerce-heading"><h1>{copy[0]}</h1><p>{copy[1]}</p></div>
        {page === 'home' ? <section className="workspace-feature"><img src={workspaceArt} alt="" /><div><h2>开始你的下一件小事</h2><p>{plugins.length ? <>从编辑一张标签，到处理一张商品图片。<br />让重复的工作更简单，把时间留给创作。</> : <>推荐 LabelEdit：PDF 编辑与文字识别。<br />推荐 AI 抠图：处理商品图片，按需安装。</>}</p><Button onClick={() => void navigate('market')}><Store data-icon="inline-start" />浏览插件市场<ArrowRight data-icon="inline-end" /></Button></div></section> : null}
        {['home', 'market', 'plugins'].includes(page) ? <>
          <div className="tool-section-heading"><div><h2>{page === 'home' ? '我的工具' : title}</h2><span>{entries.length} 款工具</span></div><InputGroup className="commerce-search"><InputGroupInput aria-label="搜索工具" placeholder="搜索工具名称或用途" value={query} onChange={e => setQuery(e.target.value)} /><InputGroupAddon><Search /></InputGroupAddon></InputGroup></div>
          {page === 'market' && categories.length ? <div className="market-filters" role="group" aria-label="工具分类">{['all', ...categories].map(item => <Button key={item} variant={category === item ? 'default' : 'outline'} aria-pressed={category === item} onClick={() => setCategory(item)}>{item === 'all' ? '全部工具' : item}</Button>)}</div> : null}
          {page === 'market' && marketState === 'loading' ? <div className="market-loading" role="status"><LoaderCircle className="animate-spin" />正在加载插件目录…</div> : page === 'market' && (marketState === 'error' || marketState === 'unavailable') ? <Empty className="market-empty"><EmptyHeader><Store /><EmptyTitle>{marketState === 'error' ? '暂时无法加载插件市场' : desktop ? '插件目录尚未就绪' : '在桌面应用中发现更多工具'}</EmptyTitle><EmptyDescription>{marketMessage}</EmptyDescription></EmptyHeader>{desktop ? <Button variant="outline" onClick={() => setMarketRevision(value => value + 1)}><RefreshCw data-icon="inline-start" />重新加载</Button> : null}</Empty> : <>
            <div className={cn('commerce-grid', page === 'market' ? 'market-grid' : 'tool-list')}>{results.map(entry => <PluginCard key={entry.id} entry={entry} installed={plugins.find(p => p.id === entry.id)} mode={page as 'home' | 'market' | 'plugins'} disabled={!desktop || busy} ready={status.kernel.ready} install={installFor(entry.id)} onOpen={settings => void navigate(entry.id, settings)} onAction={act} />)}</div>
            {!results.length ? <Empty><EmptyHeader><Search /><EmptyTitle>{query || category !== 'all' ? '没有找到工具' : '这里还没有工具'}</EmptyTitle><EmptyDescription>{query || category !== 'all' ? '换个关键词或分类，试试其他工具。' : '前往插件市场，或导入本地插件。'}</EmptyDescription></EmptyHeader>{query || category !== 'all' ? <Button variant="outline" onClick={() => { setQuery(''); setCategory('all'); }}>清除筛选</Button> : null}</Empty> : null}
          </>}
          {page === 'home' ? <button className="workspace-discover" onClick={() => void navigate('market')}><span className="discover-icon"><Plus /></span><span><strong>去插件市场，发现更多顺手工具</strong><small>按需扩展你的工作台，工具可以独立安装与更新。</small></span><ArrowRight /></button> : null}
          <div className="commerce-info"><ShieldCheck /><div><strong>{page === 'market' ? '插件签名验证' : '你的工作台，由你掌握'}</strong><p>{page === 'market' ? '从签名目录安装工具，管理你自己的工作台。' : '本地工具在本机处理文件，联网插件按授权访问服务。'}</p></div></div>
        </> : null}
        {page === 'ai' ? <AISettings imageAvailable={desktop && plugins.some(plugin => plugin.id === 'official.ai-image' && plugin.enabled && !plugin.missing.length) && status.kernel.ready} onOpenImage={() => void navigate('official.ai-image', true)} onOpenChat={() => void navigate('chat')} /> : null}
        {page === 'settings' ? <div className="commerce-settings"><Card><CardHeader><CardTitle role="heading" aria-level={2}>AI 模型与账户</CardTitle><CardDescription>图像 API Key、助手服务和 OAuth 登录已集中到独立的 AI 设置页。</CardDescription></CardHeader><CardContent><Button variant="outline" onClick={() => void navigate('ai')}><Sparkles data-icon="inline-start" />打开 AI 设置<ArrowRight data-icon="inline-end" /></Button></CardContent></Card><Card><CardHeader><CardTitle role="heading" aria-level={2}>外观</CardTitle><CardDescription>为工作台选择舒适的显示方式。</CardDescription></CardHeader><CardContent><div className="theme-options" role="group" aria-label="主题">{([{ value: 'light', label: '浅色', icon: Sun }, { value: 'dark', label: '深色', icon: Moon }, { value: 'system', label: '跟随系统', icon: Monitor }] as const).map(({ value, label, icon: Icon }) => <Button key={value} variant={theme === value ? 'secondary' : 'outline'} aria-pressed={theme === value} onClick={() => setTheme(value)}><Icon />{label}</Button>)}</div></CardContent></Card><Card><CardHeader><CardTitle role="heading" aria-level={2}>运行环境</CardTitle><CardDescription>轻作与本地平台服务。</CardDescription></CardHeader><CardContent><dl className="runtime-info"><div><dt>轻作</dt><dd>v{status.version}</dd></div><div><dt>Harness / DeepSeek 内核</dt><dd>v{status.kernel.version}</dd></div><div><dt>CLIProxyAPI</dt><dd>v{cliProxyCurrentVersion}</dd></div><div><dt>运行状态</dt><dd>{status.kernel.ready ? '内核运行正常' : desktop ? '内核尚未就绪' : '浏览器预览不启动本地内核'}</dd></div></dl><div className="runtime-systems">{status.kernel.systems.map(s => <Badge key={s.id} variant="secondary">{s.title}</Badge>)}</div><div className="runtime-components" aria-label="版本与组件更新"><UpdateCard version={status.version} kernelVersion={status.kernel.version} update={status.update} disabled={!desktop || busy} onAction={act} /><div className="runtime-component"><div><strong>CLIProxyAPI v{cliProxyCurrentVersion}</strong><p className="runtime-component-description">{cliProxyResult}</p>{cliProxyCandidate ? <p className="runtime-component-candidate">候选版本 v{cliProxyCandidate}</p> : null}</div><div className="runtime-component-actions"><Button variant="outline" size="sm" disabled={!desktop || busy || cliProxyChecking} onClick={() => act('cliProxy.check')}>{cliProxyChecking ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}检查 CLIProxyAPI 更新</Button>{cliProxyState.updateAvailable && cliProxyState.canUpdate === true ? <Button size="sm" disabled={!desktop || busy || cliProxyChecking} onClick={() => act('cliProxy.update')}><Download data-icon="inline-start" />立即更新</Button> : null}</div></div></div></CardContent></Card></div> : null}
      </div></main> : <div ref={surface} className={cn('commerce-plugin-surface', !status.kernel.ready && 'opacity-50')} />}
    </div>
  </div>;
}
