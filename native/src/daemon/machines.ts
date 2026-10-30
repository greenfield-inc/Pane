import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

import { RemoteUnconfirmedResultError, type RemoteDaemonClient } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { demoConnection, isDemoProfile } from '@/features/demo/demoHost';
import { sendDirect } from '@/features/notify/notifyActions';

import { CLIENT_LABEL, createDaemonClient, DEVICE_LABEL, getRuntimeId, streamingFetch } from './createClient';
import { useDaemon } from './DaemonProvider';
import { invokeChannel, readChannel, unwrap } from './invoke';

/**
 * Runs `use` with a client for a saved machine that never connects: no event stream, so no
 * terminal output, only the reads `use` makes. Each read is sent once with its own deadline.
 */
export async function withMachineClient<T>(profile: RemotePaneConnectionProfile, use: (client: RemoteDaemonClient) => Promise<T>): Promise<T> {
  const client = createDaemonClient(profile);
  try {
    return await use(client);
  } finally {
    client.disconnect();
  }
}

/**
 * Reads a channel on any saved machine: through the live connection when it is the machine the
 * phone is on, otherwise as one timed read. Keys start with the machine's profile id, as the live
 * hooks' do, so both share one cache entry per machine.
 */
export function useMachineQuery<T>(
  machine: RemotePaneConnectionProfile | null,
  channel: string,
  args: unknown[] = [],
  options?: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>,
) {
  const { profile: current, client } = useDaemon();
  const live = machine?.id === current.id;
  return useQuery<T>({
    ...options,
    queryKey: [machine?.id ?? null, channel, ...args],
    enabled: machine !== null && (options?.enabled ?? true),
    // A timed read already failed for a reason; the person retries by picking the machine again.
    retry: live ? options?.retry : false,
    queryFn: () => {
      if (live || !machine) return invokeChannel<T>(client, channel, args);
      return withMachineClient(machine, other => readChannel<T>(other, channel, args));
    },
  });
}

/** New's create commands, so the sheet can hold its machine and kind while one is in flight. */
export const CREATE_ON_MACHINE = ['create-on-machine'];

/**
 * Sends a command to any saved machine: through the live connection on the machine the phone is
 * on, otherwise straight to that machine's `/invoke`, the way alert buttons answer. Never retried.
 * A lost reply throws `RemoteUnconfirmedResultError` with `unconfirmed` as its message.
 */
export function useMachineCommand() {
  const { profile: current, client } = useDaemon();
  return async <T>(machine: RemotePaneConnectionProfile, channel: string, args: unknown[], unconfirmed: string): Promise<T> => {
    if (machine.id === current.id) return invokeChannel<T>(client, channel, args);
    const sender = {
      // The demo's sample machines answer in the app.
      fetch: isDemoProfile(machine) ? demoConnection().fetch : streamingFetch,
      runtimeId: await getRuntimeId(),
      clientLabel: CLIENT_LABEL,
      deviceLabel: DEVICE_LABEL,
    };
    const sent = await sendDirect(sender, machine, channel, args, {
      unconfirmed,
      refused: `${machine.label} refused it without saying why. Nothing changed. Open Pane on ${machine.label} to do it there.`,
    });
    if (sent.status === 'sent') return unwrap<T>(sent.result, channel);
    if (sent.status === 'unconfirmed') throw new RemoteUnconfirmedResultError(sent.message);
    throw new Error(sent.message);
  };
}
