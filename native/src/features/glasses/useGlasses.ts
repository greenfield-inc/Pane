import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';

import { revokeGlassesOnComputers } from '@shared/glassesRevoke';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

import { useActiveHost, useHostsStore } from '@/auth/hostsStore';
import { secureStore } from '@/auth/secureStore';
import { createDaemonClient, DEVICE_LABEL, getRuntimeId } from '@/daemon/createClient';
import { invokeChannel } from '@/daemon/invoke';
import { useComputers } from '@/features/computers/useComputers';

import {
  createGlassesPairingCode,
  glassesDeviceName,
  listGlassesOnComputers,
  pairableComputers,
  type GlassesInvoke,
} from './glassesPairing';

/** Full DNS names of computers a revoke could not reach yet; retried each time Settings › Glasses opens. */
const PENDING_REVOKES_KEY = 'pane.glasses.pendingRevokes';

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * One call on one computer. The client sends commands only once connected (reads aside), so it
 * connects first and waits for its stream, then disconnects.
 */
const invoke: GlassesInvoke = async (profile, channel, args) => {
  const client = createDaemonClient(profile);
  try {
    await client.connect();
    await new Promise<void>((resolve, reject) => {
      let stop = () => {};
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`${profile.label} did not connect within ${CONNECT_TIMEOUT_MS / 1000} s`));
      }, CONNECT_TIMEOUT_MS);
      stop = client.onStatus(state => {
        if (state.status !== 'connected') return;
        clearTimeout(timer);
        queueMicrotask(() => stop());
        resolve();
      });
    });
    return await invokeChannel(client, channel, args);
  } finally {
    client.disconnect();
  }
};

async function readPending(): Promise<string[]> {
  try {
    return decodeOptionalBoundary(JSON.parse((await secureStore.getItem(PENDING_REVOKES_KEY)) ?? '[]'), boundary.array(boundary.string)) ?? [];
  } catch {
    return [];
  }
}

/**
 * Settings › Glasses: the computers on this phone's Tailscale login, these glasses on each, and
 * pairing and revoking across all of them at once.
 */
export function useGlasses() {
  const queryClient = useQueryClient();
  const active = useActiveHost();
  const profiles = useHostsStore(state => state.profiles);
  const directory: RemotePaneConnectionProfile | null = active?.tailnetMachine
    ? active
    : profiles.find(profile => profile.tailnetMachine) ?? null;
  const machines = useComputers(directory);
  const list = machines.data?.ok ? machines.data : null;
  const { computers, skipped } = list ? pairableComputers(list.machines, list.domain, profiles) : { computers: [], skipped: [] };
  const deviceName = glassesDeviceName(DEVICE_LABEL, Platform.OS === 'ios' ? 'ios' : 'android');
  const names = computers.map(computer => computer.machine.name).join(',');

  const paired = useQuery({
    queryKey: [directory?.id ?? null, 'runpane:glasses:list', names],
    enabled: computers.length > 0,
    queryFn: async () => {
      const phoneId = await getRuntimeId();
      const pending = await readPending();
      // A revoke that couldn't reach a computer earlier finishes once it answers.
      const reachablePending = computers.filter(computer => pending.includes(computer.machine.dnsName));
      if (reachablePending.length > 0) {
        const result = await revokeGlassesOnComputers(reachablePending, pending, phoneId, invoke);
        await secureStore.setItem(PENDING_REVOKES_KEY, JSON.stringify(result.pending));
      }
      return { computers: await listGlassesOnComputers(computers, phoneId, invoke), pending: await readPending() };
    },
  });

  const pair = useMutation({
    mutationFn: async () => {
      const result = await createGlassesPairingCode(computers, { name: deviceName, id: await getRuntimeId() }, invoke);
      if (result.code) await Clipboard.setStringAsync(result.code);
      return result;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [directory?.id ?? null, 'runpane:glasses:list'] }),
  });

  const revoke = useMutation({
    mutationFn: async () => {
      const result = await revokeGlassesOnComputers(computers, await readPending(), await getRuntimeId(), invoke);
      // Offline computers are revoked when they next answer.
      const unseen = skipped.filter(skip => skip.reason === 'offline').map(skip => skip.dnsName);
      await secureStore.setItem(PENDING_REVOKES_KEY, JSON.stringify([...new Set([...result.pending, ...unseen])].sort()));
    },
    // The screen shows what is still pending from the refreshed list, once it has refreshed.
    onSettled: () => queryClient.invalidateQueries({ queryKey: [directory?.id ?? null, 'runpane:glasses:list'] }),
  });

  return { directory, machines, computers, skipped, deviceName, paired, pair, revoke };
}
