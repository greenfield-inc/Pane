import { MACHINE_HEALTH_ASK_AGENT_CHANNEL, type MachineHealthCard } from '../../../../shared/types/machineHealth';
import type { NotifyItem } from '../../../../shared/types/notify';
import { showActionError } from '../../stores/errorStore';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { runNotify } from '../../stores/notifyStore';

export type HealthNotifyItem = NotifyItem & { machineHealth: MachineHealthCard };

export function isHealthCard(item: NotifyItem): item is HealthNotifyItem {
  return item.machineHealth !== undefined;
}

/** The raising machine's name when the card came from another machine. */
export function remoteMachineName(item: NotifyItem): string | undefined {
  return item.machineId && item.machineId !== 'local' ? item.machine ?? item.machineHealth?.hostname : undefined;
}

/**
 * The card's title as this screen shows it: a linked machine's card starts with that machine's
 * name, since the raising machine writes its titles about itself.
 */
export function cardTitle(item: HealthNotifyItem): string {
  const remote = remoteMachineName(item);
  if (!remote) return item.title;
  // A leak card starts with a process name, kept as written; the others start with a plain word.
  const title = item.machineHealth.kind === 'leak' ? item.title : `${item.title.charAt(0).toLowerCase()}${item.title.slice(1)}`;
  return `${remote}: ${title}`;
}

/** Opens Resources on this screen with the card's machine selected. */
export async function reviewHealthCard(item: NotifyItem): Promise<void> {
  // Loaded on use: Notify surfaces render in windows and tests that have no navigation store.
  const { useNavigationStore } = await import('../../stores/navigationStore');
  useNavigationStore.getState().navigateToResources(item.machineId ?? 'local');
}

export function answerHealthCard(item: NotifyItem, choice: string): void {
  runNotify({ type: 'answer', id: item.id, answer: { choice } });
}

/** A request to an agent about one machine's disk and memory. */
export interface CleanupRequest {
  /** The machine it is about, as machine links name it: `local` or a linked machine's id. */
  machineId: string;
  machineName: string;
  prompt: string;
}

/**
 * Hands the request to the agent of the machine's "Clean up" Session (main starts one when none is
 * open) and shows it. A request about the machine the window is on runs there. Any other runs on
 * this computer, switching the window back to it if needed, since linked machine ids resolve only here.
 */
export async function askAgentToCleanUp({ machineId, machineName, prompt }: CleanupRequest): Promise<void> {
  try {
    // Loaded on use: Notify surfaces render in windows and tests that have no navigation store.
    const [{ useActiveMachineStore }, { useAllMachinesStore }, { useOrchestrationSessionStore }, { useNavigationStore }] = await Promise.all([
      import('../../stores/activeMachineStore'),
      import('../../stores/allMachinesStore'),
      import('../../stores/orchestrationSessionStore'),
      import('../../stores/navigationStore'),
    ]);
    const active = useActiveMachineStore.getState().machine;
    const windowMachine = !active || active.local ? 'local' : active.id;
    if (machineId !== windowMachine && windowMachine !== 'local') {
      const outcome = await useAllMachinesStore.getState().switchMachine?.('local');
      if (!outcome?.ok) throw new Error(`Pane could not switch back to this computer${outcome && 'error' in outcome ? `: ${outcome.error}` : ''}. Nothing was sent. Switch to this computer in the machine menu, then ask again.`);
    }
    // runpane workspace resolves the saved machine id; a label or OS hostname may not resolve.
    const request = machineId === windowMachine || machineId === 'local'
      ? prompt
      : `This is about the linked machine ${machineName}. Run each runpane command there as \`runpane workspace ${machineId} <command>\`. ${prompt}`;
    const { sessionId } = decodeBoundary(
      await window.electronAPI.invoke(MACHINE_HEALTH_ASK_AGENT_CHANNEL, { name: `Clean up ${machineName}`, prompt: request }),
      boundary.object({ sessionId: boundary.nonEmptyString }),
    );
    await useOrchestrationSessionStore.getState().select({ sessionId });
    useNavigationStore.getState().navigateToPaneChat();
  } catch (error) {
    showActionError('Could not ask an agent', error);
  }
}

/** Asks an agent about the card's list, on the machine that raised the card. */
export async function askAgentAbout(item: HealthNotifyItem): Promise<void> {
  await askAgentToCleanUp({
    machineId: item.machineId ?? 'local',
    machineName: remoteMachineName(item) ?? item.machineHealth.hostname,
    prompt: item.machineHealth.agentPrompt,
  });
}
