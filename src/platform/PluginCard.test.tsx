import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginCard, formatDownloadCount, type Plugin } from './PluginCard';
import type { PluginInstallState } from './commerce';

const entry = { id: 'official.labeledit', title: 'LabelEdit', description: '本地 PDF 标签编辑', version: '0.2.0', category: '标签与文档' };
const installed: Plugin = { ...entry, version: '0.1.0', enabled: true, source: 'market', local: false, missing: [] };
const job = (status: PluginInstallState['status'], extra: Partial<PluginInstallState> = {}): PluginInstallState => ({ id: entry.id, version: entry.version, status, progress: null, transferred: 0, total: 0, error: null, ...extra });

describe('PluginCard installation state', () => {
  afterEach(cleanup);

  it('offers upgrades and prevents catalog downgrades', () => {
    const props = { entry, installed, mode: 'catalog' as const, disabled: false, ready: true, onOpen: vi.fn(), onAction: vi.fn() };
    const { rerender } = render(<PluginCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '更新插件' }));
    expect(props.onAction).toHaveBeenCalledWith('market.install', { id: entry.id });
    rerender(<PluginCard {...props} installed={{ ...installed, version: '0.3.0' }} />);
    expect(screen.getByRole('button', { name: '已安装' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows measured download progress and blocks duplicate updates without a global busy flag', () => {
    const onAction = vi.fn();
    render(<PluginCard entry={entry} installed={installed} mode="catalog" disabled={false} ready={true} install={job('downloading', { progress: 42.8, transferred: 4 * 1024 ** 2, total: 10 * 1024 ** 2 })} onOpen={vi.fn()} onAction={onAction} />);
    const progress = screen.getByRole('progressbar', { name: 'LabelEdit 安装进度' });
    expect(progress.getAttribute('aria-valuenow')).toBe('42.8');
    expect(screen.getByText('正在下载新版本… 42%')).toBeTruthy();
    expect(screen.getByText('4.0 MB / 10.0 MB')).toBeTruthy();
    const button = screen.getByRole('button', { name: '更新插件' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('shows indeterminate verification and prevents management races during installation', () => {
    const onAction = vi.fn();
    const props = { entry: installed, installed, mode: 'installed' as const, disabled: false, ready: true, onOpen: vi.fn(), onAction };
    const { container, rerender } = render(<PluginCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    rerender(<PluginCard {...props} install={job('verifying')} />);
    expect(screen.getByText('正在校验插件签名…')).toBeTruthy();
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
    const track = container.querySelector('[data-slot="progress-track"]');
    const shimmer = container.querySelector('[data-slot="progress-shimmer"]');
    expect(shimmer).toBeTruthy();
    // 动画条必须被 track 裁剪，不能挂在 Progress 根节点上横跨整块内容。
    expect(shimmer?.parentElement).toBe(track);
    expect(container.querySelectorAll('[data-slot="progress-shimmer"]')).toHaveLength(1);
    for (const name of ['停用', '恢复版本', '卸载']) {
      const button = screen.getByRole('button', { name });
      expect(button.hasAttribute('disabled')).toBe(true);
      fireEvent.click(button);
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it('allows retry when refreshing tools failed after installing the new version', () => {
    const onAction = vi.fn();
    render(<PluginCard entry={entry} installed={{ ...installed, version: entry.version }} mode="installed" disabled={false} ready={true} install={job('error', { error: '工具刷新失败：内核已退出' })} onOpen={vi.fn()} onAction={onAction} />);
    expect(screen.getByRole('alert').textContent).toContain('工具刷新失败：内核已退出');
    const button = screen.getByRole('button', { name: '重试更新' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith('market.install', { id: entry.id });
  });

  it('offers a catalog update from the installed tab without downgrading local state', () => {
    const onAction = vi.fn();
    const { rerender, container } = render(<PluginCard entry={entry} installed={installed} mode="installed" disabled={false} ready={true} onOpen={vi.fn()} onAction={onAction} />);
    expect(container.querySelector('.plugin-state')?.textContent).toContain('v0.1.0');
    // The management page passes the catalog entry only after an explicit check.
    const catalogEntry = { ...entry, releaseNotes: '修复稳定性问题' };
    rerender(<PluginCard entry={catalogEntry} installed={installed} mode="installed" disabled={false} ready={true} onOpen={vi.fn()} onAction={onAction} />);
    expect(container.querySelector('.plugin-state .is-update')?.textContent).toBe('可更新到 v0.2.0');
    expect(container.querySelector('.plugin-state')?.textContent).not.toContain('签名');
    fireEvent.click(screen.getByRole('button', { name: '更新插件' }));
    expect(onAction).toHaveBeenCalledWith('market.install', { id: entry.id });
    rerender(<PluginCard entry={entry} installed={{ ...installed, version: '0.3.0' }} mode="installed" disabled={false} ready={true} onOpen={vi.fn()} onAction={onAction} />);
    expect(container.querySelector('.plugin-state')?.textContent).toContain('v0.3.0');
    expect(screen.queryByRole('button', { name: '更新插件' })).toBeNull();
  });

  it('shows compact cumulative downloads only when a positive market value exists', () => {
    expect([999, 1234, 31000, 1250000].map(formatDownloadCount)).toEqual(['999', '1.2K', '31K', '1.3M']);
    const { rerender } = render(<PluginCard entry={{ ...entry, stats: { downloads: 31000 } }} mode="catalog" disabled={false} ready={true} onOpen={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByLabelText('累计下载 31,000 次').textContent).toContain('31K');
    rerender(<PluginCard entry={{ ...entry, stats: { downloads: 0 } }} mode="catalog" disabled={false} ready={true} onOpen={vi.fn()} onAction={vi.fn()} />);
    expect(screen.queryByLabelText(/累计下载/)).toBeNull();
  });

  it('keeps release notes hidden until explicitly opened', async () => {
    render(<PluginCard entry={{ ...entry, releaseNotes: '修复稳定性问题' }} mode="catalog" disabled={false} ready={true} onOpen={vi.fn()} onAction={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: '查看版本说明' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('修复稳定性问题')).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText('修复稳定性问题')).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起版本说明' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '收起版本说明' }));
    expect(screen.queryByText('修复稳定性问题')).toBeNull();
  });

  it('renders the plugin-provided brand icon instead of the category fallback', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    const { container } = render(<PluginCard entry={{ ...entry, icon }} mode="catalog" disabled={false} ready={true} onOpen={vi.fn()} onAction={vi.fn()} />);
    const image = container.querySelector('.commerce-tool-icon.has-image img');
    expect(image?.getAttribute('src')).toBe(icon);
    expect(container.querySelector('.commerce-tool-icon svg')).toBeNull();
  });

  it('uses built-in official brand icons when an older installed plugin lacks manifest.icon', () => {
    const { container } = render(<PluginCard entry={entry} mode="installed" disabled={false} ready={true} onOpen={vi.fn()} onAction={vi.fn()} />);
    const image = container.querySelector('.commerce-tool-icon.has-image img');
    expect(image?.getAttribute('src')).toBeTruthy();
    expect(container.querySelector('.commerce-tool-icon svg')).toBeNull();
  });
});
