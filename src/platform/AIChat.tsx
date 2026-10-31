import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Plus, Send, Square, Trash2, Settings, Puzzle, ShieldCheck, CheckCircle2, AlertCircle, History, LayoutGrid, Image, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { HarnessActivity, HarnessMessage, HarnessParameters } from './HarnessPresentation';
import { chatInvoke, type ChatSession, type ChatSummary, type ChatPlugin } from './harness-client';
import { isChatModel, type AIModel } from './ai-providers';
import { aiChatIcon, resolvePluginIcon } from './plugin-icons';

export default function AIChat({ onSettings, onOpenPlugin }: { onSettings: () => void; onOpenPlugin: (id: string) => void }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [plugins, setPlugins] = useState<ChatPlugin[]>([]);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<AIModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelError, setModelError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [text, setText] = useState('');
  const [stream, setStream] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = useRef('');
  const operation = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const modelIds = useRef(new Set<string>());
  const fallbackModel = useRef('');
  const refreshList = useCallback(async () => setChats(await chatInvoke<ChatSummary[]>('list')), []);
  const load = useCallback(async (id: string) => {
    selected.current = id; setStream(''); setError(''); follow.current = true;
    const value = await chatInvoke<ChatSession>('status', { id });
    if (selected.current === id) {
      setSession(value);
      setStream(value.partial || '');
      setModel(value.model && modelIds.current.has(value.model) ? value.model : fallbackModel.current);
    }
  }, []);
  useEffect(() => {
    if (!window.commerceDesktop) return;
    let active = true;
    void (async () => {
      const [items, tools, status] = await Promise.all([
        chatInvoke<ChatSummary[]>('list'),
        chatInvoke<ChatPlugin[]>('tools'),
        window.commerceDesktop?.invoke<{ model?: string; verified?: string[]; ready?: boolean }>('ai.status'),
      ]);
      if (!active) return;
      setChats(items);
      setPlugins(tools);
      const connected = typeof status?.ready === 'boolean'
        ? status.ready
        : Boolean(status?.model && status.verified?.includes(status.model) && isChatModel({ id: status.model }));
      setConnected(connected);
      if (connected) {
        try {
          const catalog = await window.commerceDesktop?.invoke<{ models: AIModel[]; defaultModel: string }>('ai.textModels');
          if (!active) return;
          const available = Array.isArray(catalog?.models) ? catalog.models : [];
          modelIds.current = new Set(available.map(item => item.id));
          fallbackModel.current = available.some(item => item.id === catalog?.defaultModel) ? catalog?.defaultModel || '' : available[0]?.id || '';
          setModels(available);
          setModel(fallbackModel.current);
        } catch (reason) {
          if (active) setModelError(reason instanceof Error ? reason.message : String(reason));
        }
      }
      if (!active) return;
      setModelsLoading(false);
      setReady(connected && modelIds.current.size > 0);
      const remembered = localStorage.getItem('qingzuo.ai-chat.selected.v1');
      const id = items.find(item => item.id === remembered)?.id || items[0]?.id;
      if (id) await load(id);
    })().catch(reason => { if (active) { setError(reason.message); setModelsLoading(false); } });
    const dispose = window.commerceDesktop?.onAI?.(event => {
      if (event.type === 'navigate') { onOpenPlugin(event.pluginId); return; }
      if (event.chatId !== selected.current) { if (event.type === 'assistant') void refreshList().catch(() => {}); return; }
      if (event.type === 'assistant-delta') setStream(value => event.partial ?? value + event.text);
      if (event.type === 'assistant') {
        setSession(value => ({ ...event.session, approvals: value?.approvals || [] }));
        if (event.session.model && modelIds.current.has(event.session.model)) setModel(event.session.model);
        setStream(event.session.partial || '');
        void refreshList().catch(() => {});
      }
      if (event.type === 'approvals') setSession(value => value ? { ...value, approvals: event.approvals } : value);
    });
    return () => { active = false; dispose?.(); };
  }, [load, onOpenPlugin, refreshList]);
  useEffect(() => { if (session?.id) localStorage.setItem('qingzuo.ai-chat.selected.v1', session.id); }, [session?.id]);
  useEffect(() => { if (follow.current && (session?.history.length || session?.approvals?.length || stream)) end.current?.scrollIntoView?.({ block: 'end' }); }, [session?.history.length, session?.approvals?.length, stream]);
  useEffect(() => {
    if (!session || session.state !== 'running') return;
    const id = session.id;
    const timer = window.setInterval(() => { void chatInvoke<ChatSession>('status', { id }).then(value => { if (selected.current === id) { setSession(value); if (value.state === 'idle') setStream(''); } }).catch(reason => setError(reason.message)); }, 3000);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.state]);
  async function action(work: () => Promise<void>) {
    if (operation.current) return; operation.current = true; setBusy(true); setError('');
    try { await work(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { operation.current = false; setBusy(false); }
  }
  async function create() {
    if (!model) return;
    const value = await chatInvoke<ChatSession>('create', { model });
    selected.current = value.id;
    setSession(value);
    setStream('');
    setText('');
    setHistoryOpen(false);
    await refreshList();
  }
  async function send() {
    const draft = text.trim(); if (!draft || !ready || !model || session?.state === 'running') return;
    await action(async () => {
      let id = session?.id;
      if (!id) { const value = await chatInvoke<ChatSession>('create', { model }); id = value.id; selected.current = id; setSession(value); }
      follow.current = true; setStream('');
      const value = await chatInvoke<ChatSession>('send', { id, text: draft, model });
      setText(''); if (selected.current === id) setSession(current => current?.state === 'running' ? current : value); await refreshList();
    });
  }
  const running = session?.state === 'running';
  const hasMessages = Boolean(session?.history.length || stream || session?.approvals?.length);
  function suggest(prompt: string) { setText(prompt); input.current?.focus(); }
  return <div className="ai-chat-layout harness-theme">
    <header className="ai-chat-toolbar">
      <div className="ai-chat-heading">
        <div><h1>{hasMessages ? session?.title || 'AI 对话' : 'AI 对话'}</h1><span className={cn('connection-dot', ready && 'connected')} aria-label={ready ? '助手已就绪' : connected ? '没有可用模型' : '助手待配置'} /></div>
        <div className="ai-chat-model-row">
          <label htmlFor="ai-chat-model">对话模型</label>
          <select id="ai-chat-model" className="ai-chat-model-select" value={model} disabled={busy || running || modelsLoading || !models.length} onChange={event => setModel(event.target.value)}>
            {!models.length ? <option value="">{modelsLoading ? '正在读取模型…' : '没有可用模型'}</option> : null}
            {models.map(item => <option key={item.id} value={item.id}>{item.title && item.title !== item.id ? `${item.title} · ${item.id}` : item.id}</option>)}
          </select>
        </div>
      </div>
      <div className="ai-chat-toolbar-actions">
        <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
          <SheetTrigger render={<Button variant="ghost" aria-label="历史对话" title="历史对话" />}><History data-icon="inline-start" /><span>历史对话</span></SheetTrigger>
          <SheetContent className="ai-chat-panel">
            <SheetHeader><SheetTitle>历史对话</SheetTitle><SheetDescription>会话保存在本机，选择一个继续。</SheetDescription></SheetHeader>
            <nav className="ai-chat-history" aria-label="历史对话">{chats.map(chat => <Button key={chat.id} variant={session?.id === chat.id ? 'secondary' : 'ghost'} disabled={busy} onClick={() => void action(async () => { await load(chat.id); setHistoryOpen(false); })}><MessageCircle data-icon="inline-start" /><span className="truncate">{chat.title}</span>{chat.state === 'running' ? <span className="connection-dot connected" aria-label="处理中" /> : null}</Button>)}{!chats.length ? <p>还没有历史对话。发送第一条消息后，会在这里保存。</p> : null}</nav>
            <div className="ai-chat-panel-footer"><Button variant="outline" disabled={busy} onClick={() => void action(create)}><Plus data-icon="inline-start" />新建对话</Button>{session ? <Button variant="ghost" disabled={busy || running} onClick={() => { if (window.confirm('删除这条对话记录？删除后无法在列表中找回。')) void action(async () => { await chatInvoke('delete', { id: session.id }); selected.current = ''; setSession(null); setStream(''); await refreshList(); }); }}><Trash2 data-icon="inline-start" />删除当前对话</Button> : null}</div>
          </SheetContent>
        </Sheet>
        <Button variant="ghost" aria-label="新建对话" title="新建对话" disabled={busy} onClick={() => void action(create)}><Plus data-icon="inline-start" /><span>新建对话</span></Button>
        <Button variant="ghost" aria-label="AI 设置" title="AI 设置" onClick={onSettings}><Settings data-icon="inline-start" /><span>AI 设置</span></Button>
      </div>
    </header>
    <section className="ai-chat-workspace" aria-label="AI 对话">
      {!connected ? <Alert><AlertDescription>AI 助手尚未启用。连接服务后即可开始对话。<Button variant="outline" size="sm" onClick={onSettings}>继续设置</Button></AlertDescription></Alert> : null}
      {connected && !modelsLoading && !models.length && !modelError ? <Alert><AlertDescription>没有可用的文本模型，请检查服务账户权限或更换服务。<Button variant="ghost" size="sm" onClick={onSettings}>检查 AI 设置</Button></AlertDescription></Alert> : null}
      {modelError || error || session?.error ? <Alert variant="destructive"><AlertCircle /><AlertDescription>{modelError || error || session?.error}<Button variant="ghost" size="sm" onClick={onSettings}>检查 AI 设置</Button></AlertDescription></Alert> : null}
      <div ref={transcript} className={cn('ai-transcript', !hasMessages && 'ai-transcript-empty')} role="log" aria-label="对话内容" onScroll={() => { const element = transcript.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
        {!hasMessages ? <div className="ai-chat-empty"><img src={aiChatIcon} alt="" className="ai-chat-empty-icon" /><h2>今天，想让工作轻一点？</h2><p>描述你的想法，让 AI 和插件一起完成。</p><div className="ai-chat-suggestions"><Button variant="outline" onClick={() => suggest('我有哪些插件可以用？')}><LayoutGrid data-icon="inline-start" />发现可用工具</Button><Button variant="outline" onClick={() => suggest('打开 AI 批图，帮我规划白底商品图')}><Image data-icon="inline-start" />规划商品图</Button></div><Button variant="ghost" size="sm" onClick={() => setToolsOpen(true)}>可调用 {plugins.length} 个插件<ChevronRight data-icon="inline-end" /></Button></div> : null}
        <div className="ai-transcript-content">
        {session?.history.map((message, index) => message.role === 'tool' ? <div className="ai-tool-record" key={message.id || index}><div>{message.state === 'succeeded' ? <CheckCircle2 /> : message.state === 'running' ? <Puzzle /> : <AlertCircle />}<strong>{message.tool === 'list_plugins' ? '发现已启用插件' : (plugins.find(plugin => plugin.id === message.pluginId)?.title || '工具调用')}</strong><span>{message.state === 'running' ? '等待确认 / 执行中' : message.state === 'succeeded' ? '已完成' : message.state === 'interrupted' ? '中断，结果未知' : '未完成'}</span></div>{message.text ? <details><summary>查看调用结果</summary><pre>{message.text}</pre></details> : null}</div> : <article key={index} className={'ai-message ai-message-' + message.role}><span>{message.role === 'user' ? '你' : 'AI'}</span><div>{message.role === 'assistant' ? <HarnessMessage text={message.text} /> : <p>{message.text}</p>}</div></article>)}
        {stream ? <article className="ai-message ai-message-assistant"><span>AI</span><div><HarnessMessage text={stream} streaming /></div></article> : null}
        {session?.approvals?.map(approval => <section className="ai-tool-approval" key={approval.id} aria-label={'确认调用 ' + approval.pluginTitle}><div><ShieldCheck /><strong>等待确认</strong></div><h3>{approval.pluginTitle} · {approval.title}</h3><HarnessParameters data={approval.detail ? { parameters: approval.args, batch: approval.detail } : approval.args} label="插件调用参数" /><p>确认后助手才会执行这一次调用。</p><div className="ai-actions flex"><Button disabled={busy} onClick={() => void action(async () => { await chatInvoke('approve', { id: session.id, approvalId: approval.id, approve: true }); setSession(value => value ? { ...value, approvals: value.approvals?.filter(entry => entry.id !== approval.id) } : value); })}>确认调用</Button><Button variant="outline" disabled={busy} onClick={() => void action(async () => { await chatInvoke('approve', { id: session.id, approvalId: approval.id, approve: false }); setSession(value => value ? { ...value, approvals: value.approvals?.filter(entry => entry.id !== approval.id) } : value); })}>拒绝</Button></div></section>)}
        {running ? <div className="ai-chat-activity" role="status"><HarnessActivity /></div> : null}<div ref={end} />
        </div>
      </div>
      <div className="ai-composer-dock"><form onSubmit={event => { event.preventDefault(); void send(); }}><InputGroup className="ai-composer"><InputGroupTextarea ref={input} aria-label="消息" placeholder="告诉我你想完成什么…" maxLength={16000} disabled={busy} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><InputGroupAddon align="block-end" className="ai-composer-actions"><div className="ai-composer-privacy"><small><ShieldCheck />插件调用需你确认</small>{hasMessages ? <Button variant="ghost" size="icon-sm" aria-label="可调用插件" title="可调用插件" onClick={() => setToolsOpen(true)}><Puzzle /></Button> : null}</div>{running ? <Button type="button" variant="outline" size="icon-lg" aria-label="停止" title="停止生成" disabled={busy} onClick={() => void action(async () => { const value = await chatInvoke<ChatSession>('cancel', { id: session.id }); setSession(value); setStream(''); await refreshList(); })}><Square /></Button> : <Button type="submit" size="icon-lg" aria-label="发送" title="发送" disabled={busy || !ready || !text.trim()}><Send /></Button>}</InputGroupAddon></InputGroup></form><div className="ai-composer-meta"><span>Enter 发送 · Shift + Enter 换行</span></div></div>
    </section>
    <Sheet open={toolsOpen} onOpenChange={setToolsOpen}><SheetContent className="ai-chat-panel"><SheetHeader><SheetTitle>可调用插件</SheetTitle><SheetDescription>只提供已启用的能力。每次调用都需要你确认。</SheetDescription></SheetHeader><div className="ai-chat-plugin-list">{plugins.map(plugin => { const iconSrc = resolvePluginIcon(plugin.id); return <section key={plugin.id}><div>{iconSrc ? <img src={iconSrc} alt="" className="ai-chat-plugin-icon" /> : <Puzzle />}<h3>{plugin.title}</h3></div>{plugin.description ? <p>{plugin.description}</p> : null}<ul>{plugin.tools.map(tool => <li key={tool.name}>{tool.title}</li>)}</ul></section>; })}{!plugins.length ? <p>安装并启用插件后，助手才能调用。</p> : null}</div></SheetContent></Sheet>
  </div>;
}
