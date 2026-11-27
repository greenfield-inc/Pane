import { showActionError } from '../stores/errorStore';
import { ipcErrorMessage } from './ipcErrorMessage';
import { beginMachineSwitch } from '../services/switchCursorHold';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { clearSessionViewCache } from '../stores/sessionViewCache';
import { cursorFollowEnabled, dropSessionCursor, settleOnSession } from '../services/sessionCursor';
import { isMachineDimmed, useAllMachinesStore } from '../stores/allMachinesStore';
import { LOCAL_MACHINE_ID, type MachineCommand } from '../../../shared/types/machineConnections';
import type { HostNavigationMemory } from '../../../shared/types/hostNavigation';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

/** A host command that answered `{ success: false }`: it ran and refused. */
const refusedSchema = boundary.object({ success: boundary.literal(false), error: boundary.optional(boundary.string) });

/** Runs one command on a machine; throws what the machine or the connection said when it fails. */
export async function commandOnMachine(machineId: string, command: MachineCommand): Promise<void> {
  const result = await window.electronAPI.machines.run(machineId, command);
  const refused = decodeOptionalBoundary(result.data, refusedSchema);
  if (refused) throw new Error(refused.error ?? 'The machine refused it and did not say why.');
}

/** What opening a row asks for: a Pane, a Session, a project's main workspace, or a to-do's page. */
export type MachineTarget =
  | { kind: 'pane'; id: string; name: string }
  | { kind: 'session'; id: string; name: string }
  | { kind: 'project'; id: number; name: string }
  | { kind: 'todo'; id: number; name: string };

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
    // The store owns selection errors and shows them in the Session view. With arrow keys
    // opening Sessions (T-87), a click or Enter settles what the cursor showed: one open call.
    const opened = cursorFollowEnabled() ? settleOnSession(target.id) : useOrchestrationSessionStore.getState().select({ sessionId: target.id });
    opened.catch(() => undefined);
  } else if (target.kind === 'todo') {
    navigation.navigateToTodos({ number: target.id });
  } else {
    navigation.navigateToProject(target.id);
  }
}

function memoryFor(target: MachineTarget): HostNavigationMemory {
  if (target.kind === 'pane') return { view: 'sessions', projectId: null, paneId: target.id };
  if (target.kind === 'session') return { view: 'pane-chat', projectId: null, paneId: null, orchestrationSessionId: target.id };
  if (target.kind === 'todo') return { view: 'todos', projectId: null, paneId: null, todoNumber: target.id };
  return { view: 'project', projectId: target.id, paneId: null };
}

/**
 * Leaves the row in the machine's navigation memory, so a switch to that machine
 * lands on it. The switch's own restore opens it, so nothing is sent to the
 * machine while it is still restoring and would refuse the write.
 */
export async function rememberOnMachine(machineId: string, target: MachineTarget): Promise<void> {
  const hostId = machineId === LOCAL_MACHINE_ID ? null : machineId;
  const saved = await window.electronAPI.uiState.saveNavigationMemory(hostId, memoryFor(target));
  if (!saved.success) throw new Error(saved.error ?? 'Pane could not remember the row to open.');
}

/** How an open from a row ended, for a caller that shows it itself (engage, T-132). */
export type MachineOpenOutcome =
  | { kind: 'here' }
  | { kind: 'offline' }
  | { kind: 'opened' }
  /** A newer press replaced it, or it could not start (no switch available). */
  | { kind: 'superseded' }
  | { kind: 'failed'; reason: string };

export interface MachineOpenOptions {
  /**
   * Engaging another machine's Session from the mirror (T-132): `quiet` lands on it as a rest
   * does, so a paused chat stays paused there; `reportErrors: false` leaves a failure to the caller,
   * which keeps what was typed beside it.
   */
  quiet?: boolean;
  reportErrors?: boolean;
}

/**
 * Opens a row from any machine. On the machine the app is on it opens as a click does today.
 * On another machine it makes that machine the one the app is on, after leaving the row in
 * that machine's navigation memory, which the switch restores. An offline machine says so.
 */
export async function openOnMachine(machineId: string, target: MachineTarget, options: MachineOpenOptions = {}): Promise<MachineOpenOutcome> {
  // Latest wins (T-128, D-6): a newer press replaces this one's landing and silences its errors.
  const press = ++openPresses;
  const reportErrors = options.reportErrors !== false;
  const sessions = useOrchestrationSessionStore.getState();
  const state = useAllMachinesStore.getState();
  const entry = state.entries.find((machine) => machine.id === machineId);
  if (entry?.active) {
    sessions.landOn(undefined);
    useAllMachinesStore.setState({ offlineNotice: null });
    openHere(target);
    return { kind: 'here' };
  }
  const name = entry?.name ?? machineId;
  if (isMachineDimmed(state.machines.find((machine) => machine.id === machineId))) {
    const question = target.kind === 'pane'
      ? state.snapshots[machineId]?.notify?.items.find((item) => item.state === 'waiting' && item.source.paneId === target.id)?.title ?? null
      : null;
    useAllMachinesStore.setState({ offlineNotice: { machineId, title: target.name, question } });
    return { kind: 'offline' };
  }
  if (!state.switchMachine) return { kind: 'superseded' };
  useAllMachinesStore.setState({ offlineNotice: null });
  // The switch's restore clears this host's Sessions; the landing then picks the pressed one
  // over the host's own last-used Session, whatever else selects meanwhile (#1767's rig).
  sessions.landOn(target.kind === 'session' ? target.id : undefined, { quiet: options.quiet === true });
  // Enter's cursor hold watches this switch, so arrow keys keep working while it runs (D-6).
  const switchEnded = beginMachineSwitch();
  const failed = (reason: string | undefined): MachineOpenOutcome => {
    if (press !== openPresses) return { kind: 'superseded' };
    useOrchestrationSessionStore.getState().landOn(undefined);
    if (reportErrors) showActionError(`Could not open ${target.name} on ${name}`, reason);
    return { kind: 'failed', reason: reason ?? 'Pane did not say why.' };
  };
  try {
    await rememberOnMachine(machineId, target);
    if (press !== openPresses) return { kind: 'superseded' };
    // Every Session view this window holds is this machine's (T-87); the host switch clears them again.
    dropSessionCursor();
    clearSessionViewCache();
    const outcome = await state.switchMachine(machineId);
    if (!outcome.ok) return failed(outcome.needsPassword ? `${name} needs its password. Enter it in Remote Access settings, then try again.` : outcome.error);
    return press === openPresses ? { kind: 'opened' } : { kind: 'superseded' };
  } catch (error) {
    return failed(ipcErrorMessage(error, 'Pane did not say why.'));
  } finally {
    switchEnded();
  }
}

/** Presses of rows on any machine so far; the newest one owns the landing. */
let openPresses = 0;

/**
 * An engage the person moved off before its switch started (T-132, review 1781 SF-2): the open in
 * flight starts no switch, and nothing lands.
 */
export function cancelMachineOpen(): void {
  openPresses += 1;
  useOrchestrationSessionStore.getState().landOn(undefined);
}
