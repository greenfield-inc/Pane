import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * A browser can't reach a computer on the same Wi-Fi without internet (it needs the relay's DNS),
 * so while this device is offline and not connected it points to the Pane app, which can.
 */
export function RelayOfflineBanner({ relay, connected }: { relay: boolean; connected: boolean }) {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  if (online || !relay || connected) return null;
  return (
    <p role="status" className="fixed inset-x-0 top-0 z-[60] border-b border-border-primary bg-surface-secondary px-4 py-2 text-center text-sm text-text-primary">
      No internet. Open the Pane app to keep working on this Wi-Fi.
    </p>
  );
}
