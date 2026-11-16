import { MACHINE_HEALTH_ASK_AGENT_CHANNEL, type MachineHealthCard } from '../../../../shared/types/machineHealth';
import type { NotifyItem } from '../../../../shared/types/notify';
import { showActionError } from '../../stores/errorStore';
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

/** Opens Pane Chat on this machine with the card's list; for another machine's card, the agent is told to work there. */
export async function askAgentAbout(item: HealthNotifyItem): Promise<void> {
  const remote = remoteMachineName(item);
  // runpane workspace resolves the saved machine id; a label or OS hostname may not resolve.
  const prompt = remote && item.machineId
    ? `This is about the linked machine ${remote}. Run each runpane command there as \`runpane workspace ${item.machineId} <command>\`. ${item.machineHealth.agentPrompt}`
    : item.machineHealth.agentPrompt;
  try {
    await window.electronAPI.invoke(MACHINE_HEALTH_ASK_AGENT_CHANNEL, { prompt });
    // Loaded on use: Notify surfaces render in windows and tests that have no navigation store.
    const { useNavigationStore } = await import('../../stores/navigationStore');
    useNavigationStore.getState().navigateToPaneChat();
  } catch (error) {
    showActionError('Could not ask an agent', error);
  }
}
