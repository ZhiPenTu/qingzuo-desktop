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
import { cn } from '@/lib/utils';
import { AI_PROVIDERS, DEFAULT_PROXY_ADDRESS, isChatModel, normalizeAIAddress, providerForAddress, type AIModel } from './ai-providers';

interface ProxyStatus {
  mode: string;
  address: string;
  running: boolean;
  model?: string;
  verified?: string[];
  ready?: boolean;
  error: string | null;
}

interface SetupSuccess {
  ok: true;
  status: ProxyStatus;
  models?: Array<{ id: string; title?: string; type?: string }>;
}

interface SetupFailure {
  ok: false;
  code: string;
  message: string;
}

interface ModelTestSuccess {
  ok: true;
  model: string;
  latencyMs: number;
  response: string;
}

interface ModelTestFailure {
  ok: false;
  model: string;
  code: string;
  message: string;
}

type ModelTestState =
  | { state: 'testing' }
  | { state: 'success'; latencyMs: number; response: string }
  | { state: 'error'; message: string };

type SetupResult = SetupSuccess | SetupFailure;
type ImageProviderId = 'google' | 'openai';

interface SharedImageStatus {
  google: { configured: boolean; source: 'dedicated' | 'inherited' | 'legacy' | 'none' };
  openai: { configured: boolean; source: 'dedicated' | 'inherited' | 'legacy' | 'none' };
  proxy: { configured: boolean };
}

interface ImageCatalogModel {
  id: string;
  title?: string;
  provider: 'google' | 'openai' | 'compatible';
  source: 'official' | 'proxy';
  sizes?: string[];
  ratios?: string[];
  qualities?: string[];
}

interface ImageCatalog {
  models: ImageCatalogModel[];
  error: string | null;
}

const CUSTOM_PROVIDER_ID = 'custom';
const providerIcons = { deepseek: BrainCircuit, openai: Sparkles, siliconflow: Layers3 } as const;
const imageProviders = [
  { id: 'google', name: 'Google 官方', keyUrl: 'https://aistudio.google.com/app/apikey' },
  { id: 'openai', name: 'OpenAI 官方', keyUrl: 'https://platform.openai.com/api-keys' },
] as const;

function statusReady(status: ProxyStatus | null) {
  if (!status) return false;
  if (typeof status.ready === 'boolean') return status.ready;
  return Boolean(status.model && Array.isArray(status.verified) && status.verified.includes(status.model));
}

function nonChatModelType(model: AIModel) {
  const signature = `${model.id} ${model.type ?? ''}`.toLowerCase();
  if (/image|imagen|dall-e|stable-diffusion|flux/.test(signature)) return '图像模型';
  if (/embedding|embed|bge/.test(signature)) return '向量模型';
  if (/rerank/.test(signature)) return '重排模型';
  if (/audio|speech|tts|whisper|transcri/.test(signature)) return '语音模型';
  if (/video|sora|veo|kling/.test(signature)) return '视频模型';
  return '非对话模型';
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

export function AISettings({ onOpenChat }: { onOpenChat?: () => void }) {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [providerId, setProviderId] = useState<string>('deepseek');
  const [address, setAddress] = useState(AI_PROVIDERS[0].address);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [editing, setEditing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [setupError, setSetupError] = useState<SetupFailure | null>(null);
  const [models, setModels] = useState<AIModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
  const [testingModel, setTestingModel] = useState('');
  const [modelTests, setModelTests] = useState<Record<string, ModelTestState>>({});
  const [imageStatus, setImageStatus] = useState<SharedImageStatus | null>(null);
  const [imageSettingsOpen, setImageSettingsOpen] = useState(false);
  const [imageKeys, setImageKeys] = useState<Record<ImageProviderId, string>>({ google: '', openai: '' });
  const [imageKeyVisible, setImageKeyVisible] = useState<Record<ImageProviderId, boolean>>({ google: false, openai: false });
  const [imageBusy, setImageBusy] = useState<ImageProviderId | null>(null);
  const [imageError, setImageError] = useState('');
  const [imageModels, setImageModels] = useState<ImageCatalogModel[]>([]);
  const [imageModelsLoading, setImageModelsLoading] = useState(true);
  const [imageModelsError, setImageModelsError] = useState('');
  const operation = useRef(false);

  const invoke = useCallback(async <Value,>(method: string, args?: unknown) => {
    if (!window.commerceDesktop) throw new Error('请在轻作桌面应用中配置 AI 服务。');
    return window.commerceDesktop.invoke<Value>('ai.' + method, args);
  }, []);

  const hydrate = useCallback((value: ProxyStatus) => {
    const savedProvider = providerForAddress(value.address);
    const hasSavedConnection = value.address !== DEFAULT_PROXY_ADDRESS || Boolean(value.ready || value.model);
    const nextProvider = savedProvider?.id ?? (hasSavedConnection ? CUSTOM_PROVIDER_ID : AI_PROVIDERS[0].id);
    setStatus(value);
    setProviderId(nextProvider);
    setAddress(savedProvider?.address ?? (hasSavedConnection ? value.address : AI_PROVIDERS[0].address));
    setAdvancedOpen(nextProvider === CUSTOM_PROVIDER_ID);
    setEditing(!statusReady(value));
    setKey('');
    setShowKey(false);
  }, []);

  const loadModels = useCallback(async (value: ProxyStatus) => {
    setModelsLoading(true);
    setModelsError('');
    if (!statusReady(value)) {
      setModels([]);
      setModelTests({});
      setModelsLoading(false);
      return;
    }
    try {
      const next = await invoke<AIModel[]>('models');
      setModels(next);
      setModelTests({});
    } catch (reason) {
      setModels([]);
      setModelTests({});
      setModelsError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setModelsLoading(false);
    }
  }, [invoke]);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const value = await invoke<ProxyStatus>('status');
      hydrate(value);
      await loadModels(value);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [hydrate, invoke, loadModels]);

  const loadImageStatus = useCallback(async () => {
    setImageError('');
    try {
      setImageStatus(await invoke<SharedImageStatus>('imageStatus'));
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [invoke]);

  const loadImageCatalog = useCallback(async () => {
    setImageModelsLoading(true);
    setImageModelsError('');
    try {
      const catalog = await invoke<ImageCatalog>('imageModels');
      setImageModels(catalog.models);
      setImageModelsError(catalog.error ?? '');
    } catch {
      setImageModels([]);
      setImageModelsError('暂时无法读取图片模型，请检查服务配置后重试。');
    } finally {
      setImageModelsLoading(false);
    }
  }, [invoke]);

  useEffect(() => {
    void loadStatus();
    void loadImageStatus();
    void loadImageCatalog();
  }, [loadImageCatalog, loadImageStatus, loadStatus]);

  const provider = AI_PROVIDERS.find(item => item.id === providerId) ?? null;
  const providerName = provider?.name ?? '自定义服务';
  const ready = statusReady(status);
  const textModelCount = models.filter(isChatModel).length;
  const canReuseKey = Boolean(status && normalizeAIAddress(status.address) === normalizeAIAddress(address));
  const partial = Boolean(status && !ready && (status.model || status.address !== DEFAULT_PROXY_ADDRESS));
  const ProviderIcon = provider ? providerIcons[provider.id] : Server;

  function clearFeedback() {
    setSetupError(null);
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
      setAdvancedOpen(false);
    } else {
      setAddress(saved ? '' : status?.address ?? '');
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

  async function openImageKeyPage(url: string) {
    try {
      await window.commerceDesktop?.invoke('openExternal', { url });
    } catch {
      setImageError('无法打开服务商页面，请稍后重试。');
    }
  }

  async function configureImage(provider: ImageProviderId, clear = false) {
    if (imageBusy) return;
    const apiKey = imageKeys[provider].trim();
    if (!clear && !apiKey) return;
    setImageBusy(provider);
    setImageError('');
    try {
      const next = await invoke<SharedImageStatus>('configureImage', { provider, ...(clear ? { clear: true } : { apiKey }) });
      setImageStatus(next);
      setImageKeys(value => ({ ...value, [provider]: '' }));
      await loadImageCatalog();
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImageBusy(null);
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
      });
      if (!result.ok) {
        setSetupError(result);
        return;
      }
      hydrate(result.status);
      await Promise.all([loadModels(result.status), loadImageStatus(), loadImageCatalog()]);
    } catch (reason) {
      setSetupError(unexpectedSetupFailure(reason));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  async function testModel(item: AIModel) {
    if (testingModel || !isChatModel(item)) return;
    setTestingModel(item.id);
    setModelTests(value => ({ ...value, [item.id]: { state: 'testing' } }));
    try {
      const result = await invoke<ModelTestSuccess | ModelTestFailure>('testModel', { model: item.id });
      setModelTests(value => ({
        ...value,
        [item.id]: result.ok
          ? { state: 'success', latencyMs: result.latencyMs, response: result.response }
          : { state: 'error', message: result.message },
      }));
    } catch (reason) {
      setModelTests(value => ({
        ...value,
        [item.id]: { state: 'error', message: reason instanceof Error ? reason.message : '模型测试失败，请稍后重试。' },
      }));
    } finally {
      setTestingModel('');
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
          <p>{modelsLoading ? '正在读取可用模型。' : models.length && textModelCount ? `已读取 ${models.length} 个模型，AI 对话和插件会选择可用的文本模型自行接入。` : models.length ? `已读取 ${models.length} 个模型，但没有可用于文本对话的模型。` : '服务没有返回任何模型，请检查服务账户权限。'}</p>
        </div>
        <div className="ai-ready-actions">
          <Button disabled={!onOpenChat} onClick={onOpenChat}><MessageCircle data-icon="inline-start" />开始 AI 对话</Button>
          <Button variant="outline" onClick={changeService}><SlidersHorizontal data-icon="inline-start" />更换服务</Button>
        </div>
      </section>

    </> : <>
      {partial ? <div className="ai-partial-note" role="status"><AlertCircle /><div><strong>已保存，尚未启用</strong><span>还需要完成连接验证才能开始对话。</span></div></div> : null}

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
            <CardDescription>{provider ? `填写 ${provider.name} 的访问密钥，地址已经自动配置。` : '填写兼容 OpenAI 接口的服务地址和访问密钥，连接后可读取全部可用模型。'}</CardDescription>
            {provider ? <CardAction><Button type="button" variant="ghost" size="sm" onClick={() => void openKeyPage()}>如何获取<ExternalLink data-icon="inline-end" /></Button></CardAction> : null}
          </CardHeader>
          <CardContent className="ai-connect-content">
            {setupError ? <Alert variant="destructive" className="ai-setup-error"><AlertCircle /><AlertDescription>
              <strong>{setupError.message}</strong>
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
              {advancedOpen || providerId === CUSTOM_PROVIDER_ID ? <div className="ai-advanced-fields is-single">
                <Field>
                  <FieldLabel htmlFor="ai-address">服务地址</FieldLabel>
                  <Input id="ai-address" value={address} disabled={busy} onChange={event => { setAddress(event.target.value); clearFeedback(); }} placeholder="https://your-service.example.com/v1" />
                  <FieldDescription>支持 HTTPS；本机服务也可以使用 HTTP。</FieldDescription>
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
            <p>连接时只读取可用模型，不会产生模型调用费用。</p>
          </CardFooter>
        </Card>
      </form>
    </>}

    {ready && status ? <Card className="ai-model-catalog">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}><Layers3 className="ai-section-icon" />可用模型{modelsLoading ? null : <span className="ai-model-count">{models.length}</span>}</CardTitle>
        <CardDescription>这里展示服务返回的全部模型。测试会发送一条最小对话请求，可能产生少量费用。</CardDescription>
        <CardAction><Button variant="ghost" size="sm" disabled={modelsLoading} onClick={() => void loadModels(status)}><RefreshCw data-icon="inline-start" />刷新</Button></CardAction>
      </CardHeader>
      <CardContent className="ai-model-catalog-content">
        {modelsLoading && !models.length ? <div className="ai-model-empty" role="status"><LoaderCircle className="animate-spin" />正在读取模型…</div> : null}
        {!modelsLoading && !models.length ? <div className="ai-model-empty">服务没有返回模型。</div> : null}
        {models.length ? <div className="ai-model-list" role="list" aria-label="可用模型列表">
          {models.map(item => {
            const chat = isChatModel(item);
            const test = modelTests[item.id];
            const title = item.title && item.title !== item.id ? item.title : item.id;
            return <div className="ai-model-row" role="listitem" key={item.id}>
              <div className="ai-model-copy">
                <div><strong>{title}</strong><span className={cn('ai-model-kind', !chat && 'is-muted')}>{chat ? '文本' : '非文本'}</span></div>
                {title !== item.id ? <code>{item.id}</code> : null}
                {!chat ? <small>{nonChatModelType(item)}</small> : null}
              </div>
              <div className="ai-model-test">
                {test?.state === 'testing' ? <span className="ai-model-testing" role="status"><LoaderCircle className="animate-spin" />正在测试</span> : null}
                {test?.state === 'success' ? <div className="ai-model-test-result is-success" role="status"><span><CheckCircle2 />连接正常 · {test.latencyMs} ms</span>{test.response ? <small title={test.response}>回复：{test.response}</small> : null}</div> : null}
                {test?.state === 'error' ? <div className="ai-model-test-result is-error" role="status"><AlertCircle /><span>{test.message}</span></div> : null}
                {chat ? <Button type="button" variant="outline" size="sm" aria-label={'测试模型 ' + item.id} disabled={Boolean(testingModel)} onClick={() => void testModel(item)}>{testingModel === item.id ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}测试</Button> : <span className="ai-model-unsupported">不可用于对话</span>}
              </div>
            </div>;
          })}
        </div> : null}
      </CardContent>
    </Card> : null}

    {modelsError ? <Alert variant="destructive"><AlertCircle /><AlertDescription><strong>暂时无法读取可用模型</strong><p>{modelsError}</p><Button variant="outline" size="sm" onClick={() => void loadStatus()}><RefreshCw data-icon="inline-start" />重新读取</Button></AlertDescription></Alert> : null}

    <Card className="ai-shared-image">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}><Image className="ai-section-icon" />共享图像能力</CardTitle>
        <CardDescription>所有图像工具共用这里的服务，不需要重复填写密钥。</CardDescription>
        <CardAction><Button variant="outline" onClick={() => setImageSettingsOpen(value => !value)}>{imageSettingsOpen ? '收起配置' : '配置共享密钥'}</Button></CardAction>
      </CardHeader>
      <CardContent className="ai-shared-image-content">
        <div className="ai-image-provider-status">
          {imageProviders.map(item => {
            const value = imageStatus?.[item.id];
            const label = !value ? '读取中' : value.source === 'inherited' ? '沿用上方连接' : value.configured ? '已配置' : '未配置';
            return <div key={item.id} className="ai-image-provider-row">
              <div><strong>{item.name}</strong><span>{value?.source === 'legacy' ? '正在使用旧版保存的密钥' : item.id === 'openai' ? '可自动沿用上方 OpenAI 连接' : '用于 Google / Gemini 图像模型'}</span></div>
              <span className={cn('ai-image-provider-state', value?.configured && 'is-configured')}>{label}</span>
            </div>;
          })}
          <div className="ai-image-provider-row">
            <div><strong>兼容服务</strong><span>沿用上方连接；可用图片模型取决于服务商支持。</span></div>
            <span className={cn('ai-image-provider-state', imageStatus?.proxy.configured && 'is-configured')}>{!imageStatus ? '读取中' : imageStatus.proxy.configured ? '已配置' : '未配置'}</span>
          </div>
        </div>
        <div className="ai-image-model-catalog">
          <div className="ai-image-model-heading">
            <div>
              <strong>可用图片模型{imageModelsLoading ? null : <span className="ai-model-count">{imageModels.length}</span>}</strong>
              <small>列出当前图像服务可用的模型，图像工具会从这些模型中选择。</small>
            </div>
            <Button variant="ghost" size="sm" disabled={imageModelsLoading} onClick={() => { void loadImageStatus(); void loadImageCatalog(); }}>
              <RefreshCw data-icon="inline-start" />刷新
            </Button>
          </div>
          {imageModelsLoading && !imageModels.length ? <div className="ai-model-empty" role="status"><LoaderCircle className="animate-spin" />正在读取图片模型…</div> : null}
          {!imageModelsLoading && !imageModels.length && !imageModelsError ? <div className="ai-model-empty">配置图像服务后，这里会显示可用模型。</div> : null}
          {imageModels.length ? <div className="ai-model-list ai-image-model-list" role="list" aria-label="可用图片模型">
            {imageModels.map(model => {
              const title = model.title && model.title !== model.id ? model.title : model.id;
              const provider = model.provider === 'google' ? 'Google' : model.provider === 'openai' ? 'OpenAI' : '兼容服务';
              return <div className="ai-model-row ai-image-model-row" role="listitem" key={model.source + ':' + model.id}>
                <div className="ai-model-copy">
                  <div><strong>{title}</strong><span className="ai-model-kind">{provider}</span></div>
                  {title !== model.id ? <code>{model.id}</code> : null}
                </div>
                <span className="ai-image-model-source">{model.source === 'official' ? '官方服务' : '兼容服务'}</span>
              </div>;
            })}
          </div> : null}
          {imageModelsError ? <Alert variant="destructive"><AlertCircle /><AlertDescription>{imageModelsError}</AlertDescription></Alert> : null}
        </div>
        {imageError ? <Alert variant="destructive"><AlertCircle /><AlertDescription>{imageError}</AlertDescription></Alert> : null}
        {imageSettingsOpen ? <div className="ai-image-key-settings">
          {imageProviders.map(item => {
            const state = imageStatus?.[item.id];
            return <div key={item.id} className="ai-image-key-row">
              <Field>
                <FieldLabel htmlFor={'ai-image-key-' + item.id}>{item.name}访问密钥</FieldLabel>
                <div className="ai-secret-field">
                  <Input id={'ai-image-key-' + item.id} type={imageKeyVisible[item.id] ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={imageKeys[item.id]} disabled={imageBusy === item.id} onChange={event => { setImageKeys(value => ({ ...value, [item.id]: event.target.value })); setImageError(''); }} placeholder={state?.configured ? '留空继续使用已保存的配置' : '粘贴访问密钥'} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={imageKeyVisible[item.id] ? '隐藏' + item.name + '访问密钥' : '显示' + item.name + '访问密钥'} onClick={() => setImageKeyVisible(value => ({ ...value, [item.id]: !value[item.id] }))}>{imageKeyVisible[item.id] ? <EyeOff /> : <Eye />}</Button>
                </div>
              </Field>
              <div className="ai-image-key-actions">
                <Button size="sm" disabled={imageBusy === item.id || !imageKeys[item.id].trim()} onClick={() => void configureImage(item.id)}>{imageBusy === item.id ? <LoaderCircle className="animate-spin" /> : null}保存</Button>
                {state?.source === 'dedicated' || state?.source === 'legacy' ? <Button size="sm" variant="ghost" disabled={imageBusy === item.id} onClick={() => void configureImage(item.id, true)}>清除</Button> : null}
                <Button size="sm" variant="ghost" onClick={() => void openImageKeyPage(item.keyUrl)}>如何获取<ExternalLink data-icon="inline-end" /></Button>
              </div>
            </div>;
          })}
        </div> : null}
      </CardContent>
    </Card>
  </div>;
}
