import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import Platform from './Platform';
import type { Plugin, ToolEntry } from './PluginCard';
import type { BrowserStatus, PluginInstallState } from './commerce';

vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light', setTheme: vi.fn() }) }));
const entry: ToolEntry = { id: 'official.labeledit', title: 'LabelEdit', description: '本地 PDF 标签编辑', category: '标签与文档', version: '0.2.0' };
const installed: Plugin = { ...entry, version: '0.1.0', enabled: true, source: 'market', local: false, missing: [] };
const job = (status: PluginInstallState['status'], extra: Partial<PluginInstallState> = {}): PluginInstallState => ({ id: entry.id, version: entry.version, status, progress: null, transferred: 0, total: 0, error: null, ...extra });

function fixture(initialJob?: PluginInstallState, hasPlugin = true, migration = false, initialTabs: string[] = [], browser?: BrowserStatus) {
  let listener = () => {};
  let plugins = hasPlugin ? [installed] : [];
  let pluginInstalls = initialJob ? [initialJob] : [];
  let downloadSource = { source: 'github', customMirrors: [] as string[], gitcodeAvailable: true, notice: null as string | null };
  const invoke = vi.fn(async (method: string, args?: unknown) => {
    if (method === 'status') return structuredClone({ version: '0.3.1', kernel: { ready: true, error: null, version: '0.2.1-alpha.1', systems: [] }, plugins, pluginInstalls, downloadSource, migration: migration ? { id: entry.id, title: entry.title, enabled: false } : null, tabs: initialTabs, ...(browser ? { browser } : {}), update: { status: 'idle', version: null, notes: '', error: null, progress: 0, transferred: 0, total: 0 } });
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

  await openToolTab('已安装');
  expect(screen.getByRole('tab', { name: '已安装' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('button', { name: '管理' })).toBeTruthy();
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
  emit(job('verifying')); await screen.findByText('正在校验插件签名…');
  emit(job('installing')); await screen.findByText('正在安装新版本…');
  emit(job('syncing')); await screen.findByText('正在刷新工具…');
  await openToolTab('全部');
  await screen.findByText('正在刷新工具…');
  emit(job('installed', { progress: 100 }), [{ ...installed, version: entry.version }]);
  await screen.findByText('安装完成 · v0.2.0');
  expect(screen.getByRole('button', { name: '已安装' }).hasAttribute('disabled')).toBe(true);
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
  emit(job('verifying')); await screen.findByText('正在校验插件签名…');
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

it('checks plugin versions on demand and offers the update from installed tools', async () => {
  const { invoke } = fixture();
  render(<Platform />);
  await screen.findByRole('heading', { name: 'LabelEdit' });
  await screen.findByRole('heading', { name: '工具中心' });
  expect(screen.getByText('检查插件是否有新版本')).toBeTruthy();
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

  await navigate('AI 对话');
  const chatShellTab = await screen.findByRole('tab', { name: 'AI 对话' });
  expect(chatShellTab.getAttribute('aria-selected')).toBe('true');
  expect(chatShellTab.querySelector('img.commerce-tab-icon-image')).toBeTruthy();

  fireEvent.click(toolTab);
  await waitFor(() => expect(toolTab.getAttribute('aria-selected')).toBe('true'));
  expect(chatShellTab.getAttribute('aria-selected')).toBe('false');
  expect(chatShellTab.textContent).toBe('AI 对话');

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
