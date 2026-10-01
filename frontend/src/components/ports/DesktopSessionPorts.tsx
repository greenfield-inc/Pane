import { useMemo } from 'react';
import type { RemotePaneConnectionState } from '../../../../shared/types/remoteDaemon';
import { useSessionPorts } from '../../hooks/useSessionPorts';
import type { SessionPortsTransport } from '../../services/sessionPortsSync';
import { SessionPortsChips, SessionPortsLoadError } from './SessionPortsChips';

const noop = () => {};

/** One key per daemon the desktop can be connected to; null while it is between hosts or failed. */
function connectedHostKey(state: Pick<RemotePaneConnectionState, 'status' | 'activeProfileId'>): string | null {
  if (state.status === 'local') return 'local';
  if (state.status === 'connected' && state.activeProfileId) return `remote:${state.activeProfileId}`;
  return null;
}

/** Session ports of the daemon this desktop is connected to (local or the active remote host). */
function createDesktopSessionPortsTransport(): SessionPortsTransport {
  const api = window.electronAPI;
  return {
    invoke: (channel, args) => api.invoke(channel, ...args),
    onChanged: listener => api.events.onSessionPortsChanged?.(listener) ?? noop,
    onReconnected: listener => api.events.onRemoteDaemonResyncRequested(listener),
    watchHost: listener => {
      let pushed = false;
      const unsubscribe = api.remoteDaemon.onConnectionStateChanged(state => {
        pushed = true;
        listener(connectedHostKey(state));
      });
      // A pushed state is newer than this read: it wins.
      void api.remoteDaemon.getConnectionState().then(response => {
        if (!pushed && response.success && response.data) listener(connectedHostKey(response.data));
      }, noop);
      return unsubscribe;
    },
  };
}

async function openInDefaultBrowser(url: string): Promise<void> {
  const result = await window.electronAPI.openExternal(url);
  if (!result.success) throw new Error(result.error ?? `Could not open ${url}`);
}

export function DesktopSessionPorts({ variant = 'row', className }: { variant?: 'row' | 'inline'; className?: string }) {
  const transport = useMemo(createDesktopSessionPortsTransport, []);
  const { snapshot, host, state, open, close, retry } = useSessionPorts(transport);
  if (!snapshot) {
    return state.status === 'error'
      ? <SessionPortsLoadError message={state.message} onRetry={retry} variant={variant} className={className} />
      : null;
  }
  return (
    <SessionPortsChips
      // A new host starts with no pending confirmation, busy chip or error from the old one.
      key={host}
      snapshot={snapshot}
      onOpenUrl={openInDefaultBrowser}
      onPublish={open}
      onClose={close}
      variant={variant}
      className={className}
    />
  );
}
