import { showActionError } from '../stores/errorStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { isMachineDimmed, useAllMachinesStore } from '../stores/allMachinesStore';
import { LOCAL_MACHINE_ID, type MachineCommand } from '../../../shared/types/machineConnections';
import type { HostNavigationMemory } from '../../../shared/types/hostNavigation';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { decodeSessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import { showSessionInLayout } from './sessionWorkspaceLayout';

/** A host command that answered `{ success: false }`: it ran and refused. */
const refusedSchema = boundary.object({ success: boundary.literal(false), error: boundary.optional(boundary.string) });

/** Runs one command on a machine; throws what the machine or the connection said when it fails. */
export async function commandOnMachine(machineId: string, command: MachineCommand): Promise<void> {
  const result = await window.electronAPI.machines.run(machineId, command);
  const refused = decodeOptionalBoundary(result.data, refusedSchema);
  if (refused) throw new Error(refused.error ?? 'The machine refused it and did not say why.');
}

/** What opening a row asks for: a Pane, a Session, or a project's main workspace. */
export type MachineTarget =
  | { kind: 'pane'; id: string; name: string }
  | { kind: 'session'; id: string; name: string }
  | { kind: 'project'; id: number; name: string };

/** Runs one row action on the row's machine, in place, and reports a failure. */
export async function runOnMachine(machineId: string, command: MachineCommand, failure: string): Promise<void> {
  try {
    await commandOnMachine(machineId, command);
  } catch (error) {
    showActionError(failure, error);
  }
}

function openHere(target: MachineTarget): void {
  const navigation = useNavigationStore.getState();
  if (target.kind === 'pane') {
    navigation.setSidebarNavigationScope('repositories');
    void useSessionStore.getState().setActiveSession(target.id);
    navigation.navigateToSessions();
  } else if (target.kind === 'session') {
    void useSessionStore.getState().setActiveSession(null);
    navigation.navigateToPaneChat();
    // The store owns selection errors and shows them in the Session view.
    useOrchestrationSessionStore.getState().select({ sessionId: target.id }).catch(() => undefined);
  } else {
    navigation.navigateToProject(target.id);
  }
}

/**
 * A Session row also goes into the machine's remembered Session layout: the
 * layout's focused tile picks the Session the switch lands on, so a layout still
 * focused on the last Session viewed there would open that one instead.
 */
async function rememberSessionLayout(hostId: string | null, sessionId: string): Promise<void> {
  const stored = await window.electronAPI.uiState.getSessionWorkspaceLayout(hostId);
  const layout = stored.success ? decodeSessionWorkspaceLayout(stored.data ?? null) : null;
  if (!layout) return;
  const next = showSessionInLayout(layout, sessionId);
  if (next === layout) return;
  const saved = await window.electronAPI.uiState.saveSessionWorkspaceLayout(hostId, next);
  if (!saved.success) throw new Error(saved.error ?? 'Pane could not remember the Session to open.');
}

function memoryFor(target: MachineTarget): HostNavigationMemory {
  if (target.kind === 'pane') return { view: 'sessions', projectId: null, paneId: target.id };
  if (target.kind === 'session') return { view: 'pane-chat', projectId: null, paneId: null, orchestrationSessionId: target.id };
  return { view: 'project', projectId: target.id, paneId: null };
}

/**
 * Opens a row from any machine. On the machine the app is on it opens as a click does today.
 * On another machine it makes that machine the one the app is on, after leaving the row in
 * that machine's navigation memory and Session layout, which the switch restores. An offline machine says so.
 */
export async function openOnMachine(machineId: string, target: MachineTarget): Promise<void> {
  const state = useAllMachinesStore.getState();
  const entry = state.entries.find((machine) => machine.id === machineId);
  if (entry?.active) {
    useAllMachinesStore.setState({ offlineNotice: null });
    openHere(target);
    return;
  }
  const name = entry?.name ?? machineId;
  if (isMachineDimmed(state.machines.find((machine) => machine.id === machineId))) {
    const question = target.kind === 'pane'
      ? state.snapshots[machineId]?.notify?.items.find((item) => item.state === 'waiting' && item.source.paneId === target.id)?.title ?? null
      : null;
    useAllMachinesStore.setState({ offlineNotice: { machineId, title: target.name, question } });
    return;
  }
  if (!state.switchMachine) return;
  useAllMachinesStore.setState({ offlineNotice: null });
  try {
    const hostId = machineId === LOCAL_MACHINE_ID ? null : machineId;
    const saved = await window.electronAPI.uiState.saveNavigationMemory(hostId, memoryFor(target));
    if (!saved.success) throw new Error(saved.error ?? 'Pane could not remember the row to open.');
    if (target.kind === 'session') await rememberSessionLayout(hostId, target.id);
    const outcome = await state.switchMachine(machineId);
    if (!outcome.ok) showActionError(`Could not open ${target.name} on ${name}`, outcome.needsPassword ? `${name} needs its password. Enter it in Remote Access settings, then try again.` : outcome.error);
  } catch (error) {
    showActionError(`Could not open ${target.name} on ${name}`, error);
  }
}
