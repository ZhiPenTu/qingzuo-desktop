import { lazy, Suspense } from 'react';
import { AlertCircle, ArrowRight, Check, ChevronDown, Download, FileText, Image, LoaderCircle, Puzzle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { PluginInstallState } from './commerce';
import gte from 'semver/functions/gte';
const ReleaseNotes = lazy(() => import('@/components/ReleaseNotes'));

export interface ToolEntry {
  id: string; title: string; description: string; category?: string; version: string; releaseNotes?: string; icon?: string; api?: string; compatible?: boolean; stats?: { downloads?: number };
}
export interface Plugin extends ToolEntry {
  enabled: boolean; source: string; local: boolean; missing: string[]; settings?: { title: string }; error?: string;
}
export function toolCategory(tool: ToolEntry) { return tool.category || '其他工具'; }
export function pluginInstallActive(install?: PluginInstallState) {
  return Boolean(install && ['checking', 'downloading', 'verifying', 'installing', 'syncing'].includes(install.status));
}
const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const exactNumber = new Intl.NumberFormat('zh-CN');
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 1 });
export function formatDownloadCount(downloads: number) {
  return downloads >= 1000 ? compactNumber.format(downloads) : exactNumber.format(downloads);
}
interface PluginCardProps {
  entry: ToolEntry; installed?: Plugin; mode: 'home' | 'market' | 'plugins'; disabled: boolean; ready: boolean; install?: PluginInstallState;
  onOpen: (settings?: boolean) => void; onAction: (method: string, args: unknown) => void;
}
export function PluginCard({ entry, installed, mode, disabled, ready, install, onOpen, onAction }: PluginCardProps) {
  const isLabel = entry.id === 'official.labeledit';
  const isCutout = entry.id === 'official.removebg';
  const Icon = isLabel ? FileText : isCutout ? Image : Puzzle;
  // A stale catalog must not offer a downgrade of a newer bundled/local tool.
  const current = installed ? gte(installed.version, entry.version) : false;
  const updateAvailable = mode === 'plugins' && Boolean(installed) && !current;
  const displayVersion = mode === 'plugins' && installed ? installed.version : entry.version;
  const updating = pluginInstallActive(install);
  const unavailable = disabled || updating;
  const failed = install?.status === 'error';
  const progress = install?.status === 'downloading' && install.progress !== null ? Math.min(100, Math.max(0, install.progress)) : null;
  const marketDownloads = entry.stats?.downloads;
  const downloads = mode === 'market' && typeof marketDownloads === 'number' && Number.isSafeInteger(marketDownloads) && marketDownloads > 0 ? marketDownloads : null;
  const phase = install ? ({ checking: '正在检查插件版本…', downloading: installed ? '正在下载新版本…' : '正在下载插件…', verifying: '正在校验插件签名…', installing: installed ? '正在安装新版本…' : '正在安装插件…', syncing: '正在刷新工具…', installed: `安装完成${install.version ? ` · v${install.version}` : ''}`, error: '' }[install.status]) : '';
  const retryLabel = installed ? '重试更新' : '重试安装';
  const retry = () => onAction('market.install', { id: entry.id });
  return <Card className={cn('plugin-card', mode !== 'market' && 'plugin-row', isCutout && 'plugin-image', updating && 'is-updating')}>
    <CardHeader>
      <span className={cn('commerce-tool-icon', entry.icon && 'has-image')}>{entry.icon ? <img src={entry.icon} alt="" /> : <Icon />}</span>
      <div className="plugin-info">
        <span className="plugin-category">{toolCategory(entry)}</span>
        <CardTitle role="heading" aria-level={2}>{entry.title}</CardTitle>
        <CardDescription>{entry.description}</CardDescription>
      </div>
    </CardHeader>
    <CardContent>
      {entry.compatible === false ? <p role="alert">请先将轻作更新到较新版本，再安装这个工具。</p> : null}
      {mode === 'market' ? <>
        {isLabel ? <p className="plugin-capabilities">离线识别<span>·</span>原尺寸导出</p> : isCutout ? <p className="plugin-capabilities">使用你自己的 remove.bg 密钥</p> : null}
        {entry.releaseNotes ? <details className="plugin-notes"><summary>版本说明<ChevronDown /></summary><Suspense fallback={<span>加载更新说明…</span>}><ReleaseNotes body={entry.releaseNotes} /></Suspense></details> : null}
      </> : <ul className="plugin-state">
        <li className="plugin-state-version">v{displayVersion}</li>
        {updateAvailable ? <li className="plugin-state-chip is-update">可更新到 v{entry.version}</li> : null}
        <li className="plugin-state-chip">{installed?.enabled ? '已启用' : '已停用'}</li>
        {installed?.missing.length ? <li className="plugin-state-chip is-warning">缺少所需组件</li> : null}
        <li className="plugin-state-chip">{({ bundled: '内置工具', local: '本地导入', market: '市场安装' }[installed?.source ?? ''] ?? installed?.source)}</li>
      </ul>}
      {mode === 'plugins' && entry.releaseNotes ? <details className="plugin-notes"><summary>版本说明<ChevronDown /></summary><Suspense fallback={<span>加载更新说明…</span>}><ReleaseNotes body={entry.releaseNotes} /></Suspense></details> : null}
      {installed?.error ? <p role="alert" className="text-destructive">{installed.error}</p> : null}
      {updating ? <div className="plugin-update-progress" role="status" aria-busy="true" aria-live="polite">
        <Progress value={progress} indeterminate={progress === null} className="relative" aria-label={`${entry.title} 安装进度`} />
        <span className="plugin-update-hint"><LoaderCircle className="animate-spin" />{phase}{progress !== null ? ` ${Math.floor(progress)}%` : ''}</span>
        {install?.status === 'downloading' && (install.transferred > 0 || install.total > 0) ? <span className="plugin-update-hint">{megabytes(install.transferred)}{install.total > 0 ? ` / ${megabytes(install.total)}` : ''}</span> : null}
      </div> : null}
      {install?.status === 'installed' && installed?.version === install.version ? <p className="plugin-update-hint" role="status"><Check />{phase}</p> : null}
      {failed ? <Alert variant="destructive"><AlertCircle /><AlertDescription>{install.error || '插件安装失败，请重试。'}{mode !== 'market' ? <Button variant="outline" size="sm" disabled={disabled} onClick={retry}>{retryLabel}</Button> : null}</AlertDescription></Alert> : null}
    </CardContent>
    <CardFooter>
      {mode === 'market' ? <><span className="plugin-market-meta">{downloads !== null ? <span className="plugin-downloads" title={`累计下载 ${exactNumber.format(downloads)} 次`} aria-label={`累计下载 ${exactNumber.format(downloads)} 次`}><Download aria-hidden="true" />{formatDownloadCount(downloads)}</span> : null}<span className="plugin-version">v{entry.version}</span></span>{current ? <span className="plugin-installed"><Check />已安装</span> : null}<Button disabled={unavailable || (current && !failed) || entry.compatible === false} aria-label={updating ? (installed ? '更新插件' : '安装插件') : undefined} onClick={retry}>{entry.compatible === false ? '需要升级轻作' : updating ? <><LoaderCircle data-icon="inline-start" className="animate-spin" />{installed ? '更新中…' : '安装中…'}</> : failed ? retryLabel : current ? '已安装' : installed ? '更新插件' : '安装插件'}</Button></> : mode === 'plugins' ? <>
        {updateAvailable ? <Button disabled={unavailable || entry.compatible === false} onClick={retry}>{updating ? <><LoaderCircle data-icon="inline-start" className="animate-spin" />更新中…</> : entry.compatible === false ? '需要升级轻作' : '更新插件'}</Button> : null}
        <Button variant="outline" disabled={unavailable} onClick={() => onAction('plugins.enable', { id: entry.id, enabled: !installed?.enabled })}>{installed?.enabled ? '停用' : '启用'}</Button>
        {installed?.settings ? <Button variant="outline" disabled={unavailable || !installed.enabled} onClick={() => onOpen(true)}>插件设置</Button> : null}
        <Button variant="ghost" disabled={unavailable} onClick={() => onAction('plugins.rollback', { id: entry.id })}>恢复版本</Button>
        <Button variant="ghost" disabled={unavailable} onClick={() => onAction('plugins.uninstall', { id: entry.id })}>卸载</Button>
      </> : <Button disabled={unavailable || !ready || !installed?.enabled || Boolean(installed?.missing.length)} onClick={() => onOpen()}>打开工具<ArrowRight data-icon="inline-end" /></Button>}
    </CardFooter>
  </Card>;
}
