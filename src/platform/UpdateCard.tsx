import { lazy, useState, Suspense } from 'react';
import { AlertCircle, Download, Info, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';

const ReleaseNotes = lazy(() => import('@/components/ReleaseNotes'));
export interface UpdateState {
  status: string; version: string | null; notes: string; error: string | null;
  progress: number; transferred: number; total: number;
  mode?: 'full' | 'resume' | 'delta' | 'cached' | 'components' | null;
  reusedBytes?: number; fallbackReason?: string | null;
}
const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export function UpdateCard({ version, update, disabled, onAction }: {
  version: string; update: UpdateState; disabled: boolean; onAction: (method: string) => Promise<any> | void;
}) {
  const [cleaning, setCleaning] = useState(false);
  const [cleanNotice, setCleanNotice] = useState<string | null>(null);
  const running = ['checking', 'downloading', 'extracting', 'installing'].includes(update.status);
  const downloading = update.status === 'downloading';
  const preparing = update.status === 'extracting' || update.status === 'installing';
  const retry = update.status === 'error' && Boolean(update.version);
  const downloadLabel = update.mode ? { full: '正在下载完整更新', resume: '正在继续下载更新', delta: '正在下载差量更新', cached: '正在校验已缓存的更新', components: '正在下载所需组件' }[update.mode] : '正在下载更新';
  const hasDetails = Boolean(downloading || preparing || update.fallbackReason || update.error || update.notes);

  const handleCleanCache = async () => {
    setCleaning(true);
    setCleanNotice(null);
    try {
      const res = await onAction('updates.cleanCache');
      const freed = typeof res?.freedBytes === 'number' ? res.freedBytes : 0;
      setCleanNotice(freed > 0 ? `已清理 ${megabytes(freed)} 过期安装包与组件缓存，保留基线缓存。` : '暂无可清理的过期更新缓存。');
    } catch (err: any) {
      setCleanNotice(err?.message || '清理缓存失败');
    } finally {
      setCleaning(false);
    }
  };

  const state = update.status === 'checking' ? 'busy' : update.status === 'current' || update.status === 'unpublished' ? 'idle' : update.version ? 'action' : 'idle';
  const statusText = update.status === 'checking' ? '正在检查最新版本…' : update.status === 'unpublished' ? '还没有可安装的新版本' : update.status === 'current' ? '已是最新版本' : update.version ? `新版本 v${update.version}` : '尚未检查更新';
  return <div className="runtime-component runtime-update-component">
    <div className="runtime-component-head">
      <div className="runtime-component-title">
        <strong role="heading" aria-level={3}>轻作更新</strong>
        <span className="runtime-update-version">v{version}</span>
        <span className="runtime-update-state" data-state={state}>{statusText}</span>
      </div>
      <div className="runtime-component-actions">
        <Button variant="outline" size="sm" disabled={disabled || running || cleaning} onClick={() => void handleCleanCache()}>
          {cleaning ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Trash2 data-icon="inline-start" />}清理更新缓存
        </Button>
        <Button variant="outline" size="sm" disabled={disabled || running} onClick={() => onAction('updates.check')}>
          {update.status === 'checking' ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}检查更新
        </Button>
        {update.status === 'available' || retry ? <Button size="sm" disabled={disabled} onClick={() => onAction('updates.download')}><Download data-icon="inline-start" />{retry ? '重新下载并更新' : '下载并重启更新'}</Button> : null}
      </div>
    </div>
    {update.status === 'available' || retry ? <p className="runtime-update-hint"><Info />下载完成后会自动安装并重启，请先保存正在编辑的文件。</p> : null}
    {cleanNotice ? <p role="status" className="text-sm text-muted-foreground">{cleanNotice}</p> : null}
    {hasDetails ? <div className="runtime-update-details">
      {downloading || preparing ? <div className="flex flex-col gap-2" aria-busy="true">
        <Progress value={downloading ? update.progress : null}>
          <ProgressLabel>{downloading ? downloadLabel : update.status === 'extracting' ? '正在解压并校验更新…' : '正在安装，即将重启…'}</ProgressLabel>
          {downloading ? <ProgressValue>{() => `${Math.floor(update.progress)}%`}</ProgressValue> : null}
        </Progress>
        {downloading ? <p className="text-sm text-muted-foreground">{megabytes(update.transferred)}{update.total > 0 ? ` / ${megabytes(update.total)}` : ''}</p> : null}
        {(update.reusedBytes || 0) > 0 ? <p className="text-sm text-muted-foreground">已复用 {megabytes(update.reusedBytes || 0)} 的本地文件</p> : null}
      </div> : null}
      {update.fallbackReason ? <p role="status" className="text-sm text-muted-foreground">{update.fallbackReason}</p> : null}
      {update.error ? <Alert variant="destructive"><AlertCircle /><AlertDescription>{update.error}</AlertDescription></Alert> : null}
      {update.notes ? <Suspense fallback={<span>加载更新说明…</span>}><ReleaseNotes body={update.notes} /></Suspense> : null}
    </div> : null}
  </div>;
}
