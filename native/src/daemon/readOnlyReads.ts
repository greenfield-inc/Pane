import type { AutopilotSnapshot } from '@shared/types/autopilot';
import type { NotifySharedState } from '@shared/types/notify';
import type { PanePermissionRequest } from '@shared/types/permissions';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { isReadOnlyProfile } from '@/auth/access';

const NOTHING_TO_ANSWER: NotifySharedState = { machine: '', epoch: '', revision: 0, enabled: false, items: [], queue: [], hidden: [] };
const NO_PERMISSIONS: PanePermissionRequest[] = [];
const NO_AUTOPILOT: AutopilotSnapshot = {
  enabled: false, chatTabsEnabled: false, entitlement: { entitled: false },
  run: null, panelId: null, ownerPaneId: null, state: 'stopped', sentinel: false,
  stack: { entries: [], shownId: null }, walk: { sessions: [] },
};

/** Reads the app makes on every computer that a read-only one refuses, and what stands in for each, so lists load without asking. */
const ANSWERS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['notify:remote-snapshot', NOTHING_TO_ANSWER],
  ['permission:getPending', NO_PERMISSIONS],
  ['autopilot:snapshot', NO_AUTOPILOT],
]);

/** Reads a channel, or answers it here when this phone is paired Read only with the computer and it would refuse. */
export function readUnlessRefused<T>(profile: RemotePaneConnectionProfile, channel: string, read: () => Promise<T>): Promise<T> {
  // SAFETY: each stand-in above holds what its channel's readers use when it has nothing to show.
  return ANSWERS.has(channel) && isReadOnlyProfile(profile) ? Promise.resolve(ANSWERS.get(channel) as T) : read();
}
