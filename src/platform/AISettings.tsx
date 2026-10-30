import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  Image,
  KeyRound,
  Layers3,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AI_PROVIDERS, DEFAULT_PROXY_ADDRESS, friendlyModelName, isChatModel, normalizeAIAddress, providerForAddress, type AIModel } from './ai-providers';

interface ProxyStatus {
  mode: string;
  address: string;
  model: string;
  running: boolean;
  verified?: string[];
  ready?: boolean;
  error: string | null;
}

interface SetupSuccess {
  ok: true;
  status: ProxyStatus;
}

interface SetupFailure {
  ok: false;
  code: string;
  message: string;
  models?: AIModel[];
}

type SetupResult = SetupSuccess | SetupFailure;

const CUSTOM_PROVIDER_ID = 'custom';
const providerIcons = { deepseek: BrainCircuit, openai: Sparkles, siliconflow: Layers3 } as const;

function statusReady(status: ProxyStatus | null) {
  if (!status || !status.model) return false;
  if (typeof status.ready === 'boolean') return status.ready;
  return Array.isArray(status.verified) && status.verified.includes(status.model) && isChatModel({ id: status.model });
}

function unexpectedSetupFailure(reason: unknown): SetupFailure {
  const raw = reason instanceof Error ? reason.message : String(reason);
  if (/401/.test(raw)) return { ok: false, code: 'invalid_key', message: '访问密钥无效，请检查后重新粘贴。' };
  if (/403/.test(raw)) return { ok: false, code: 'forbidden', message: '这个密钥没有调用所选服务的权限，请在服务商后台检查权限。' };
  if (/404/.test(raw)) return { ok: false, code: 'incompatible_address', message: '服务地址不兼容，请检查是否填写了 OpenAI 兼容接口地址。' };
  if (/429/.test(raw)) return { ok: false, code: 'rate_limited', message: '请求过于频繁或额度不足，请稍后再试，或检查服务商账户。' };
  if (/timeout|超时/i.test(raw)) return { ok: false, code: 'network_timeout', message: '连接超时，请检查网络后重试。' };
  return { ok: false, code: 'network_error', message: '无法连接 AI 服务，请检查网络或服务地址后重试。' };
}

export function AISettings({ imageAvailable = false, onOpenImage, onOpenChat }: { imageAvailable?: boolean; onOpenImage?: () => void; onOpenChat?: () => void }) {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [providerId, setProviderId] = useState<string>('deepseek');
  const [address, setAddress] = useState(AI_PROVIDERS[0].address);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [editing, setEditing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [setupError, setSetupError] = useState<SetupFailure | null>(null);
  const [recoveryModels, setRecoveryModels] = useState<AIModel[]>([]);
  const operation = useRef(false);

  const invoke = useCallback(async <Value,>(method: string, args?: unknown) => {
    if (!window.commerceDesktop) throw new Error('请在轻作桌面应用中配置 AI 服务。');
    return window.commerceDesktop.invoke<Value>('ai.' + method, args);
  }, []);

  const hydrate = useCallback((value: ProxyStatus) => {
    const savedProvider = providerForAddress(value.address);
    const hasSavedConnection = value.address !== DEFAULT_PROXY_ADDRESS || Boolean(value.model);
    const nextProvider = savedProvider?.id ?? (hasSavedConnection ? CUSTOM_PROVIDER_ID : AI_PROVIDERS[0].id);
    setStatus(value);
    setProviderId(nextProvider);
    setAddress(savedProvider?.address ?? (hasSavedConnection ? value.address : AI_PROVIDERS[0].address));
    setModel(value.model);
    setAdvancedOpen(nextProvider === CUSTOM_PROVIDER_ID);
    setEditing(!statusReady(value));
    setKey('');
    setShowKey(false);
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const value = await invoke<ProxyStatus>('status');
      hydrate(value);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [hydrate, invoke]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const provider = AI_PROVIDERS.find(item => item.id === providerId) ?? null;
  const providerName = provider?.name ?? '自定义服务';
  const ready = statusReady(status);
  const canReuseKey = Boolean(status && normalizeAIAddress(status.address) === normalizeAIAddress(address));
  const partial = Boolean(status && !ready && (status.model || status.address !== DEFAULT_PROXY_ADDRESS));
  const ProviderIcon = provider ? providerIcons[provider.id] : Server;

  function clearFeedback() {
    setSetupError(null);
    setRecoveryModels([]);
  }

  function selectProvider(id: string) {
    clearFeedback();
    setProviderId(id);
    setKey('');
    setShowKey(false);
    const known = AI_PROVIDERS.find(item => item.id === id);
    const saved = status ? providerForAddress(status.address) : null;
    if (known) {
      setAddress(known.address);
      setModel(saved?.id === id ? status?.model ?? '' : '');
      setAdvancedOpen(false);
    } else {
      setAddress(saved ? '' : status?.address ?? '');
      setModel(saved ? '' : status?.model ?? '');
      setAdvancedOpen(true);
    }
  }

  async function openKeyPage() {
    if (!provider) return;
    try {
      await window.commerceDesktop?.invoke('openExternal', { url: provider.keyUrl });
    } catch (reason) {
      setSetupError(unexpectedSetupFailure(reason));
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current || !address.trim() || (!key.trim() && !canReuseKey)) return;
    operation.current = true;
    setBusy(true);
    clearFeedback();
    try {
      const result = await invoke<SetupResult>('setup', {
        address: address.trim(),
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        preferredModels: provider?.preferredModels ?? [],
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      if (!result.ok) {
        setSetupError(result);
        const available = (result.models ?? []).filter(item => isChatModel(item));
        setRecoveryModels(available);
        if (available.length) {
          setModel('');
          setAdvancedOpen(true);
        }
        return;
      }
      hydrate(result.status);
    } catch (reason) {
      setSetupError(unexpectedSetupFailure(reason));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  function changeService() {
    clearFeedback();
    setEditing(true);
    setKey('');
    setShowKey(false);
    setAdvancedOpen(providerId === CUSTOM_PROVIDER_ID);
  }

  if (loading && !status) {
    return <div className="ai-settings-loading" role="status"><LoaderCircle className="animate-spin" />正在读取 AI 设置…</div>;
  }

  if (loadError && !status) {
    return <div className="ai-settings">
      <Alert variant="destructive"><AlertCircle /><AlertDescription><strong>暂时无法读取 AI 设置</strong><p>原有设置不会因此被修改。请检查应用状态后重试。</p><Button variant="outline" size="sm" onClick={() => void loadStatus()}><RefreshCw data-icon="inline-start" />重新读取</Button></AlertDescription></Alert>
    </div>;
  }

  return <div className="ai-settings ai-settings-wizard">
    {status?.error || loadError ? <Alert variant="destructive"><AlertCircle /><AlertDescription><strong>{status?.error || loadError}</strong><Button variant="outline" size="sm" onClick={() => void loadStatus()}><RefreshCw data-icon="inline-start" />重新读取</Button></AlertDescription></Alert> : null}

    {ready && !editing ? <>
      <section className="ai-ready-card" aria-label="AI 助手状态">
        <div className="ai-ready-mark"><CheckCircle2 /></div>
        <div className="ai-ready-copy">
          <span>已启用</span>
          <h1>AI 助手已连接 {providerName}</h1>
          <p>{friendlyModelName(status!.address, status!.model)}</p>
        </div>
        <div className="ai-ready-actions">
          <Button disabled={!onOpenChat} onClick={onOpenChat}><MessageCircle data-icon="inline-start" />开始 AI 对话</Button>
          <Button variant="outline" onClick={changeService}><SlidersHorizontal data-icon="inline-start" />更换服务</Button>
        </div>
      </section>

      <Card id="ai-image" className="ai-image-entry">
        <CardHeader>
          <CardTitle role="heading" aria-level={2}><Image className="ai-section-icon" />图像编辑</CardTitle>
          <CardDescription>需要处理或生成图片时，再单独配置图像服务。</CardDescription>
          <CardAction><Button variant="outline" disabled={!imageAvailable} onClick={onOpenImage}>{imageAvailable ? '配置图像服务' : '需要安装 AI 批图'}</Button></CardAction>
        </CardHeader>
        {!imageAvailable ? <CardContent><p className="text-sm text-muted-foreground">安装并启用「AI 批图」后即可配置。</p></CardContent> : null}
      </Card>
    </> : <>
      {partial ? <div className="ai-partial-note" role="status"><AlertCircle /><div><strong>已保存，尚未启用</strong><span>{status?.model ? `已选择 ${friendlyModelName(status.address, status.model)}，还需要完成连接验证。` : '还需要完成连接验证才能开始对话。'}</span></div></div> : null}

      <section className="ai-provider-section" aria-labelledby="ai-provider-heading">
        <div className="ai-wizard-heading">
          <div><span>连接 AI 服务</span><h1 id="ai-provider-heading">选择一个服务商</h1><p>连接并验证成功后，就可以开始对话。</p></div>
          <div className="ai-privacy-note"><KeyRound /><span>访问密钥只保存在本机</span></div>
        </div>
        <div className="ai-provider-grid" role="group" aria-label="服务商">
          {AI_PROVIDERS.map(item => {
            const Icon = providerIcons[item.id];
            const selected = providerId === item.id;
            return <button key={item.id} type="button" className="ai-provider-card" aria-pressed={selected} onClick={() => selectProvider(item.id)}>
              <span className="ai-provider-icon"><Icon /></span>
              <span className="ai-provider-copy"><strong>{item.name}</strong><small>{item.description}</small></span>
              {selected ? <CheckCircle2 className="ai-provider-check" /> : null}
            </button>;
          })}
          <button type="button" className="ai-provider-card is-custom" aria-pressed={providerId === CUSTOM_PROVIDER_ID} onClick={() => selectProvider(CUSTOM_PROVIDER_ID)}>
            <span className="ai-provider-icon"><Server /></span>
            <span className="ai-provider-copy"><strong>自定义服务</strong><small>连接其他 OpenAI 兼容服务</small></span>
            {providerId === CUSTOM_PROVIDER_ID ? <CheckCircle2 className="ai-provider-check" /> : null}
          </button>
        </div>
      </section>

      <form onSubmit={event => void connect(event)}>
        <Card className="ai-connect-card">
          <CardHeader>
            <CardTitle role="heading" aria-level={2}><ProviderIcon className="ai-section-icon" />连接 {providerName}</CardTitle>
            <CardDescription>{provider ? `填写 ${provider.name} 的访问密钥，地址已经自动配置。` : '填写兼容 OpenAI 接口的服务地址和访问密钥。'}</CardDescription>
            {provider ? <CardAction><Button type="button" variant="ghost" size="sm" onClick={() => void openKeyPage()}>如何获取<ExternalLink data-icon="inline-end" /></Button></CardAction> : null}
          </CardHeader>
          <CardContent className="ai-connect-content">
            {setupError ? <Alert variant="destructive" className="ai-setup-error"><AlertCircle /><AlertDescription>
              <strong>{setupError.message}</strong>
              {recoveryModels.length ? <div className="ai-model-recovery">
                <FieldLabel htmlFor="ai-recovery-model">可用模型</FieldLabel>
                <select id="ai-recovery-model" className="ai-select" value={model} onChange={event => setModel(event.target.value)}>
                  <option value="">请选择模型</option>
                  {recoveryModels.map(item => <option key={item.id} value={item.id}>{item.title && item.title !== item.id ? `${item.title} · ${item.id}` : item.id}</option>)}
                </select>
                <span>选择后重新验证，不会自动改用其他模型。</span>
              </div> : null}
            </AlertDescription></Alert> : null}

            <FieldGroup className="ai-key-field">
              <Field>
                <FieldLabel htmlFor="ai-access-key">访问密钥</FieldLabel>
                <div className="ai-secret-field">
                  <Input id="ai-access-key" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={key} disabled={busy} onChange={event => { setKey(event.target.value); clearFeedback(); }} placeholder={canReuseKey ? '留空继续使用已保存的密钥' : '粘贴访问密钥'} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={showKey ? '隐藏访问密钥' : '显示访问密钥'} title={showKey ? '隐藏访问密钥' : '显示访问密钥'} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff /> : <Eye />}</Button>
                </div>
                <FieldDescription>{provider ? `在 ${provider.name} 控制台创建密钥后粘贴到这里。` : '使用服务提供的 OpenAI 兼容访问密钥。'}</FieldDescription>
              </Field>
            </FieldGroup>

            <div className="ai-advanced">
              <button type="button" className="ai-advanced-toggle" aria-expanded={advancedOpen || providerId === CUSTOM_PROVIDER_ID} onClick={() => setAdvancedOpen(value => !value)}>
                <SlidersHorizontal />高级设置<ChevronDown className={advancedOpen || providerId === CUSTOM_PROVIDER_ID ? 'is-open' : ''} />
              </button>
              {advancedOpen || providerId === CUSTOM_PROVIDER_ID ? <div className="ai-advanced-fields">
                <Field>
                  <FieldLabel htmlFor="ai-address">服务地址</FieldLabel>
                  <Input id="ai-address" value={address} disabled={busy} onChange={event => { setAddress(event.target.value); clearFeedback(); }} placeholder="https://your-service.example.com/v1" />
                  <FieldDescription>支持 HTTPS；本机服务也可以使用 HTTP。</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="ai-model-override">指定模型（可选）</FieldLabel>
                  <Input id="ai-model-override" value={model} disabled={busy} onChange={event => { setModel(event.target.value); clearFeedback(); }} placeholder="留空自动选择推荐模型" />
                  <FieldDescription>只有需要使用特定模型时才填写。</FieldDescription>
                </Field>
              </div> : null}
            </div>
          </CardContent>
          <CardFooter className="ai-connect-actions">
            <Button type="submit" disabled={busy || !address.trim() || (!key.trim() && !canReuseKey)}>
              {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Sparkles data-icon="inline-start" />}
              {busy ? '正在连接…' : setupError ? '重新验证' : partial ? '完成启用' : '连接并启用'}
            </Button>
            {ready && editing ? <Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditing(false); clearFeedback(); }}>取消</Button> : null}
            <p>连接时会发送一次测试消息，可能产生少量费用。</p>
          </CardFooter>
        </Card>
      </form>
    </>}
  </div>;
}
