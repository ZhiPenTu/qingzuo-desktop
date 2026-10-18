import { useEffect, useMemo, useState } from 'react';
import { Check, Download, Image as ImageIcon, LoaderCircle, RefreshCw, Video, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BrowserDownloadTask, BrowserStatus } from './commerce';
import { cn } from '@/lib/utils';

interface BrowserCandidatePanelProps {
  status: BrowserStatus;
  busy: boolean;
  onAction: (method: string, args?: unknown) => Promise<unknown>;
}

function taskFor(tasks: BrowserDownloadTask[], candidateId: string) {
  return [...tasks].reverse().find(task => task.candidateId === candidateId);
}

export function BrowserCandidatePanel({ status, busy, onAction }: BrowserCandidatePanelProps) {
  const candidates = useMemo(() => status.candidates.filter(candidate => candidate.tabId === status.activeTabId), [status.activeTabId, status.candidates]);
  const ready = candidates.filter(candidate => candidate.status === 'ready');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const valid = new Set(ready.map(candidate => candidate.id));
    setSelected(previous => new Set([...previous].filter(id => valid.has(id))));
  }, [status.activeTabId, status.candidates]);

  const allSelected = ready.length > 0 && ready.every(candidate => selected.has(candidate.id));
  const toggle = (id: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(ready.map(candidate => candidate.id)));
  const download = (ids: string[], mode: 'single' | 'batch') => {
    if (!ids.length || busy) return;
    void onAction('browser.download', { candidateIds: ids, mode }).catch(() => {});
  };

  return <aside className="browser-candidate-panel" aria-label="检测结果">
    <div className="browser-candidate-head">
      <div>
        <h2>检测结果</h2>
        <span>{candidates.length ? `${candidates.length} 项媒体` : '滚动页面后自动检测'}</span>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="重新扫描" title="重新扫描" disabled={busy || !status.activeTabId} onClick={() => void onAction('browser.rescan', { id: status.activeTabId }).catch(() => {})}><RefreshCw /></Button>
    </div>
    <div className="browser-candidate-toolbar">
      <label className="browser-candidate-select-all"><input type="checkbox" checked={allSelected} disabled={!ready.length || busy} onChange={toggleAll} /><span>全选可下载项</span></label>
      <Button size="sm" disabled={!selected.size || busy} onClick={() => download([...selected], 'batch')}><Download data-icon="inline-start" />批量下载</Button>
    </div>
    <div className="browser-candidate-list">
      {!candidates.length ? <p className="browser-candidate-empty">打开一个包含视频或图片的页面，检测结果会显示在这里。</p> : null}
      {candidates.map(candidate => {
        const task = taskFor(status.downloads, candidate.id);
        const downloading = task && ['queued', 'downloading'].includes(task.status);
        return <article className={cn('browser-candidate-item', candidate.status === 'unresolved' && 'is-unresolved')} key={candidate.id}>
          <label className="browser-candidate-check"><input type="checkbox" checked={selected.has(candidate.id)} disabled={candidate.status !== 'ready' || busy} onChange={() => toggle(candidate.id)} /><span className="sr-only">选择{candidate.title}</span></label>
          <div className="browser-candidate-thumb">
            {candidate.thumbnailUrl ? <img src={candidate.thumbnailUrl} alt="" /> : candidate.type === 'video' ? <Video aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
          </div>
          <div className="browser-candidate-info">
            <strong title={candidate.title}>{candidate.title}</strong>
            {candidate.status === 'unresolved' ? <span className="browser-candidate-note">{candidate.reason || '需要打开详情'}</span> : task?.status === 'failed' ? <span className="browser-candidate-note is-error">{task.error || '下载失败，请重试。'}</span> : downloading ? <span className="browser-candidate-note"><LoaderCircle className="animate-spin" />{task.status === 'queued' ? '排队中' : `下载中 ${task.progress}%`}</span> : task?.status === 'completed' ? <span className="browser-candidate-note is-done"><Check />已保存</span> : null}
            {downloading ? <div className="browser-candidate-progress"><span style={{ width: `${task.progress}%` }} /></div> : null}
          </div>
          <div className="browser-candidate-actions">
            {downloading ? <Button variant="ghost" size="icon-xs" aria-label="取消下载" title="取消下载" onClick={() => void onAction('browser.cancel', { id: task.id }).catch(() => {})}><X /></Button> : candidate.status === 'ready' ? <Button variant="ghost" size="icon-xs" aria-label={`下载${candidate.title}`} title="下载" disabled={busy} onClick={() => download([candidate.id], 'single')}><Download /></Button> : null}
          </div>
        </article>;
      })}
    </div>
  </aside>;
}
