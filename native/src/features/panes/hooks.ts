import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PanelAgentStatusEvent } from '@shared/types/agentStatus';
import type { PanePermissionRequest, PanePermissionResponse } from '@shared/types/permissions';
import type { RunpanePaneCreateRequest, RunpanePaneCreateResult, RunpaneWorkspaceStateResult } from '@shared/types/runpaneOrchestration';

import { invokeChannel, useDaemon, useDaemonEvent, useDaemonQueryKey, useInvokeMutation, useInvokeQuery } from '@/daemon';

import { agentStatusFromWorkspace, applyAgentStatusEvent, markSeen, type AgentStatusSnapshot } from './agentStatus';
import type { BranchInfo } from './createPane';
import { toggleFavorite, type ProjectWithPanes } from './paneList';

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
  useDaemonEvent('session:deleted', refetchPanesAndAgents);
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
  const statuses = useQuery<AgentStatusSnapshot>({
    queryKey,
    queryFn: async () => agentStatusFromWorkspace(
      await invokeChannel<RunpaneWorkspaceStateResult>(client, WORKSPACE, [{}]),
      queryClient.getQueryData<AgentStatusSnapshot>(queryKey),
    ),
  });
  useDaemonEvent('panel:agentStatus', event => {
    const status = event.args[0] as PanelAgentStatusEvent | undefined;
    if (!status) return;
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
  return (paneId: string) => {
    queryClient.setQueryData<ProjectWithPanes[]>(queryKey, projects =>
      projects && toggleFavorite(projects, paneId, new Date().toISOString()));
    mutation.mutate([paneId]);
  };
}

/** `sessions:delete` archives: it stops the agents, removes the worktree and keeps the history. */
export function useArchivePane() {
  return useInvokeMutation<[paneId: string]>('sessions:delete', { invalidates: [PANES, ARCHIVED, WORKSPACE] });
}

/** Only archived panes can be deleted for good. */
export function useDeleteArchivedPane() {
  return useInvokeMutation<[paneId: string]>('sessions:permanent-delete', { invalidates: [ARCHIVED] });
}

export function useBranches(projectId: number | undefined) {
  return useInvokeQuery<BranchInfo[]>('projects:list-branches', [String(projectId)], { enabled: projectId !== undefined });
}

/** Creates the worktree and starts the agent in one host call. */
export function useCreatePane() {
  return useInvokeMutation<[RunpanePaneCreateRequest], RunpanePaneCreateResult>('runpane:panes:create', { invalidates: [PANES, WORKSPACE] });
}
