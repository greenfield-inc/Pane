import { useConfigStore } from '../stores/configStore';
import { sessionHostFor } from '../utils/moveSessionToHost';

/** Why "Move to host…" can't run for the host on screen, or null when it can. */
export function useMoveToHostBlockedReason(): string | null {
  const host = sessionHostFor(useConfigStore(state => state.config?.remoteDaemon));
  return host.kind === 'paired' ? host.reason : null;
}
