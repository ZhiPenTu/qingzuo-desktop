import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Image, LoaderCircle, Server, LayoutList, Box, MessageCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardAction, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';

interface ProxyStatus { mode: string; address: string; model: string; running: boolean; verified: string[]; error: string | null }

export function AISettings({ imageAvailable = false, onOpenImage, onOpenChat }: { imageAvailable?: boolean; onOpenImage?: () => void; onOpenChat?: () => void }) {
  const [section, setSection] = useState('overview');
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [address, setAddress] = useState('http://127.0.0.1:8317');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<{ id: string }[]>([]);
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
      if (active) { setStatus(value); setAddress(value.address); setModel(value.model); }
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
    const value = await invoke<ProxyStatus>('configure', { mode: 'external', address, model, apiKey: key });
    if (status?.address !== value.address || key) { setModels([]); }
    setStatus(value); setKey('');
  }

  const connectionChanged = Boolean(status && (status.address !== address || key));
  const disabled = Boolean(busy) || !status;
  const verified = Boolean(status?.verified.includes(model));
  const imageModel = /gpt[-_]?image|nano[-_ ]?banana|image[-_]?generation/i.test(model);
  const sections = [
    { group: '开始使用', items: [{ id: 'overview', title: '配置概览', icon: LayoutList }] },
    { group: '文本助手', items: [{ id: 'connection', title: '代理连接', icon: Server }, { id: 'model', title: '默认模型', icon: Box }] },
    { group: '图像编辑', items: [{ id: 'image', title: '图像 API', icon: Image }] },
  ];

  function selectSection(next: string) {
    setSection(next); setKey(''); setError(''); setMessage('');
  }
  const spinner = (name: string) => busy === name ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null;

  return (
    <div className="ai-settings-layout">
      <nav className="ai-settings-rail" aria-label="AI 配置分类">
        {sections.map(group => (
          <div key={group.group}>
            <p>{group.group}</p>
            {group.items.map(({ id, title, icon: Icon }) => (
              <Button key={id} variant={section === id ? 'secondary' : 'ghost'} aria-current={section === id ? 'page' : undefined} onClick={() => selectSection(id)}>
                <Icon />{title}
              </Button>
            ))}
          </div>
        ))}
      </nav>
      <div className="ai-settings">
        {error || status?.error ? <Alert variant="destructive"><AlertDescription>{error || status?.error}</AlertDescription></Alert> : null}
        {message ? <Alert role="status"><CheckCircle2 /><AlertDescription>{message}</AlertDescription></Alert> : null}

        {section === 'overview' ? (
          <section className="ai-overview" aria-label="配置概览">
            <div className="ai-setup-steps">
              {[
                { number: 1, title: '接入文本服务', description: status?.address ? '已配置代理地址：' + status.address : '配置外部代理或兼容服务地址与访问密钥。', button: '配置连接', action: () => selectSection('connection') },
                { number: 2, title: '选择助手模型', description: status?.model ? '当前：' + status.model + (status.verified.includes(status.model) ? ' · 已验证工具调用' : ' · 尚未验证工具调用') : '验证工具调用后启用插件编排。图像型号不能用作文本助手。', button: '选择模型', action: () => selectSection('model') },
                { number: 3, title: '开始 AI 对话', description: '调用前展示插件及参数，确认后执行。', button: '打开对话', action: onOpenChat },
              ].map(step => (
                <div className="ai-setup-row" key={step.number}>
                  <span>{step.number}</span>
                  <div><h2>{step.title}</h2><p>{step.description}</p></div>
                  <Button disabled={!step.action} onClick={step.action}>{step.button}<ArrowRight /></Button>
                </div>
              ))}
            </div>
            <div className="ai-image-band">
              <Image />
              <div><h2>图像编辑</h2><p>复用代理服务图片模型，或配置官方 API。</p></div>
              <Button variant="outline" onClick={() => selectSection('image')}>配置图像 API<ArrowRight /></Button>
            </div>
          </section>
        ) : null}

        {section === 'image' ? (
          <Card id="ai-image" className="ai-image-entry">
            <CardHeader>
              <CardTitle role="heading" aria-level={2}><Image className="ai-section-icon" />图像编辑 API</CardTitle>
              <CardDescription>批图插件可直接选择已接入代理服务的图片模型，也保留 Google / OpenAI 官方 API 入口。</CardDescription>
              <CardAction><Button disabled={!imageAvailable} onClick={onOpenImage}>配置图像 API<ArrowRight data-icon="inline-end" /></Button></CardAction>
            </CardHeader>
            {!imageAvailable ? <CardContent><p className="text-sm text-muted-foreground">请先安装并启用「AI 批图」插件。密钥仅授权给该插件。</p></CardContent> : null}
            <CardContent><p className="text-sm text-muted-foreground">代理模式复用已保存的连接与密钥，是否支持图片编辑取决于代理型号和账户权限。官方模式仍使用插件专属密钥；所有凭据留在宿主，不会交给插件页面或 AI 对话。选择图片型号不会改变默认文本助手模型。</p></CardContent>
          </Card>
        ) : null}

        {section === 'connection' ? (
          <Card id="ai-connection">
            <CardHeader>
              <CardTitle role="heading" aria-level={2}><Server className="ai-section-icon" />助手连接方式</CardTitle>
              <CardDescription>配置外部代理或兼容服务连接。保存后需在「默认模型」中完成验证。</CardDescription>
              <CardAction><Badge variant="secondary">当前：外部代理</Badge></CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FieldGroup className="ai-connection-fields">
                <Field>
                  <FieldLabel htmlFor="ai-address">代理地址</FieldLabel>
                  <Input id="ai-address" disabled={disabled} value={address} onChange={event => setAddress(event.target.value)} placeholder="http://127.0.0.1:8317" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="ai-access-key">代理访问密钥</FieldLabel>
                  <Input id="ai-access-key" disabled={disabled} type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder="留空保留已有密钥" />
                </Field>
              </FieldGroup>
              <p className="text-sm text-muted-foreground">支持兼容 OpenAI 接口规范的外部代理或本地服务（例如 http://127.0.0.1:8317）。仅支持本机 HTTP 或 HTTPS 地址。</p>
              {connectionChanged ? <p role="status" className="text-sm text-muted-foreground">连接方式尚未应用。请先保存，再获取模型。</p> : null}
            </CardContent>
            <CardFooter className="ai-actions">
              <Button disabled={disabled} onClick={() => void action('configure', configure, '连接设置已保存')}>{spinner('configure')}保存连接设置</Button>
              <Button variant="outline" disabled={disabled || connectionChanged} onClick={() => selectSection('model')}>下一步：选择模型<ArrowRight /></Button>
            </CardFooter>
          </Card>
        ) : null}

        {section === 'model' ? (
          <Card id="ai-assistant-model">
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>默认助手模型</CardTitle>
              <CardDescription>保存连接设置后获取模型。助手能否编排批图，需要单独验证工具调用。</CardDescription>
              <CardAction><Badge variant="secondary">{verified ? '已通过工具调用验证' : '尚未验证'}</Badge></CardAction>
            </CardHeader>
            <CardContent>
              <FieldGroup className="ai-model-fields">
                <Field>
                  <FieldLabel htmlFor="ai-model">助手型号</FieldLabel>
                  <select id="ai-model" className="ai-select" disabled={disabled || connectionChanged} value={model} onChange={event => setModel(event.target.value)}>
                    <option value="">{models.length ? '请选择模型' : '先点击「获取模型」'}</option>
                    {model && !models.some(item => item.id === model) ? <option value={model}>{model}</option> : null}
                    {models.map(item => (
                      <option key={item.id} value={item.id} disabled={/gpt[-_]?image|nano[-_ ]?banana|image[-_]?generation/i.test(item.id)}>
                        {item.id}
                      </option>
                    ))}
                  </select>
                  <FieldDescription>只选择文本模型。图像模型灰显，已有选择不会被静默替换。</FieldDescription>
                </Field>
                <Button variant="outline" disabled={disabled || connectionChanged} onClick={() => void action('models', async () => setModels(await invoke<{ id: string }[]>('models')), '模型列表已刷新')}>
                  {spinner('models')}获取模型
                </Button>
              </FieldGroup>
              {imageModel ? <Alert variant="destructive"><AlertDescription>当前选择的是图像模型，不能用于 AI 对话。请获取模型后选择支持工具调用的文本型号；原配置尚未改动。</AlertDescription></Alert> : null}
            </CardContent>
            <CardFooter className="ai-actions">
              <Button disabled={disabled || connectionChanged || !model || imageModel} onClick={() => void action('model', configure, '默认助手模型已保存')}>
                {spinner('model')}保存默认模型
              </Button>
              <Button variant="outline" disabled={disabled || connectionChanged || !model || imageModel} onClick={() => {
                if (window.confirm('验证会向 ' + model + ' 发送一次简短的文本请求，可能按提供商规则计费。是否继续？')) {
                  void action('verify', async () => { await configure(); await invoke('verify'); }, '模型连接及工具调用验证通过');
                }
              }}>
                {spinner('verify')}验证连接与工具调用
              </Button>
              <p className="text-sm text-muted-foreground">验证只请求文本，不生成图片。</p>
            </CardFooter>
            <CardFooter>
              <Button variant="ghost" onClick={onOpenChat}><MessageCircle />打开 AI 对话</Button>
            </CardFooter>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
