import { useState, type ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

export function MonacoErrorBoundary({ children }: { children: ReactNode }) {
  const [retried, setRetried] = useState(false);

  return (
    <ErrorBoundary
      onError={(error, errorInfo) => console.warn('Monaco editor error details:', { error, errorInfo })}
      onReset={() => setRetried(true)}
      fallbackRender={({ resetErrorBoundary }) => (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-8 text-text-secondary">
          <p>The editor could not be displayed. Your edits are still held in this tab.</p>
          {retried ? (
            <p>Retry failed. Switch to another file or reopen the tab to try again.</p>
          ) : (
            <button type="button" className="rounded border border-border-primary px-3 py-2" onClick={resetErrorBoundary}>
              Retry editor
            </button>
          )}
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
