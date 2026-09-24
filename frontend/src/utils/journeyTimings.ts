import type { Journey } from '../../../shared/types/journeyTimings';

// On-device timings for Pane's core journeys, shown as p50/p75 in
// Settings > Advanced. Each journey runs from the user's action to the frame
// that shows the result; an abandoned journey is replaced by the next one, and
// a switch to a pane showing no terminal is never recorded.

const ABANDONED_AFTER_MS = 60_000;

interface PendingPane {
  journey: 'create_pane' | 'switch_pane';
  sessionId?: string;
  startedAt: number;
}

let pendingPane: PendingPane | null = null;
const pendingPrompts = new Map<string, number>();

function recordAtNextFrame(journey: Exclude<Journey, 'app_launch'>, startedAt: number): void {
  requestAnimationFrame(() => {
    const durationMs = performance.now() - startedAt;
    if (durationMs > ABANDONED_AFTER_MS) return;
    void window.electronAPI.invoke('journeys:record', { journey, durationMs }).catch(() => undefined);
  });
}

/** Main measures launch from process start; later calls in the same process are ignored there. */
export function markAppReady(): void {
  requestAnimationFrame(() => void window.electronAPI.invoke('journeys:app-ready').catch(() => undefined));
}

export function startCreatePane(): void {
  pendingPane = { journey: 'create_pane', startedAt: performance.now() };
}

export function cancelCreatePane(): void {
  if (pendingPane?.journey === 'create_pane') pendingPane = null;
}

/** The first pane created after startCreatePane is the one the user is waiting for. */
export function claimCreatedPane(sessionId: string): void {
  if (pendingPane?.journey === 'create_pane' && !pendingPane.sessionId) pendingPane.sessionId = sessionId;
}

export function startSwitchPane(sessionId: string): void {
  // Selecting the pane being created is part of creating it.
  if (pendingPane?.journey === 'create_pane' && pendingPane.sessionId === sessionId) return;
  pendingPane = { journey: 'switch_pane', sessionId, startedAt: performance.now() };
}

function finishPane(journey: PendingPane['journey'], sessionId: string): void {
  if (pendingPane?.journey !== journey || pendingPane.sessionId !== sessionId) return;
  recordAtNextFrame(journey, pendingPane.startedAt);
  pendingPane = null;
}

/** A new pane opens on its panels (an empty pane shows the agent launcher). */
export function markPaneViewShown(sessionId: string): void {
  finishPane('create_pane', sessionId);
}

/** A switched-to pane's terminal is visible and painted, with no loading mask over it. */
export function markPaneTerminalShown(sessionId: string): void {
  finishPane('switch_pane', sessionId);
}

export function startSendPrompt(panelId: string): void {
  pendingPrompts.set(panelId, performance.now());
}

/** The first output after Enter (the agent's echo or redraw) is written: Pane's own round trip, not the model's reply. */
export function markPanelOutput(panelId: string): void {
  const startedAt = pendingPrompts.get(panelId);
  if (startedAt === undefined) return;
  pendingPrompts.delete(panelId);
  recordAtNextFrame('send_prompt', startedAt);
}
