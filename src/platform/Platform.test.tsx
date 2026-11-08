import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import Platform from './Platform';
import type { Plugin, ToolEntry } from './PluginCard';
import type { BrowserStatus, PluginInstallState } from './commerce';

vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light', setTheme: vi.fn() }) }));
const entry: ToolEntry = { id: 'official.labeledit', title: 'LabelEdit', description: '本地 PDF 标签编辑', category: '标签与文档', version: '0.2.0', tier: 'official' };
const communityEntry: ToolEntry = { id: 'community.tool', title: '社区工具', description: '社区开发的效率工具', category: '效率工具', version: '1.0.0', tier: 'community' };
const bundled: Plugin = { id: 'builtin.tool', title: '内置工具', description: '随应用提供的基础工具', category: '效率工具', version: '1.0.0', tier: 'platform', enabled: true, source: 'bundled', local: false, missing: [] };
const installed: Plugin = { ...entry, version: '0.1.0', enabled: true, source: 'market', local: false, missing: [] };
const diagnostics: Plugin = { id: 'official.diagnostics', title: '日志调试', description: '查看运行日志', category: '开发工具', version: '0.1.0', tier: 'platform', enabled: true, source: 'market', local: false, missing: [] };
const aiAssistant: Plugin = { id: 'official.ai-assistant', title: 'AI 助手', description: '文本与图像服务', category: 'AI', version: '0.1.0', tier: 'platform', enabled: true, source: 'market', local: false, missing: [], settings: { title: 'AI 设置' } };
const job = (status: PluginInstallState['status'], extra: Partial<PluginInstallState> = {}): PluginInstallState => ({ id: entry.id, version: entry.version, status, progress: null, transferred: 0, total: 0, error: null, ...extra });

function fixture(initialJob?: PluginInstallState, hasPlugin = true, migration = false, initialTabs: string[] = [], browser?: BrowserStatus, options: { marketItems?: ToolEntry[]; plugins?: Plugin[] } = {}) {
  let listener = () => {};
  let debugListener = (_entries: import('./commerce').DebugLogEntry[]) => {};
  let plugins = options.plugins ?? (hasPlugin ? [installed] : []);
  let pluginInstalls = initialJob ? [initialJob] : [];
  let debugLog = { enabled: false, directory: '/tmp/qingzuo-logs', maxBytes: 50 * 1024 ** 2, currentFile: null, storedBytes: 0, lastError: null };
  let downloadSource = { source: 'github', customMirrors: [] as string[], gitcodeAvailable: true, notice: null as string | null };
  let updatePreferences = { autoUpdate: true };
  let update = { status: 'idle', version: null as string | null, notes: '', error: null as string | null, progress: 0, transferred: 0, total: 0, downloaded: false };
  const invoke = vi.fn(async (method: string, args?: unknown) => {
    if (method === 'status') return structuredClone({ version: '0.3.1', kernel: { ready: true, error: null, version: '0.2.1-alpha.1', systems: [] }, plugins, pluginInstalls, downloadSource, debugLog, updatePreferences, migration: migration ? { id: entry.id, title: entry.title, enabled: false } : null, tabs: initialTabs, ...(browser ? { browser } : {}), update });
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
    if (method === 'market.list') return { items: options.marketItems ?? [entry] };
    if (method === 'market.install') { pluginInstalls = [job('downloading', { progress: 40, transferred: 4 * 1024 ** 2, total: 10 * 1024 ** 2 })]; listener(); return { accepted: true }; }
    if (method === 'debugLog.recent') return [];
    if (method === 'debugLog.configure') {
      const update = args as { enabled?: boolean; maxBytes?: number };
      debugLog = { ...debugLog, ...update };
      listener();
      return structuredClone(debugLog);
    }
    if (method === 'debugLog.chooseDirectory') {
      debugLog = { ...debugLog, directory: '/tmp/qingzuo-logs/chosen' };
      listener();
      return { canceled: false, debugLog: structuredClone(debugLog) };
    }
    if (method === 'debugLog.openDirectory') return true;
    if (method === 'debugLog.revokePluginAccess') return { revoked: true };
    if (method === 'updates.configure') {
      updatePreferences = { autoUpdate: (args as { autoUpdate: boolean }).autoUpdate };
      listener();
      return structuredClone(updatePreferences);
    }
    return {};
  });
  window.commerceDesktop = { invoke, onChanged: callback => { listener = callback; return () => { listener = () => {}; }; }, onDebugLog: callback => { debugListener = callback; return () => { debugListener = () => {}; }; } } as NonNullable<Window['commerceDesktop']>;
  return { invoke, emit: (install: PluginInstallState, nextPlugins = plugins) => act(() => { pluginInstalls = [install]; plugins = nextPlugins; listener(); }), emitUpdate: (next: Partial<typeof update>) => act(() => { update = { ...update, ...next }; listener(); }), emitDebug: (entries: import('./commerce').DebugLogEntry[]) => act(() => debugListener(entries)) };
}
async function navigate(name: string) { fireEvent.click(screen.getByRole('button', { name })); }
async function openToolTab(name: '已安装' | '全部') { fireEvent.click(await screen.findByRole('tab', { name })); }
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.removeItem('qingzuo.sidebarCollapsed');
  window.localStorage.removeItem('qingzuo.browserPaneRatio');
  window.localStorage.removeItem('qingzuo.browserPaneWidth');
  delete window.commerceDesktop;
});

it('merges installed tools and the catalog into one page with two tabs', async () => {
  fixture();
  render(<Platform />);
  await screen.findByRole('heading', { name: '工具中心' });

  expect(screen.queryByRole('button', { name: '插件市场' })).toBeNull();
  expect(screen.queryByRole('button', { name: '插件管理' })).toBeNull();
  expect(screen.getByRole('tablist', { name: '工具视图' }).querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(screen.getByRole('tab', { name: '已安装' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('button', { name: '管理' })).toBeTruthy();

  await openToolTab('全部');
  expect(screen.getByRole('tab', { name: '全部' }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByRole('button', { name: '导入插件' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'LabelEdit' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '打开' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '已安装' })).toBeNull();

  await openToolTab('已安装');
  expect(screen.getByRole('tab', { name: '已安装' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('button', { name: '管理' })).toBeTruthy();
});

it('filters the catalog with one platform, official and community trust group', async () => {
  fixture(undefined, false, false, [], undefined, { marketItems: [entry, communityEntry], plugins: [bundled] });
  render(<Platform />);
  await screen.findByRole('heading', { name: '内置工具' });
  await openToolTab('全部');

  const tierFilter = await screen.findByRole('combobox', { name: '按来源筛选' });
  expect(within(tierFilter).getAllByRole('option').map(option => option.textContent)).toEqual(['全部（3）', '底座内置（1）', '官方社区（1）', '第三方（1）']);
  expect(screen.queryByRole('group', { name: '按发布者筛选' })).toBeNull();

  fireEvent.change(tierFilter, { target: { value: 'platform' } });
  await screen.findByRole('heading', { name: '内置工具' });
  expect(screen.queryByRole('heading', { name: 'LabelEdit' })).toBeNull();

  fireEvent.change(screen.getByRole('combobox', { name: '按来源筛选' }), { target: { value: 'community' } });
  await screen.findByRole('heading', { name: '社区工具' });
  expect(screen.queryByRole('heading', { name: 'LabelEdit' })).toBeNull();

  fireEvent.change(screen.getByRole('combobox', { name: '按来源筛选' }), { target: { value: 'official' } });
  await screen.findByRole('heading', { name: 'LabelEdit' });
  expect(screen.queryByRole('heading', { name: '社区工具' })).toBeNull();
});

it('filters the catalog by type and clears the filter', async () => {
  fixture(undefined, false, false, [], undefined, { marketItems: [entry, communityEntry], plugins: [installed] });
  render(<Platform />);
  await openToolTab('全部');

  const typeFilter = await screen.findByRole('combobox', { name: '按功能分类筛选' });
  expect(within(typeFilter).getAllByRole('option').map(option => option.textContent)).toEqual(['全部', '标签与文档', '效率工具']);

  fireEvent.change(typeFilter, { target: { value: '效率工具' } });
  await screen.findByRole('heading', { name: '社区工具' });
  expect(screen.queryByRole('heading', { name: 'LabelEdit' })).toBeNull();
  expect(screen.getByText('找到 1 个')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
  await screen.findByRole('heading', { name: 'LabelEdit' });
  expect(screen.queryByText(/找到 \d+ 个/)).toBeNull();
  expect((screen.getByRole('combobox', { name: '按功能分类筛选' }) as HTMLSelectElement).value).toBe('all');
});

it('labels bundled installations separately from their platform trust tier', async () => {
  fixture(undefined, false, false, [], undefined, { plugins: [bundled] });
  render(<Platform />);
  await screen.findByRole('heading', { name: '内置工具' });
  expect(screen.getByText('底座内置')).toBeTruthy();
  expect(screen.getByText('随应用内置')).toBeTruthy();
});

it('keeps installed identity and source separate from the same-id market catalog entry', async () => {
  const local: Plugin = { ...entry, title: '安装标题', icon: 'data:image/png;base64,iVBORw0KGgo=', tier: 'community', source: 'local', version: '0.1.0', enabled: true, local: true, missing: [] };
  fixture(undefined, true, false, [], undefined, {
    plugins: [local],
    marketItems: [{ ...entry, title: '市场标题', icon: 'data:image/png;base64,iVBORw0KGgoAAA==' }],
  });
  render(<Platform />);
  await screen.findByRole('heading', { name: '安装标题' });
  expect(screen.getByText('第三方')).toBeTruthy();
  expect(screen.getByText('本地导入')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '市场标题' })).toBeNull();

  await openToolTab('全部');
  await screen.findByRole('heading', { name: '市场标题' });
  expect(screen.getByText('本地已安装')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '打开' })).toBeNull();
  expect(screen.queryByRole('button', { name: '更新插件' })).toBeNull();
  await openToolTab('已安装');
  await screen.findByRole('heading', { name: '安装标题' });
  expect(screen.getByText('本地导入')).toBeTruthy();
});

it('keeps backend progress after acknowledgment, restores it across tabs, and completes on the installed state', async () => {
  const { invoke, emit } = fixture();
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });
  await openToolTab('全部');
  fireEvent.click(await screen.findByRole('button', { name: '更新插件' }));
  fireEvent.click(screen.getByRole('button', { name: '更新插件' }));
  await screen.findByText('正在下载新版本… 40%');
  expect(screen.getByRole('button', { name: '更新插件' }).hasAttribute('disabled')).toBe(true);
  expect(invoke.mock.calls.filter(([method]) => method === 'market.install')).toHaveLength(1);
  await waitFor(() => expect(screen.getByRole('button', { name: '导入插件' }).hasAttribute('disabled')).toBe(false));
  await openToolTab('已安装');
  await screen.findByText('正在下载新版本… 40%');
  expect(screen.getByRole('button', { name: '打开' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '管理' }).hasAttribute('disabled')).toBe(true);
  emit(job('verifying')); await screen.findByText('正在校验插件包…');
  emit(job('installing')); await screen.findByText('正在安装新版本…');
  emit(job('syncing')); await screen.findByText('正在刷新工具…');
  await openToolTab('全部');
  await screen.findByText('正在刷新工具…');
  emit(job('installed', { progress: 100 }), [{ ...installed, version: entry.version }]);
  await screen.findByText('安装完成 · v0.2.0');
  expect(screen.queryByRole('button', { name: '已安装' })).toBeNull();
  expect(screen.getByRole('button', { name: '打开' }).hasAttribute('disabled')).toBe(false);
  expect(screen.queryByRole('progressbar')).toBeNull();
  await openToolTab('已安装');
  await screen.findByText('v0.2.0');
  expect(screen.getByText('已启用')).toBeTruthy();
  expect(screen.getByText('市场安装')).toBeTruthy();
  expect(screen.getByRole('button', { name: '打开' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '管理' }));
  expect(screen.getByRole('button', { name: '卸载' })).toBeTruthy();
  emit(job('installed', { progress: 100 }), [installed]);
  await screen.findByText('v0.1.0');
  expect(screen.queryByText('安装完成 · v0.2.0')).toBeNull();
  emit(job('installed', { progress: 100 }), []);
  await openToolTab('全部');
  await screen.findByRole('button', { name: '安装插件' });
  expect(screen.queryByText('安装完成 · v0.2.0')).toBeNull();
});

it('restores an existing background installation and retries its specific error', async () => {
  const { invoke, emit } = fixture(job('downloading', { progress: null, transferred: 1024 ** 2 }), false);
  render(<Platform />);
  await screen.findByText('工具服务已就绪');
  await openToolTab('全部');
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
  emit(job('verifying')); await screen.findByText('正在校验插件包…');
  expect(screen.getByRole('progressbar', { name: 'LabelEdit 恢复进度' }).hasAttribute('aria-valuenow')).toBe(false);
  emit(job('installing')); await screen.findByText('正在安装插件…');
  emit(job('syncing')); await screen.findByText('正在刷新工具…');
  expect(screen.getByRole('button', { name: '恢复 LabelEdit' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '稍后从市场安装' }).hasAttribute('disabled')).toBe(true);
});

it('shows the app version and routes every runtime check to app updates', async () => {
  const { invoke } = fixture();
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });
  expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
  await navigate('设置');
  await screen.findByRole('heading', { name: '关于轻作' });
  await screen.findByRole('heading', { name: '轻作更新' });
  expect(screen.getByText('尚未检查更新')).toBeTruthy();
  expect(document.querySelector('.runtime-update-version')?.textContent).toBe('v0.3.1');
  expect(screen.queryByRole('button', { name: '检查代理更新' })).toBeNull();
  expect(screen.queryByText(/Harness/)).toBeNull();
  expect(screen.queryByText('下载完成后将自动安装并重启，请先保存正在编辑的文件。')).toBeNull();

  expect(screen.queryByRole('button', { name: '检查轻作更新' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '清理更新缓存' }));
  await waitFor(() => expect(invoke.mock.calls.filter(([method]) => method === 'updates.cleanCache')).toHaveLength(1));

  fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
  await waitFor(() => expect(invoke.mock.calls.filter(([method]) => method === 'updates.check')).toHaveLength(1));

  const sourceSelect = screen.getByRole('combobox', { name: '切换下载源' }) as HTMLSelectElement;
  expect(sourceSelect.value).toBe('github');
  fireEvent.change(sourceSelect, { target: { value: 'gh-proxy' } });
  await waitFor(() => expect(sourceSelect.value).toBe('gh-proxy'));

  fireEvent.click(screen.getByRole('button', { name: '添加自定义源' }));
  await screen.findByRole('dialog', { name: '添加自定义下载源' });
  const mirrorInput = screen.getByLabelText('镜像站地址，例如 https://mirror.example.com/');
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

it('persists the automatic update switch and waits for user confirmation before installing', async () => {
  const { invoke, emitUpdate } = fixture();
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });
  await navigate('设置');

  const autoUpdate = await screen.findByRole('switch', { name: '关闭自动更新' });
  expect(autoUpdate.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(autoUpdate);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('updates.configure', { autoUpdate: false }));
  await screen.findByRole('switch', { name: '开启自动更新' });

  emitUpdate({ status: 'available', version: '0.6.17' });
  await screen.findByText('新版本 v0.6.17');
  await screen.findByText('下载完成后由你选择何时重新启动；正在编辑的文件不会受影响。');
  fireEvent.click(screen.getByRole('button', { name: '下载更新' }));
  await waitFor(() => expect(invoke.mock.calls.filter(([method]) => method === 'updates.download')).toHaveLength(1));

  emitUpdate({ status: 'ready', version: '0.6.17', progress: 100, downloaded: true });
  await screen.findByText('更新已下载，等待重启');
  expect(screen.getByRole('button', { name: '检查更新' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '清理更新缓存' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '重新启动并更新' }));
  await waitFor(() => expect(invoke.mock.calls.filter(([method]) => method === 'updates.install')).toHaveLength(1));
});

it('keeps log controls in settings and opens the trusted diagnostics plugin from the sidebar', async () => {
  const { invoke } = fixture(undefined, true, false, [], undefined, { plugins: [installed, diagnostics] });
  render(<Platform />);
  await navigate('设置');
  await screen.findByRole('heading', { name: '按你的习惯，轻松工作。' });

  const toggle = await screen.findByRole('switch', { name: '开启日志调试' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('button', { name: '日志调试' })).toBeTruthy();

  fireEvent.click(toggle);
  await screen.findByRole('switch', { name: '关闭日志调试' });
  expect(invoke.mock.calls.some(([method, args]) => method === 'debugLog.configure' && (args as { enabled?: boolean }).enabled === true)).toBe(true);

  const size = screen.getByLabelText('最大保存大小') as HTMLSelectElement;
  fireEvent.change(size, { target: { value: '100' } });
  await waitFor(() => expect(invoke.mock.calls.some(([method, args]) => method === 'debugLog.configure' && (args as { maxBytes?: number }).maxBytes === 100 * 1024 ** 2)).toBe(true));

  fireEvent.click(screen.getByRole('button', { name: '更改目录' }));
  await screen.findByText('/tmp/qingzuo-logs/chosen');
  fireEvent.click(screen.getByRole('button', { name: '打开目录' }));
  await waitFor(() => expect(invoke.mock.calls.some(([method]) => method === 'debugLog.openDirectory')).toBe(true));

  fireEvent.click(screen.getByRole('button', { name: '撤销日志访问' }));
  await screen.findByText('日志访问授权已撤销，查看器下次读取时会重新询问。');
  expect(invoke.mock.calls.some(([method, args]) => method === 'debugLog.revokePluginAccess' && (args as { pluginId?: string }).pluginId === 'official.diagnostics')).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: '日志调试' }));
  await waitFor(() => expect(invoke.mock.calls.some(([method, args]) => method === 'view.open' && (args as { id?: string }).id === 'official.diagnostics')).toBe(true));
});

it('offers AI and diagnostics market installs without creating shell pages', async () => {
  const { invoke } = fixture(undefined, false);
  render(<Platform />);
  await navigate('设置');
  await screen.findByRole('heading', { name: '按你的习惯，轻松工作。' });

  expect(screen.queryByRole('button', { name: 'AI 对话' })).toBeNull();
  expect(screen.queryByRole('button', { name: '日志调试' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '从市场安装' }));
  await waitFor(() => expect(invoke.mock.calls.some(([method, args]) => method === 'market.install' && (args as { id?: string }).id === 'official.ai-assistant')).toBe(true));

  fireEvent.click(screen.getByRole('button', { name: '从市场安装日志查看器' }));
  await waitFor(() => expect(invoke.mock.calls.some(([method, args]) => method === 'market.install' && (args as { id?: string }).id === 'official.diagnostics')).toBe(true));
});

it('hides first-party entry points for local installations and opens installed AI settings', async () => {
  const localAI: Plugin = { ...aiAssistant, source: 'local', tier: 'community' };
  const disabledDiagnostics: Plugin = { ...diagnostics, enabled: false };
  fixture(undefined, true, false, [], undefined, { plugins: [installed, localAI, disabledDiagnostics] });
  render(<Platform />);
  await navigate('设置');
  await screen.findByRole('heading', { name: '按你的习惯，轻松工作。' });

  expect(screen.queryByRole('button', { name: 'AI 对话' })).toBeNull();
  expect(screen.queryByRole('button', { name: '日志调试' })).toBeNull();
  expect(screen.getByRole('button', { name: 'AI 服务暂不可用' }).hasAttribute('disabled')).toBe(true);

  cleanup();
  const second = fixture(undefined, true, false, [], undefined, { plugins: [installed, aiAssistant] });
  render(<Platform />);
  await screen.findByRole('heading', { name: '工具中心' });
  await navigate('设置');
  await screen.findByRole('heading', { name: '按你的习惯，轻松工作。' });
  fireEvent.click(screen.getByRole('button', { name: '打开 AI 设置' }));
  await waitFor(() => expect(second.invoke.mock.calls.some(([method, args]) => method === 'view.open' && (args as { id?: string; settings?: boolean }).id === 'official.ai-assistant' && (args as { settings?: boolean }).settings === true)).toBe(true));
});

it('checks plugin versions on demand and offers the update from installed tools', async () => {
  const { invoke } = fixture();
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });
  await screen.findByRole('heading', { name: '工具中心' });
  expect(screen.queryByText('检查插件是否有新版本')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '检查插件更新' }));
  await screen.findByText('发现 1 个插件更新');
  expect(document.querySelector('.plugin-state .is-update')?.textContent).toBe('可更新到 v0.2.0');
  fireEvent.click(screen.getByRole('button', { name: '更新插件' }));
  await waitFor(() => expect(invoke.mock.calls.filter(([method]) => method === 'market.install')).toHaveLength(1));
});

it('strips Electron IPC remote-method prefixes and translates raw ADM-ZIP import errors', async () => {
  const { invoke } = fixture();
  const baseImpl = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method: string) => {
    if (method === 'plugins.import') throw new Error("Error invoking remote method 'commerce:platform': Error: ADM-ZIP: Invalid or unsupported zip format. No END header found");
    return baseImpl(method);
  });
  render(<Platform />);
  await openToolTab('全部');
  fireEvent.click(await screen.findByRole('button', { name: '导入插件' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('插件包格式无效或文件未下载完整');
  expect(alert.textContent).not.toContain('Error invoking remote method');
  expect(alert.textContent).not.toContain('ADM-ZIP');
});

it('renders workspace tabs without a duplicate page title bar', async () => {
  const { invoke } = fixture(undefined, true, false, ['official.labeledit']);
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });

  expect(document.querySelector('.commerce-breadcrumb')).toBeNull();
  expect(document.querySelector('.commerce-topbar')).toBeNull();

  const tablist = screen.getByRole('tablist', { name: '已打开的工具' });
  expect(tablist).toBeTruthy();

  const shellTab = screen.getByRole('tab', { name: '工具中心' });
  expect(shellTab.getAttribute('aria-selected')).toBe('true');

  const toolTab = screen.getByRole('tab', { name: 'LabelEdit' });
  expect(toolTab.getAttribute('aria-selected')).toBe('false');
  expect(toolTab.querySelector('img.commerce-tab-icon-image')).toBeTruthy();

  await navigate('设置');
  const settingsShellTab = await screen.findByRole('tab', { name: '设置' });
  expect(settingsShellTab.getAttribute('aria-selected')).toBe('true');
  expect(settingsShellTab.querySelector('img.commerce-tab-icon-image')).toBeNull();

  fireEvent.click(toolTab);
  await waitFor(() => expect(toolTab.getAttribute('aria-selected')).toBe('true'));
  expect(settingsShellTab.getAttribute('aria-selected')).toBe('false');
  expect(settingsShellTab.textContent).toBe('设置');

  const closeBtn = screen.getByRole('button', { name: '关闭工具' });
  fireEvent.click(closeBtn);
  await waitFor(() => expect(invoke.mock.calls.filter(([method]) => method === 'view.close')).toHaveLength(1));
});

it('keeps the sidebar toggle in the topbar and switches its accessible state', async () => {
  fixture();
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });

  const collapseButton = screen.getByRole('button', { name: '收起侧边栏' });
  expect(collapseButton.closest('aside')).toBeNull();
  expect(collapseButton.closest('.commerce-windowbar')).toBeTruthy();

  fireEvent.click(collapseButton);
  const expandButton = await screen.findByRole('button', { name: '展开侧边栏' });
  expect(expandButton.closest('.commerce-windowbar')).toBeTruthy();
  expect(expandButton.getAttribute('aria-expanded')).toBe('false');
});


it('restores the browser pane ratio from storage and clears it on double-click', async () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 1920;
  try {
    window.localStorage.setItem('qingzuo.browserPaneRatio', '0.5');
    const browser: BrowserStatus = { open: true, activeTabId: 'browser-1', candidates: [], downloads: [], tabs: [{ id: 'browser-1', title: '新标签页', url: '', loading: false, canGoBack: false, canGoForward: false }] };
    fixture(undefined, true, false, [], browser);
    render(<Platform />);
    fireEvent.click(await screen.findByRole('button', { name: '打开浏览器面板' }));
    await screen.findByRole('tablist', { name: '浏览器标签页' });
    const pane = document.querySelector<HTMLElement>('.commerce-browser-pane');
    expect(pane).toBeTruthy();
    expect(pane?.style.flexBasis).toBe('856px');

    const resizer = screen.getByRole('separator', { name: '调整浏览器面板宽度' });
    expect(resizer.getAttribute('aria-valuenow')).toBe('856');

    fireEvent.doubleClick(resizer);
    expect(pane?.style.flexBasis).toBe('');
    expect(window.localStorage.getItem('qingzuo.browserPaneRatio')).toBeNull();
    expect(window.localStorage.getItem('qingzuo.browserPaneWidth')).toBeNull();
  } finally {
    window.innerWidth = originalWidth;
  }
});

it('scales the browser pane proportionally when the window or sidebar size changes', async () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 1280;
  try {
    window.localStorage.setItem('qingzuo.browserPaneRatio', '0.5');
    window.localStorage.setItem('qingzuo.browserPaneWidth', '980');
    const browser: BrowserStatus = { open: true, activeTabId: 'browser-1', candidates: [], downloads: [], tabs: [{ id: 'browser-1', title: '新标签页', url: '', loading: false, canGoBack: false, canGoForward: false }] };
    fixture(undefined, true, false, [], browser);
    render(<Platform />);
    fireEvent.click(await screen.findByRole('button', { name: '打开浏览器面板' }));
    await screen.findByRole('tablist', { name: '浏览器标签页' });

    const pane = document.querySelector<HTMLElement>('.commerce-browser-pane');
    const resizer = screen.getByRole('separator', { name: '调整浏览器面板宽度' });
    // 1280 - 208(sidebar) leaves 1072px; 50% would be 536px, but the narrow
    // window still reserves room for the tool area and the drag target.
    expect(pane?.style.flexBasis).toBe('520px');
    expect(Number(resizer.getAttribute('aria-valuemax'))).toBe(520);
    expect(window.localStorage.getItem('qingzuo.browserPaneWidth')).toBeNull();

    window.innerWidth = 2000;
    fireEvent(window, new Event('resize'));
    // The same 50% preference now expands with the available workspace.
    await waitFor(() => expect(pane?.style.flexBasis).toBe('896px'));
    expect(Number(resizer.getAttribute('aria-valuemax'))).toBe(1172);
    fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }));
    await waitFor(() => expect(pane?.style.flexBasis).toBe('964px'));
  } finally {
    window.innerWidth = originalWidth;
  }
});

it('keeps room to resize the browser pane on narrow windows instead of pinning it to the minimum', async () => {
  const originalWidth = window.innerWidth;
  // Narrow windows cannot reserve the full tool-area floor without pinning the
  // pane to its 360px minimum, which would leave no width to drag.
  window.innerWidth = 1100;
  try {
    const browser: BrowserStatus = { open: true, activeTabId: 'browser-1', candidates: [], downloads: [], tabs: [{ id: 'browser-1', title: '新标签页', url: '', loading: false, canGoBack: false, canGoForward: false }] };
    fixture(undefined, true, false, [], browser);
    render(<Platform />);
    fireEvent.click(await screen.findByRole('button', { name: '打开浏览器面板' }));
    await screen.findByRole('tablist', { name: '浏览器标签页' });
    const resizer = screen.getByRole('separator', { name: '调整浏览器面板宽度' });
    const max = Number(resizer.getAttribute('aria-valuemax'));
    expect(max).toBeGreaterThan(360);
    expect(max - 360).toBeGreaterThanOrEqual(160);
  } finally {
    window.innerWidth = originalWidth;
  }
});

it('scales default browser pane width responsively on ultra-wide screens without 1360px cap', async () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 3840;
  try {
    const browser: BrowserStatus = { open: true, activeTabId: 'browser-1', candidates: [], downloads: [], tabs: [{ id: 'browser-1', title: '新标签页', url: '', loading: false, canGoBack: false, canGoForward: false }] };
    fixture(undefined, true, false, [], browser);
    render(<Platform />);
    fireEvent.click(await screen.findByRole('button', { name: '打开浏览器面板' }));
    await screen.findByRole('tablist', { name: '浏览器标签页' });
    const resizer = screen.getByRole('separator', { name: '调整浏览器面板宽度' });
    expect(Number(resizer.getAttribute('aria-valuenow'))).toBeGreaterThan(1500);
  } finally {
    window.innerWidth = originalWidth;
  }
});

it('opens the browser in a right-side pane with independent left and right controls', async () => {
  const browser: BrowserStatus = { open: true, activeTabId: 'browser-1', candidates: [], downloads: [], tabs: [{ id: 'browser-1', title: '新标签页', url: '', loading: false, canGoBack: false, canGoForward: false }] };
  const { invoke } = fixture(undefined, true, false, [], browser);
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });

  fireEvent.click(screen.getByRole('button', { name: '打开浏览器面板' }));
  await screen.findByRole('tablist', { name: '浏览器标签页' });
  const sidebar = document.querySelector('.commerce-sidebar');
  expect(sidebar).toBeTruthy();
  expect(document.querySelector('.commerce-browser-pane')).toBeTruthy();
  expect(screen.queryByRole('tablist', { name: '已打开的工具' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }));
  expect(sidebar?.classList.contains('is-collapsed')).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: '隐藏浏览器面板' }));
  await screen.findByRole('heading', { name: '工具中心' });
  expect(document.querySelector('.commerce-sidebar')).toBeTruthy();
  expect(invoke.mock.calls.some(([method]) => method === 'browser.open')).toBe(true);
  expect(invoke.mock.calls.some(([method]) => method === 'browser.hide')).toBe(true);
});

it('shows only tool tabs on the left and browser tabs on the right while split', async () => {
  const browser: BrowserStatus = { open: true, activeTabId: 'browser-1', candidates: [], downloads: [], tabs: [{ id: 'browser-1', title: '商品页', url: 'https://shop.example/item', loading: false, canGoBack: false, canGoForward: false }] };
  fixture(undefined, true, false, [entry.id], browser);
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });

  fireEvent.click(screen.getByRole('button', { name: '打开' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: 'LabelEdit' }).getAttribute('aria-selected')).toBe('true'));
  fireEvent.click(screen.getByRole('button', { name: '打开浏览器面板' }));
  const toolTabs = await screen.findByRole('tablist', { name: '已打开的工具' });
  const browserTabs = await screen.findByRole('tablist', { name: '浏览器标签页' });

  expect(toolTabs.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('LabelEdit');
  expect(toolTabs.textContent).not.toContain('工具中心');
  expect(browserTabs.textContent).toContain('商品页');
});

it('shows feedback action on error alert and opens issue reporting dialog', async () => {
  const { invoke } = fixture();
  const baseImpl = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (method: string, args?: unknown) => {
    if (method === 'plugins.import') throw new Error('模拟导入失败');
    return baseImpl(method, args);
  });
  render(<Platform />);
  await openToolTab('全部');
  fireEvent.click(await screen.findByRole('button', { name: '导入插件' }));
  const feedbackBtn = await screen.findByRole('button', { name: '反馈此问题' });
  expect(feedbackBtn).toBeTruthy();

  fireEvent.click(feedbackBtn);
  expect(await screen.findByRole('dialog', { name: /提交反馈与报错/ })).toBeTruthy();
  expect(screen.getByText(/模拟导入失败/)).toBeTruthy();
});

it('provides an issue reporting entry in settings about card', async () => {
  fixture();
  render(<Platform />);
  await navigate('设置');
  const reportBtn = await screen.findByRole('button', { name: '提交反馈与报错' });
  expect(reportBtn).toBeTruthy();

  fireEvent.click(reportBtn);
  expect(await screen.findByRole('dialog', { name: /提交反馈与报错/ })).toBeTruthy();
});
