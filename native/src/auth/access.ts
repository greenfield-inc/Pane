import { create } from 'zustand';

import type { RemoteDaemonTransport } from '@shared/remoteClient';
import { withReadyAccess } from '@shared/remoteClient/readyAccess';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

/** What each computer's last ready event said, by profile id. `token` is the pairing it said it for. */
type AccessLevels = Readonly<Record<string, { token: string; readOnly: boolean }>>;

/** Learned on every connect and kept in memory only. It adds to a pairing's own mark and never lifts it: full access comes with a new token. */
export const useAccessStore = create<{ levels: AccessLevels }>(() => ({ levels: {} }));

/**
 * Whether this phone is paired Read only with a computer. Outside a render, leave `levels` out to
 * read the current ones; a component passes the ones it subscribed to.
 */
export function isReadOnlyProfile(profile: RemotePaneConnectionProfile, levels: AccessLevels = useAccessStore.getState().levels): boolean {
  const told = levels[profile.id];
  return profile.access === 'read' || (told !== undefined && told.token === profile.token && told.readOnly);
}

/** The profile with its level as known now, for what reads `access` alone. */
export function withCurrentAccess<T extends RemotePaneConnectionProfile>(profile: T): T {
  return { ...profile, access: isReadOnlyProfile(profile) ? 'read' : undefined };
}

/** The transport, noting the access level in each ready event before the client sees it. */
export function withAccessNoted(profile: RemotePaneConnectionProfile, transport: RemoteDaemonTransport): RemoteDaemonTransport {
  return withReadyAccess(transport, access => noteAccess(profile, access === 'read'));
}

function noteAccess(profile: RemotePaneConnectionProfile, readOnly: boolean): void {
  useAccessStore.setState(({ levels }) => {
    const told = levels[profile.id];
    if (told?.token === profile.token && told.readOnly === readOnly) return { levels };
    return { levels: { ...levels, [profile.id]: { token: profile.token, readOnly } } };
  });
}
