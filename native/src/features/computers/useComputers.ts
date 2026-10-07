import { useMutation, useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import type { TailnetMachine } from '@shared/types/workspaceAccess';

import { codelessProfile, decodeMachineList } from '@/auth/computers';
import { useHostsStore } from '@/auth/hostsStore';
import { createDaemonClient } from '@/daemon/createClient';

/** Computers come and go, and a tailnet switch changes the whole list; refresh while it is on screen. */
const REFRESH_MS = 30_000;

/**
 * The computers `directory` can see on its tailnet. A phone can't read `tailscale status`, so it
 * asks a computer it can reach, which answers only if its visibility lets this phone in.
 */
export function useComputers(directory: RemotePaneConnectionProfile | null) {
  return useQuery({
    queryKey: ['computers', directory?.baseUrl ?? null, directory?.token ?? ''],
    enabled: directory !== null,
    refetchInterval: REFRESH_MS,
    retry: false,
    queryFn: async () => {
      if (!directory) throw new Error('No computer to ask');
      const client = createDaemonClient(directory);
      try {
        return decodeMachineList(await client.invoke('runpane:workspaces:machines'));
      } finally {
        client.disconnect();
      }
    },
  });
}

/** Proves a computer lets this phone in (with the password, when it has one), then switches to it. */
export function useConnectComputer(onConnected?: () => void) {
  const addHost = useHostsStore(state => state.add);
  return useMutation({
    mutationFn: async ({ machine, domain, password }: { machine: TailnetMachine; domain: string; password?: string }) => {
      const profile = codelessProfile(machine, domain, password);
      const client = createDaemonClient(profile);
      try {
        await client.invoke('sessions:get-all-with-projects');
      } finally {
        client.disconnect();
      }
      await addHost(profile);
      onConnected?.();
      return profile;
    },
    onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    onError: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  });
}
