import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueReportDialog } from './IssueReportDialog';

describe('IssueReportDialog', () => {
  const writeTextMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });
    writeTextMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not render when closed', () => {
    const { container } = render(
      <IssueReportDialog open={false} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders title, description and initial error details', () => {
    render(
      <IssueReportDialog
        open={true}
        onClose={vi.fn()}
        initialError={{ timestamp: Date.now(), message: '插件加载失败' }}
        env={{ appVersion: '0.3.13', kernelReady: true }}
      />
    );

    expect(screen.getByRole('heading', { name: /提交反馈与报错/ })).toBeTruthy();
    expect(screen.getByPlaceholderText(/请简要描述发生异常时的操作/)).toBeTruthy();
    expect(screen.getByText(/插件加载失败/)).toBeTruthy();
  });

  it('copies diagnostic report to clipboard', async () => {
    render(
      <IssueReportDialog
        open={true}
        onClose={vi.fn()}
        initialError={{ timestamp: Date.now(), message: '插件异常' }}
        env={{ appVersion: '0.3.13' }}
      />
    );

    const copyBtn = screen.getByRole('button', { name: /复制诊断信息/ });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalled();
    });
    expect(writeTextMock.mock.calls[0][0]).toContain('### 报错信息');
    expect(writeTextMock.mock.calls[0][0]).toContain('插件异常');
    expect(screen.getByText('已复制诊断信息')).toBeTruthy();
  });

  it('submits issue by opening external GitHub issue URL and closing dialog', async () => {
    const onClose = vi.fn();
    const onOpenExternal = vi.fn().mockResolvedValue(undefined);

    render(
      <IssueReportDialog
        open={true}
        onClose={onClose}
        initialError={{ timestamp: Date.now(), message: '内核崩溃' }}
        env={{ appVersion: '0.3.13' }}
        onOpenExternal={onOpenExternal}
      />
    );

    const submitBtn = screen.getByRole('button', { name: /前往 GitHub 提交/ });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onOpenExternal).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    const openedUrl = onOpenExternal.mock.calls[0][0] as string;
    expect(openedUrl).toContain('https://github.com/ZhiPenTu/qingzuo-desktop/issues/new');
    expect(openedUrl).toContain('title=%5BBug%5D+%E5%86%85%E6%A0%B8%E5%B4%A9%E6%BA%83');
  });
});
