import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, FolderOpen, LoaderCircle, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { DebugLogEntry, DebugLogState } from './commerce';

const MAX_VISIBLE_ENTRIES = 1200;
const SIZE_OPTIONS = [10, 20, 50, 100, 250, 500, 1024];
const scopeLabels = { app: '底座', plugin: '插件', browser: '浏览器' } as const;
const levelLabels = { debug: '调试', info: '信息', warn: '警告', error: '错误' } as const;

function cleanError(reason: unknown) {
  return (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).format(new Date(value));
}

function formatBytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(value % (1024 ** 2) ? 1 : 0)} MB`;
  return `${Math.max(0, Math.round(value / 1024))} KB`;
}

interface Props {
  state: DebugLogState;
  onStateChange: (state: DebugLogState) => void;
}

export function DebugLogPage({ state, onStateChange }: Props) {
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [scope, setScope] = useState<'all' | DebugLogEntry['scope']>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void window.commerceDesktop?.invoke<DebugLogEntry[]>('debugLog.recent').then(value => {
      if (active) setEntries(value.slice(-MAX_VISIBLE_ENTRIES));
    }).catch(reason => {
      if (active) setError(cleanError(reason));
    });
    const unsubscribe = window.commerceDesktop?.onDebugLog?.(batch => {
      setEntries(current => [...current, ...batch].slice(-MAX_VISIBLE_ENTRIES));
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const visible = useMemo(() => scope === 'all' ? entries : entries.filter(entry => entry.scope === scope), [entries, scope]);
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [visible.length, scope]);
  const configuredMb = Math.round(state.maxBytes / 1024 ** 2);
  const sizeOptions = SIZE_OPTIONS.includes(configuredMb) ? SIZE_OPTIONS : [...SIZE_OPTIONS, configuredMb].sort((left, right) => left - right);

  const chooseDirectory = async () => {
    if (!window.commerceDesktop || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.commerceDesktop.invoke<{ canceled: boolean; debugLog: DebugLogState }>('debugLog.chooseDirectory');
      onStateChange(result.debugLog);
    } catch (reason) {
      setError(cleanError(reason));
    } finally {
      setBusy(false);
    }
  };

  const changeSize = async (maxBytes: number) => {
    if (!window.commerceDesktop || busy) return;
    setBusy(true);
    setError(null);
    try {
      onStateChange(await window.commerceDesktop.invoke<DebugLogState>('debugLog.configure', { maxBytes }));
    } catch (reason) {
      setError(cleanError(reason));
    } finally {
      setBusy(false);
    }
  };

  const openDirectory = async () => {
    if (!window.commerceDesktop || busy) return;
    setError(null);
    try {
      await window.commerceDesktop.invoke('debugLog.openDirectory');
    } catch (reason) {
      setError(cleanError(reason));
    }
  };

  return <div className="debug-log-page">
    <Card className="debug-log-overview">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>保存设置</CardTitle>
        <CardDescription>超过容量上限时，会先删除最早的日志文件。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="debug-log-location">
          <div>
            <span>保存位置</span>
            <strong title={state.directory}>{state.directory}</strong>
          </div>
          <div className="debug-log-location-actions">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void chooseDirectory()}>
              {busy ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}更改目录
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void openDirectory()}>打开目录</Button>
          </div>
        </div>
        <div className="debug-log-size">
          <label htmlFor="debug-log-max-size">最大保存大小</label>
          <select
            id="debug-log-max-size"
            className="download-source-select"
            value={configuredMb}
            disabled={busy}
            onChange={event => void changeSize(Number(event.target.value) * 1024 ** 2)}
          >
            {sizeOptions.map(size => <option key={size} value={size}>{size} MB</option>)}
          </select>
          <span>已使用 {formatBytes(state.storedBytes)}</span>
        </div>
      </CardContent>
    </Card>

    {state.lastError ? <Alert variant="destructive"><CircleAlert /><AlertDescription>{state.lastError}</AlertDescription></Alert> : null}
    {error ? <Alert variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert> : null}

    <Card className="debug-log-viewer">
      <CardHeader className="debug-log-viewer-head">
        <div>
          <CardTitle role="heading" aria-level={2}>实时日志</CardTitle>
          <CardDescription>{visible.length ? `显示 ${visible.length} 条记录` : '等待轻作、插件或浏览器产生日志。'}</CardDescription>
        </div>
        <div className="debug-log-viewer-actions">
          <div className="debug-log-filters" role="group" aria-label="日志范围">
            {(['all', 'app', 'plugin', 'browser'] as const).map(value => (
              <Button key={value} type="button" size="xs" variant={scope === value ? 'secondary' : 'ghost'} aria-pressed={scope === value} onClick={() => setScope(value)}>
                {value === 'all' ? '全部' : scopeLabels[value]}
              </Button>
            ))}
          </div>
          <Button type="button" size="sm" variant="ghost" disabled={!entries.length} onClick={() => setEntries([])}><Trash2 />清空显示</Button>
        </div>
      </CardHeader>
      <CardContent>
        <div ref={listRef} className="debug-log-list" role="log" aria-label="调试日志" aria-live="off">
          {visible.length ? visible.map((entry, index) => (
            <article key={`${entry.time}:${index}:${entry.source}`} className={cn('debug-log-row', `is-${entry.level}`)}>
              <time dateTime={new Date(entry.time).toISOString()}>{formatTime(entry.time)}</time>
              <span className={cn('debug-log-scope', `is-${entry.scope}`)}>{scopeLabels[entry.scope]}</span>
              <span className="debug-log-source" title={entry.source}>{entry.source}</span>
              <span className="debug-log-level">{levelLabels[entry.level]}</span>
              <pre>{entry.message}</pre>
              {entry.url || entry.line ? <small>{entry.url ?? ''}{entry.line ? `:${entry.line}` : ''}</small> : null}
            </article>
          )) : <div className="debug-log-empty">当前范围还没有日志。</div>}
        </div>
      </CardContent>
    </Card>
  </div>;
}
