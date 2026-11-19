import type { HealthCardRow, HealthLevel, HealthProcess, LeakWarning, MachineHealthCard, MachineHealthSnapshot, ReclaimItem } from '../../../../shared/types/machineHealth';
import { formatBytes, formatMB } from '../../../../shared/utils/formatBytes';
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

  isOpen(key: string): boolean {
    return this.openKeys.has(key);
  }

  open(key: string): void {
    this.openKeys.add(key);
  }

  closed(key: string): void {
    this.openKeys.delete(key);
  }
}

const MB = 1024 * 1024;

export const NOT_NOW = 'Not now';
export const CLEAN_UP = 'Clean up';
export const PAUSE_IDLE = 'Pause idle Panes';
export const STOP_IT = 'Stop it';
export const RESTART_IT = 'Restart it';
export const IGNORE_PROCESS = 'Ignore for this process';
export const STOP_THEM = 'Stop them';
export const KEEP_THEM = 'Keep them';
export const KEEP_IT = 'Keep it';

export interface CardQuestion {
  title: string;
  context: string;
  choices: string[];
  card: MachineHealthCard;
}

/** A process that left its tab and still runs after its Pane was archived or paused. */
export interface Leftover {
  proc: HealthProcess;
  paneName: string;
  paneState: 'archived' | 'paused';
}

const agentRule = 'Clean up only through `runpane machine cleanup --kind <kind>`. Run it without --yes first to see the list and total. Add --yes yourself only for a tier 1 kind; for a tier 2 kind, show me that list and total and wait for my OK. Never delete files with rm, and ask me before you stop a process or archive a Pane.';

/** The rows the person saw, for the agent prompt. */
function listed(rows: HealthCardRow[]): string {
  const lines = rows.map(row => `- ${row.label} (${row.detail})${row.bytes > 0 ? `: ${formatBytes(row.bytes)}` : ''}${row.note ? `, ${row.note}` : ''}${row.command ? `, \`${row.command}\`` : ''}`);
  return lines.length > 0 ? `\n\nThe card listed:\n${lines.join('\n')}` : '';
}

function topConsumers(snapshot: MachineHealthSnapshot): HealthCardRow[] {
  const rows: HealthCardRow[] = snapshot.panes.flatMap(pane => pane.processes.map(proc => ({
    label: proc.name.split('/').pop() ?? proc.name, detail: pane.name, bytes: Math.round(proc.rssMB * MB),
  })));
  rows.push({ label: 'Pane', detail: 'the app', bytes: Math.round(snapshot.app.rssMB * MB) });
  return rows.sort((a, b) => b.bytes - a.bytes).slice(0, 5);
}

/** The card for a disk below the warning level: free space, and the items Clean up deletes, every one listed. */
export function diskCard(snapshot: MachineHealthSnapshot, items: readonly ReclaimItem[]): CardQuestion {
  const volume = [...snapshot.disk.volumes].sort((a, b) => RANK[b.level] - RANK[a.level] || a.freeBytes - b.freeBytes || a.path.localeCompare(b.path))[0];
  const free = volume?.freeBytes ?? 0;
  const level = volume?.level ?? snapshot.disk.level;
  const volumes = volume ? [volume, ...snapshot.disk.volumes.filter(item => item !== volume)] : [];
  const diskContext = volumes.map(item => `${item.path}: ${formatBytes(item.freeBytes)} free of ${formatBytes(item.totalBytes)} (${item.level})`).join('. ') || 'Disk space unavailable';
  const frees = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  const rows = items.map(item => ({ label: item.path.split(/[\\/]/u).pop() ?? item.path, detail: item.reason, bytes: item.sizeBytes, note: `Tier ${item.tier}` }));
  return {
    title: level === 'critical' ? 'Disk is almost full' : 'Disk almost full',
    context: frees > 0 ? `${diskContext}. Pane can free about ${formatBytes(frees)} of its own leftovers and finished work across watched volumes.` : `${diskContext}.`,
    choices: frees > 0 ? [CLEAN_UP, NOT_NOW] : [NOT_NOW],
    card: {
      kind: 'disk', level, hostname: snapshot.hostname,
      freeBytes: free, totalBytes: volume?.totalBytes, rows, freesBytes: frees,
      agentPrompt: `${snapshot.hostname} disk volumes: ${diskContext}. Run \`runpane machine health --json\` to see what Pane can free, by tier. ${agentRule}${listed(rows)}`,
    },
  };
}

/** The card for memory pressure: top consumers and an early pause of idle Panes. */
export function memoryCard(snapshot: MachineHealthSnapshot, offer: IdleOffer, hours: number): CardQuestion {
  const used = snapshot.memory.totalBytes - snapshot.memory.freeBytes;
  const swap = snapshot.memory.swapUsedBytes ? `, plus ${formatBytes(snapshot.memory.swapUsedBytes)} of swap` : '';
  const rows = topConsumers(snapshot);
  return {
    title: 'Memory is tight',
    context: `Using ${formatBytes(used)} of ${formatBytes(snapshot.memory.totalBytes)}${swap}. Agents and dev servers may slow down.`,
    choices: offer.paneIds.length > 0 ? [PAUSE_IDLE, NOT_NOW] : [NOT_NOW],
    card: {
      kind: 'memory', level: snapshot.memory.level, hostname: snapshot.hostname,
      usedBytes: used, totalBytes: snapshot.memory.totalBytes, swapUsedBytes: snapshot.memory.swapUsedBytes,
      rows,
      pauseOffer: { paneCount: offer.paneIds.length, memoryMB: Math.round(offer.memoryMB), hours },
      agentPrompt: `${snapshot.hostname} is short of memory. Run \`runpane machine health --json\` to see which Panes and processes use the most. ${agentRule}${listed(rows)}`,
    },
  };
}

/** The card for a process that keeps climbing, named with its Pane and tab. */
export function leakCard(leak: LeakWarning, paneName: string, tabName: string | null, canRestart: boolean, snapshot: MachineHealthSnapshot): CardQuestion {
  const name = leak.name.split('/').pop() ?? leak.name;
  const minutes = Math.round(leak.windowMs / 60_000);
  const where = tabName ? `${paneName} · ${tabName}` : paneName;
  return {
    title: `${name} in ${paneName} keeps using more memory`,
    context: `${tabName ? `It runs in the tab ${tabName}. ` : ''}It grew ${formatMB(leak.growthMB)} in ${minutes} min and kept climbing. It now uses ${formatMB(leak.memoryMB)}.`,
    choices: canRestart ? [RESTART_IT, STOP_IT, IGNORE_PROCESS] : [STOP_IT, IGNORE_PROCESS],
    card: {
      kind: 'leak', level: 'warning', hostname: snapshot.hostname,
      rows: [{ label: name, detail: where, bytes: Math.round(leak.memoryMB * MB) }],
      leak: { pid: leak.pid, started: leak.started, growthMB: leak.growthMB, windowMs: leak.windowMs, series: leak.series, canRestart },
      agentPrompt: `${name} (pid ${leak.pid}) in the Pane ${paneName}${tabName ? `, tab ${tabName},` : ''} on ${snapshot.hostname} grew ${leak.growthMB} MB in ${minutes} minutes. Find out why before restarting it, and ask me before you stop it.`,
    },
  };
}

/** The card for finished Panes: each with its reason and size; protected ones listed as skipped. */
export function finishedCard(finished: FinishedPane[], snapshot: MachineHealthSnapshot): CardQuestion {
  const ready = finished.filter(pane => !pane.protection);
  const frees = ready.reduce((sum, pane) => sum + (pane.sizeBytes ?? 0), 0);
  const reasonText = (pane: FinishedPane) => pane.reason === 'pr-merged' ? `PR #${pane.prNumber} merged`
    : pane.reason === 'pr-closed' ? `PR #${pane.prNumber} closed` : pane.reason === 'folder-missing' ? 'Folder missing' : `Idle ${pane.idleDays} days`;
  const rows = finished.map(pane => ({ label: pane.name, detail: pane.projectName, bytes: pane.sizeBytes ?? 0, note: pane.protection ?? reasonText(pane), skipped: !!pane.protection }));
  return {
    title: `Archive ${ready.length} finished Pane${ready.length === 1 ? '' : 's'}`,
    context: 'Their work is done. Archiving keeps each branch, and you can restore them.',
    choices: [`Archive ${ready.length} Pane${ready.length === 1 ? '' : 's'}`, NOT_NOW],
    card: {
      kind: 'finished', level: 'warning', hostname: snapshot.hostname, freesBytes: frees, rows,
      agentPrompt: `Pane found finished Panes on ${snapshot.hostname}. Review them with \`runpane panes list\` and archive merged ones with \`runpane panes archive --merged\`. Ask me before archiving anything else.${listed(rows)}`,
    },
  };
}

/** The card for processes left behind by archived or paused Panes: what each one is, and stop or keep. */
export function leftoversCard(leftovers: readonly Leftover[], snapshot: MachineHealthSnapshot): CardQuestion {
  const count = leftovers.length;
  const rows = leftovers.map(({ proc, paneName, paneState }) => ({
    label: proc.name.split('/').pop() ?? proc.name, detail: `${paneName}, ${paneState}`, bytes: Math.round(proc.rssMB * MB),
    note: `pid ${proc.pid}`, command: proc.command,
  }));
  return {
    title: count === 1 ? 'A process was left behind' : `${count} processes were left behind`,
    context: `${count === 1 ? 'It was' : 'They were'} started in a Pane terminal and still ${count === 1 ? 'runs' : 'run'} after ${count === 1 ? 'its' : 'their'} Pane was archived or paused. Stop ${count === 1 ? 'it' : 'them'}, or keep ${count === 1 ? 'it' : 'them'} and Pane won't ask about ${count === 1 ? 'it' : 'them'} again.`,
    choices: count === 1 ? [STOP_IT, KEEP_IT] : [STOP_THEM, KEEP_THEM],
    card: {
      kind: 'leftovers', level: 'warning', hostname: snapshot.hostname, rows,
      agentPrompt: `Processes started in Pane terminals on ${snapshot.hostname} still run after their Pane was archived or paused. Find out what each one is doing, and ask me before you stop any.${listed(rows)}`,
    },
  };
}
