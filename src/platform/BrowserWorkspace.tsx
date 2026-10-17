import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BrowserStatus } from './commerce';
import { cn } from '@/lib/utils';

interface BrowserWorkspaceProps {
  status: BrowserStatus;
  busy: boolean;
  onAction: (method: string, args?: unknown) => Promise<unknown>;
}

export function BrowserWorkspace({ status, busy, onAction }: BrowserWorkspaceProps) {
  const surface = useRef<HTMLDivElement>(null);
  const activeTab = useMemo(() => status.tabs.find(tab => tab.id === status.activeTabId) ?? null, [status.activeTabId, status.tabs]);
  const [address, setAddress] = useState(activeTab?.url ?? '');

  useEffect(() => setAddress(activeTab?.url ?? ''), [activeTab?.id, activeTab?.url]);
  useEffect(() => {
    const element = surface.current;
    if (!element || !activeTab?.url || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      void window.commerceDesktop?.invoke('browser.bounds', { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [activeTab?.id, activeTab?.url]);

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    if (!activeTab || !address.trim() || busy) return;
    void onAction('browser.navigate', { id: activeTab.id, url: address.trim() }).catch(() => {});
  };
  const activate = (id: string) => { if (!busy && id !== status.activeTabId) void onAction('browser.activate', { id }).catch(() => {}); };
  const close = (id: string) => { if (!busy) void onAction('browser.closeTab', { id }).catch(() => {}); };

  return <section className="browser-workspace" aria-label="浏览器">
    <div className="browser-tabs" role="tablist" aria-label="浏览器标签页">
      {status.tabs.map(tab => <div
        key={tab.id}
        role="tab"
        tabIndex={0}
        aria-selected={tab.id === status.activeTabId}
        className={cn('browser-tab', tab.id === status.activeTabId && 'is-active')}
        onClick={() => activate(tab.id)}
        onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && !busy) { event.preventDefault(); activate(tab.id); } }}
      >
        <Globe className="browser-tab-icon" />
        <span className="browser-tab-title">{tab.title || '新标签页'}</span>
        <button type="button" className="browser-tab-close" aria-label={`关闭${tab.title || '新标签页'}`} title="关闭" disabled={busy} onClick={event => { event.stopPropagation(); close(tab.id); }}><X /></button>
      </div>)}
      <Button variant="ghost" size="icon-sm" className="browser-new-tab-button" aria-label="新建浏览器标签" title="新建标签页" disabled={busy} onClick={() => void onAction('browser.newTab').catch(() => {})}><Plus /></Button>
    </div>
    <div className="browser-toolbar">
      <div className="browser-navigation" aria-label="网页导航">
        <Button variant="ghost" size="icon-sm" aria-label="后退" title="后退" disabled={!activeTab?.canGoBack || busy} onClick={() => void onAction('browser.back').catch(() => {})}><ArrowLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="前进" title="前进" disabled={!activeTab?.canGoForward || busy} onClick={() => void onAction('browser.forward').catch(() => {})}><ArrowRight /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="刷新" title="刷新" disabled={!activeTab?.url || busy} onClick={() => void onAction('browser.reload').catch(() => {})}><RotateCw className={activeTab?.loading ? 'browser-loading-icon' : undefined} /></Button>
      </div>
      <form className="browser-address-form" onSubmit={submitAddress}>
        <Globe className="browser-address-icon" aria-hidden="true" />
        <input aria-label="地址栏" value={address} placeholder="输入完整网址" onChange={event => setAddress(event.target.value)} spellCheck={false} disabled={!activeTab || busy} />
      </form>
    </div>
    <div ref={surface} className="browser-surface">
      {!activeTab?.url ? <div className="browser-new-tab-page" role="status"><Globe /><h1>新标签页</h1><p>输入完整的 HTTP 或 HTTPS 地址开始浏览</p></div> : null}
    </div>
  </section>;
}

