import { useCallback, useState } from 'react';
import { Check, Copy, Globe, Radio, RotateCw, X } from 'lucide-react';
import type { SessionPort, SessionPortOpenRequest, SessionPortsSnapshot, SuggestedPort } from '../../../../shared/types/sessionPorts';
import { errorMessage, isSessionPortConflict } from '../../services/sessionPortsSync';
import { cn } from '../../utils/cn';
import { copyTerminalText } from '../../utils/terminalClipboard';
import { LiveRegion } from '../ui/LiveRegion';

interface SessionPortsChipsProps {
  snapshot: SessionPortsSnapshot;
  onOpenUrl(url: string): void | Promise<void>;
  onPublish(request: SessionPortOpenRequest): Promise<void>;
  onClose(target: number | string): Promise<void>;
  /** `row`: a full-width strip under a tab bar; `inline`: inside an existing header. */
  variant?: PortsRowVariant;
  className?: string;
}

type PendingConfirm =
  | { kind: 'close'; port: SessionPort }
  | { kind: 'replace'; port: SuggestedPort };

const iconButton =
  'inline-flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle';
const textButton =
  'rounded px-1.5 py-0.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle';

type PortsRowVariant = 'row' | 'inline';

function rowClassName(variant: PortsRowVariant, className?: string): string {
  return cn(
    'flex min-w-0 items-center gap-1.5 text-xs',
    // A phone keeps the row one line high and scrolls it sideways; wider screens wrap.
    variant === 'row'
      ? 'flex-nowrap overflow-x-auto border-b border-border-primary bg-surface-primary px-3 py-1 md:flex-wrap md:overflow-x-visible'
      : 'flex-wrap',
    className,
  );
}

function PortsLabel() {
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1 text-text-tertiary">
      <Globe className="h-3.5 w-3.5" aria-hidden="true" />
      Ports
    </span>
  );
}

/** Why a published port may not work, or null when it is serving normally. */
export function portProblem(port: SessionPort): string | null {
  if (port.status === 'missing') return port.detail ?? 'Not being served (the daemon will restore it)';
  if (port.status === 'error') return port.detail ?? 'Serve failed';
  if (port.reachable === false) return `Not answering on 127.0.0.1:${port.port}`;
  return null;
}

/** Short label for a detected listener: `:5173 vite`. */
export function suggestedPortLabel(port: SuggestedPort): string {
  return port.process ? `:${port.port} ${port.process}` : `:${port.port}`;
}

/**
 * The Ports chip row: published Session ports open their tailnet HTTPS URL,
 * detected listeners are offered dimmed with "Open on tailnet". Renders nothing
 * when the Session has neither.
 */
export function SessionPortsChips({ snapshot, onOpenUrl, onPublish, onClose, variant = 'row', className }: SessionPortsChipsProps) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = useCallback(async (key: string, action: () => Promise<void>, onConflict?: () => void) => {
    setBusyKey(key);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      if (onConflict && isSessionPortConflict(error)) onConflict();
      else setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }, []);

  const copy = useCallback(async (url: string) => {
    setActionError(null);
    try {
      await copyTerminalText(url);
    } catch (cause) {
      setActionError(`Copy failed: ${errorMessage(cause)}`);
      return;
    }
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(current => (current === url ? null : current)), 1500);
  }, []);

  const publish = (port: SuggestedPort, yes: boolean) => {
    setConfirm(null);
    void run(`suggested:${port.port}`, () => onPublish({ port: port.port, yes }),
      yes ? undefined : () => setConfirm({ kind: 'replace', port }));
  };

  const closePort = (port: SessionPort) => {
    setConfirm(null);
    void run(`port:${port.httpsPort}`, () => onClose(port.name || port.port));
  };

  if (!snapshot.available || (snapshot.ports.length === 0 && snapshot.suggested.length === 0)) return null;

  return (
    <div role="region" aria-label="Session ports" data-testid="session-ports" className={rowClassName(variant, className)}>
      <PortsLabel />

      {snapshot.ports.map(port => {
        const key = `port:${port.httpsPort}`;
        const busy = busyKey === key;
        return (
          <span
            key={key}
            data-testid="session-port-chip"
            className={cn('inline-flex max-w-full flex-shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border border-border-primary bg-surface-secondary py-0.5 pl-2 pr-1', busy && 'opacity-60')}
          >
            {portProblem(port) && (
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-status-warning" title={portProblem(port) ?? undefined} aria-label={portProblem(port) ?? undefined} role="img" />
            )}
            <button
              type="button"
              className="inline-flex min-w-0 items-center gap-1 rounded text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
              title={port.url}
              aria-label={`Open ${port.name} (${port.url})`}
              onClick={() => { void run(key, async () => { await onOpenUrl(port.url); }); }}
            >
              <span className="truncate font-medium">{port.name}</span>
              <span className="text-text-tertiary">:{port.httpsPort}</span>
              {port.scheme === 'http' && <span className="text-status-warning" title={port.detail ?? 'No TLS certificate: plain HTTP on the tailnet'}>http</span>}
            </button>
            <button type="button" className={iconButton} aria-label={`Copy ${port.name} URL`} title="Copy URL" onClick={() => { void copy(port.url); }}>
              {copiedUrl === port.url
                ? <Check className="h-3 w-3 text-status-success" aria-hidden="true" />
                : <Copy className="h-3 w-3" aria-hidden="true" />}
            </button>
            <button type="button" className={iconButton} aria-label={`Close ${port.name}`} title="Stop publishing on the tailnet" disabled={busy} onClick={() => setConfirm({ kind: 'close', port })}>
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        );
      })}

      {snapshot.suggested.map(port => {
        const key = `suggested:${port.port}`;
        const busy = busyKey === key;
        return (
          <span
            key={key}
            data-testid="session-port-suggestion"
            className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border-primary py-0.5 pl-2 pr-1 text-text-tertiary"
            title={`Listening on ${port.address}:${port.port}`}
          >
            <Radio className="h-3 w-3 opacity-70" aria-hidden="true" />
            <span className="opacity-80">{suggestedPortLabel(port)}</span>
            <button
              type="button"
              className={cn(textButton, 'text-text-secondary hover:bg-surface-hover hover:text-text-primary')}
              disabled={busy}
              onClick={() => publish(port, false)}
            >
              {busy ? 'Opening…' : 'Open on tailnet'}
            </button>
          </span>
        );
      })}

      {confirm && (
        <span role="group" aria-label="Confirm" className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded border border-status-warning px-2 py-0.5 text-text-secondary">
          {confirm.kind === 'close'
            ? `Stop publishing ${confirm.port.name} (:${confirm.port.httpsPort})?`
            : `Tailnet port :${confirm.port.port} is already served. Replace it?`}
          <button
            type="button"
            className={cn(textButton, 'bg-status-warning text-text-on-status-warning hover:bg-status-warning-hover')}
            onClick={() => (confirm.kind === 'close' ? closePort(confirm.port) : publish(confirm.port, true))}
          >
            {confirm.kind === 'close' ? 'Close' : 'Replace'}
          </button>
          <button type="button" className={cn(textButton, 'hover:bg-surface-hover')} onClick={() => setConfirm(null)}>Cancel</button>
        </span>
      )}

      {actionError && <span role="alert" className="min-w-0 truncate text-status-error" title={actionError}>{actionError}</span>}
      <LiveRegion>{copiedUrl ? 'URL copied to clipboard' : ''}</LiveRegion>
    </div>
  );
}

interface SessionPortsLoadErrorProps {
  message: string;
  onRetry(): void;
  variant?: PortsRowVariant;
  className?: string;
}

/** The first read of a host's ports failed: say why and offer Retry instead of hiding the row. */
export function SessionPortsLoadError({ message, onRetry, variant = 'row', className }: SessionPortsLoadErrorProps) {
  return (
    <div role="region" aria-label="Session ports" data-testid="session-ports" className={rowClassName(variant, className)}>
      <PortsLabel />
      <span role="alert" className="min-w-0 truncate text-status-error" title={message}>Couldn't load ports: {message}</span>
      <button type="button" className={cn(textButton, 'inline-flex flex-shrink-0 items-center gap-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary')} onClick={onRetry}>
        <RotateCw className="h-3 w-3" aria-hidden="true" />
        Retry
      </button>
    </div>
  );
}
