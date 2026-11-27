import { ReadOnlyPill } from '../../components/machines/ReadOnlyPill';
import { useReadOnlyHost } from '../../stores/readOnlyHostStore';
import { ListTodo, LogOut, Menu } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RemotePaneConnectionProfile, RemotePaneConnectionStatus } from '../../../../shared/types/remoteDaemon';

interface RemoteStatusBarProps {
  profile: RemotePaneConnectionProfile;
  /** The open Pane or Session. The header falls back to the host when nothing is open. */
  openName: string | null;
  status: RemotePaneConnectionStatus;
  lastError: string | null;
  updateIntent?: import('../../../../shared/remoteClient/updateIntent').RemoteUpdateIntent | null;
  lastSeenAt: string | null;
  onDisconnect: () => void;
  onRetry: () => void;
  onOpenSidebar: () => void;
  /** The open Session's to-dos (T-23): a To-dos button, with the amber count of its approvals waiting on you. */
  todos?: { waiting: number; onOpen: () => void };
}

export function RemoteStatusBar({
  profile,
  openName,
  status,
  lastError: reportedError,
  lastSeenAt,
  updateIntent,
  onDisconnect,
  onRetry,
  onOpenSidebar,
  todos,
}: RemoteStatusBarProps) {
  const readOnly = useReadOnlyHost();
  const connected = status === 'connected';
  // Through Pane's servers, the connection bar under this header says what is wrong in plain words;
  // the client's own reason (a dropped stream, a refused token) stays out of the header.
  const relay = profile.relay !== undefined;
  const lastError = relay && !connected ? null : reportedError;
  // A refused token only stops a relay connection: retrying cannot help, a new code does.
  const canRetry = status === 'reconnecting' || (status === 'error' && !relay);
  // `error` is a settled state and stays still; only the two states where the
  // app is actively trying to reach the host get the ring.
  const reaching = status === 'connecting' || status === 'reconnecting';
  const dotColor = connected
    ? 'bg-status-success'
    : status === 'error' ? 'bg-status-error' : 'bg-status-warning';
  const statusLabel = getStatusLabel(status);
  const hostLabel = connected ? profile.label : `${statusLabel} ${profile.label}`;
  const title = openName ?? hostLabel;
  const hostDetail = openName ? `${hostLabel} · ${profile.baseUrl}` : profile.baseUrl;
  const [announcement, setAnnouncement] = useState('');
  const previousAnnouncementRef = useRef('');

  useEffect(() => {
    const nextAnnouncement = status === 'error' && lastError
      ? `${statusLabel} ${profile.label}. ${lastError}`
      : `${statusLabel} ${profile.label}`;
    if (nextAnnouncement !== previousAnnouncementRef.current) {
      previousAnnouncementRef.current = nextAnnouncement;
      setAnnouncement(nextAnnouncement);
    }
  }, [lastError, profile.label, status, statusLabel]);

  return (
    <div
      className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-border-primary bg-surface-primary px-3 py-2 sm:px-4"
      aria-busy={status === 'connecting' || status === 'reconnecting'}
    >
      <div
        className="sr-only"
        role={status === 'error' ? 'alert' : 'status'}
        aria-live={status === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        {announcement}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="rounded-md p-2 text-text-secondary hover:bg-surface-hover hover:text-text-primary md:hidden"
          aria-label="Open remote panes"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        <span aria-hidden="true" className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
          {reaching && <span className={`pane-status-reaching absolute inset-0 rounded-full ${dotColor}`} />}
          <span className={`relative h-2.5 w-2.5 rounded-full transition-colors duration-normal ease-out-strong ${dotColor}`} />
        </span>
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
            <span className="truncate">{title}</span>
            {readOnly && <ReadOnlyPill />}
          </p>
          <p className="truncate text-xs text-text-tertiary">
            {lastError || (updateIntent ? `Updating remote Pane. Session saved; reconnecting automatically. Operation ${updateIntent.id}, checkpoint confirmed.` : hostDetail)}
            {lastSeenAt ? ` · seen ${formatLastSeen(lastSeenAt)}` : ''}
          </p>
        </div>
      </div>
      {todos && (
        <button
          type="button"
          onClick={todos.onOpen}
          aria-label={todos.waiting > 0 ? `To-dos, ${todos.waiting} waiting on you` : 'To-dos'}
          className="ml-auto inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-border-primary px-2.5 text-sm font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary sm:h-8"
          data-testid="remote-session-todos"
        >
          <ListTodo className="h-4 w-4" aria-hidden="true" />
          <span>To-dos</span>
          {todos.waiting > 0 && <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-status-warning px-1.5 text-[11.5px] font-semibold tabular-nums text-text-on-status-warning">{todos.waiting}</span>}
        </button>
      )}
      {canRetry && <button type="button" onClick={onRetry} className="shrink-0 rounded-md border border-border-primary px-3 py-2 text-sm text-text-primary">Retry now</button>}
      <button
        type="button"
        onClick={onDisconnect}
        aria-label="Disconnect"
        className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border-primary px-2.5 py-2 text-sm font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary sm:px-3 sm:py-1.5"
      >
        <LogOut className="h-4 w-4 sm:hidden" aria-hidden="true" />
        <span className="hidden sm:inline">Disconnect</span>
      </button>
    </div>
  );
}

function getStatusLabel(status: RemotePaneConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected to';
    case 'connecting':
      return 'Connecting to';
    case 'restoring':
      return 'Restoring workspace on';
    case 'reconnecting':
      return 'Reconnecting to';
    case 'error':
      return 'Connection issue with';
    case 'local':
      return 'Disconnected from';
  }
}

function formatLastSeen(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return 'recently';
  }
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}
