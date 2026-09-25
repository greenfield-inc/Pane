import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';

import type { RemoteMobilePushStatus } from '@shared/types/remoteDaemon';

import { invokeChannel, useDaemon, useDaemonQueryKey } from '@/daemon';

import { devicePush, getInstallationId } from './device';
import { registerForPush, type PushSetupResult } from './registration';

const SETUP_KEY = 'push-setup';

// The stream's first `ready` invalidates every query while the mount's
// registration may still be waiting on the permission prompt. Share that run.
const inFlight = new Map<string, Promise<PushSetupResult>>();

/**
 * This phone's notification registration with the active host. The first
 * mount registers (asking for permission once), and so does every reconnect,
 * because `DaemonProvider` refetches the host's queries when the stream opens.
 */
export function usePushSetup() {
  const { client, profile } = useDaemon();
  const queryClient = useQueryClient();
  const query = useQuery<PushSetupResult>({
    queryKey: [profile.id, SETUP_KEY],
    queryFn: () => {
      const running = inFlight.get(profile.id);
      if (running) return running;
      const run = registerForPush({ ...devicePush, invoke: (channel, args) => invokeChannel(client, channel, args) }, profile.id)
        .finally(() => inFlight.delete(profile.id));
      inFlight.set(profile.id, run);
      return run;
    },
    staleTime: Infinity,
    retry: false,
    // Coming back from the Settings app may have turned notifications on.
    refetchOnWindowFocus: current => (current.state.data?.state === 'denied' ? 'always' : false),
  });

  useEffect(() => {
    // APNs and FCM can rotate a token while the app runs.
    const subscription = Notifications.addPushTokenListener(() => void queryClient.invalidateQueries({ queryKey: [profile.id, SETUP_KEY] }));
    return () => subscription.remove();
  }, [queryClient, profile.id]);

  return query;
}

/** Turns one alert kind on or off for this phone on the active host. */
export function usePushControls() {
  const { client } = useDaemon();
  const queryKey = useDaemonQueryKey(SETUP_KEY);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (controls: { needsInputEnabled?: boolean; completedEnabled?: boolean }) =>
      invokeChannel<RemoteMobilePushStatus>(client, 'mobile:push-controls', [
        { platform: devicePush.platform, installationId: await getInstallationId(), ...controls },
      ]),
    onSuccess: (status: RemoteMobilePushStatus) => {
      const next: PushSetupResult = { state: 'registered', status };
      queryClient.setQueryData(queryKey, next);
    },
    // The host may have applied a change whose response was lost: show what it has.
    onError: () => queryClient.invalidateQueries({ queryKey }),
  });
}

/** Best effort: stops this host from sending to this phone before its token is deleted. */
export async function revokePush(client: Parameters<typeof invokeChannel>[0], hostProfileId: string): Promise<void> {
  const revoke = getInstallationId().then(installationId =>
    invokeChannel(client, 'mobile:push-revoke', [{ platform: devicePush.platform, installationId, hostProfileId }]));
  await Promise.race([revoke, new Promise(resolve => setTimeout(resolve, 3_000))]).catch(() => undefined);
}
