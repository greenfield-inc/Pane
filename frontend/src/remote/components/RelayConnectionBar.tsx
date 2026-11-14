import { useSyncExternalStore } from 'react';
import { CONNECTION_GRACE_MS, connectionNotice } from '../../../../shared/remoteClient/connectionPresence';
import type { RemotePaneConnectionProfile, RemotePaneConnectionStatus } from '../../../../shared/types/remoteDaemon';
import { useConnectionPresence } from '../../hooks/useConnectionPresence';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * The one-line bar for a computer reached through Pane's servers, worded as in the Pane app: it
 * stays up while the computer can't be reached and goes away on its own when the connection returns.
 * A browser can't reach a computer on the same Wi-Fi without internet (it needs internet DNS), so
 * while this device is offline it points to the Pane app, which can.
 */
export function RelayConnectionBar({ profile, status, lastError }: {
  profile: RemotePaneConnectionProfile | undefined;
  status: RemotePaneConnectionStatus;
  lastError: string | null;
}) {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  const { presence } = useConnectionPresence({
    mode: 'remote', status, lastError, activeProfileId: null, activeProfileLabel: null, activeBaseUrl: null, lastSeenAt: null,
  });
  if (!profile?.relay || status === 'connected') return null;
  // `local` is no connection at all, such as the connect screen: nothing is being retried.
  const message = !online
    ? 'No internet. Open the Pane app to keep working on this Wi-Fi.'
    : status === 'local'
      ? null
      : connectionNotice({ status, lastError }, presence === 'reconnecting' ? 0 : CONNECTION_GRACE_MS, profile.label, { asleepSince: null })?.message;
  if (!message) return null;
  return (
    <p role="status" className="border-b border-border-primary bg-surface-secondary px-4 py-2 text-center text-sm text-text-primary">
      {message}
    </p>
  );
}
