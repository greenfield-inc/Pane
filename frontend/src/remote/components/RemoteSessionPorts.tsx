import { useMemo } from 'react';
import { SESSION_PORTS_CHANGED_EVENT } from '../../../../shared/types/sessionPorts';
import { SessionPortsChips, SessionPortsLoadError } from '../../components/ports/SessionPortsChips';
import { useSessionPorts } from '../../hooks/useSessionPorts';
import type { SessionPortsTransport } from '../../services/sessionPortsSync';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { RemoteBrowserConnectionState } from '../runtime/remoteDaemonBrowserClient';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';

const noop = () => {};

function createRemoteSessionPortsTransport(adapter: RemoteRuntimeAdapter): SessionPortsTransport {
  return {
    invoke: (channel, args) => adapter.invoke<JsonValue>(channel, args),
    onChanged: listener => adapter.onEvent(event => {
      if (event.channel === SESSION_PORTS_CHANGED_EVENT) listener(decodeOptionalBoundary(event.args[0], boundary.json));
    }),
    // A reconnect arrives through watchHost (null, then the host again).
    onReconnected: () => noop,
    watchHost: listener => {
      // One adapter talks to one saved host; it is that host only while connected.
      const hostOf = (state: RemoteBrowserConnectionState) => (state.status === 'connected' ? adapter.profile.id : null);
      listener(hostOf(adapter.getStatus()));
      return adapter.onStatus(state => listener(hostOf(state)));
    },
  };
}

// A new tab, never this one: the PWA must keep its connection.
function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Session ports of the connected host, for the web client (Remote Pane PWA). */
export function RemoteSessionPorts({ adapter }: { adapter: RemoteRuntimeAdapter | null }) {
  const transport = useMemo(() => (adapter ? createRemoteSessionPortsTransport(adapter) : null), [adapter]);
  const { snapshot, host, state, open, close, retry } = useSessionPorts(transport);
  if (!snapshot) return state.status === 'error' ? <SessionPortsLoadError message={state.message} onRetry={retry} /> : null;
  return <SessionPortsChips key={host} snapshot={snapshot} onOpenUrl={openInNewTab} onPublish={open} onClose={close} />;
}
