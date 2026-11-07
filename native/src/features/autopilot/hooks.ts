import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import type { AutopilotSnapshot } from '@shared/types/autopilot';

import { invokeChannel, useDaemon, useDaemonEvent, useInvokeMutation, useInvokeQuery } from '@/daemon';

import { autopilotUnsupported } from './autopilot';

const SNAPSHOT = 'autopilot:snapshot';

/**
 * Autopilot on the connected computer, refetched when it changes there (`autopilot:changed`).
 * `unsupported`: the computer's Pane predates Autopilot, so home shows no row.
 */
export function useAutopilot() {
  const queryClient = useQueryClient();
  const { profile } = useDaemon();
  const snapshot = useInvokeQuery<AutopilotSnapshot>(SNAPSHOT, [], { retry: false });
  useDaemonEvent('autopilot:changed', () => void queryClient.invalidateQueries({ queryKey: [profile.id, SNAPSHOT] }));
  return { ...snapshot, unsupported: autopilotUnsupported(snapshot.error) };
}

/** Start, Pause and Go on: the same commands as the desktop's buttons. Never retried. */
export function useAutopilotControl(action: 'start' | 'pause' | 'go-on') {
  return useInvokeMutation<[]>(`autopilot:${action}`, { invalidates: [SNAPSHOT] });
}

/** Sentinel Mode's toggle (package 7): the same command as the desktop header's. Turning it on also starts Autopilot. */
export function useAutopilotSentinel() {
  return useInvokeMutation<[boolean]>('autopilot:sentinel', { invalidates: [SNAPSHOT] });
}

/**
 * Tells the computer the person is looking at Autopilot: when the screen opens and when the app
 * comes back to the front on it. With Sentinel on, that is how they return for the While you were
 * away card (J29); otherwise nothing happens. An older Pane without the channel is ignored.
 */
export function useAutopilotOpened() {
  const { client } = useDaemon();
  useEffect(() => {
    const opened = () => { void invokeChannel(client, 'autopilot:opened').catch(() => undefined); };
    opened();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') opened(); });
    return () => subscription.remove();
  }, [client]);
}
