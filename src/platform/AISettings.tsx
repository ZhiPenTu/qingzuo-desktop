import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Image, KeyRound, LoaderCircle, LogIn, RefreshCw, Server, LayoutList, Box, MessageCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardAction, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';

interface ProxyStatus { mode: 'builtin' | 'external'; address: string; model: string; version: string; running: boolean; verified: string[]; error: string | null }
interface Account { name: string; provider: string; status: string }
const oauthProviders = [
  { id: 'codex', title: 'Codex', description: '使用 OpenAI 账户授权助手模型' },
  { id: 'claude', title: 'Claude', description: '使用 Anthropic 账户授权助手模型' },
  { id: 'antigravity', title: 'Antigravity', description: '使用 Google 账户授权助手模型' },
];

export function AISettings({ imageAvailable = false, onOpenImage, onOpenChat }: { imageAvailable?: boolean; onOpenImage?: () => void; onOpenChat?: () => void }) {
  const [section, setSection] = useState('overview');
  const [access, setAccess] = useState('oauth');
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [mode, setMode] = useState<'builtin' | 'external'>('builtin');
  const [address, setAddress] = useState('http://127.0.0.1:8317');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<{ id: string }[]>([]);
  const [provider, setProvider] = useState('compatible');
  const [providerKey, setProviderKey] = useState('');
  const [providerURL, setProviderURL] = useState('https://api.deepseek.com/v1');
  const [providerModels, setProviderModels] = useState('deepseek-chat');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [login, setLogin] = useState<{ state: string; status: string; provider: string } | null>(null);
  const [busy, setBusy] = useState('');
  const operation = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const invoke = useCallback(async <Value,>(method: string, args?: unknown) => {
    if (!window.commerceDesktop) throw new Error('请在轻作桌面应用中配置 AI 模型。');
    return window.commerceDesktop.invoke<Value>('ai.' + method, args);
  }, []);

  useEffect(() => {
    let active = true;
    void invoke<ProxyStatus>('status').then(value => {
      if (active) { setStatus(value); setMode(value.mode); setAddress(value.address); setModel(value.model); }
    }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [invoke]);

  async function action(name: string, work: () => Promise<unknown>, success: string) {
    if (operation.current) return;
    operation.current = true; setBusy(name); setError(''); setMessage('');
    try { await work(); setStatus(await invoke<ProxyStatus>('status')); setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { operation.current = false; setBusy(''); }
  }
  async function configure() {
    const value = await invoke<ProxyStatus>('configure', { mode, address, model, apiKey: key });
    if (status?.mode !== value.mode || status?.address !== value.address || key) { setModels([]); setAccounts([]); setAccountsLoaded(false); }
    setStatus(value); setKey('');
  }
  async function refreshAccounts() { setAccounts(await invoke<Account[]>('accounts')); setAccountsLoaded(true); }

  useEffect(() => {
    if (!login || login.status !== 'wait') return;
    let active = true, checking = false;
    const timer = window.setInterval(() => {
      if (checking) return;
      checking = true;
      void invoke<{ status: string; error?: string }>('loginStatus', { state: login.state }).then(async value => {
        if (!active || value.status === 'wait') return;
        if (value.status === 'ok') {
          setMessage('授权成功，接下来获取模型并选择默认助手。');
          const currentAccounts = await invoke<Account[]>('accounts');
          if (active) { setAccounts(currentAccounts); setAccountsLoaded(true); }
        } else setError(value.error || '授权失败，请重试。');
        if (active) setLogin(null);
      }).catch(reason => { if (active) { setError(reason.message); setLogin(null); } }).finally(() => { checking = false; });
    }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [login, invoke]);

  const connectionChanged = Boolean(status && (status.mode !== mode || (mode === 'external' && (status.address !== address || key))));
  const disabled = Boolean(busy) || !status;
  const builtinReady = !disabled && !connectionChanged && mode === 'builtin';
  const verified = Boolean(status?.verified.includes(model));
  const imageModel = /gpt[-_]?image|nano[-_ ]?banana|image[-_]?generation/i.test(model);
  const sections = [{ group: '开始使用', items: [{ id: 'overview', title: '配置概览', icon: LayoutList }] }, { group: '文本助手', items: [{ id: 'accounts', title: '账户与 API', icon: KeyRound }, { id: 'model', title: '默认模型', icon: Box }] }, { group: '图像编辑', items: [{ id: 'image', title: '图像 API', icon: Image }] }, { group: '高级', items: [{ id: 'connection', title: '代理连接', icon: Server }] }];
  function selectSection(next: string) { setSection(next); setProviderKey(''); setKey(''); setError(''); setMessage(''); }
  const spinner = (name: string) => busy === name ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null;
  return <div className="ai-settings-layout">
    <nav className="ai-settings-rail" aria-label="AI 配置分类">{sections.map(group => <div key={group.group}><p>{group.group}</p>{group.items.map(({ id, title, icon: Icon }) => <Button key={id} variant={section === id ? 'secondary' : 'ghost'} aria-current={section === id ? 'page' : undefined} onClick={() => selectSection(id)}><Icon />{title}</Button>)}</div>)}</nav>
    <div className="ai-settings">
    {error || status?.error ? <Alert variant="destructive"><AlertDescription>{error || status?.error}</AlertDescription></Alert> : null}
    {message ? <Alert role="status"><CheckCircle2 /><AlertDescription>{message}</AlertDescription></Alert> : null}
    {section === 'overview' ? <section className="ai-overview" aria-label="配置概览"><div className="ai-setup-steps">{[
      { number: 1, title: '接入文本服务', description: 'API Key 或 OAuth，任选一种。已授权账户无需重新登录。', button: '配置账户', action: () => selectSection('accounts') },
      { number: 2, title: '选择助手模型', description: status?.model ? '当前：' + status.model + (status.verified.includes(status.model) ? ' · 已验证工具调用' : ' · 尚未验证工具调用') : '验证工具调用后启用插件编排。图像型号不能用作文本助手。', button: '选择模型', action: () => selectSection('model') },
      { number: 3, title: '开始 AI 对话', description: '调用前展示插件及参数，确认后执行。', button: '打开对话', action: onOpenChat },
    ].map(step => <div className="ai-setup-row" key={step.number}><span>{step.number}</span><div><h2>{step.title}</h2><p>{step.description}</p></div><Button disabled={!step.action} onClick={step.action}>{step.button}<ArrowRight /></Button></div>)}</div><div className="ai-image-band"><Image /><div><h2>图像编辑</h2><p>复用 CLIProxyAPI 图片模型，或配置官方 API。</p></div><Button variant="outline" onClick={() => selectSection('image')}>配置图像 API<ArrowRight /></Button></div></section> : null}
    {section === 'image' ? <Card id="ai-image" className="ai-image-entry">
      <CardHeader><CardTitle role="heading" aria-level={2}><Image className="ai-section-icon" />图像编辑 API</CardTitle><CardDescription>批图插件可直接选择已接入 CLIProxyAPI 的图片模型，也保留 Google / OpenAI 官方 API 入口。</CardDescription><CardAction><Button disabled={!imageAvailable} onClick={onOpenImage}>配置图像 API<ArrowRight data-icon="inline-end" /></Button></CardAction></CardHeader>
      {!imageAvailable ? <CardContent><p className="text-sm text-muted-foreground">请先安装并启用「AI 批图」插件。密钥仅授权给该插件。</p></CardContent> : null}
      <CardContent><p className="text-sm text-muted-foreground">代理模式复用已保存的连接与账户，是否支持图片编辑取决于代理型号和账户权限。官方模式仍使用插件专属密钥；所有凭据留在宿主，不会交给插件页面或 AI 对话。选择图片型号不会改变默认文本助手模型。</p></CardContent>
    </Card> : null}

    {section === 'connection' ? <Card id="ai-connection">
      <CardHeader><CardTitle role="heading" aria-level={2}><Server className="ai-section-icon" />助手连接方式</CardTitle><CardDescription>选择由轻作管理账户，或使用你已有的 CLIProxyAPI。切换后需保存才生效。</CardDescription><CardAction><Badge variant="secondary">{!status ? '读取配置中' : status.mode === 'external' ? '当前：外部代理' : status.running ? '内置代理运行中' : '内置代理已停止'}</Badge></CardAction></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldSet disabled={disabled || Boolean(login)}><FieldLegend className="sr-only">代理运行方式</FieldLegend><FieldGroup className="ai-mode-options">
          <FieldLabel className="ai-mode-option"><input type="radio" name="ai-mode" value="builtin" checked={mode === 'builtin'} onChange={() => setMode('builtin')} /><span><strong>轻作内置管理</strong><small>在这里填写 API Key，或登录 OAuth 账户</small></span></FieldLabel>
          <FieldLabel className="ai-mode-option"><input type="radio" name="ai-mode" value="external" checked={mode === 'external'} onChange={() => setMode('external')} /><span><strong>连接外部 CLIProxyAPI</strong><small>连接已有服务，账户由外部管理端维护</small></span></FieldLabel>
        </FieldGroup></FieldSet>
        {mode === 'external' ? <FieldGroup className="ai-connection-fields"><Field><FieldLabel htmlFor="ai-address">代理地址</FieldLabel><Input id="ai-address" disabled={disabled} value={address} onChange={event => setAddress(event.target.value)} placeholder="http://127.0.0.1:8317" /></Field><Field><FieldLabel htmlFor="ai-access-key">代理访问密钥</FieldLabel><Input id="ai-access-key" disabled={disabled} type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder="留空保留已有密钥" /></Field></FieldGroup> : <p className="text-sm text-muted-foreground">内置 CLIProxyAPI v{status?.version ?? '8.0.23'}，仅监听本机。接入 API / OAuth 时会自动启动，无需先手动启动。</p>}
        {connectionChanged ? <p role="status" className="text-sm text-muted-foreground">连接方式尚未应用。请先保存，再配置账户或获取模型。</p> : null}
      </CardContent>
      <CardFooter className="ai-actions"><Button disabled={disabled || Boolean(login)} onClick={() => void action('configure', configure, '连接设置已保存')}>{spinner('configure')}保存连接设置</Button>{mode === 'builtin' ? <><Button variant="outline" disabled={!builtinReady || Boolean(login) || status?.running} onClick={() => void action('start', () => invoke('start'), '内置代理已启动')}>{spinner('start')}启动代理</Button><Button variant="ghost" disabled={!builtinReady || Boolean(login) || !status?.running} onClick={() => void action('stop', () => invoke('stop'), '内置代理已停止')}>停止代理</Button></> : null}</CardFooter>
    </Card> : null}

    {section === 'accounts' ? <><div className="ai-section-heading"><h2>账户与 API</h2><p>选一种方式接入文本助手，再到「默认模型」完成验证。</p><div className="ai-access-tabs" role="group" aria-label="账户接入方式"><Button variant={access === 'oauth' ? 'secondary' : 'ghost'} aria-pressed={access === 'oauth'} onClick={() => { setAccess('oauth'); setProviderKey(''); }}><LogIn />OAuth 登录</Button><Button variant={access === 'api' ? 'secondary' : 'ghost'} aria-pressed={access === 'api'} onClick={() => setAccess('api')}><KeyRound />API Key 接入</Button></div></div>
    {mode === 'external' ? <Alert><AlertDescription><strong>外部模式：账户与 OAuth 在外部管理端配置。</strong><p>要在轻作内登录，请到「代理连接」选择内置管理并保存，不会迁移外部账户。</p><Button variant="outline" size="sm" onClick={() => selectSection('connection')}>设置代理连接</Button></AlertDescription></Alert> : null}
      {access === 'api' ? <Card id="ai-api-keys">
        <CardHeader><CardTitle role="heading" aria-level={2}><KeyRound className="ai-section-icon" />助手 API Key 接入</CardTitle><CardDescription>用服务密钥接入文本助手，不用于批图。</CardDescription></CardHeader>
        <CardContent>
          <FieldSet disabled={!builtinReady}><FieldGroup>
            <Field><FieldLabel htmlFor="ai-provider">服务提供商</FieldLabel><select id="ai-provider" value={provider} onChange={event => setProvider(event.target.value)} className="ai-select"><option value="compatible">DeepSeek / OpenAI 兼容服务</option><option value="openai">OpenAI</option><option value="google">Google</option><option value="claude">Claude</option></select></Field>
            <Field><FieldLabel htmlFor="ai-provider-key">提供商 API Key</FieldLabel><Input id="ai-provider-key" type="password" autoComplete="off" placeholder="粘贴你的服务 API Key" value={providerKey} onChange={event => setProviderKey(event.target.value)} /></Field>
            {provider === 'compatible' ? <><Field><FieldLabel htmlFor="ai-provider-url">服务 API 地址</FieldLabel><Input id="ai-provider-url" value={providerURL} onChange={event => setProviderURL(event.target.value)} /></Field><Field><FieldLabel htmlFor="ai-provider-models">服务型号</FieldLabel><Input id="ai-provider-models" placeholder="例如 deepseek-chat" value={providerModels} onChange={event => setProviderModels(event.target.value)} /><FieldDescription>多个模型用逗号分隔。</FieldDescription></Field></> : null}
          </FieldGroup></FieldSet>
        </CardContent>
        <CardFooter><Button disabled={!builtinReady || !providerKey.trim()} onClick={() => void action('provider', async () => { await invoke('provider', { provider, apiKey: providerKey.trim(), baseURL: providerURL.trim(), models: providerModels.split(',').map(value => value.trim()).filter(Boolean) }); setProviderKey(''); }, '服务已接入，请获取模型并选择默认助手')}>{spinner('provider')}保存并接入服务</Button></CardFooter>
      </Card> : <Card id="ai-oauth">
        <CardHeader><CardTitle role="heading" aria-level={2}><LogIn className="ai-section-icon" />OAuth 账户登录</CardTitle><CardDescription>通过系统浏览器授权，无需在轻作填写账户密码。</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="ai-oauth-providers">{oauthProviders.map(value => <div key={value.id} className="ai-oauth-provider"><div><strong>{value.title}</strong><p>{value.description}</p></div><Button variant="outline" disabled={!builtinReady || Boolean(login)} onClick={() => void action(value.id, async () => { const session = await invoke<{ state: string; status: string }>('login', { provider: value.id }); setLogin({ ...session, provider: value.title }); }, '请在系统浏览器中完成授权')}>{spinner(value.id)}登录 {value.title}</Button></div>)}</div>
          {login ? <Alert role="status"><AlertDescription><p>正在等待 {login.provider} 浏览器授权…</p><Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void action('cancel', async () => { await invoke('loginStatus', { state: login.state, cancel: true }); setLogin(null); }, '登录已取消')}>取消登录</Button></AlertDescription></Alert> : null}
          <section aria-label="已授权账户" className="ai-account-status"><div className="ai-status-heading"><strong>已授权账户</strong><Button variant="ghost" size="sm" disabled={!builtinReady} onClick={() => void action('accounts', refreshAccounts, '账户状态已刷新')}><RefreshCw data-icon="inline-start" />刷新账户</Button></div>{accounts.length ? accounts.map(account => <div key={account.name} className="ai-account-row"><strong>{account.provider}</strong><span>{account.name}</span><Badge variant="secondary">{account.status}</Badge></div>) : <p>{accountsLoaded ? '暂无已授权账户，选择上方服务登录。' : '点击刷新，查看内置代理已授权的账户。'}</p>}</section>
        </CardContent>
      </Card>}
      <div className="ai-actions flex"><Button variant="outline" disabled={Boolean(login)} onClick={() => selectSection('model')}>下一步：选择模型<ArrowRight /></Button>{mode === 'builtin' ? <Button variant="ghost" onClick={() => selectSection('connection')}>管理代理连接</Button> : null}</div>
    </> : null}

    {section === 'model' ? <Card id="ai-assistant-model">
      <CardHeader><CardTitle role="heading" aria-level={2}>默认助手模型</CardTitle><CardDescription>接入 API 或 OAuth 后获取模型。助手能否编排批图，需要单独验证工具调用。</CardDescription><CardAction><Badge variant="secondary">{verified ? '已通过工具调用验证' : '尚未验证'}</Badge></CardAction></CardHeader>
      <CardContent><FieldGroup className="ai-model-fields"><Field><FieldLabel htmlFor="ai-model">助手型号</FieldLabel><select id="ai-model" className="ai-select" disabled={disabled || connectionChanged} value={model} onChange={event => setModel(event.target.value)}><option value="">{models.length ? '请选择模型' : '先点击「获取模型」'}</option>{model && !models.some(item => item.id === model) ? <option value={model}>{model}</option> : null}{models.map(item => <option key={item.id} value={item.id} disabled={/gpt[-_]?image|nano[-_ ]?banana|image[-_]?generation/i.test(item.id)}>{item.id}</option>)}</select><FieldDescription>只选择文本模型。图像模型灰显，已有选择不会被静默替换。</FieldDescription></Field><Button variant="outline" disabled={disabled || connectionChanged} onClick={() => void action('models', async () => setModels(await invoke<{ id: string }[]>('models')), '模型列表已刷新')}>{spinner('models')}获取模型</Button></FieldGroup>{imageModel ? <Alert variant="destructive"><AlertDescription>当前选择的是图像模型，不能用于 AI 对话。请获取模型后选择支持工具调用的文本型号；原配置尚未改动。</AlertDescription></Alert> : null}</CardContent>
      <CardFooter className="ai-actions"><Button disabled={disabled || connectionChanged || !model || imageModel} onClick={() => void action('model', configure, '默认助手模型已保存')}>{spinner('model')}保存默认模型</Button><Button variant="outline" disabled={disabled || connectionChanged || !model || imageModel} onClick={() => { if (window.confirm('验证会向 ' + model + ' 发送一次简短的文本请求，可能按提供商规则计费。是否继续？')) void action('verify', async () => { await configure(); await invoke('verify'); }, '模型连接及工具调用验证通过'); }}>{spinner('verify')}验证连接与工具调用</Button><p className="text-sm text-muted-foreground">验证只请求文本，不生成图片。</p></CardFooter>
      <CardFooter><Button variant="ghost" onClick={onOpenChat}><MessageCircle />打开 AI 对话</Button></CardFooter>
    </Card> : null}
  </div></div>;
}
