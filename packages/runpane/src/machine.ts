import { boundary, decodeBoundary, type BoundarySchema, type JsonObject } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon } from './daemonClient';
import { RunpaneError } from './errors';
import { RUNPANE_CONTRACT } from './generated/contract';

// `runpane machine health|cleanup`: read this machine's health and free the disk space Pane made.
// Pane's cleanup engine decides what is safe to delete; this file shapes requests and output.

const SNAPSHOT_CHANNEL = 'resource-monitor:machine-health';
const INVENTORY_CHANNEL = 'resource-monitor:machine-inventory';
const CLEANUP_CHANNEL = 'resource-monitor:machine-cleanup';
const RECLAIM_KINDS: readonly string[] = RUNPANE_CONTRACT.enums.reclaimKinds;
const FOREIGN_KINDS = new Set<string>(RUNPANE_CONTRACT.enums.foreignReclaimKinds);
const TOP_PANES = 5;
const TIERS = [
  { tier: 1, title: 'Tier 1, Pane removes these by itself' },
  { tier: 2, title: 'Tier 2, Pane asks first' },
  { tier: 3, title: 'Tier 3, not Pane\'s to delete' },
] as const;

interface ReclaimItem {
  id: string;
  kind: string;
  tier: number;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  sessionId: string | null;
  reason: string;
  projectPath?: string;
  howToFree?: string;
}

const reclaimItemSchema: BoundarySchema<ReclaimItem> = boundary.object({
  id: boundary.string,
  kind: boundary.string,
  tier: boundary.number,
  path: boundary.string,
  sizeBytes: boundary.number,
  modifiedAt: boundary.number,
  sessionId: boundary.nullable(boundary.string),
  reason: boundary.string,
  projectPath: boundary.optional(boundary.string),
  howToFree: boundary.optional(boundary.string),
});
const inventorySchema = boundary.object({ scannedAt: boundary.number, items: boundary.array(reclaimItemSchema) });
const levelSchema = boundary.enumeration('ok', 'warning', 'critical');
const snapshotSchema = boundary.object({
  sampledAt: boundary.number,
  hostname: boundary.string,
  disk: boundary.object({
    level: levelSchema,
    volumes: boundary.array(boundary.object({
      path: boundary.string,
      roles: boundary.array(boundary.string),
      totalBytes: boundary.number,
      freeBytes: boundary.number,
      level: levelSchema,
    })),
  }),
  memory: boundary.object({ level: levelSchema, source: boundary.string, detail: boundary.string }),
  panes: boundary.array(boundary.object({
    sessionId: boundary.string,
    name: boundary.string,
    rssMB: boundary.number,
    cpuPercent: boundary.number,
    processes: boundary.array(boundary.jsonObject),
  })),
  leaks: boundary.array(boundary.object({
    pid: boundary.number,
    name: boundary.string,
    sessionId: boundary.string,
    memoryMB: boundary.number,
    growthMB: boundary.number,
    windowMs: boundary.number,
  })),
});
type MachineCleanupResult =
  | { ok: true; dryRun: true; kind: string; items: ReclaimItem[]; totalBytes: number }
  | { ok: true; dryRun: false; kind: string; run: typeof cleanupRunSchema extends BoundarySchema<infer Value> ? Value : never };
type Snapshot = typeof snapshotSchema extends BoundarySchema<infer Value> ? Value : never;
type Inventory = typeof inventorySchema extends BoundarySchema<infer Value> ? Value : never;
const cleanupEntrySchema = boundary.object({
  id: boundary.string,
  kind: boundary.string,
  path: boundary.string,
  sizeBytes: boundary.number,
  reason: boundary.optional(boundary.string),
});
const cleanupRunSchema = boundary.object({
  at: boundary.number,
  source: boundary.literal('cli'),
  removed: boundary.array(cleanupEntrySchema),
  skipped: boundary.array(cleanupEntrySchema),
  freedBytes: boundary.number,
});

export async function runMachineHealth(parsed: ParsedArgs): Promise<number> {
  const options = { paneDir: parsed.paneDir };
  const snapshot = await invokeDaemon(SNAPSHOT_CHANNEL, [], boundary.jsonObject, options);
  const inventory = await invokeDaemon(INVENTORY_CHANNEL, [{ refresh: false }], boundary.jsonObject, options);
  if (parsed.json) {
    printJson({ ok: true, snapshot, inventory });
    return 0;
  }
  for (const line of healthLines(decodeBoundary(snapshot, snapshotSchema), decodeBoundary(inventory, inventorySchema))) console.log(line);
  return 0;
}

export async function runMachineCleanup(parsed: ParsedArgs): Promise<number> {
  const kind = requireKind(parsed.kind);
  const options = { paneDir: parsed.paneDir };
  if (FOREIGN_KINDS.has(kind) || !parsed.yes) {
    const inventory = decodeBoundary(await invokeDaemon(INVENTORY_CHANNEL, [{ refresh: false }], boundary.jsonObject, options), inventorySchema);
    const ofKind = inventory.items.filter(item => item.kind === kind);
    if (FOREIGN_KINDS.has(kind)) throw notPanesError(kind, ofKind);
    const items = ofKind.filter(item => item.tier !== 3);
    const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (parsed.json) {
      printJson({ ok: true, dryRun: true, kind, items, totalBytes });
      return 0;
    }
    if (items.length === 0) {
      console.log(`No ${kind} items to delete in the last scan (${isoTime(inventory.scannedAt)}).`);
      return 0;
    }
    console.log(`${count(items.length, `${kind} item`)}, ${formatBytes(totalBytes)}:`);
    for (const item of items) console.log(`  ${formatBytes(item.sizeBytes)}  ${item.path}: ${item.reason}`);
    console.log('Dry run: nothing was deleted. Rerun with --yes to delete these.');
    return 0;
  }

  const run = await invokeDaemon(CLEANUP_CHANNEL, [{ kinds: [kind], source: 'cli' }], cleanupRunSchema, options);
  if (parsed.json) {
    printJson({ ok: true, dryRun: false, kind, run });
    return 0;
  }
  if (run.removed.length === 0 && run.skipped.length === 0) {
    console.log(`Removed nothing: no ${kind} items were left to delete.`);
    return 0;
  }
  console.log(`Removed ${count(run.removed.length, `${kind} item`)}, freed ${formatBytes(run.freedBytes)}.`);
  for (const entry of run.removed) console.log(`  ${formatBytes(entry.sizeBytes)}  ${entry.path}`);
  if (run.skipped.length > 0) {
    console.log(`Skipped ${count(run.skipped.length, 'item')}:`);
    for (const entry of run.skipped) console.log(`  ${formatBytes(entry.sizeBytes)}  ${entry.path}: ${entry.reason ?? 'skipped'}`);
  }
  return 0;
}

function requireKind(kind: string | undefined): string {
  const valid = `Valid kinds: ${RECLAIM_KINDS.join(', ')}.`;
  const next = 'Run runpane machine health to see each item\'s kind.';
  if (!kind) throw new RunpaneError('ERR_RUNPANE_INVALID_ARGUMENT', `runpane machine cleanup requires --kind <kind>. ${valid} Nothing was deleted.`, next);
  if (!RECLAIM_KINDS.includes(kind)) throw new RunpaneError('ERR_RUNPANE_INVALID_ARGUMENT', `Unknown --kind "${kind}". ${valid} Nothing was deleted.`, next);
  return kind;
}

function notPanesError(kind: string, items: ReclaimItem[]): RunpaneError {
  const reason = items[0] ? ` ${items[0].reason}` : '';
  const howTos = [...new Set(items.flatMap(item => item.howToFree ? [item.howToFree] : []))];
  const next = howTos.length === 0
    ? 'Free it with the tool that owns it; runpane machine health shows each item and its owner.'
    : howTos.length === 1
      ? `Free it with the tool that owns it: ${howTos[0]}`
      : `Free each with the tool that owns it, for example: ${howTos[0]}. runpane machine health lists how to free each one.`;
  return new RunpaneError('ERR_MACHINE_CLEANUP_NOT_PANES', `${kind} is tier 3: not Pane's to delete.${reason} Nothing was deleted.`, next);
}

function healthLines(snapshot: Snapshot, inventory: Inventory): string[] {
  const lines = [`Machine health for ${snapshot.hostname}, sampled ${isoTime(snapshot.sampledAt)}`];
  lines.push(`Disk: ${snapshot.disk.level}`);
  for (const volume of snapshot.disk.volumes) {
    lines.push(`  ${volume.path} (${volume.roles.join(', ')}): ${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.totalBytes)}, ${volume.level}`);
  }
  lines.push(`Memory: ${snapshot.memory.level} (${snapshot.memory.source}): ${snapshot.memory.detail}`);
  lines.push('Top Panes by memory:');
  const panes = [...snapshot.panes].sort((a, b) => b.rssMB - a.rssMB).slice(0, TOP_PANES);
  for (const pane of panes) {
    lines.push(`  ${pane.name}: ${formatBytes(pane.rssMB * 1024 * 1024)}, ${oneDecimal(pane.cpuPercent)}% CPU, ${count(pane.processes.length, 'process', 'processes')}`);
  }
  if (panes.length === 0) lines.push('  None.');
  lines.push('Leak warnings:');
  for (const leak of snapshot.leaks) {
    const paneName = snapshot.panes.find(pane => pane.sessionId === leak.sessionId)?.name ?? leak.sessionId;
    lines.push(`  ${leak.name} (pid ${leak.pid}) in ${paneName}: ${formatBytes(leak.memoryMB * 1024 * 1024)}, grew ${formatBytes(leak.growthMB * 1024 * 1024)} in ${Math.round(leak.windowMs / 60_000)} min`);
  }
  if (snapshot.leaks.length === 0) lines.push('  None.');
  lines.push(`Storage, scanned ${isoTime(inventory.scannedAt)}:`);
  for (const { tier, title } of TIERS) {
    const items = inventory.items.filter(item => item.tier === tier);
    lines.push(`${title} (${formatBytes(items.reduce((sum, item) => sum + item.sizeBytes, 0))}):`);
    for (const item of items) {
      lines.push(`  ${item.kind}  ${formatBytes(item.sizeBytes)}  ${item.path}: ${item.reason}`);
      if (item.howToFree) lines.push(`    Free it: ${item.howToFree}`);
    }
    if (items.length === 0) lines.push('  None.');
  }
  lines.push('Free tier 1 and 2 items with runpane machine cleanup --kind <kind>; it is a dry run until you add --yes.');
  return lines;
}

/** One decimal, halves rounded up, so the npm and Python CLIs print the same digits. */
function oneDecimal(value: number): string {
  return (Math.floor(value * 10 + 0.5) / 10).toFixed(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${oneDecimal(value)} ${units[unit]}`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function printJson(value: JsonObject | MachineCleanupResult): void {
  console.log(JSON.stringify(value, null, 2));
}
