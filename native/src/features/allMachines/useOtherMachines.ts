import { useQueries } from '@tanstack/react-query';

import type { NotifySharedState } from '@shared/types/notify';
import type { OrchestrationSessionListResult } from '@shared/types/orchestrationSession';
import type { PanePermissionRequest } from '@shared/types/permissions';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import type { RunpaneWorkspaceStateResult } from '@shared/types/runpaneOrchestration';

import { queryClient } from '@/daemon';
import { readChannel } from '@/daemon/invoke';
import { withMachineClient } from '@/daemon/machines';
import { agentStatusFromWorkspace } from '@/features/panes/agentStatus';
import type { ProjectWithPanes } from '@/features/panes/paneList';
import { sessionsUnavailable } from '@/features/sessions/hooks';

import type { MachineSnapshot } from './allMachinesList';

/** How often All machines reads every machine the phone isn't on, while it is on screen. */
const ALL_MACHINES_REFRESH_MS = 15_000;
const SNAPSHOT = 'all-machines:snapshot';

export interface OtherMachine {
  profile: RemotePaneConnectionProfile;
  snapshot: MachineSnapshot | undefined;
  /** The last read failed or timed out. */
  unreachable: boolean;
  /** Epoch ms of the last read that answered; 0 before the first. */
  readAt: number;
  refetch(): Promise<unknown>;
}

/**
 * Home's lists from every saved machine the phone isn't on, without connecting to them: five reads
 * each, every 15 s while `enabled`, each read with its own deadline, so a slow or offline machine
 * never holds up another. TanStack Query pauses the timer while the app is in the background.
 */
export function useOtherMachines(profiles: readonly RemotePaneConnectionProfile[], enabled: boolean): OtherMachine[] {
  const results = useQueries({
    queries: profiles.map(profile => ({
      queryKey: [profile.id, SNAPSHOT, profile.baseUrl],
      queryFn: () => readMachine(profile),
      enabled,
      refetchInterval: ALL_MACHINES_REFRESH_MS,
      staleTime: ALL_MACHINES_REFRESH_MS,
      // The next refresh is the retry.
      retry: false,
    })),
  });
  return profiles.map((profile, index) => {
    const result = results[index];
    return {
      profile,
      snapshot: result?.data,
      unreachable: result?.isError ?? false,
      readAt: result?.dataUpdatedAt ?? 0,
      refetch: () => result?.refetch() ?? Promise.resolve(),
    };
  });
}

async function readMachine(profile: RemotePaneConnectionProfile): Promise<MachineSnapshot> {
  const previous = queryClient.getQueryData<MachineSnapshot>([profile.id, SNAPSHOT, profile.baseUrl]);
  return withMachineClient(profile, async client => {
    // Hosts without Sessions or Notify answer those reads as unknown channels; the list goes on
    // without them. Any other failure, such as a read that timed out, keeps the last answer.
    const optional = <T,>(read: Promise<T>, last: T | undefined) => read.catch((error: Error) => (sessionsUnavailable(error) ? undefined : last));
    const [projects, statuses, permissions, notify, sessions] = await Promise.all([
      readChannel<ProjectWithPanes[]>(client, 'sessions:get-all-with-projects'),
      // Against the last read, so a Pane that finished between reads shows as Ready.
      optional(readChannel<RunpaneWorkspaceStateResult>(client, 'runpane:workspace:state', [{}])
        .then(workspace => agentStatusFromWorkspace(workspace, previous?.statuses)), previous?.statuses),
      optional(readChannel<PanePermissionRequest[]>(client, 'permission:getPending'), previous?.permissions),
      optional(readChannel<NotifySharedState>(client, 'notify:remote-snapshot'), previous?.notify),
      optional(readChannel<OrchestrationSessionListResult>(client, 'orchestration-sessions:list').then(list => list.sessions), previous?.sessions),
    ]);
    return { projects, statuses, permissions, notify, sessions };
  });
}
