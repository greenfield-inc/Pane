import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './contexts/ThemeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BrowserFallback } from './components/BrowserFallback';
import './styles/markdown-preview.css';
import './styles/notebook-preview.css';

let mounted = false;

interface RendererErrorDetails {
  toString(): string;
}

type RendererErrorValue = Error | string | RendererErrorDetails | null | undefined;

function getErrorMessage(value: RendererErrorValue): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) || String(value);
  } catch {
    return String(value);
  }
}

function getErrorStack(value: RendererErrorValue): string | undefined {
  return value instanceof Error ? value.stack : undefined;
}

function reportRendererFatal(payload: {
  kind: 'unhandledrejection' | 'error';
  message: string;
  stack?: string;
  url?: string;
  line?: number;
  column?: number;
}) {
  window.electronAPI?.diagnostics?.rendererFatal(payload).catch(() => {});
}

export function mountDesktopRenderer(): void {
  if (mounted) return;
  mounted = true;

  // Global error handlers catch failures outside React error boundaries.
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    reportRendererFatal({
      kind: 'unhandledrejection',
      message: getErrorMessage(event.reason),
      stack: getErrorStack(event.reason),
      url: window.location.href,
    });
    event.preventDefault();
    alert('An unexpected error occurred. The application may need to be restarted.\n\nError: ' + (event.reason?.message || String(event.reason)));
  });

  window.addEventListener('error', (event) => {
    console.error('Uncaught error:', event.error);
    reportRendererFatal({
      kind: 'error',
      message: getErrorMessage(event.error || event.message),
      stack: getErrorStack(event.error),
      url: event.filename || window.location.href,
      line: event.lineno,
      column: event.colno,
    });
  });

  // Prevent Chromium from navigating away when files are dropped outside a registered drop zone.
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });

  const root = ReactDOM.createRoot(document.getElementById('root')!);
  if (!window.electronAPI) {
    root.render(
      <React.StrictMode>
        <BrowserFallback />
      </React.StrictMode>,
    );
    return;
  }

  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
