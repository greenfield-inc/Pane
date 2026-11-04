import { useEffect, useState } from 'react';
import { useConnectionPresence } from '../hooks/useConnectionPresence';
import { useRemoteRuntimeState } from '../hooks/useRemoteRuntimeState';
import { API } from '../utils/api';
import { stripIpcWrapper } from '../utils/ipcErrorMessage';

/** How long a delivery warning stays once the connection is back. */
const DELIVERY_UNKNOWN_CLEAR_MS = 8_000;

export function RemoteConnectionBanner({ onSettings }: { onSettings: () => void }) {
  const { connectionState: state } = useRemoteRuntimeState();
  // Empty inside the grace window: the dimmed workspace and pulsing dot say enough.
  const { notice } = useConnectionPresence(state);
  const [retrying, setRetrying] = useState(false);
  const [unknownDelivery, setUnknownDelivery] = useState<string | null>(null);
  const connected = state.mode !== 'remote' || state.status === 'connected';
  useEffect(() => {
    const listener = (event: Event) => setUnknownDelivery(event instanceof CustomEvent ? stripIpcWrapper(String(event.detail)) : 'Delivery unknown: check the original host before resubmitting.');
    window.addEventListener('remote-delivery-unknown', listener);
    return () => window.removeEventListener('remote-delivery-unknown', listener);
  }, []);
  useEffect(() => {
    if (!unknownDelivery || !connected) return;
    const timer = setTimeout(() => setUnknownDelivery(null), DELIVERY_UNKNOWN_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [unknownDelivery, connected]);
  // The connection checklist card speaks for the connection while it shows.
  const checkShowing = Boolean(state.check && state.check.outcome !== 'passed');
  const updateIntent = connected ? null : state.updateIntent ?? null;
  const connectionProblem = !connected && !checkShowing && (updateIntent !== null || notice !== null);
  const canRetry = updateIntent !== null || Boolean(notice?.canRetry);
  if (!unknownDelivery && !connectionProblem) return null;
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try { await API.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: state.activeProfileId }); }
    catch (error) { console.warn('Remote retry failed:', error); }
    finally { setRetrying(false); }
  };
  return (
    <div role="status" className="flex shrink-0 items-center justify-between gap-4 border-b border-border-primary bg-surface-secondary px-4 py-2 text-sm text-text-primary">
      <div>
        <strong>{unknownDelivery ? 'Delivery unknown' : updateIntent ? 'Updating remote Pane. Your Session is saved; reconnecting automatically.' : notice?.message}</strong>
        {unknownDelivery
          ? <p className="text-xs text-text-secondary">{unknownDelivery}</p>
          : updateIntent && <p className="text-xs text-text-secondary">{`Operation ${updateIntent.id}. Last confirmed: checkpoint saved.`}</p>}
      </div>
      <div className="flex shrink-0 gap-3">
        {unknownDelivery && <button type="button" onClick={() => setUnknownDelivery(null)}>Dismiss</button>}
        {connectionProblem && canRetry && <button type="button" disabled={retrying || state.status === 'restoring'} onClick={() => void retry()}>Retry now</button>}
        <button type="button" onClick={onSettings}>Connection settings</button>
      </div>
    </div>
  );
}
