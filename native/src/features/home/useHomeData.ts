import { useDaemon } from '@/daemon';
import type { AllMachinesFeed } from '@/features/allMachines/AllMachinesRows';
import { useOtherMachines } from '@/features/allMachines/useOtherMachines';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { useMachinePrefs } from '@/features/machines/machinePrefs';
import { useMachines } from '@/features/machines/useMachines';
import { useNotifyShared } from '@/features/notify/hooks';
import { useAgentStatuses, usePendingPermissions, useProjects } from '@/features/panes/hooks';
import { useSessions } from '@/features/sessions/hooks';

/**
 * The machine the phone is on, read live: its Panes, agent statuses, permission requests, Notify
 * items and Sessions, as one feed for the lists that also read other machines. `unreachable`
 * marks its rows as from the last read, and collapses its approvals to one row.
 */
export function useCurrentMachine({ name, unreachable = false, retry }: { name?: string; unreachable?: boolean; retry?: () => void } = {}) {
  const { profile } = useDaemon();
  const projects = useProjects();
  const statuses = useAgentStatuses();
  const permissions = usePendingPermissions();
  const notify = useNotifyShared();
  const sessions = useSessions();
  const feed: AllMachinesFeed = {
    key: profile.id,
    name: name ?? profile.label,
    // Approvals still list when only the Panes read failed.
    snapshot: projects.data || permissions.data || notify.data
      ? { projects: projects.data ?? [], statuses: statuses.data, permissions: permissions.data, notify: notify.data, sessions: sessions.data?.sessions }
      : undefined,
    offlineSince: unreachable ? projects.dataUpdatedAt : undefined,
    // Wait for statuses too, so dots don't flip from "No agent" to their real status.
    waiting: { lists: projects.isPending || statuses.isPending, approvals: permissions.isPending || notify.isPending },
    // Connected, but the first read failed: say why, with Try again.
    error: !unreachable && !projects.data && projects.isError ? projects.error.message : undefined,
    retry: unreachable && retry ? retry : () => void projects.refetch(),
  };
  return {
    profile,
    projects,
    statuses,
    permissions,
    notify,
    sessions,
    feed,
    loading: projects.isPending || statuses.isPending,
    refetch: () => Promise.all([projects.refetch(), statuses.refetch(), permissions.refetch(), notify.refetch(), sessions.refetch()]),
  };
}

/**
 * Home's machines: every chip, whether All is selected, the connection to the machine the phone is
 * on, and the feeds home lists: that machine, plus every other saved machine while All is on screen
 * (`active`).
 */
export function useHomeFeeds({ active }: { active: boolean }) {
  const machines = useMachines();
  const current = machines.find(machine => machine.current);
  const connection = useConnectionPresence();
  const here = useCurrentMachine({ name: current?.name, unreachable: connection.presence === 'unreachable', retry: connection.retry });
  const saved = machines.filter(machine => machine.profile);
  const showAll = saved.length >= 2;
  const all = useMachinePrefs(state => state.all) && showAll;
  // Other machines are read only while All is on screen; the timer also stops in the background.
  const others = useOtherMachines(saved.flatMap(machine => (machine.profile && !machine.current ? [machine.profile] : [])), all && active);
  const feeds: AllMachinesFeed[] = all
    ? saved.map(machine => {
      if (machine.current) return here.feed;
      const other = others.find(read => read.profile.id === machine.key);
      return {
        key: machine.key,
        name: machine.name,
        snapshot: other?.snapshot,
        offlineSince: other?.unreachable ? other.readAt : undefined,
        retry: () => void other?.refetch(),
      };
    })
    : [here.feed];
  // On All, a machine that stopped answering dims, like the current one does.
  const chipMachines = all
    ? machines.map(machine => (others.some(read => read.profile.id === machine.key && read.unreachable)
      ? { ...machine, state: 'dimmed' as const, status: 'Can’t reach', selectable: false }
      : machine))
    : machines;
  return {
    ...connection,
    machines,
    chipMachines,
    current,
    saved,
    showAll,
    all,
    here,
    feeds,
    refetch: () => Promise.all([here.refetch(), ...(all ? others.map(other => other.refetch()) : [])]),
  };
}
