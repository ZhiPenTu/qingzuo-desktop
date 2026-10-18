import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserCandidatePanel } from './BrowserCandidatePanel';
import type { BrowserStatus } from './commerce';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const status: BrowserStatus = {
  open: true,
  activeTabId: 'tab-1',
  tabs: [{ id: 'tab-1', title: '抖音', url: 'https://www.douyin.com/', loading: false, canGoBack: false, canGoForward: false }],
  candidates: [
    { id: 'video-1', tabId: 'tab-1', type: 'video', title: '测试视频', pageUrl: 'https://www.douyin.com/', status: 'ready' },
    { id: 'image-1', tabId: 'tab-1', type: 'image', title: '未解析图集', pageUrl: 'https://www.douyin.com/', status: 'unresolved', reason: '请打开详情后重试。' },
  ],
  downloads: [],
};

it('renders candidates, keeps unresolved items visible, and downloads selected items', () => {
  const onAction = vi.fn(async () => undefined);
  render(<BrowserCandidatePanel status={status} busy={false} onAction={onAction} />);
  expect(screen.getByRole('heading', { name: '检测结果' })).toBeTruthy();
  expect(screen.getByText('测试视频')).toBeTruthy();
  expect(screen.getByText('请打开详情后重试。')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('全选可下载项'));
  fireEvent.click(screen.getByRole('button', { name: '批量下载' }));
  expect(onAction).toHaveBeenCalledWith('browser.download', { candidateIds: ['video-1'], mode: 'batch' });
});
