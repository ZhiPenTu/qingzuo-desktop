import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserWorkspace } from './BrowserWorkspace';
import type { BrowserStatus } from './commerce';

const status: BrowserStatus = {
  open: true,
  activeTabId: 'one',
  candidates: [],
  downloads: [],
  tabs: [
    { id: 'one', title: '商品页', url: 'https://shop.example/products/1', loading: false, canGoBack: true, canGoForward: false },
    { id: 'two', title: '新标签页', url: '', loading: false, canGoBack: false, canGoForward: false },
  ],
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete window.commerceDesktop; });

it('renders browser tabs, navigation state, and the active address', () => {
  render(<BrowserWorkspace status={status} busy={false} onAction={vi.fn(async () => undefined)} />);
  expect(screen.getByRole('tab', { name: /商品页/ }).getAttribute('aria-selected')).toBe('true');
  expect((screen.getByLabelText('地址栏') as HTMLInputElement).value).toBe('https://shop.example/products/1');
  expect(screen.getByRole('button', { name: '后退' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('button', { name: '前进' }).hasAttribute('disabled')).toBe(true);
});

it('dispatches tab, navigation, and address actions through the browser IPC boundary', () => {
  const onAction = vi.fn(async () => undefined);
  render(<BrowserWorkspace status={status} busy={false} onAction={onAction} />);
  fireEvent.click(screen.getByRole('tab', { name: /新标签页/ }));
  fireEvent.click(screen.getByRole('button', { name: '新建浏览器标签' }));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  fireEvent.change(screen.getByLabelText('地址栏'), { target: { value: 'https://shop.example/products/2' } });
  fireEvent.submit(screen.getByLabelText('地址栏').closest('form')!);
  expect(onAction).toHaveBeenCalledWith('browser.activate', { id: 'two' });
  expect(onAction).toHaveBeenCalledWith('browser.newTab');
  expect(onAction).toHaveBeenCalledWith('browser.reload');
  expect(onAction).toHaveBeenCalledWith('browser.navigate', { id: 'one', url: 'https://shop.example/products/2' });
});

