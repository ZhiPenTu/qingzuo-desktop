import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RotateCcw, Bug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IssueReportDialog } from './IssueReportDialog';
import { recordError, type CapturedError } from './error-tracker';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  capturedError: CapturedError | null;
  dialogOpen: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      capturedError: null,
      dialogOpen: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const captured = recordError(
      new Error(`${error.message}\n组件堆栈: ${errorInfo.componentStack}`),
      'React.ErrorBoundary'
    );
    this.setState({ capturedError: captured });
  }

  handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen items-center justify-center p-4 bg-background text-foreground">
          <div className="max-w-md w-full flex flex-col items-center text-center gap-2.5 p-4 border rounded-lg bg-card shadow-lg">
            <div className="rounded-full bg-destructive/10 p-2.5 text-destructive">
              <AlertCircle className="h-7 w-7" />
            </div>
            <div className="flex flex-col gap-1">
              <h1 className="text-lg font-semibold">轻作界面遇到异常</h1>
              <p className="text-sm text-muted-foreground">
                界面运行发生意外错误，你可以尝试重新载入，或向我们反馈此问题。
              </p>
            </div>
            {this.state.error?.message ? (
              <div className="w-full text-left p-2.5 rounded-md bg-muted text-xs font-mono text-muted-foreground overflow-x-auto max-h-32">
                {this.state.error.message}
              </div>
            ) : null}
            <div className="flex items-center gap-3 pt-2">
              <Button variant="outline" size="sm" onClick={this.handleReload}>
                <RotateCcw className="h-4 w-4" />
                重新加载界面
              </Button>
              <Button
                size="sm"
                onClick={() => this.setState({ dialogOpen: true })}
              >
                <Bug className="h-4 w-4" />
                反馈此问题
              </Button>
            </div>
          </div>
          <IssueReportDialog
            open={this.state.dialogOpen}
            onClose={() => this.setState({ dialogOpen: false })}
            initialError={this.state.capturedError}
          />
        </div>
      );
    }

    return this.props.children;
  }
}
