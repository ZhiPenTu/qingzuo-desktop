import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildIssueUrl,
  cleanErrorMessage,
  clearRecentErrors,
  formatIssueMarkdown,
  getLatestError,
  getRecentErrors,
  recordError,
} from './error-tracker';

describe('error-tracker', () => {
  beforeEach(() => {
    clearRecentErrors();
  });

  it('cleans remote invocation prefixes from error messages', () => {
    expect(cleanErrorMessage("Error invoking remote method 'commerce:platform': Error: 平台操作失败。")).toBe('平台操作失败。');
    expect(cleanErrorMessage(new Error('普通错误'))).toBe('普通错误');
  });

  it('records errors and caps buffer to 10 entries', () => {
    for (let i = 1; i <= 15; i++) {
      recordError(`Error #${i}`, 'test');
    }
    const recent = getRecentErrors();
    expect(recent).toHaveLength(10);
    expect(recent[0].message).toBe('Error #6');
    expect(recent[9].message).toBe('Error #15');
    expect(getLatestError()?.message).toBe('Error #15');
  });

  it('formats Markdown diagnostic report with system and plugin information', () => {
    const error = recordError(new Error('测试网络断开'), 'network');
    const md = formatIssueMarkdown({
      error,
      userDescription: '正在安装插件时点击取消',
      env: {
        appVersion: '0.3.13',
        system: { platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', electron: '44.0.0' },
        kernelReady: true,
        plugins: [{ id: 'official.labeledit', version: '0.2.0', title: 'LabelEdit' }],
      },
      recentErrors: [error],
    });

    expect(md).toContain('### 报错信息');
    expect(md).toContain('`测试网络断开`');
    expect(md).toContain('- 轻作版本: v0.3.13');
    expect(md).toContain('- 操作系统: darwin (arm64) 24.0.0');
    expect(md).toContain('- Electron: v44.0.0');
    expect(md).toContain('- 工具服务: 运行中');
    expect(md).toContain('LabelEdit (v0.2.0)');
    expect(md).toContain('正在安装插件时点击取消');
  });

  it('builds GitHub new issue URL and bounds body length', () => {
    const url = buildIssueUrl({
      title: '[Bug] 启动失败',
      body: '详细报错信息',
    });
    expect(url).toContain('https://github.com/ZhiPenTu/qingzuo-desktop/issues/new');
    expect(url).toContain('title=%5BBug%5D+%E5%90%AF%E5%8A%A8%E5%A4%B1%E8%B4%A5');

    const hugeBody = 'A'.repeat(5000);
    const truncatedUrl = buildIssueUrl({ body: hugeBody });
    expect(truncatedUrl.length).toBeLessThan(4000);
    expect(decodeURIComponent(truncatedUrl)).toContain('诊断信息较长，完整内容已同步复制至剪贴板');
  });
});
