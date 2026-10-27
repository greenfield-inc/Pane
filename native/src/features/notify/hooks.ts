import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { NotifyRemoteCommand, NotifySharedState } from '@shared/types/notify';

import { useDaemon, useDaemonEvent, useInvokeMutation, useInvokeQuery } from '@/daemon';
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

/** Answers, Undo and the rest; the host fills in this phone's name as the sender. */
export function useNotifyCommand() {
  return useInvokeMutation<[NotifyRemoteCommand]>('notify:remote-command', { invalidates: [SNAPSHOT] });
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
