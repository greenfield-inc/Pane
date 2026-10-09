import { LogOut, Menu } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RemotePaneConnectionProfile, RemotePaneConnectionStatus } from '../../../../shared/types/remoteDaemon';

interface RemoteStatusBarProps {
  profile: RemotePaneConnectionProfile;
  /** The open Pane or Session. The header falls back to the host when nothing is open. */
  openName: string | null;
  status: RemotePaneConnectionStatus;
  lastError: string | null;
  lastSeenAt: string | null;
  onDisconnect: () => void;
  onOpenSidebar: () => void;
}

export function RemoteStatusBar({
  profile,
  openName,
  status,
  lastError,
  lastSeenAt,
  onDisconnect,
  onOpenSidebar,
}: RemoteStatusBarProps) {
  const connected = status === 'connected';
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
          <p className="truncate text-sm font-semibold text-text-primary">{title}</p>
          <p className="truncate text-xs text-text-tertiary">
            {lastError || hostDetail}
            {lastSeenAt ? ` · seen ${formatLastSeen(lastSeenAt)}` : ''}
          </p>
        </div>
      </div>
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
