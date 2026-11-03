import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, KeyRound, Link2, LoaderCircle, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

type McpStatus = 'ready' | 'auth-required' | 'error' | 'disabled';
interface McpServer {
  id: string;
  name: string;
  url: string;
  authMode: 'none' | 'bearer' | 'oauth';
  headerName: string | null;
  enabled: boolean;
  hasSecret: boolean;
  status: McpStatus;
  error: string | null;
  toolCount: number;
}
interface McpTool { name: string; title: string; description: string; readOnly: boolean }
interface McpGrant { pluginId: string; serverId: string; toolNames: string[] }
interface WechatAccount { id: string; name: string; appIdMasked: string; verified: boolean; updatedAt?: number }

const mcpInitial = { name: '', url: '', authMode: 'none', headerName: 'Authorization', secret: '' };
const wechatInitial = { name: '', appId: '', appSecret: '' };

function messageOf(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function statusLabel(status: McpStatus) {
  return status === 'ready' ? '连接正常' : status === 'auth-required' ? '等待授权' : status === 'disabled' ? '已停用' : '连接异常';
}

export function CapabilitySettings({ desktop }: { desktop: boolean }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [accounts, setAccounts] = useState<WechatAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mcpForm, setMcpForm] = useState(mcpInitial);
  const [mcpEditing, setMcpEditing] = useState('');
  const [tools, setTools] = useState<Record<string, McpTool[]>>({});
  const [grants, setGrants] = useState<Record<string, McpGrant[]>>({});
  const [wechatForm, setWechatForm] = useState(wechatInitial);
  const [wechatEditing, setWechatEditing] = useState('');

  const invoke = useCallback(async <T,>(method: string, args?: unknown) => {
    if (!window.commerceDesktop) throw new Error('请在轻作桌面应用中配置。');
    return window.commerceDesktop.invoke<T>(method, args);
  }, []);

  const load = useCallback(async () => {
    if (!desktop) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [nextServers, nextAccounts] = await Promise.all([
        invoke<McpServer[]>('capabilities.mcp.list'),
        invoke<WechatAccount[]>('capabilities.wechat.list'),
      ]);
      setServers(Array.isArray(nextServers) ? nextServers : []);
      setAccounts(Array.isArray(nextAccounts) ? nextAccounts : []);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, [desktop, invoke]);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, action: () => Promise<unknown>, success = '') => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const result = await action();
      if (success) setNotice(success);
      await load();
      return result;
    } catch (reason) {
      setError(messageOf(reason));
      return null;
    } finally {
      setBusy('');
    }
  };

  const submitMcp = async (event: FormEvent) => {
    event.preventDefault();
    if (!mcpForm.name.trim() || !mcpForm.url.trim()) return;
    const patch = {
      name: mcpForm.name,
      url: mcpForm.url,
      authMode: mcpForm.authMode,
      headerName: mcpForm.authMode === 'bearer' ? mcpForm.headerName : undefined,
      ...(mcpForm.secret.trim() ? { secret: mcpForm.secret } : {}),
    };
    if (mcpEditing) {
      await run('mcp-form', () => invoke('capabilities.mcp.update', { id: mcpEditing, ...patch }), 'MCP 服务已更新。');
    } else {
      await run('mcp-form', () => invoke('capabilities.mcp.create', patch), 'MCP 服务已添加。');
    }
    setMcpForm(mcpInitial);
    setMcpEditing('');
  };

  const editMcp = (server: McpServer) => {
    setMcpEditing(server.id);
    setMcpForm({ name: server.name, url: server.url, authMode: server.authMode, headerName: server.headerName || 'Authorization', secret: '' });
  };

  const loadTools = async (server: McpServer) => {
    const value = await run('tools-' + server.id, () => invoke<McpTool[]>('capabilities.mcp.tools', { id: server.id }));
    if (Array.isArray(value)) setTools(current => ({ ...current, [server.id]: value }));
  };

  const loadGrants = async (server: McpServer) => {
    const value = await run('grants-' + server.id, () => invoke<McpGrant[]>('capabilities.mcp.grants', { serverId: server.id }));
    if (Array.isArray(value)) setGrants(current => ({ ...current, [server.id]: value }));
  };

  const submitWechat = async (event: FormEvent) => {
    event.preventDefault();
    if (!wechatForm.name.trim() || (!wechatEditing && !wechatForm.appId.trim())) return;
    if (wechatEditing) {
      await run('wechat-form', () => invoke('capabilities.wechat.update', {
        id: wechatEditing,
        name: wechatForm.name,
        ...(wechatForm.appId.trim() ? { appId: wechatForm.appId } : {}),
        ...(wechatForm.appSecret.trim() ? { appSecret: wechatForm.appSecret } : {}),
      }), '公众号信息已更新。');
    } else {
      await run('wechat-form', () => invoke('capabilities.wechat.create', wechatForm), '公众号已添加。');
    }
    setWechatForm(wechatInitial);
    setWechatEditing('');
  };

  const editWechat = (account: WechatAccount) => {
    setWechatEditing(account.id);
    setWechatForm({ name: account.name, appId: '', appSecret: '' });
  };

  return <>
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>能力连接</CardTitle>
        <CardDescription>连接内容检索服务和公众号账号，供已安装工具在授权后使用。</CardDescription>
      </CardHeader>
      <CardContent className="capability-settings-body">
        {error ? <Alert variant="destructive"><AlertCircle /><AlertDescription>{error}</AlertDescription></Alert> : null}
        {notice ? <p className="capability-notice" role="status"><CheckCircle2 />{notice}</p> : null}
        <section className="capability-section" aria-labelledby="mcp-heading">
          <div className="capability-section-head">
            <div><h3 id="mcp-heading"><PlugZap />远程 MCP</h3><p>用于搜索资料和读取网页；工具需要单独授权只读调用。</p></div>
            <Button type="button" variant="outline" size="sm" disabled={!desktop || Boolean(busy)} onClick={() => void load()}><RefreshCw data-icon="inline-start" />刷新</Button>
          </div>
          {loading ? <p className="capability-loading" role="status"><LoaderCircle className="animate-spin" />正在读取连接…</p> : null}
          {!loading && !servers.length ? <p className="capability-empty">还没有连接远程 MCP 服务。</p> : null}
          {servers.map(server => <article className="capability-row" key={server.id}>
            <div className="capability-row-main"><strong>{server.name}</strong><span title={server.url}>{server.url}</span><small className={server.status === 'ready' ? 'is-ok' : server.status === 'error' ? 'is-error' : ''}>{statusLabel(server.status)}{server.error ? ' · ' + server.error : ''} · {server.toolCount} 个工具</small></div>
            <div className="capability-row-actions">
              {server.authMode === 'oauth' ? <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void run('auth-' + server.id, () => invoke('capabilities.mcp.authorize', { id: server.id }), 'MCP 授权已完成。')}><KeyRound data-icon="inline-start" />授权</Button> : null}
              <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void run('test-' + server.id, () => invoke('capabilities.mcp.test', { id: server.id }), 'MCP 连接正常。')}>测试</Button>
              <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void loadTools(server)}>工具</Button>
              <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void loadGrants(server)}>授权</Button>
              <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => editMcp(server)}>编辑</Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={'删除 ' + server.name} title="删除" disabled={Boolean(busy)} onClick={() => void run('remove-' + server.id, () => invoke('capabilities.mcp.remove', { id: server.id }), 'MCP 服务已删除。')}><Trash2 /></Button>
            </div>
            {tools[server.id]?.length ? <div className="capability-subsection"><strong>可用工具</strong><ul>{tools[server.id].map(tool => <li key={tool.name}><span>{tool.title || tool.name}</span><small>{tool.readOnly ? '只读' : '不可调用'}{tool.description ? ' · ' + tool.description : ''}</small></li>)}</ul></div> : null}
            {grants[server.id]?.length ? <div className="capability-subsection"><strong>工具授权</strong><ul>{grants[server.id].map(grant => <li key={grant.pluginId + grant.serverId}><span>{grant.pluginId}</span><small>{grant.toolNames.join('、')}</small><Button type="button" variant="ghost" size="icon-xs" aria-label="撤销授权" title="撤销授权" disabled={Boolean(busy)} onClick={() => void run('revoke-' + server.id + grant.pluginId, () => invoke('capabilities.mcp.revokeGrant', { pluginId: grant.pluginId, serverId: server.id }), '工具授权已撤销。')}><Trash2 /></Button></li>)}</ul></div> : null}
          </article>)}
          <form className="capability-form" onSubmit={event => void submitMcp(event)}>
            <div className="capability-form-head"><strong>{mcpEditing ? '编辑远程 MCP' : '添加远程 MCP'}</strong>{mcpEditing ? <Button type="button" variant="ghost" size="sm" onClick={() => { setMcpEditing(''); setMcpForm(mcpInitial); }}>取消编辑</Button> : null}</div>
            <FieldGroup>
              <Field><FieldLabel htmlFor="mcp-name">名称</FieldLabel><Input id="mcp-name" value={mcpForm.name} onChange={event => setMcpForm(value => ({ ...value, name: event.target.value }))} placeholder="例如：资料检索" disabled={!desktop || Boolean(busy)} /></Field>
              <Field><FieldLabel htmlFor="mcp-url">服务地址</FieldLabel><Input id="mcp-url" type="url" value={mcpForm.url} onChange={event => setMcpForm(value => ({ ...value, url: event.target.value }))} placeholder="https://example.com/mcp" disabled={!desktop || Boolean(busy)} /></Field>
              <Field><FieldLabel htmlFor="mcp-auth">鉴权</FieldLabel><select id="mcp-auth" className="capability-select" value={mcpForm.authMode} onChange={event => setMcpForm(value => ({ ...value, authMode: event.target.value }))} disabled={!desktop || Boolean(busy)}><option value="none">无鉴权</option><option value="bearer">API Key / Bearer</option><option value="oauth">OAuth 2.1</option></select></Field>
              {mcpForm.authMode === 'bearer' ? <><Field><FieldLabel htmlFor="mcp-header">请求头</FieldLabel><Input id="mcp-header" value={mcpForm.headerName} onChange={event => setMcpForm(value => ({ ...value, headerName: event.target.value }))} disabled={!desktop || Boolean(busy)} /></Field><Field><FieldLabel htmlFor="mcp-secret">密钥{mcpEditing ? '（留空保持不变）' : ''}</FieldLabel><Input id="mcp-secret" type="password" value={mcpForm.secret} onChange={event => setMcpForm(value => ({ ...value, secret: event.target.value }))} disabled={!desktop || Boolean(busy)} /></Field></> : null}
            </FieldGroup>
            <Button type="submit" disabled={!desktop || Boolean(busy) || !mcpForm.name.trim() || !mcpForm.url.trim()}>{mcpEditing ? '保存连接' : '添加连接'}</Button>
          </form>
        </section>
        <section className="capability-section" aria-labelledby="wechat-heading">
          <div className="capability-section-head"><div><h3 id="wechat-heading"><Link2 />公众号账号</h3><p>账号密钥只保存在本机系统凭据库，工具只会看到掩码。</p></div></div>
          {!loading && !accounts.length ? <p className="capability-empty">还没有添加公众号账号。</p> : null}
          {accounts.map(account => <article className="capability-row" key={account.id}>
            <div className="capability-row-main"><strong>{account.name}</strong><span>{account.appIdMasked}</span><small className={account.verified ? 'is-ok' : ''}>{account.verified ? '已验证' : '尚未验证'}</small></div>
            <div className="capability-row-actions"><Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void run('verify-' + account.id, () => invoke('capabilities.wechat.verify', { id: account.id }), '公众号连接正常。')}>验证</Button><Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => editWechat(account)}>编辑</Button><Button type="button" variant="ghost" size="icon-sm" aria-label={'删除 ' + account.name} title="删除" disabled={Boolean(busy)} onClick={() => void run('remove-' + account.id, () => invoke('capabilities.wechat.remove', { id: account.id }), '公众号账号已删除。')}><Trash2 /></Button></div>
          </article>)}
          <form className="capability-form" onSubmit={event => void submitWechat(event)}>
            <div className="capability-form-head"><strong>{wechatEditing ? '编辑公众号' : '添加公众号'}</strong>{wechatEditing ? <Button type="button" variant="ghost" size="sm" onClick={() => { setWechatEditing(''); setWechatForm(wechatInitial); }}>取消编辑</Button> : null}</div>
            <FieldGroup>
              <Field><FieldLabel htmlFor="wechat-name">显示名称</FieldLabel><Input id="wechat-name" value={wechatForm.name} onChange={event => setWechatForm(value => ({ ...value, name: event.target.value }))} placeholder="例如：产品公众号" disabled={!desktop || Boolean(busy)} /></Field>
              <Field><FieldLabel htmlFor="wechat-appid">AppID</FieldLabel><Input id="wechat-appid" value={wechatForm.appId} onChange={event => setWechatForm(value => ({ ...value, appId: event.target.value }))} disabled={!desktop || Boolean(busy)} /></Field>
              <Field><FieldLabel htmlFor="wechat-secret">AppSecret{wechatEditing ? '（留空保持不变）' : ''}</FieldLabel><Input id="wechat-secret" type="password" value={wechatForm.appSecret} onChange={event => setWechatForm(value => ({ ...value, appSecret: event.target.value }))} disabled={!desktop || Boolean(busy)} /></Field>
            </FieldGroup>
            <Button type="submit" disabled={!desktop || Boolean(busy) || !wechatForm.name.trim() || (!wechatEditing && !wechatForm.appId.trim())}>{wechatEditing ? '保存公众号' : '添加公众号'}</Button>
          </form>
        </section>
      </CardContent>
    </Card>
  </>;
}
