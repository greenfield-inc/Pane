import React, { useEffect, useRef, type ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

// Transient failures (a webview not ready yet after a pane switch) clear on remount,
// so retry quietly a few times before showing the error.
const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 200;
const AUTO_RETRY_WINDOW_MS = 30_000;

interface AutoRetryState {
  count: number;
  lastAt: number;
}

const PanelErrorFallback: React.FC<{
  error: Error;
  resetErrorBoundary: () => void;
  autoRetry: React.MutableRefObject<AutoRetryState>;
}> = ({ error, resetErrorBoundary, autoRetry }) => {
  if (Date.now() - autoRetry.current.lastAt > AUTO_RETRY_WINDOW_MS) {
    autoRetry.current.count = 0;
  }
  const retrying = autoRetry.current.count < MAX_AUTO_RETRIES;

  useEffect(() => {
    if (!retrying) return;
    const timer = setTimeout(() => {
      autoRetry.current = { count: autoRetry.current.count + 1, lastAt: Date.now() };
      resetErrorBoundary();
    }, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [retrying, resetErrorBoundary, autoRetry]);

  if (retrying) return null;

  return (
    <div className="flex flex-col items-center justify-center h-full text-status-error p-4">
      <p className="text-lg font-semibold mb-2">Panel Error</p>
      <p className="select-text text-sm text-text-secondary mb-4">{error.message}</p>
      <button
        onClick={() => {
          autoRetry.current = { count: 0, lastAt: 0 };
          resetErrorBoundary();
        }}
        className="px-4 py-2 bg-interactive text-text-on-interactive rounded hover:bg-interactive-hover"
      >
        Retry
      </button>
    </div>
  );
};

/** A panel's error boundary: a throw in one panel shows its error there, never blanking the window. */
export function PanelErrorBoundary({ panelId, children }: { panelId: string; children: ReactNode }) {
  const autoRetry = useRef<AutoRetryState>({ count: 0, lastAt: 0 });
  return (
    <ErrorBoundary
      onError={(error, info) => {
        window.electronAPI?.diagnostics?.rendererFatal({
          kind: 'error-boundary',
          message: error instanceof Error ? error.message : 'Panel render failed',
          stack: error instanceof Error ? error.stack : undefined,
          componentStack: info.componentStack ?? undefined,
        }).catch(() => {});
      }}
      fallbackRender={({ error, resetErrorBoundary }) => (
        <PanelErrorFallback
          // SAFETY: Panel children only throw Error instances.
          error={error as Error}
          resetErrorBoundary={resetErrorBoundary}
          autoRetry={autoRetry}
        />
      )}
      resetKeys={[panelId]} // Only reset when panel changes
    >
      {children}
    </ErrorBoundary>
  );
}
