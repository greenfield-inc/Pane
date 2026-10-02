import { useQueryClient } from '@tanstack/react-query';

import type {
  OrchestrationSessionCreateInput,
  OrchestrationSessionListResult,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '@shared/types/orchestrationSession';

import { useDaemon, useDaemonEvent, useDaemonQueryKey, useInvokeMutation, useInvokeQuery } from '@/daemon';

type SessionView = OrchestrationSessionView<{ id: string; name: string }>;

const LIST = 'orchestration-sessions:list';
const GET = 'orchestration-sessions:get';

/**
 * Every Session on the host, refetched when the host reports a change. Hosts
 * without Sessions answer with "No Pane daemon command registered"; `unavailable`
 * hides the Sessions section there.
 */
export function useSessions() {
  const queryClient = useQueryClient();
  const { profile } = useDaemon();
  const sessions = useInvokeQuery<OrchestrationSessionListResult>(LIST, [], { retry: false });
  useDaemonEvent('orchestration-sessions:changed', () => {
    void queryClient.invalidateQueries({ queryKey: [profile.id, LIST] });
    // An open Session follows the desktop when its agent changes.
    void queryClient.invalidateQueries({ queryKey: [profile.id, GET] });
  });
  const unavailable = sessions.error?.message.includes('No Pane daemon command registered') ?? false;
  return { ...sessions, unavailable };
}

/** A Session with its workspace Pane and agent chat. Never selects it on the host, so the desktop stays put. */
export function useSessionView(sessionId: string) {
  return useInvokeQuery<SessionView>(GET, [{ sessionId }]);
}

/** Pins, unpins, archives or restores a Session, updating the list before the host confirms. */
export function useUpdateSession() {
  const queryClient = useQueryClient();
  const queryKey = useDaemonQueryKey(LIST);
  const mutation = useInvokeMutation<[{ sessionId: string }, OrchestrationSessionUpdateInput]>('orchestration-sessions:update', { invalidates: [LIST] });
  return async (sessionId: string, update: Pick<OrchestrationSessionUpdateInput, 'isPinned' | 'archived'>) => {
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<OrchestrationSessionListResult>(queryKey, list => list && {
      ...list,
      sessions: list.sessions.map(session => session.id === sessionId ? { ...session, ...update, updatedAt: new Date().toISOString() } : session),
    });
    await mutation.mutateAsync([{ sessionId }, update]);
  };
}

/** Creates a Session and starts its agent; the result is cached so the Session opens without another fetch. */
export function useCreateSession() {
  const queryClient = useQueryClient();
  const { profile } = useDaemon();
  const mutation = useInvokeMutation<[OrchestrationSessionCreateInput], SessionView>('orchestration-sessions:create', { invalidates: [LIST] });
  return {
    isPending: mutation.isPending,
    create: async (input: OrchestrationSessionCreateInput) => {
      const view = await mutation.mutateAsync([input]);
      queryClient.setQueryData([profile.id, GET, { sessionId: view.session.id }], view);
      return view;
    },
  };
}
