import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { NotifyRemoteCommand, NotifySharedState } from '@shared/types/notify';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { useDaemon, useDaemonEvent, useInvokeMutation, useInvokeQuery } from '@/daemon';
import { useMachineCommand, useMachineQuery } from '@/daemon/machines';
import { dismissNotifyAlerts } from '@/features/notifications/device';

import { waitingQuestions } from './notifyQuestions';

const SNAPSHOT = 'notify:remote-snapshot';

/** The host's Notify questions, refetched whenever any screen asks, answers or undoes one. */
export function useNotifyShared() {
  const queryClient = useQueryClient();
  const { profile } = useDaemon();
  const shared = useInvokeQuery<NotifySharedState>(SNAPSHOT);
  useDaemonEvent('notify:shared-changed', () => void queryClient.invalidateQueries({ queryKey: [profile.id, SNAPSHOT] }));
  return shared;
}

/**
 * Answers, Undo and the rest; the host fills in this phone's name as the sender. Each stays
 * pending until the snapshot refetches, so an Undo shows as pending until the host confirms it.
 */
export function useNotifyCommand(onAccepted?: (command: NotifyRemoteCommand) => void) {
  return useInvokeMutation<[NotifyRemoteCommand]>('notify:remote-command', { invalidates: [SNAPSHOT], onAccepted: ([command]) => onAccepted?.(command) });
}

/**
 * Another saved machine's questions, read without switching to it, refreshed every few seconds
 * while a sheet shows one. Off (and empty) for `null`.
 */
export function useMachineNotifyShared(machine: RemotePaneConnectionProfile | null) {
  return useMachineQuery<NotifySharedState>(machine, SNAPSHOT, [], { refetchInterval: 5_000 });
}

/**
 * Answers and Undo for another saved machine's question, sent straight to it the way alert
 * buttons answer, so the phone stays on the machine it's on.
 */
export function useMachineNotifyCommand(machine: RemotePaneConnectionProfile | null, onAccepted?: (command: NotifyRemoteCommand) => void) {
  const queryClient = useQueryClient();
  const send = useMachineCommand();
  return useMutation({
    mutationFn: async ([command]: [NotifyRemoteCommand]) => {
      if (!machine) throw new Error('No machine to answer on. Nothing was sent.');
      await send(machine, 'notify:remote-command', [command], `Your answer may have reached ${machine.label}. Check the question before answering again.`);
    },
    onSuccess: (_result, [command]) => onAccepted?.(command),
    // The question leaves the sheet and All machines once its machine says so.
    onSettled: () => (machine ? queryClient.invalidateQueries({ queryKey: [machine.id] }) : undefined),
  });
}

/** Removes this host's question alerts once the snapshot shows them answered or gone (D-11's in-app half). */
export function useClearResolvedNotifyAlerts() {
  const { profile } = useDaemon();
  const shared = useNotifyShared();
  useEffect(() => {
    if (!shared.data) return;
    const waiting = new Set(waitingQuestions(shared.data).map(item => item.id));
    void dismissNotifyAlerts(push => push.host === profile.id && !waiting.has(push.notifyId));
  }, [shared.data, profile.id]);
}
