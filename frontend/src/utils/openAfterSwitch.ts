import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useErrorStore } from '../stores/errorStore';
import { nextHostRestored } from '../hooks/useIPCEvents';
import type { MachineSelectOutcome } from '../hooks/useMachines';

/** A machine switch reloads every list first; give a slow machine this long before opening anyway. */
const SWITCH_RESTORE_TIMEOUT_MS = 60_000;

/** Switches the app to the machine something was just created on, then opens it there. */
export async function openAfterSwitch(machineName: string, select: (() => Promise<MachineSelectOutcome>) | null, open: () => Promise<void>): Promise<void> {
  const failed = (why: string) => useErrorStore.getState().showError({
    title: `Created on ${machineName}`,
    error: `It was created on ${machineName}, but Pane could not switch there: ${why} Pick ${machineName} in the machine menu to open it.`,
  });
  if (!select) return failed('the machine menu does not list it yet.');
  try {
    const restored = nextHostRestored(SWITCH_RESTORE_TIMEOUT_MS);
    const outcome = await select();
    if (!outcome.ok) return failed(outcome.needsPassword ? 'it needs its password.' : outcome.error);
    await restored;
    await open();
  } catch (cause) {
    failed(cause instanceof Error ? cause.message : 'Pane did not say why.');
  }
}

/**
 * Opens the new Session once the switch has landed. The switch restores the Session
 * New left in the machine's memory, so it is normally open already; selecting it
 * then would reach a machine that is still restoring and be refused.
 */
export async function openCreatedSession(sessionId: string): Promise<void> {
  if (useOrchestrationSessionStore.getState().selectedSessionId !== sessionId) {
    await useOrchestrationSessionStore.getState().select({ sessionId });
  }
  if (useSessionStore.getState().activeSessionId !== null) await useSessionStore.getState().setActiveSession(null);
  useNavigationStore.getState().navigateToPaneChat();
}
