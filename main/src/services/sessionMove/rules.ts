import type { PathMap } from './pathMap';

/** A `runpane watch` or wait is how an orchestrator idles; a tab doing only that counts as idle (P2). */
const WATCH_COMMAND = /\brunpane(?:\.cjs)?\b[^\n]*\b(?:watch|wait)\b/;

/** True when a working tab's only activity under its agent is `runpane watch` or a wait. */
export function onlyWatching(rootPid: number, table: ReadonlyArray<{ pid: number; ppid: number; command: string }>): boolean {
  const children = new Map<number, Array<{ pid: number; command: string }>>();
  for (const entry of table) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) {
      if (WATCH_COMMAND.test(child.command)) return true;
      queue.push(child.pid);
    }
  }
  return false;
}

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
