import { useQueryClient } from '@tanstack/react-query';

import { isOlderPane } from '@shared/glassesRevoke';
import { decodeListeningPortsSnapshot, type ListeningPortsSnapshot } from '@shared/types/listeningPorts';

import { useDaemonEvent, useDaemonQueryKey, useInvokeQuery } from '@/daemon';

import type { PortsRead } from './browserPage';

/** The computer's listening ports and phone addresses, kept current by `ports:changed`. */
export function usePorts(): PortsRead & { error: unknown; refetch: () => void } {
  const queryClient = useQueryClient();
  const key = useDaemonQueryKey('ports:list');
  const query = useInvokeQuery<ListeningPortsSnapshot | null>('ports:list', [], {
    select: decodeListeningPortsSnapshot,
    // An older computer has no ports:list; asking again will not change that.
    retry: (count, error) => !isOlderPane(error) && count < 2,
  });
  useDaemonEvent('ports:changed', event => {
    const next = decodeListeningPortsSnapshot(event.args[0]);
    if (next) queryClient.setQueryData(key, next);
  });
  const olderPane = query.isError && isOlderPane(query.error);
  return {
    ports: query.data ?? null,
    olderPane,
    error: query.isError && !olderPane ? query.error : null,
    refetch: () => void query.refetch(),
  };
}
