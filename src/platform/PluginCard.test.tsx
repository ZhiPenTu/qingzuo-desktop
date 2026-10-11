import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginCard, type Plugin } from './PluginCard';
import type { PluginInstallState } from './commerce';

const entry = { id: 'official.labeledit', title: 'LabelEdit', description: '本地 PDF 标签编辑', version: '0.2.0', category: '标签与文档' };
const installed: Plugin = { ...entry, version: '0.1.0', enabled: true, source: 'market', local: false, missing: [] };
const job = (status: PluginInstallState['status'], extra: Partial<PluginInstallState> = {}): PluginInstallState => ({ id: entry.id, version: entry.version, status, progress: null, transferred: 0, total: 0, error: null, ...extra });

describe('PluginCard installation state', () => {
  afterEach(cleanup);

  it('offers upgrades and prevents catalog downgrades', () => {
    const props = { entry, installed, mode: 'market' as const, disabled: false, ready: true, onOpen: vi.fn(), onAction: vi.fn() };
    const { rerender } = render(<PluginCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '更新插件' }));
    expect(props.onAction).toHaveBeenCalledWith('market.install', { id: entry.id });
    rerender(<PluginCard {...props} installed={{ ...installed, version: '0.3.0' }} />);
    expect(screen.getByRole('button', { name: '已安装' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows measured download progress and blocks duplicate updates without a global busy flag', () => {
    const onAction = vi.fn();
    render(<PluginCard entry={entry} installed={installed} mode="market" disabled={false} ready={true} install={job('downloading', { progress: 42.8, transferred: 4 * 1024 ** 2, total: 10 * 1024 ** 2 })} onOpen={vi.fn()} onAction={onAction} />);
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
    const { container } = render(<PluginCard entry={installed} installed={installed} mode="plugins" disabled={false} ready={true} install={job('verifying')} onOpen={vi.fn()} onAction={onAction} />);
    expect(screen.getByText('正在校验插件签名…')).toBeTruthy();
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
    expect(container.querySelector('.plugin-update-shimmer')).toBeTruthy();
    for (const name of ['停用', '恢复版本', '卸载']) {
      const button = screen.getByRole('button', { name });
      expect(button.hasAttribute('disabled')).toBe(true);
      fireEvent.click(button);
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it('allows retry when refreshing tools failed after installing the new version', () => {
    const onAction = vi.fn();
    render(<PluginCard entry={entry} installed={{ ...installed, version: entry.version }} mode="market" disabled={false} ready={true} install={job('error', { error: '工具刷新失败：内核已退出' })} onOpen={vi.fn()} onAction={onAction} />);
    expect(screen.getByRole('alert').textContent).toContain('工具刷新失败：内核已退出');
    const button = screen.getByRole('button', { name: '重试更新' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith('market.install', { id: entry.id });
  });
});
