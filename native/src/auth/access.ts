import { create } from 'zustand';

import type { RemoteDaemonTransport } from '@shared/remoteClient';
import { readOnlyMarkSchema } from '@shared/types/accessLevel';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import { boundary, decodeOptionalBoundary, type JsonValue } from '@shared/validation/boundaryDecoder';

/** What each computer's last ready event said, by profile id. `token` is the pairing it said it for. */
type AccessLevels = Readonly<Record<string, { token: string; readOnly: boolean }>>;

/** Learned on every connect and kept in memory only; until a computer answers, its pairing's own mark decides. */
export const useAccessStore = create<{ levels: AccessLevels }>(() => ({ levels: {} }));

/**
 * Whether this phone is paired Read only with a computer. Outside a render, leave `levels` out to
 * read the current ones; a component passes the ones it subscribed to.
 */
export function isReadOnlyProfile(profile: RemotePaneConnectionProfile, levels: AccessLevels = useAccessStore.getState().levels): boolean {
  const told = levels[profile.id];
  return told && told.token === profile.token ? told.readOnly : profile.access === 'read';
}

const readySchema = boundary.object({ access: boundary.optional(readOnlyMarkSchema) });

/** The transport, noting the access level in each ready event before the client sees it. */
export function withAccessNoted(profile: RemotePaneConnectionProfile, transport: RemoteDaemonTransport): RemoteDaemonTransport {
  return {
    invokeRequest: (context, channel, args) => transport.invokeRequest(context, channel, args),
    openEventStream: context => transport.openEventStream({
      ...context,
      onEvent: event => {
        if (event.event === 'ready') noteReady(profile, event.data);
        context.onEvent(event);
      },
    }),
  };
}

/** A host that sends no level (an older Pane) gives full access. */
function noteReady(profile: RemotePaneConnectionProfile, data: string): void {
  const readOnly = decodeOptionalBoundary(parseJson(data), readySchema)?.access === 'read';
  useAccessStore.setState(({ levels }) => {
    const told = levels[profile.id];
    if (told?.token === profile.token && told.readOnly === readOnly) return { levels };
    return { levels: { ...levels, [profile.id]: { token: profile.token, readOnly } } };
  });
}

function parseJson(data: string): JsonValue | undefined {
  try {
    return JSON.parse(data) as JsonValue;
  } catch {
    return undefined;
  }
}
