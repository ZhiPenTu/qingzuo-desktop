import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import Platform from './Platform';
import type { Plugin, ToolEntry } from './PluginCard';
import type { PluginInstallState } from './commerce';

vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light', setTheme: vi.fn() }) }));
const entry: ToolEntry = { id: 'official.labeledit', title: 'LabelEdit', description: '本地 PDF 标签编辑', category: '标签与文档', version: '0.2.0' };
const installed: Plugin = { ...entry, version: '0.1.0', enabled: true, source: 'market', local: false, missing: [] };
const job = (status: PluginInstallState['status'], extra: Partial<PluginInstallState> = {}): PluginInstallState => ({ id: entry.id, version: entry.version, status, progress: null, transferred: 0, total: 0, error: null, ...extra });

function fixture(initialJob?: PluginInstallState, hasPlugin = true, migration = false) {
  let listener = () => {};
  let plugins = hasPlugin ? [installed] : [];
  let pluginInstalls = initialJob ? [initialJob] : [];
  let downloadSource = { source: 'github', customMirrors: [] as string[], gitcodeAvailable: true, notice: null as string | null };
  const invoke = vi.fn(async (method: string, args?: unknown) => {
    if (method === 'status') return structuredClone({ version: '0.3.1', kernel: { ready: true, error: null, version: '0.2.1-alpha.1', systems: [] }, plugins, pluginInstalls, downloadSource, migration: migration ? { id: entry.id, title: entry.title, enabled: false } : null, tabs: [], update: { status: 'idle', version: null, notes: '', error: null, progress: 0, transferred: 0, total: 0 } });
    if (method === 'downloadSource.set') {
      const next = (args as { source: string }).source;
      downloadSource = { ...downloadSource, source: next, notice: null };
      listener();
      return downloadSource;
    }
    if (method === 'downloadSource.addCustomMirror') {
      const raw = (args as { url: string }).url.trim().replace(/\/+$/, '') + '/';
      const customMirrors = downloadSource.customMirrors.includes(raw) ? downloadSource.customMirrors : [...downloadSource.customMirrors, raw];
      downloadSource = { ...downloadSource, source: `custom:${raw}`, customMirrors, notice: null };
      listener();
      return downloadSource;
    }
    if (method === 'downloadSource.removeCustomMirror') {
      const raw = (args as { url: string }).url;
      const customMirrors = downloadSource.customMirrors.filter(item => item !== raw);
      const source = downloadSource.source === `custom:${raw}` ? 'github' : downloadSource.source;
      downloadSource = { ...downloadSource, source, customMirrors, notice: null };
      listener();
      return downloadSource;
    }
    if (method === 'market.list') return { items: [entry] };
    if (method === 'market.install') { pluginInstalls = [job('downloading', { progress: 40, transferred: 4 * 1024 ** 2, total: 10 * 1024 ** 2 })]; listener(); return { accepted: true }; }
    return {};
  });
  window.commerceDesktop = { invoke, onChanged: callback => { listener = callback; return () => { listener = () => {}; }; } } as NonNullable<Window['commerceDesktop']>;
  return { invoke, emit: (install: PluginInstallState, nextPlugins = plugins) => act(() => { pluginInstalls = [install]; plugins = nextPlugins; listener(); }) };
}
async function navigate(name: string) { fireEvent.click(screen.getByRole('button', { name })); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete window.commerceDesktop; });

it('keeps backend progress after acknowledgment, restores it across pages, and completes on the installed state', async () => {
  const { invoke, emit } = fixture();
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });
  await navigate('插件市场');
  fireEvent.click(await screen.findByRole('button', { name: '更新插件' }));
  fireEvent.click(screen.getByRole('button', { name: '更新插件' }));
  await screen.findByText('正在下载新版本… 40%');
  expect(screen.getByRole('button', { name: '更新插件' }).hasAttribute('disabled')).toBe(true);
  expect(invoke.mock.calls.filter(([method]) => method === 'market.install')).toHaveLength(1);
  await waitFor(() => expect(screen.getByRole('button', { name: '导入插件' }).hasAttribute('disabled')).toBe(false));
  await navigate('工具中心');
  await screen.findByText('正在下载新版本… 40%');
  expect(screen.getByRole('button', { name: '打开工具' }).hasAttribute('disabled')).toBe(true);
  await navigate('插件管理');
  await screen.findByText('正在下载新版本… 40%');
  expect(screen.getByRole('button', { name: '卸载' }).hasAttribute('disabled')).toBe(true);
  emit(job('verifying')); await screen.findByText('正在校验插件签名…');
  emit(job('installing')); await screen.findByText('正在安装新版本…');
  emit(job('syncing')); await screen.findByText('正在刷新工具…');
  await navigate('插件市场');
  await screen.findByText('正在刷新工具…');
  emit(job('installed', { progress: 100 }), [{ ...installed, version: entry.version }]);
  await screen.findByText('安装完成 · v0.2.0');
  expect(screen.getByRole('button', { name: '已安装' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('progressbar')).toBeNull();
  await navigate('工具中心');
  await screen.findByText('v0.2.0 · 已启用 · 市场签名验证');
  expect(screen.getByRole('button', { name: '打开工具' }).hasAttribute('disabled')).toBe(false);
  emit(job('installed', { progress: 100 }), [installed]);
  await screen.findByText('v0.1.0 · 已启用 · 市场签名验证');
  expect(screen.queryByText('安装完成 · v0.2.0')).toBeNull();
  emit(job('installed', { progress: 100 }), []);
  await navigate('插件市场');
  await screen.findByRole('button', { name: '安装插件' });
  expect(screen.queryByText('安装完成 · v0.2.0')).toBeNull();
});

it('restores an existing background installation and retries its specific error', async () => {
  const { invoke, emit } = fixture(job('downloading', { progress: null, transferred: 1024 ** 2 }), false);
  render(<Platform />);
  await screen.findByText('Harness 内核已连接');
  await navigate('插件市场');
  await screen.findByText('正在下载插件…');
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  expect(screen.getByText('1.0 MB')).toBeTruthy();
  expect(screen.getByRole('button', { name: '安装插件' }).hasAttribute('disabled')).toBe(true);
  expect(invoke.mock.calls.some(([method]) => method === 'market.install')).toBe(false);
  emit(job('error', { error: '插件下载失败：连接已断开' }));
  await screen.findByText('插件下载失败：连接已断开');
  fireEvent.click(screen.getByRole('button', { name: '重试安装' }));
  await screen.findByText('正在下载插件… 40%');
  expect(screen.queryByText('插件下载失败：连接已断开')).toBeNull();
  expect(invoke.mock.calls.filter(([method]) => method === 'market.install')).toHaveLength(1);
});

it('shows offline recovery failures on the empty home and retries from the migration banner', async () => {
  const { invoke, emit } = fixture(undefined, false, true);
  render(<Platform />);
  fireEvent.click(await screen.findByRole('button', { name: '恢复 LabelEdit' }));
  await screen.findByText('正在下载插件… 40%');
  emit(job('error', { error: 'offline：插件目录无法连接' }));
  await screen.findByText('offline：插件目录无法连接');
  expect(screen.getByRole('alert').textContent).toContain('offline：插件目录无法连接');
  expect(screen.queryByRole('heading', { name: 'LabelEdit' })).toBeNull();
  const restore = screen.getByRole('button', { name: '恢复 LabelEdit' });
  expect(restore.hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('button', { name: '稍后从市场安装' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(restore);
  await screen.findByText('正在下载插件… 40%');
  expect(screen.queryByText('offline：插件目录无法连接')).toBeNull();
  expect(invoke.mock.calls.filter(([method]) => method === 'market.install')).toHaveLength(2);
});

it('keeps background recovery progress visible without installed plugins and prevents pending dismissal', async () => {
  const { invoke, emit } = fixture(job('downloading', { progress: 40, transferred: 4 * 1024 ** 2, total: 10 * 1024 ** 2 }), false, true);
  render(<Platform />);
  await screen.findByText('正在下载插件… 40%');
  expect(screen.getByRole('progressbar', { name: 'LabelEdit 恢复进度' }).getAttribute('aria-valuenow')).toBe('40');
  expect(screen.getByText('4.0 MB / 10.0 MB')).toBeTruthy();
  for (const name of ['恢复 LabelEdit', '稍后从市场安装']) {
    const button = screen.getByRole('button', { name });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
  }
  expect(invoke.mock.calls.some(([method]) => method === 'market.install' || method === 'migration.dismiss')).toBe(false);
  emit(job('verifying')); await screen.findByText('正在校验插件签名…');
  expect(screen.getByRole('progressbar', { name: 'LabelEdit 恢复进度' }).hasAttribute('aria-valuenow')).toBe(false);
  emit(job('installing')); await screen.findByText('正在安装插件…');
  emit(job('syncing')); await screen.findByText('正在刷新工具…');
  expect(screen.getByRole('button', { name: '恢复 LabelEdit' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '稍后从市场安装' }).hasAttribute('disabled')).toBe(true);
});

it('shows runtime component versions and routes Harness checks to app updates', async () => {
  const { invoke } = fixture();
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });
  expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
  await navigate('设置');
  await screen.findByRole('heading', { name: '运行环境' });
  await screen.findByRole('heading', { name: '轻作更新' });
  expect(screen.getByText('v0.2.1-alpha.1')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '检查代理更新' })).toBeNull();
  expect(screen.getByText('DeepSeek Harness 随轻作版本发布，当前运行时不会单独替换。')).toBeTruthy();

  expect(screen.queryByRole('button', { name: '检查轻作更新' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
  await waitFor(() => expect(invoke.mock.calls.filter(([method]) => method === 'updates.check')).toHaveLength(1));

  const sourceSelect = screen.getByRole('combobox', { name: '切换下载源' }) as HTMLSelectElement;
  expect(sourceSelect.value).toBe('github');
  fireEvent.change(sourceSelect, { target: { value: 'gh-proxy' } });
  await waitFor(() => expect(sourceSelect.value).toBe('gh-proxy'));

  fireEvent.click(screen.getByRole('button', { name: '添加自定义源' }));
  await screen.findByRole('dialog', { name: '添加自定义下载源' });
  const mirrorInput = screen.getByLabelText('镜像前缀，例如 https://mirror.example.com/');
  fireEvent.change(mirrorInput, { target: { value: 'https://mirror.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '添加并切换' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加自定义下载源' })).toBeNull());
  expect(sourceSelect.value).toBe('custom:https://mirror.example.com/');
  expect(screen.getByRole('option', { name: '自定义镜像 · mirror.example.com' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '添加自定义源' }));
  await screen.findByText('已添加的自定义源');
  fireEvent.click(screen.getByRole('button', { name: '删除自定义源' }));
  await waitFor(() => expect(sourceSelect.value).toBe('github'));
});

it('strips Electron IPC remote-method prefixes and translates raw ADM-ZIP import errors', async () => {
  const { invoke } = fixture();
  const baseImpl = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method: string) => {
    if (method === 'plugins.import') throw new Error("Error invoking remote method 'commerce:platform': Error: ADM-ZIP: Invalid or unsupported zip format. No END header found");
    return baseImpl(method);
  });
  render(<Platform />);
  fireEvent.click(await screen.findByRole('button', { name: '导入插件' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('插件包格式无效或文件未下载完整');
  expect(alert.textContent).not.toContain('Error invoking remote method');
  expect(alert.textContent).not.toContain('ADM-ZIP');
});
