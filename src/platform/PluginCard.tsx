import { lazy, Suspense, useId, useState } from 'react';
import { AlertCircle, Check, Download, FileText, Image, LoaderCircle, Puzzle, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { PluginInstallState } from './commerce';
import { resolvePluginIcon } from './plugin-icons';
import gte from 'semver/functions/gte';
const ReleaseNotes = lazy(() => import('@/components/ReleaseNotes'));

export interface ToolEntry {
  id: string; title: string; description: string; category?: string; version: string; releaseNotes?: string; icon?: string; api?: string; compatible?: boolean; tier?: PluginTier; official?: boolean; sourceUnavailable?: boolean; stats?: { downloads?: number };
}
export interface Plugin extends ToolEntry {
  enabled: boolean; source: string; local: boolean; bundled?: boolean; missing: string[]; settings?: { title: string }; error?: string;
}
export type PluginTier = 'platform' | 'official' | 'community';
export const pluginTierLabels: Record<PluginTier, string> = { platform: '底座内置', official: '官方社区', community: '第三方' };
export function isPluginTier(value: unknown): value is PluginTier {
  return value === 'platform' || value === 'official' || value === 'community';
}
export function isTrustedPluginTier(value: unknown): boolean {
  return value === 'platform' || value === 'official';
}
export function isTrustedPluginSource(value: unknown): boolean {
  return value === 'market' || value === 'bundled';
}
export function toolCategory(tool: ToolEntry) { return tool.category || '其他工具'; }
export function pluginTier(tool: ToolEntry, installed?: Pick<Plugin, 'source' | 'tier'>): PluginTier {
  if (installed) {
    if (installed.source === 'local') return 'community';
    if (isPluginTier(installed.tier)) return installed.tier;
    return installed.source === 'bundled' ? 'platform' : 'community';
  }
  if (isPluginTier(tool.tier)) return tool.tier;
  if (typeof tool.official === 'boolean') return tool.official ? 'official' : 'community';
  return tool.id.startsWith('official.') ? 'official' : 'community';
}
export function pluginOriginLabel(tool: ToolEntry, installed?: Pick<Plugin, 'source' | 'tier'>) {
  return pluginTierLabels[pluginTier(tool, installed)];
}
export function pluginInstallActive(install?: PluginInstallState) {
  return Boolean(install && ['checking', 'downloading', 'verifying', 'installing', 'syncing'].includes(install.status));
}
const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const exactNumber = new Intl.NumberFormat('zh-CN');
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 1 });
export function formatDownloadCount(downloads: number) {
  return downloads >= 1000 ? compactNumber.format(downloads) : exactNumber.format(downloads);
}
export function pluginInstallSourceLabel(source?: string) {
  return ({ bundled: '随应用内置', local: '本地导入', market: '市场安装' } as Record<string, string>)[source ?? ''] ?? source;
}
interface PluginCardProps {
  entry: ToolEntry; installed?: Plugin; mode: 'installed' | 'catalog'; disabled: boolean; ready: boolean; install?: PluginInstallState;
  onOpen: (settings?: boolean) => void; onAction: (method: string, args: unknown) => void;
}
export function PluginCard({ entry, installed, mode, disabled, ready, install, onOpen, onAction }: PluginCardProps) {
  const installedIdentity = mode === 'installed' ? installed : undefined;
  const displayTitle = installedIdentity?.title ?? entry.title;
  const displayDescription = installedIdentity?.description ?? entry.description;
  const displayCategory = toolCategory(installedIdentity ?? entry);
  const tier = mode === 'catalog' ? pluginTier(entry) : pluginTier(entry, installed);
  const trustSource = mode === 'catalog' ? (installed?.source === 'bundled' ? 'bundled' : 'market') : installed?.source;
  const trusted = isTrustedPluginTier(tier) && isTrustedPluginSource(trustSource);
  const isLabel = trusted && entry.id === 'official.labeledit';
  const isCutout = trusted && entry.id === 'official.removebg';
  const Icon = isLabel ? FileText : isCutout ? Image : Puzzle;
  const iconSrc = resolvePluginIcon(entry.id, installedIdentity ? installedIdentity.icon : entry.icon, { tier, source: trustSource });
  // A stale catalog must not offer a downgrade of a newer bundled/local tool.
  const current = installed ? gte(installed.version, entry.version) : false;
  const updateAvailable = mode === 'installed' && Boolean(installed) && !current;
  const displayVersion = mode === 'installed' && installed ? installed.version : entry.version;
  const updating = pluginInstallActive(install);
  const unavailable = disabled || updating;
  const failed = install?.status === 'error';
  const catalogInstalled = mode === 'catalog' && installed !== undefined && (installed.source === 'market' || installed.source === 'bundled');
  const progress = install?.status === 'downloading' && install.progress !== null ? Math.min(100, Math.max(0, install.progress)) : null;
  const marketDownloads = entry.stats?.downloads;
  const downloads = mode === 'catalog' && typeof marketDownloads === 'number' && Number.isSafeInteger(marketDownloads) && marketDownloads > 0 ? marketDownloads : null;
  const notesId = useId();
  const manageId = useId();
  const [notesOpen, setNotesOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const hasNotes = Boolean(entry.releaseNotes);
  const notesToggle = hasNotes ? <Button className="plugin-notes-toggle" variant="ghost" size="icon-xs" title="版本说明" aria-label={notesOpen ? '收起版本说明' : '查看版本说明'} aria-expanded={notesOpen} aria-controls={notesOpen ? notesId : undefined} onClick={() => setNotesOpen(open => !open)}><ScrollText aria-hidden="true" /></Button> : null;
  const openAction = installed && (mode === 'installed' || catalogInstalled) ? <Button variant="outline" size="sm" disabled={unavailable || !ready || !installed.enabled || Boolean(installed.missing.length)} onClick={() => onOpen()}>打开</Button> : null;
  const showInstallAction = !installed || failed || (catalogInstalled && !current && !entry.sourceUnavailable);
  const phase = install ? ({ checking: '正在检查插件版本…', downloading: installed ? '正在下载新版本…' : '正在下载插件…', verifying: '正在校验插件包…', installing: installed ? '正在安装新版本…' : '正在安装插件…', syncing: '正在刷新工具…', installed: `安装完成${install.version ? ` · v${install.version}` : ''}`, error: '' }[install.status]) : '';
  const retryLabel = installed ? '重试更新' : '重试安装';
  const retry = () => onAction('market.install', { id: entry.id });
  const manage = (method: string, args: unknown) => {
    onAction(method, args);
    setManageOpen(false);
  };
  return <Card className={cn('plugin-card', isCutout && 'plugin-image', updating && 'is-updating')}>
    <CardHeader>
      <span className={cn('commerce-tool-icon', iconSrc && 'has-image')}>{iconSrc ? <img src={iconSrc} alt="" /> : <Icon />}</span>
      <div className="plugin-info">
        <CardTitle role="heading" aria-level={2}>{displayTitle}</CardTitle>
        <span className="plugin-category">{displayCategory}</span>
      </div>
    </CardHeader>
    <CardContent>
      <CardDescription className="plugin-description" title={displayDescription}>{displayDescription}</CardDescription>
      {entry.compatible === false ? <p role="alert">请先将轻作更新到较新版本，再安装这个工具。</p> : null}
      {entry.sourceUnavailable ? <p role="status">暂时无法获取最新版本，请稍后重试。</p> : null}
      {notesOpen && entry.releaseNotes ? <div className="plugin-notes-panel" id={notesId}><Suspense fallback={<span>加载更新说明…</span>}><ReleaseNotes body={entry.releaseNotes} /></Suspense></div> : null}
      {mode === 'catalog' ? <>
        {isLabel ? <p className="plugin-capabilities">离线识别<span>·</span>原尺寸导出</p> : isCutout ? <p className="plugin-capabilities">使用你自己的 remove.bg 密钥</p> : null}
        <span className="plugin-market-meta">
          {installed ? <span className={cn('plugin-installed', !installed.enabled && 'is-muted')}><Check aria-hidden="true" />{installed.enabled ? (installed.source === 'local' ? '本地已安装' : '已安装') : '已停用'}</span> : null}
          {installed?.missing.length ? <span className="plugin-status-warning">缺少组件</span> : null}
          <span className="plugin-origin">{pluginOriginLabel(entry, installed)}</span>
          <span className="plugin-version">v{entry.version}</span>
          {downloads !== null ? <span className="plugin-downloads" title={`累计下载 ${exactNumber.format(downloads)} 次`} aria-label={`累计下载 ${exactNumber.format(downloads)} 次`}><Download aria-hidden="true" />{formatDownloadCount(downloads)}</span> : null}
        </span>
      </> : <ul className="plugin-state">
        <li className="plugin-state-version">v{displayVersion}</li>
        {updateAvailable ? <li className="plugin-state-chip is-update">可更新到 v{entry.version}</li> : null}
        <li className={cn('plugin-state-chip', installed?.enabled ? 'is-enabled' : 'is-disabled')}>{installed?.enabled ? '已启用' : '已停用'}</li>
        {installed?.missing.length ? <li className="plugin-state-chip is-warning">缺少所需组件</li> : null}
        <li className="plugin-state-chip">{pluginOriginLabel(entry, installed)}</li>
        <li className="plugin-state-chip">{pluginInstallSourceLabel(installed?.source)}</li>
      </ul>}
      {mode === 'installed' && manageOpen ? <div id={manageId} className="plugin-manage-panel" role="group" aria-label={`${displayTitle} 管理`}>
        <Button variant="outline" size="sm" disabled={unavailable} onClick={() => manage('plugins.enable', { id: entry.id, enabled: !installed?.enabled })}>{installed?.enabled ? '停用' : '启用'}</Button>
        {installed?.settings ? <Button variant="outline" size="sm" disabled={unavailable || !installed.enabled} onClick={() => { setManageOpen(false); onOpen(true); }}>插件设置</Button> : null}
        <Button variant="ghost" size="sm" disabled={unavailable} onClick={() => manage('plugins.rollback', { id: entry.id })}>恢复版本</Button>
        <Button variant="ghost" size="sm" className="plugin-danger-action" disabled={unavailable} onClick={() => manage('plugins.uninstall', { id: entry.id })}>卸载</Button>
      </div> : null}
      {installed?.error ? <p role="alert" className="text-destructive">{installed.error}</p> : null}
      {updating ? <div className="plugin-update-progress" role="status" aria-busy="true" aria-live="polite">
        <Progress value={progress} indeterminate={progress === null} className="relative" aria-label={`${displayTitle} 安装进度`} />
        <span className="plugin-update-hint"><LoaderCircle className="animate-spin" />{phase}{progress !== null ? ` ${Math.floor(progress)}%` : ''}</span>
        {install?.status === 'downloading' && (install.transferred > 0 || install.total > 0) ? <span className="plugin-update-hint">{megabytes(install.transferred)}{install.total > 0 ? ` / ${megabytes(install.total)}` : ''}</span> : null}
      </div> : null}
      {install?.status === 'installed' && installed?.version === install.version ? <p className="plugin-update-hint" role="status"><Check />{phase}</p> : null}
      {failed ? <Alert variant="destructive"><AlertCircle /><AlertDescription>{install.error || '插件安装失败，请重试。'}{mode === 'installed' ? <Button variant="outline" size="sm" disabled={disabled || entry.sourceUnavailable} onClick={retry}>{retryLabel}</Button> : null}</AlertDescription></Alert> : null}
    </CardContent>
    <CardFooter>
      {mode === 'catalog' ? <>{notesToggle}<div className="plugin-card-actions">
        {openAction}
        {showInstallAction ? <Button size="sm" disabled={unavailable || entry.sourceUnavailable || entry.compatible === false} aria-label={updating ? (installed ? '更新插件' : '安装插件') : undefined} onClick={retry}>{entry.sourceUnavailable ? '暂不可用' : entry.compatible === false ? '需要升级轻作' : updating ? <><LoaderCircle data-icon="inline-start" className="animate-spin" />{installed ? '更新中…' : '安装中…'}</> : failed ? retryLabel : installed ? '更新插件' : '安装插件'}</Button> : null}
      </div></> : <>
        {notesToggle}
        <div className="plugin-card-actions">
          {updateAvailable && !entry.sourceUnavailable ? <Button size="sm" disabled={unavailable || entry.compatible === false} onClick={retry}>{updating ? <><LoaderCircle data-icon="inline-start" className="animate-spin" />更新中…</> : entry.compatible === false ? '需要升级轻作' : '更新插件'}</Button> : null}
          <Button variant="outline" size="sm" disabled={unavailable} aria-expanded={manageOpen} aria-controls={manageOpen ? manageId : undefined} onClick={() => setManageOpen(open => !open)}>管理</Button>
          {openAction}
        </div>
      </>}
    </CardFooter>
  </Card>;
}
