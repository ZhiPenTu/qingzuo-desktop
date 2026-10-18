import { useState, useId, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { X, Copy, Check, ExternalLink, ChevronDown, ChevronRight, Bug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  formatIssueMarkdown,
  buildIssueUrl,
  type CapturedError,
  type EnvironmentContext,
} from './error-tracker';

const QQ_FEEDBACK_GROUP_URL = 'https://qm.qq.com/q/CkVASJvvDW';

export interface IssueReportDialogProps {
  open: boolean;
  onClose: () => void;
  initialError?: CapturedError | null;
  env?: EnvironmentContext;
  onOpenExternal?: (url: string) => Promise<boolean | void> | void;
}

export function IssueReportDialog({
  open,
  onClose,
  initialError,
  env,
  onOpenExternal,
}: IssueReportDialogProps) {
  const [userNotes, setUserNotes] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(Boolean(initialError));
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const titleId = useId();

  if (!open) return null;

  const reportMarkdown = formatIssueMarkdown({
    error: initialError,
    userDescription: userNotes,
    env,
  });

  const handleCopyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(reportMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      try {
        await navigator.clipboard.writeText(reportMarkdown);
      } catch {}

      const title = initialError?.message
        ? `[Bug] ${initialError.message.slice(0, 60)}`
        : '[Feedback] 建议与问题反馈';
      const url = buildIssueUrl({ title, body: reportMarkdown });

      if (onOpenExternal) {
        await onOpenExternal(url);
      } else if (window.commerceDesktop) {
        await window.commerceDesktop.invoke('openExternal', { url });
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenQQGroup = async (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (onOpenExternal) {
      await onOpenExternal(QQ_FEEDBACK_GROUP_URL);
    } else if (window.commerceDesktop) {
      await window.commerceDesktop.invoke('openExternal', { url: QQ_FEEDBACK_GROUP_URL });
    } else {
      window.open(QQ_FEEDBACK_GROUP_URL, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div
      className="issue-dialog-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="issue-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="issue-dialog-head">
          <div>
            <p className="issue-dialog-eyebrow">反馈与帮助</p>
            <h2 id={titleId} className="flex items-center gap-1.5">
              <Bug className="h-4 w-4 text-muted-foreground" />
              提交反馈与报错
            </h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>

        <p className="issue-dialog-description">
          我们会将问题和诊断日志提交至 GitHub 仓库。点击提交时，完整报告也会同步复制到剪贴板。
        </p>
        <p className="issue-dialog-community">
          也可以加入反馈群：<a href={QQ_FEEDBACK_GROUP_URL} onClick={event => void handleOpenQQGroup(event)}>点击链接加入群聊【Qingzuo技术反馈+许愿群】</a>
        </p>

        <form className="issue-dialog-form" onSubmit={handleSubmit}>
          <div className="issue-dialog-field">
            <label htmlFor="issue-user-notes" className="issue-dialog-label">
              操作说明（可选）
            </label>
            <Textarea
              id="issue-user-notes"
              rows={3}
              value={userNotes}
              onChange={e => setUserNotes(e.target.value)}
              placeholder="请简要描述发生异常时的操作或预期行为…"
              className="issue-dialog-textarea"
            />
          </div>

          <div className="issue-diagnostics-section">
            <button
              type="button"
              className="issue-diagnostics-toggle"
              onClick={() => setShowDiagnostics(v => !v)}
              aria-expanded={showDiagnostics}
            >
              {showDiagnostics ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <span>查看即将提交的诊断信息</span>
            </button>

            {showDiagnostics ? (
              <div className="issue-diagnostics-box" role="region" aria-label="诊断信息预览">
                <pre className="issue-diagnostics-code">{reportMarkdown}</pre>
              </div>
            ) : null}
          </div>

          <div className="issue-dialog-footer">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyDiagnostics}
              className="mr-auto"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              {copied ? '已复制诊断信息' : '复制诊断信息'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              <ExternalLink className="h-4 w-4" />
              前往 GitHub 提交
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
