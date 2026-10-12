import { lazy, Suspense } from 'react';
import { AlertCircle, Download, LoaderCircle, RefreshCw } from 'lucide-react';
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

export function UpdateCard({ version, kernelVersion, update, disabled, onAction }: {
  version: string; kernelVersion?: string; update: UpdateState; disabled: boolean; onAction: (method: string) => void;
}) {
  const running = ['checking', 'downloading', 'extracting', 'installing'].includes(update.status);
  const downloading = update.status === 'downloading';
  const preparing = update.status === 'extracting' || update.status === 'installing';
  const retry = update.status === 'error' && Boolean(update.version);
  const downloadLabel = update.mode ? { full: '正在下载完整更新', resume: '正在继续下载更新', delta: '正在下载差量更新', cached: '正在校验已缓存的更新', components: '正在下载所需组件' }[update.mode] : '正在下载更新';
  const hasDetails = Boolean(downloading || preparing || update.fallbackReason || update.error || update.notes);
  return <div className="runtime-component runtime-update-component">
    <div className="runtime-component-head">
      <div>
        <div className="runtime-component-title">
          <strong role="heading" aria-level={3}>轻作更新</strong>
          <span>当前版本 v{version}{kernelVersion ? ` · Harness v${kernelVersion}` : ''}</span>
        </div>
        <p className="runtime-component-status">{update.status === 'unpublished' ? '尚无公开发布的底座版本。' : update.status === 'current' ? '当前已是最新版本。' : update.version ? `检测到版本 v${update.version}` : '手动检查是否有新版本。'}</p>
        <p className="runtime-component-description">DeepSeek Harness 随轻作版本发布，当前运行时不会单独替换。</p>
        <p className="runtime-component-description">下载完成后将自动安装并重启，请先保存正在编辑的文件。</p>
      </div>
      <div className="runtime-component-actions">
        <Button variant="outline" size="sm" disabled={disabled || running} onClick={() => onAction('updates.check')}>
          {update.status === 'checking' ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}检查更新
        </Button>
        {update.status === 'available' || retry ? <Button size="sm" disabled={disabled} onClick={() => onAction('updates.download')}><Download data-icon="inline-start" />{retry ? '重新下载并更新' : '下载并重启更新'}</Button> : null}
      </div>
    </div>
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
