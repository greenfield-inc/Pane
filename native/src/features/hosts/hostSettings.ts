import { useMutation, useQueryClient } from '@tanstack/react-query';

import { RemoteUnconfirmedResultError } from '@shared/remoteClient';
import type { RemotePwaAffordances, RemoteSettingsPatch } from '@shared/types/remoteDaemon';

import { invokeChannel, useDaemon, useDaemonQueryKey, useInvokeQuery } from '@/daemon';

import { requestSharedCredentialSync } from './SharedCredentialSync';

const AFFORDANCES = 'remote:pwa-affordances';

/**
 * The host's shortcuts, voice setup and agents. `DaemonProvider` refetches it
 * whenever any client saves settings on the host.
 */
export function useAffordances() {
  return useInvokeQuery<RemotePwaAffordances>(AFFORDANCES, [], { staleTime: 5 * 60_000 });
}

/** Saves to the host through `remote:settings:update`. Never retried; see `saveErrorMessage`. */
export function useSaveHostSettings() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const queryKey = useDaemonQueryKey(AFFORDANCES);
  return useMutation({
    mutationFn: (patch: RemoteSettingsPatch) => invokeChannel<RemotePwaAffordances>(client, 'remote:settings:update', [patch]),
    onSuccess: (affordances, patch) => {
      queryClient.setQueryData(queryKey, affordances);
      // A key typed for this host goes to the phone's other hosts too.
      if (Object.keys(patch).some(field => field !== 'terminalShortcuts')) requestSharedCredentialSync();
    },
    // The host may have applied a save whose reply was lost; show what it has.
    onError: () => void queryClient.invalidateQueries({ queryKey }),
  });
}

/** A save error as a sentence. Never includes what was sent, which may be a key. */
export function saveErrorMessage(error: unknown, hostLabel: string): string {
  if (error instanceof RemoteUnconfirmedResultError) return 'The connection dropped before the host answered. Check the list: the change may have saved.';
  const message = error instanceof Error ? error.message : String(error);
  if (isUnknownChannelError(message)) return `Update Pane on ${hostLabel} to change this from your phone.`;
  return message;
}

/** Older hosts answer a channel they don't have with this. */
function isUnknownChannelError(message: string): boolean {
  return message.includes('No Pane daemon command registered');
}
