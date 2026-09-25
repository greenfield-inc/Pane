import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import type { PanelAgentStatusEvent } from '@shared/types/agentStatus';
import type { PanePermissionRequest, PanePermissionResponse } from '@shared/types/permissions';
import type { RunpanePaneCreateRequest, RunpanePaneCreateResult, RunpaneWorkspaceStateResult } from '@shared/types/runpaneOrchestration';

import { invokeChannel, useDaemon, useDaemonEvent, useDaemonQueryKey, useInvokeMutation, useInvokeQuery } from '@/daemon';

import { agentStatusFromWorkspace, applyAgentStatusEvent, markSeen, type AgentStatusSnapshot } from './agentStatus';
import type { BranchInfo } from './createPane';
import { removePane, toggleFavorite, type ProjectWithPanes } from './paneList';

const PANES = 'sessions:get-all-with-projects';
const ARCHIVED = 'sessions:get-archived-with-projects';
const WORKSPACE = 'runpane:workspace:state';
const PERMISSIONS = 'permission:getPending';

/** Projects with their panes, refetched whenever the host adds, changes or removes one. */
export function useProjects() {
  const queryClient = useQueryClient();
  const { profile } = useDaemon();
  const projects = useInvokeQuery<ProjectWithPanes[]>(PANES);
  const refetchPanes = () => void queryClient.invalidateQueries({ queryKey: [profile.id, PANES] });
  const refetchPanesAndAgents = () => {
    refetchPanes();
    // New panes bring new agent panels; the snapshot knows which agent each runs.
    void queryClient.invalidateQueries({ queryKey: [profile.id, WORKSPACE] });
  };
  useDaemonEvent('session:created', refetchPanesAndAgents);
  useDaemonEvent('session:deleted', () => {
    refetchPanesAndAgents();
    // Archiving emits session:deleted, so the Archived screen needs it too.
    void queryClient.invalidateQueries({ queryKey: [profile.id, ARCHIVED] });
  });
  useDaemonEvent('session:updated', refetchPanes);
  useDaemonEvent('project:updated', refetchPanes);
  return projects;
}

export function useArchivedProjects() {
  return useInvokeQuery<ProjectWithPanes[]>(ARCHIVED);
}

/** Every pane's agent status: a snapshot on (re)connect, then live `panel:agentStatus` events. */
export function useAgentStatuses() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const queryKey = useDaemonQueryKey(WORKSPACE);
  // Events that arrive while a snapshot is in flight may be newer than it.
  const eventsDuringFetch = useRef<PanelAgentStatusEvent[] | null>(null);
  const statuses = useQuery<AgentStatusSnapshot>({
    queryKey,
    queryFn: async () => {
      eventsDuringFetch.current = [];
      try {
        const workspace = await invokeChannel<RunpaneWorkspaceStateResult>(client, WORKSPACE, [{}]);
        const snapshot = agentStatusFromWorkspace(workspace, queryClient.getQueryData<AgentStatusSnapshot>(queryKey));
        return eventsDuringFetch.current.reduce(applyAgentStatusEvent, snapshot);
      } finally {
        eventsDuringFetch.current = null;
      }
    },
  });
  useDaemonEvent('panel:agentStatus', event => {
    const status = event.args[0] as PanelAgentStatusEvent | undefined;
    if (!status) return;
    eventsDuringFetch.current?.push(status);
    // Before the first snapshot lands there is nothing to update; the snapshot includes this state.
    queryClient.setQueryData<AgentStatusSnapshot>(queryKey, snapshot => snapshot && applyAgentStatusEvent(snapshot, status));
  });
  return statuses;
}

/** Clears a pane's Ready badge once it has been opened on this phone. */
export function useMarkPaneSeen() {
  const queryClient = useQueryClient();
  const queryKey = useDaemonQueryKey(WORKSPACE);
  return (paneId: string) => {
    queryClient.setQueryData<AgentStatusSnapshot>(queryKey, snapshot => snapshot && markSeen(snapshot, paneId));
  };
}

export function usePendingPermissions() {
  const queryClient = useQueryClient();
  const { profile } = useDaemon();
  const pending = useInvokeQuery<PanePermissionRequest[]>(PERMISSIONS);
  const refetch = () => void queryClient.invalidateQueries({ queryKey: [profile.id, PERMISSIONS] });
  useDaemonEvent('permission:request', refetch);
  useDaemonEvent('permission:resolved', refetch);
  return pending;
}

export function useRespondToPermission() {
  return useInvokeMutation<[requestId: string, response: PanePermissionResponse]>('permission:respond', { invalidates: [PERMISSIONS] });
}

/** Stars or unstars a pane, updating the list before the host confirms. */
export function useToggleFavorite() {
  const queryClient = useQueryClient();
  const queryKey = useDaemonQueryKey(PANES);
  const mutation = useInvokeMutation<[paneId: string]>('sessions:toggle-favorite', { invalidates: [PANES] });
  return async (paneId: string) => {
    // A refetch already in flight would land after this write and undo it.
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<ProjectWithPanes[]>(queryKey, projects =>
      projects && toggleFavorite(projects, paneId, new Date().toISOString()));
    await mutation.mutateAsync([paneId]);
  };
}

/**
 * `sessions:delete` archives: it stops the agents, removes the worktree and
 * keeps the history. The row leaves the list at once; a failure brings it back.
 */
export function useArchivePane() {
  return useOptimisticRemoval('sessions:delete', PANES, [PANES, ARCHIVED, WORKSPACE]);
}

/** Only archived panes can be deleted for good. */
export function useDeleteArchivedPane() {
  return useOptimisticRemoval('sessions:permanent-delete', ARCHIVED, [ARCHIVED]);
}

function useOptimisticRemoval(channel: string, list: string, invalidates: string[]) {
  const queryClient = useQueryClient();
  const queryKey = useDaemonQueryKey(list);
  const mutation = useInvokeMutation<[paneId: string]>(channel, { invalidates });
  return async (paneId: string) => {
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<ProjectWithPanes[]>(queryKey, projects => projects && removePane(projects, paneId));
    await mutation.mutateAsync([paneId]);
  };
}

export function useBranches(projectId: number | undefined) {
  return useInvokeQuery<BranchInfo[]>('projects:list-branches', [String(projectId)], { enabled: projectId !== undefined });
}

/** Creates the worktree and starts the agent in one host call. */
export function useCreatePane() {
  return useInvokeMutation<[RunpanePaneCreateRequest], RunpanePaneCreateResult>('runpane:panes:create', { invalidates: [PANES, WORKSPACE] });
}
