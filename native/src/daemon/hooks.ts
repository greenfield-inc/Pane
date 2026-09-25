import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect, useEffectEvent } from 'react';

import type { RemoteDaemonEventEnvelope } from '@shared/types/remoteDaemon';

import { useDaemon } from './DaemonProvider';
import { invokeChannel } from './invoke';

/**
 * @public
 * Query keys start with the host's profile ID so hosts never share cache entries. */
export function useDaemonQueryKey(channel: string, args: unknown[] = []): unknown[] {
  const { profile } = useDaemon();
  return [profile.id, channel, ...args];
}

/** Reads a daemon channel through TanStack Query. */
export function useInvokeQuery<T>(
  channel: string,
  args: unknown[] = [],
  options?: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>,
) {
  const { client } = useDaemon();
  const queryKey = useDaemonQueryKey(channel, args);
  return useQuery<T>({ ...options, queryKey, queryFn: () => invokeChannel<T>(client, channel, args) });
}

/**
 * @public
 * Calls a mutating daemon channel. Mutations are never retried: the host may
 * have applied one whose response was lost (RemoteUnconfirmedResultError).
 */
export function useInvokeMutation<TArgs extends unknown[], TResult = unknown>(
  channel: string,
  options?: { invalidates?: string[] },
) {
  const { client, profile } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) => invokeChannel<TResult>(client, channel, args),
    onSettled: () => Promise.all((options?.invalidates ?? []).map(invalidated =>
      queryClient.invalidateQueries({ queryKey: [profile.id, invalidated] }))),
  });
}

/**
 * @public
 * Subscribes to one daemon event channel (e.g. `panel:agentStatus`) while mounted. */
export function useDaemonEvent(channel: string, handler: (event: RemoteDaemonEventEnvelope) => void): void {
  const { client } = useDaemon();
  const onEvent = useEffectEvent(handler);
  useEffect(() => client.onEvent(event => {
    if (event.type === 'daemon-event' && event.payload.channel === channel) onEvent(event.payload);
  }), [client, channel]);
}
