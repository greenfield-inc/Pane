import type { HealthCardRow, HealthLevel, LeakWarning, MachineHealthCard, MachineHealthSnapshot, StorageInventory } from '../../../../shared/types/machineHealth';
import type { FinishedPane } from './finishedPanes';
import type { IdleOffer } from './memoryRelief';

const HOUR = 3_600_000;
const REPEAT_AFTER_MS = 6 * HOUR;
const SNOOZE_MS = 24 * HOUR;
const RANK = { ok: 0, warning: 1, critical: 2 } as const satisfies Record<HealthLevel, number>;

/** When a card for one condition may show: once per 6 hours unless it worsens, 24 hours after Not now, never twice at once. */
export class CardGate {
  private last = new Map<string, { at: number; level: HealthLevel; snoozedUntil: number }>();
  private openKeys = new Set<string>();

  constructor(private readonly now: () => number) {}

  shouldShow(key: string, level: HealthLevel): boolean {
    if (this.openKeys.has(key)) return false;
    const last = this.last.get(key);
    if (!last) return true;
    if (RANK[level] > RANK[last.level]) return true;
    const now = this.now();
    return now >= last.snoozedUntil && now - last.at >= REPEAT_AFTER_MS;
  }

  shown(key: string, level: HealthLevel): void {
    const previous = this.last.get(key);
    this.last.set(key, { at: this.now(), level, snoozedUntil: previous?.snoozedUntil ?? 0 });
  }

  snooze(key: string, level: HealthLevel): void {
    this.last.set(key, { at: this.now(), level, snoozedUntil: this.now() + SNOOZE_MS });
  }

  open(key: string): void {
    this.openKeys.add(key);
  }

  closed(key: string): void {
    this.openKeys.delete(key);
  }
}

const GB = 1024 ** 3;
const MB = 1024 * 1024;
/** "13 GB", "2.4 GB", "40 MB": the same wording as the Resources page. */
const formatGB = (bytes: number) => (bytes >= 10 * GB ? `${Math.round(bytes / GB)} GB` : bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`);

export const NOT_NOW = 'Not now';
export const CLEAN_UP = 'Clean up';
export const PAUSE_IDLE = 'Pause idle Panes';
export const STOP_IT = 'Stop it';
export const RESTART_IT = 'Restart it';
export const IGNORE_PROCESS = 'Ignore for this process';

export interface CardQuestion {
  title: string;
  context: string;
  choices: string[];
  card: MachineHealthCard;
}

const agentRule = 'Clean up only through `runpane machine cleanup --kind <kind>`: run it without --yes first to see the list, then with --yes. Never delete files with rm, and ask me before you stop a process or archive a Pane.';

function topConsumers(snapshot: MachineHealthSnapshot): HealthCardRow[] {
  const rows: HealthCardRow[] = snapshot.panes.flatMap(pane => pane.processes.map(proc => ({
    label: proc.name.split('/').pop() ?? proc.name, detail: pane.name, bytes: Math.round(proc.rssMB * MB),
  })));
  rows.push({ label: 'Pane', detail: 'the app', bytes: Math.round(snapshot.app.rssMB * MB) });
  return rows.sort((a, b) => b.bytes - a.bytes).slice(0, 5);
}

/** The card for a disk below the warning level: free space, what Pane can free, and the cleanup. */
export function diskCard(snapshot: MachineHealthSnapshot, inventory: StorageInventory | null, machine: string): CardQuestion {
  const volume = [...snapshot.disk.volumes].sort((a, b) => a.freeBytes - b.freeBytes)[0];
  const free = volume?.freeBytes ?? 0;
  const items = (inventory?.items ?? []).filter(item => item.tier !== 3).slice(0, 5);
  const frees = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  const rows = items.map(item => ({ label: item.path.split(/[\\/]/u).pop() ?? item.path, detail: item.reason, bytes: item.sizeBytes, note: `Tier ${item.tier}` }));
  const where = machine === 'local' ? 'This machine' : snapshot.hostname;
  return {
    title: snapshot.disk.level === 'critical' ? 'Disk is almost full' : 'Disk almost full',
    context: `${where} has ${formatGB(free)} free. Pane can free about ${formatGB(frees)} of its own leftovers and finished work.`,
    choices: frees > 0 ? [CLEAN_UP, NOT_NOW] : [NOT_NOW],
    card: {
      kind: 'disk', level: snapshot.disk.level, machine, hostname: snapshot.hostname,
      freeBytes: free, totalBytes: volume?.totalBytes, rows, freesBytes: frees,
      agentPrompt: `${snapshot.hostname} has ${formatGB(free)} of disk free. Run \`runpane machine health --json\` to see what Pane can free, by tier. ${agentRule}`,
    },
  };
}

/** The card for memory pressure: top consumers and an early pause of idle Panes. */
export function memoryCard(snapshot: MachineHealthSnapshot, offer: IdleOffer, hours: number, machine: string): CardQuestion {
  const used = snapshot.memory.totalBytes - snapshot.memory.freeBytes;
  const swap = snapshot.memory.swapUsedBytes ? `, plus ${formatGB(snapshot.memory.swapUsedBytes)} of swap` : '';
  const where = machine === 'local' ? 'This machine' : snapshot.hostname;
  return {
    title: machine === 'local' ? 'Memory is tight' : `${snapshot.hostname}: memory is tight`,
    context: `${where} is using ${formatGB(used)} of ${formatGB(snapshot.memory.totalBytes)}${swap}. Agents and dev servers may slow down.`,
    choices: offer.paneIds.length > 0 ? [PAUSE_IDLE, NOT_NOW] : [NOT_NOW],
    card: {
      kind: 'memory', level: snapshot.memory.level, machine, hostname: snapshot.hostname,
      usedBytes: used, totalBytes: snapshot.memory.totalBytes, swapUsedBytes: snapshot.memory.swapUsedBytes,
      rows: topConsumers(snapshot),
      pauseOffer: { paneCount: offer.paneIds.length, memoryMB: Math.round(offer.memoryMB), hours },
      agentPrompt: `${snapshot.hostname} is short of memory. Run \`runpane machine health --json\` to see which Panes and processes use the most. ${agentRule}`,
    },
  };
}

/** The card for a process that keeps climbing. */
export function leakCard(leak: LeakWarning, paneName: string, canRestart: boolean, snapshot: MachineHealthSnapshot, machine: string): CardQuestion {
  const name = leak.name.split('/').pop() ?? leak.name;
  const minutes = Math.round(leak.windowMs / 60_000);
  return {
    title: `${name} in ${paneName} keeps using more memory`,
    context: `It grew ${leak.growthMB >= 1024 ? `${(leak.growthMB / 1024).toFixed(1)} GB` : `${leak.growthMB} MB`} in ${minutes} min and kept climbing. It now uses ${leak.memoryMB} MB.`,
    choices: canRestart ? [RESTART_IT, STOP_IT, IGNORE_PROCESS] : [STOP_IT, IGNORE_PROCESS],
    card: {
      kind: 'leak', level: 'warning', machine, hostname: snapshot.hostname,
      rows: [{ label: name, detail: paneName, bytes: Math.round(leak.memoryMB * MB) }],
      leak: { pid: leak.pid, started: leak.started, growthMB: leak.growthMB, windowMs: leak.windowMs, series: leak.series, canRestart },
      agentPrompt: `${name} (pid ${leak.pid}) in the Pane ${paneName} on ${snapshot.hostname} grew ${leak.growthMB} MB in ${minutes} minutes. Find out why before restarting it, and ask me before you stop it.`,
    },
  };
}

/** The card for finished Panes: each with its reason and size; protected ones listed as skipped. */
export function finishedCard(finished: FinishedPane[], snapshot: MachineHealthSnapshot, machine: string): CardQuestion {
  const ready = finished.filter(pane => !pane.protection);
  const frees = ready.reduce((sum, pane) => sum + (pane.sizeBytes ?? 0), 0);
  const reasonText = (pane: FinishedPane) => pane.reason === 'pr-merged' ? `PR #${pane.prNumber} merged`
    : pane.reason === 'pr-closed' ? `PR #${pane.prNumber} closed` : pane.reason === 'folder-missing' ? 'Folder missing' : `Idle ${pane.idleDays} days`;
  return {
    title: `Archive ${ready.length} finished Pane${ready.length === 1 ? '' : 's'}`,
    context: 'Their work is done. Archiving keeps each branch, and you can restore them.',
    choices: [`Archive ${ready.length} Pane${ready.length === 1 ? '' : 's'}`, NOT_NOW],
    card: {
      kind: 'finished', level: 'warning', machine, hostname: snapshot.hostname, freesBytes: frees,
      rows: finished.map(pane => ({ label: pane.name, detail: pane.projectName, bytes: pane.sizeBytes ?? 0, note: pane.protection ?? reasonText(pane), skipped: !!pane.protection })),
      agentPrompt: `Pane found finished Panes on ${snapshot.hostname}. Review them with \`runpane panes list\` and archive merged ones with \`runpane panes archive --merged\`. Ask me before archiving anything else.`,
    },
  };
}

