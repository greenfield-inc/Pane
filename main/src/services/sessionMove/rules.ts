import type { PathMap } from './pathMap';

/** The Agent Farm profile a launch command runs (`agent-farm run greenfield/implementer:opus …`), without its variant. */
export function agentFarmProfileOf(command: string | undefined): string | null {
  const match = /(?:^|\s)agent-farm\s+run\s+([^\s:]+)/.exec(command ?? '');
  return match ? match[1] : null;
}

/** The one line the orchestrator and each working tab receive on arrival (Q-373.4). */
export function movedLine(from: string, here: string, map: PathMap): string {
  const paths = map.entries.slice(0, 6).map(entry => `${entry.from} → ${entry.to}`).join('; ');
  return `[Pane] This Session just moved from ${from} to ${here}. Paths changed: ${paths} (the full map is in moved.json in the Session folder). Servers, watches and background commands stopped on ${from}: restart the ones you need here, re-arm your runpane watch, and reconcile workers from their status files.`;
}
