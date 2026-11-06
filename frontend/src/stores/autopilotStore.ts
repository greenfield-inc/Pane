import { create } from 'zustand';
import type { AutopilotSnapshot, AutopilotStack, AutopilotStackCommand, AutopilotStackEntry } from '../../../shared/types/autopilot';
import { showActionError } from './errorStore';

/**
 * The renderer's copy of main's Autopilot (experimental). Main owns every decision (the run,
 * the agent's state, the stack and which entry shows); the UI renders this and sends commands.
 */
interface AutopilotState {
  snapshot: AutopilotSnapshot | null;
  /** A control is waiting on main (Start, Pause, New Autopilot Session). */
  pending: boolean;
}

export const useAutopilotStore = create<AutopilotState>(() => ({ snapshot: null, pending: false }));

const NO_STACK: AutopilotStack = { entries: [], shownId: null };

/** The stack, or one shared empty stack before the first snapshot (a stable value for selectors). */
export function selectAutopilotStack(state: AutopilotState): AutopilotStack {
  return state.snapshot?.stack ?? NO_STACK;
}

/** Keeps the store in step with main. Returns the unsubscribe. */
export function subscribeAutopilot(): () => void {
  const api = window.electronAPI?.autopilot;
  if (!api) return () => undefined;
  let pushed = false;
  const unsubscribe = api.onChanged((snapshot) => {
    pushed = true;
    useAutopilotStore.setState({ snapshot });
  });
  void api.snapshot()
    .then((snapshot) => { if (!pushed) useAutopilotStore.setState({ snapshot }); })
    .catch((error) => console.error('Failed to read Autopilot:', error));
  return unsubscribe;
}

type Control = 'start' | 'pause' | 'goOn' | 'newRun';
const CONTROL_LABELS = { start: 'Could not start Autopilot', pause: 'Could not pause Autopilot', goOn: 'Could not resume Autopilot', newRun: 'Could not start a new Autopilot Session' } satisfies Record<Control, string>;

/** Start, Pause, Go on, New Autopilot Session. Errors say what happened and what to do next. */
export async function runAutopilot(control: Control): Promise<void> {
  useAutopilotStore.setState({ pending: true });
  try {
    const snapshot = await window.electronAPI.autopilot[control]();
    useAutopilotStore.setState({ snapshot });
  } catch (error) {
    showActionError(CONTROL_LABELS[control], error);
  } finally {
    useAutopilotStore.setState({ pending: false });
  }
}

/**
 * The person is looking at Autopilot (the view opened, or Pane came to the front on it). With
 * Sentinel on, main may ask the agent for the While you were away card; otherwise nothing happens.
 */
export function markAutopilotOpened(): void {
  const opened = window.electronAPI?.autopilot?.opened;
  if (!opened) return;
  void opened()
    .then((snapshot) => useAutopilotStore.setState({ snapshot }))
    .catch((error) => console.warn('Could not tell Autopilot the view opened:', error));
}

export function moveAutopilotStack(command: AutopilotStackCommand): void {
  void window.electronAPI.autopilot.stack(command)
    .then((snapshot) => useAutopilotStore.setState({ snapshot }))
    .catch((error) => showActionError('Could not move the stack', error));
}

/** The entry on screen. */
export function shownStackEntry(snapshot: AutopilotSnapshot | null): AutopilotStackEntry | undefined {
  return snapshot?.stack.entries.find((entry) => entry.id === snapshot.stack.shownId);
}

/** Open entries on the stack: the sidebar row's count. */
export function openStackCount(snapshot: AutopilotSnapshot | null): number {
  return snapshot?.stack.entries.filter((entry) => entry.doneAt === undefined).length ?? 0;
}

/** Puts the item on the stack (if it isn't) and shows it. */
export function openOnStack(id: string): void {
  const snapshot = useAutopilotStore.getState().snapshot;
  const existing = snapshot?.stack.entries.find((entry) => entry.ref.kind === 'item' && entry.ref.notifyId === id);
  if (existing) { moveAutopilotStack({ type: 'show', id: existing.id }); return; }
  void window.electronAPI.autopilot.push({ item: id })
    .then((next) => {
      useAutopilotStore.setState({ snapshot: next });
      const entry = next.stack.entries.find((candidate) => candidate.ref.kind === 'item' && candidate.ref.notifyId === id);
      if (entry) moveAutopilotStack({ type: 'show', id: entry.id });
    })
    .catch((error) => showActionError('Could not put it on the stack', error));
}

/** Item ids the chat's blocks show right now, so the view knows whether the current one needs docking. */
export const useRenderedItems = create<{ counts: Record<string, number> }>(() => ({ counts: {} }));
