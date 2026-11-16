import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Archive, Box, ChevronDown, ChevronUp, Clock, FlaskConical, FolderX, HardDrive, MemoryStick, Moon, RefreshCw, Sparkles, Square, TrendingUp } from 'lucide-react';
import type { MachineHealthSnapshot, ReclaimItem, ReclaimKind } from '../../../../shared/types/machineHealth';
import { MACHINE_HEALTH_ASK_AGENT_CHANNEL } from '../../../../shared/types/machineHealth';
import { configuredAgent, CONFIGURED_AGENT_IDS } from '../../../../shared/agents';
import { cn } from '../../utils/cn';
import { showActionError } from '../../stores/errorStore';
import { useConfigStore } from '../../stores/configStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { formatBytes, formatMB } from './format';
import { CATEGORY_COLORS } from '../ui/charts/palette';
import { MachineSwitcher } from './MachineSwitcher';
import { runHealthAction, useMachineHealth, type FinishedPaneRow, type MachineHealthData } from './useMachineHealth';

const MB = 1024 * 1024;

/** Bar segments use theme tokens so every theme, light and dark, keeps its own palette. */
const [BLUE, GREEN, ORANGE, PURPLE, , TEAL] = CATEGORY_COLORS;
const DISK_SEGMENTS = [
  { key: 'paneWorktrees', label: 'Pane worktrees', color: BLUE },
  { key: 'dependencies', label: 'Dependencies', color: PURPLE },
  { key: 'qaAndScratch', label: 'QA and scratch', color: ORANGE },
  { key: 'agentTemp', label: 'Agent temp files', color: TEAL },
  { key: 'paneData', label: 'Pane data and snapshots', color: GREEN },
] as const;
/** "Other" and "Free" are not categories: they take the theme's own muted and empty colours. */
interface BarPart { label: string; bytes: number; color?: string; className?: string }

const AGENT_EXECUTABLES = new Set(CONFIGURED_AGENT_IDS.flatMap(id => configuredAgent(id).executables));
const processBase = (name: string) => (name.split(/[\\/]/u).pop() ?? name).replace(/\.exe$/iu, '');

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function StackedBar({ parts, total }: { parts: BarPart[]; total: number }) {
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-tertiary" aria-hidden="true">
      {parts.map(part => part.bytes > 0 && (
        <span key={part.label} className={cn('h-full border-r border-surface-primary last:border-r-0', part.className)} style={{ width: `${(part.bytes / Math.max(1, total)) * 100}%`, backgroundColor: part.color }} />
      ))}
    </div>
  );
}

function Legend({ parts }: { parts: BarPart[] }) {
  return (
    <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 text-sm sm:grid-cols-3">
      {parts.map(part => (
        <div key={part.label} className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', part.className)} style={{ backgroundColor: part.color }} aria-hidden="true" />
          <dt className="min-w-0 flex-1 truncate text-text-secondary">{part.label}</dt>
          <dd className="tabular-nums text-text-primary">{formatBytes(part.bytes)}</dd>
        </div>
      ))}
    </dl>
  );
}

function DiskSection({ data }: { data: MachineHealthData }) {
  const { snapshot, inventory } = data;
  const volume = snapshot.disk.volumes.find(item => item.roles.includes('pane-data')) ?? snapshot.disk.volumes[0];
  if (!volume) return null;
  const used = volume.totalBytes - volume.freeBytes;
  const buckets = inventory?.buckets;
  const known: BarPart[] = DISK_SEGMENTS.map(segment => ({ label: segment.label, color: segment.color, bytes: buckets?.[segment.key] ?? 0 }));
  const other = Math.max(0, used - known.reduce((sum, part) => sum + part.bytes, 0));
  const parts = [...known, { label: snapshot.platform === 'darwin' ? 'Other apps and macOS' : 'Other apps and the system', bytes: other, className: 'bg-text-muted' }];
  const frees = (inventory?.items ?? []).filter(item => item.tier !== 3).reduce((sum, item) => sum + item.sizeBytes, 0)
    + data.finished.filter(pane => !pane.protection).reduce((sum, pane) => sum + (pane.sizeBytes ?? 0), 0);
  return (
    <section className="rounded-xl border border-border-primary p-5" aria-label="Disk">
      <div className="flex items-center gap-1.5 text-sm text-text-secondary"><HardDrive className="h-4 w-4" aria-hidden="true" />Disk</div>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <span className="text-2xl font-semibold text-text-primary">{`${formatBytes(used)} of ${formatBytes(volume.totalBytes)} used`}</span>
        <LevelBadge level={snapshot.disk.level} text={`${formatBytes(volume.freeBytes)} free`} />
        {inventory && <span className="ml-auto text-sm text-text-secondary">{`Pane can free about ${formatBytes(frees)}`}</span>}
      </div>
      <div className="mt-3"><StackedBar parts={parts} total={volume.totalBytes} /></div>
      <Legend parts={[...parts, { label: 'Free', bytes: volume.freeBytes, className: 'bg-surface-tertiary border border-border-primary' }]} />
    </section>
  );
}

function LevelBadge({ level, text }: { level: MachineHealthSnapshot['disk']['level']; text: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm',
      level === 'critical' ? 'bg-status-error/10 text-status-error' : level === 'warning' ? 'bg-status-warning/10 text-status-warning' : 'bg-surface-secondary text-text-secondary')}>
      {level !== 'ok' && <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
      {text}
    </span>
  );
}

function MemorySection({ data, onPause, busy, hours }: { data: MachineHealthData; onPause: () => void; busy: boolean; hours: number }) {
  const { snapshot, relief } = data;
  const used = snapshot.memory.totalBytes - snapshot.memory.freeBytes;
  const processes = snapshot.panes.flatMap(pane => pane.processes);
  const agents = processes.filter(proc => AGENT_EXECUTABLES.has(processBase(proc.name)));
  const agentBytes = agents.reduce((sum, proc) => sum + proc.rssMB * MB, 0);
  const devBytes = processes.reduce((sum, proc) => sum + proc.rssMB * MB, 0) - agentBytes;
  const appBytes = snapshot.app.rssMB * MB;
  const parts = [
    { label: `Agents (${agents.length})`, bytes: agentBytes, color: BLUE },
    { label: 'Dev servers and tests', bytes: devBytes, color: TEAL },
    { label: 'Pane', bytes: appBytes, color: GREEN },
    { label: 'Other apps', bytes: Math.max(0, used - agentBytes - devBytes - appBytes), className: 'bg-text-muted' },
  ];
  const pressure = snapshot.memory.level === 'critical' ? 'Pressure critical' : snapshot.memory.level === 'warning' ? 'Pressure high' : 'Pressure normal';
  return (
    <section className="rounded-xl border border-border-primary p-5" aria-label="Memory">
      <div className="flex items-center gap-1.5 text-sm text-text-secondary"><MemoryStick className="h-4 w-4" aria-hidden="true" />Memory</div>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <span className="text-2xl font-semibold text-text-primary">{`${formatBytes(used)} of ${formatBytes(snapshot.memory.totalBytes)} used`}</span>
        <LevelBadge level={snapshot.memory.level} text={pressure} />
        {snapshot.memory.swapUsedBytes ? <span className="rounded-md bg-surface-secondary px-2 py-0.5 text-sm text-text-secondary">{`Swap ${formatBytes(snapshot.memory.swapUsedBytes)}`}</span> : null}
        <span className="ml-auto text-sm text-text-secondary">{`CPU ${Math.round(snapshot.cpuPercent)}%`}</span>
        {relief.idle.paneIds.length > 0 && (
          <button type="button" disabled={busy} onClick={onPause} className="inline-flex items-center gap-1.5 rounded-md border border-border-primary px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover disabled:opacity-50">
            <Moon className="h-4 w-4" aria-hidden="true" />{`Pause Panes idle ${hours}+ hours`}
          </button>
        )}
      </div>
      <div className="mt-3"><StackedBar parts={parts} total={snapshot.memory.totalBytes} /></div>
      <Legend parts={[...parts, { label: 'Free', bytes: snapshot.memory.freeBytes, className: 'bg-surface-tertiary border border-border-primary' }]} />
    </section>
  );
}

interface Recommendation {
  key: string;
  icon: typeof Archive;
  title: string;
  detail: string;
  bytes: number;
  unit: 'frees' | 'memory' | 'frees automatically';
  action?: { label: string; run: () => Promise<void> };
  automatic?: boolean;
}

interface KindText { icon: typeof Archive; title: (count: number) => string; detail: string }
const KIND_TEXT = new Map<ReclaimKind, KindText>([
  ['agent-temp', { icon: Clock, title: () => 'Clear old agent temp files', detail: 'Folders of Panes that are gone, and items nobody touched for 2 days.' }],
  ['update-snapshot', { icon: Box, title: count => (count === 1 ? 'Remove replaced update snapshot' : `Remove ${count} replaced update snapshots`), detail: 'Rollback copies of updates a newer update replaced.' }],
  ['migration-backup', { icon: Box, title: () => 'Remove old database backup', detail: 'A migration backup over 30 days old; the database has opened cleanly since.' }],
  ['paused-scratch', { icon: FlaskConical, title: () => 'Clear QA folders in paused Panes', detail: 'Scratch and QA captures in paused Panes.' }],
  ['archived-pane-folder', { icon: FolderX, title: count => `Remove ${count} folder${count === 1 ? '' : 's'} left by archived Panes`, detail: 'Git confirms each was that Pane\'s worktree. Branches stay.' }],
]);
const kindText = (kind: ReclaimKind): KindText | undefined => KIND_TEXT.get(kind);

function FinishedReview({ finished, machineId, onDone, automatic, onAutomatic }: {
  finished: FinishedPaneRow[]; machineId: string; onDone: () => void; automatic: boolean | null; onAutomatic: (on: boolean) => void;
}) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(finished.filter(pane => !pane.protection).map(pane => pane.sessionId)));
  const [busy, setBusy] = useState(false);
  const chosen = finished.filter(pane => checked.has(pane.sessionId));
  const frees = chosen.reduce((sum, pane) => sum + (pane.sizeBytes ?? 0), 0);
  const reason = (pane: FinishedPaneRow) => pane.reason === 'pr-merged' ? 'PR merged' : pane.reason === 'pr-closed' ? 'PR closed' : pane.reason === 'folder-missing' ? 'Folder missing' : `Idle ${pane.idleDays} days`;
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border-primary">
      <ul className="divide-y divide-border-primary">
        {finished.map(pane => (
          <li key={pane.sessionId} className={cn('flex items-center gap-3 px-3 py-2 text-sm', pane.protection && 'text-text-tertiary')}>
            <input type="checkbox" aria-label={`Archive ${pane.name}`} disabled={!!pane.protection} checked={checked.has(pane.sessionId)}
              onChange={event => setChecked(previous => {
                const next = new Set(previous);
                if (event.target.checked) next.add(pane.sessionId); else next.delete(pane.sessionId);
                return next;
              })} />
            <span className="min-w-0 flex-1 truncate"><span className={pane.protection ? '' : 'text-text-primary'}>{pane.name}</span><span className="ml-1.5 text-text-tertiary">{pane.projectName}</span></span>
            <span className={cn('rounded px-1.5 py-0.5 text-xs', pane.protection ? 'bg-surface-secondary text-text-tertiary' : pane.reason === 'folder-missing' ? 'bg-status-error/10 text-status-error' : 'bg-status-success/10 text-status-success')}>{pane.protection ?? reason(pane)}</span>
            <span className="w-16 text-right tabular-nums">{pane.sizeBytes ? formatBytes(pane.sizeBytes) : ''}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-4 bg-surface-secondary px-4 py-3">
        {automatic !== null && (
          <label className="flex min-w-0 flex-1 items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1" checked={automatic} onChange={event => onAutomatic(event.target.checked)} />
            <span><span className="block font-medium text-text-primary">Do this automatically</span><span className="text-text-secondary">Archive Panes whose PR merged, whose folder is missing, or that sat idle 14 days.</span></span>
          </label>
        )}
        <button type="button" disabled={busy || chosen.length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              await runHealthAction(machineId, 'archive-finished', { ids: chosen.map(pane => pane.sessionId), source: 'ui' });
              onDone();
            } catch (error) {
              showActionError('Could not archive the finished Panes', error);
            } finally {
              setBusy(false);
            }
          }}
          className="ml-auto rounded-md bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50">
          {`Archive ${chosen.length} Pane${chosen.length === 1 ? '' : 's'} · ${formatBytes(frees)}`}
        </button>
      </div>
    </div>
  );
}

function Sparkline({ series }: { series: number[] }) {
  if (series.length < 2) return null;
  const min = Math.min(...series);
  const span = Math.max(...series) - min || 1;
  const points = series.map((value, index) => `${(index / (series.length - 1)) * 120},${28 - ((value - min) / span) * 26}`).join(' ');
  return (
    <svg viewBox="0 0 120 30" className="h-7 w-28 shrink-0 text-status-warning" aria-hidden="true">
      <polyline points={`0,30 ${points} 120,30`} className="fill-status-warning/15" stroke="none" />
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Recommendations({ data, machineId, reload, readOnlyReason }: { data: MachineHealthData; machineId: string; reload: () => Promise<void>; readOnlyReason: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const config = useConfigStore(state => state.config);
  const updateConfig = useConfigStore(state => state.updateConfig);
  const items = data.inventory?.items ?? [];
  const byKind = new Map<ReclaimKind, ReclaimItem[]>();
  for (const item of items) if (item.tier !== 3) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  const act = (key: string, run: () => Promise<void>, failure: string) => async () => {
    setBusy(key);
    try {
      await run();
      await reload();
    } catch (error) {
      showActionError(failure, error);
    } finally {
      setBusy(null);
    }
  };
  const ready = data.finished.filter(pane => !pane.protection);
  const finishedBytes = ready.reduce((sum, pane) => sum + (pane.sizeBytes ?? 0), 0);
  const panes = new Map(data.snapshot.panes.map(pane => [pane.sessionId, pane.name]));

  const rows: Recommendation[] = [];
  for (const [kind, kindItems] of byKind) {
    const text = kindText(kind);
    if (!text) continue;
    const tierOne = kindItems.every(item => item.tier === 1);
    rows.push({
      key: kind, icon: text.icon, title: text.title(kindItems.length), detail: text.detail,
      bytes: kindItems.reduce((sum, item) => sum + item.sizeBytes, 0), unit: tierOne ? 'frees automatically' : 'frees', automatic: tierOne,
      action: tierOne ? undefined : { label: 'Clear', run: () => act(kind, () => runHealthAction(machineId, 'cleanup', { kinds: [kind], source: 'ui' }), `Could not clear ${text.title(kindItems.length).toLowerCase()}`)() },
    });
  }
  if (data.relief.leftBehind.length > 0) {
    const names = [...new Set(data.relief.leftBehind.map(proc => processBase(proc.name)))].join(', ');
    rows.push({
      key: 'leftovers', icon: Square, title: `Stop ${data.relief.leftBehind.length} leftover process${data.relief.leftBehind.length === 1 ? '' : 'es'}`,
      detail: `${names}, left behind by work that already finished.`, bytes: data.relief.leftBehind.reduce((sum, proc) => sum + proc.rssMB * MB, 0), unit: 'memory',
      action: { label: 'Stop', run: () => act('leftovers', () => runHealthAction(machineId, 'stop-processes', { source: 'ui', processes: data.relief.leftBehind.map(proc => ({ pid: proc.pid, started: proc.started })) }), 'Could not stop the leftover processes')() },
    });
  }
  const total = rows.filter(row => row.unit !== 'memory').reduce((sum, row) => sum + row.bytes, 0) + finishedBytes;
  const leaks = data.snapshot.leaks;
  if (rows.length === 0 && ready.length === 0 && leaks.length === 0) {
    return <p className="text-sm text-text-secondary">Nothing to clean up right now.</p>;
  }
  const disabled = readOnlyReason !== null;
  return (
    <section aria-label="Recommendations">
      <h2 className="mb-2 text-base font-semibold text-text-primary">Recommendations <span className="ml-2 text-sm font-normal text-text-secondary">{`Frees about ${formatBytes(total)}${leaks.length ? ` · ${leaks.length} need${leaks.length === 1 ? 's' : ''} a look` : ''}`}</span></h2>
      {readOnlyReason && <p className="mb-2 text-sm text-text-secondary">{readOnlyReason}</p>}
      <ul className="divide-y divide-border-primary overflow-hidden rounded-xl border border-border-primary">
        {leaks.map(leak => (
          <li key={`${leak.pid}:${leak.started}`} className="flex flex-wrap items-center gap-4 border-l-2 border-status-warning bg-status-warning/5 px-5 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-status-warning/15 text-status-warning"><TrendingUp className="h-4 w-4" aria-hidden="true" /></span>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-text-primary">{`${processBase(leak.name)} in ${panes.get(leak.sessionId) ?? 'a Pane'} keeps using more memory`}</div>
              <div className="text-sm text-text-secondary">{`Grew ${formatMB(leak.growthMB)} in ${Math.round(leak.windowMs / 60_000)} min and kept climbing.`}</div>
            </div>
            <Sparkline series={leak.series} />
            <div className="flex items-center gap-1">
              {leak.panelId === null && (
                <button type="button" disabled={disabled || busy !== null} onClick={act(`restart:${leak.pid}`, () => runHealthAction(machineId, 'restart-process', { pid: leak.pid, started: leak.started }), 'Could not restart it')}
                  className="inline-flex items-center gap-1.5 rounded-md bg-status-warning px-3 py-1.5 text-sm font-medium text-text-on-status-warning disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Restart it</button>
              )}
              <button type="button" disabled={disabled || busy !== null} onClick={act(`stop:${leak.pid}`, () => runHealthAction(machineId, 'stop-processes', { source: 'ui', processes: [{ pid: leak.pid, started: leak.started }] }), 'Could not stop it')}
                className="rounded-md px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover disabled:opacity-50">Stop it</button>
              <button type="button" disabled={disabled || busy !== null} onClick={act(`ignore:${leak.pid}`, () => runHealthAction(machineId, 'ignore-leak', { pid: leak.pid, started: leak.started }), 'Could not ignore it')}
                className="rounded-md px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-hover disabled:opacity-50">Ignore for this process</button>
            </div>
          </li>
        ))}
        {ready.length > 0 && (
          <li className="px-5 py-3">
            <div className="flex items-center gap-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-text-secondary"><Archive className="h-4 w-4" aria-hidden="true" /></span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-text-primary">{`Archive ${ready.length} finished Pane${ready.length === 1 ? '' : 's'}`}</div>
                <div className="text-sm text-text-secondary">Their work is done. Branches stay and you can restore them.</div>
              </div>
              <div className="w-28 text-right"><div className="font-semibold tabular-nums text-text-primary">{`up to ${formatBytes(finishedBytes)}`}</div><div className="text-sm text-text-secondary">frees</div></div>
              <button type="button" disabled={disabled} onClick={() => setOpen(open === 'finished' ? null : 'finished')}
                className={cn('inline-flex w-24 items-center justify-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50', open === 'finished' ? 'text-text-primary hover:bg-surface-hover' : 'bg-interactive text-text-on-interactive hover:bg-interactive-hover')}>
                {open === 'finished' ? <><ChevronUp className="h-4 w-4" aria-hidden="true" />Hide</> : <><ChevronDown className="h-4 w-4" aria-hidden="true" />Review</>}
              </button>
            </div>
            {open === 'finished' && (
              <FinishedReview finished={data.finished} machineId={machineId} onDone={() => { setOpen(null); void reload(); }}
                automatic={machineId === 'local' ? config?.machineHealth?.autoArchiveFinished === true : null}
                onAutomatic={on => { void updateConfig({ machineHealth: { ...config?.machineHealth, autoArchiveFinished: on } }).catch(error => showActionError('Could not save the setting', error)); }} />
            )}
          </li>
        )}
        {rows.map(row => {
          const Icon = row.icon;
          return (
            <li key={row.key} className="flex items-center gap-4 px-5 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-text-secondary"><Icon className="h-4 w-4" aria-hidden="true" /></span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-text-primary">{row.title}</div>
                <div className="text-sm text-text-secondary">{row.detail}</div>
              </div>
              <div className="w-28 text-right"><div className="font-semibold tabular-nums text-text-primary">{formatBytes(row.bytes)}</div><div className="text-sm text-text-secondary">{row.unit}</div></div>
              <div className="flex w-24 justify-center">
                {row.automatic ? (
                  <span className="rounded-md bg-interactive/10 px-2 py-0.5 text-sm text-interactive">Automatic</span>
                ) : row.action && (
                  <button type="button" disabled={disabled || busy !== null} onClick={() => { void row.action?.run(); }} className="rounded-md px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-hover disabled:opacity-50">{busy === row.key ? 'Working…' : row.action.label}</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PerPane({ data }: { data: MachineHealthData }) {
  const [sort, setSort] = useState<'disk' | 'memory'>('disk');
  const memory = new Map(data.snapshot.panes.map(pane => [pane.sessionId, pane]));
  const rows = (data.inventory?.panes ?? []).map(pane => ({ ...pane, rssMB: memory.get(pane.sessionId)?.rssMB ?? 0 }));
  for (const pane of data.snapshot.panes) {
    if (!rows.some(row => row.sessionId === pane.sessionId)) rows.push({ sessionId: pane.sessionId, name: pane.name, worktreePath: '', worktreeBytes: 0, dependencyBytes: 0, buildOutputBytes: 0, scratchBytes: 0, agentTempBytes: 0, rssMB: pane.rssMB });
  }
  rows.sort((a, b) => (sort === 'disk' ? b.worktreeBytes + b.agentTempBytes - (a.worktreeBytes + a.agentTempBytes) : b.rssMB - a.rssMB));
  const largest = Math.max(1, ...rows.map(row => row.worktreeBytes + row.agentTempBytes));
  if (rows.length === 0) return null;
  return (
    <section aria-label="Per Pane">
      <div className="mb-2 flex items-center">
        <h2 className="text-base font-semibold text-text-primary">Per Pane <span className="ml-2 text-sm font-normal text-text-secondary">{`${rows.length} open`}</span></h2>
        <select aria-label="Sort Panes" value={sort} onChange={event => setSort(event.target.value === 'memory' ? 'memory' : 'disk')}
          className="ml-auto rounded-md border border-border-primary bg-surface-primary px-2 py-1 text-sm text-text-primary">
          <option value="disk">By disk</option>
          <option value="memory">By memory</option>
        </select>
      </div>
      <table className="w-full overflow-hidden rounded-xl border border-border-primary text-sm">
        <thead className="text-left text-text-secondary">
          <tr className="border-b border-border-primary"><th className="px-4 py-2 font-normal">Pane</th><th className="px-4 py-2 font-normal">Breakdown</th><th className="px-4 py-2 text-right font-normal">Disk</th><th className="px-4 py-2 text-right font-normal">Memory</th></tr>
        </thead>
        <tbody className="divide-y divide-border-primary">
          {rows.slice(0, 50).map(row => {
            const total = row.worktreeBytes + row.agentTempBytes;
            const code = Math.max(0, row.worktreeBytes - row.dependencyBytes - row.buildOutputBytes - row.scratchBytes);
            const parts = [
              { label: 'Worktree', bytes: code, color: BLUE },
              { label: 'Dependencies', bytes: row.dependencyBytes, color: PURPLE },
              { label: 'Build outputs', bytes: row.buildOutputBytes, color: GREEN },
              { label: 'Scratch', bytes: row.scratchBytes, color: ORANGE },
              { label: 'Agent temp', bytes: row.agentTempBytes, color: TEAL },
            ];
            return (
              <tr key={row.sessionId}>
                <td className="max-w-[260px] truncate px-4 py-2 text-text-primary">{row.name}</td>
                <td className="px-4 py-2">{total > 0 && <div style={{ width: `${Math.max(2, (total / largest) * 100)}%` }}><StackedBar parts={parts} total={total} /></div>}</td>
                <td className="px-4 py-2 text-right tabular-nums text-text-primary">{total ? formatBytes(total) : '–'}</td>
                <td className="px-4 py-2 text-right tabular-nums text-text-primary">{row.rssMB ? formatMB(row.rssMB) : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function NotManaged({ data }: { data: MachineHealthData }) {
  const items = (data.inventory?.items ?? []).filter(item => item.tier === 3);
  if (items.length === 0) return null;
  return (
    <section aria-label="Not managed by Pane">
      <h2 className="mb-1 text-base font-semibold text-text-primary">Not managed by Pane</h2>
      <p className="mb-2 text-sm text-text-secondary">Pane shows these with their owner and never deletes them. Ask an agent, or free them with the command beside each.</p>
      <ul className="divide-y divide-border-primary overflow-hidden rounded-xl border border-border-primary text-sm">
        {items.slice(0, 30).map(item => (
          <li key={item.id} className="flex items-start gap-4 px-4 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-text-primary" title={item.path}>{item.path}</div>
              <div className="text-text-secondary">{item.reason}</div>
              {item.howToFree && (/[.!]$/u.test(item.howToFree)
                ? <div className="mt-0.5 text-xs text-text-tertiary">{item.howToFree}</div>
                : <code className="mt-0.5 block truncate text-xs text-text-tertiary">{item.howToFree}</code>)}
            </div>
            <span className="tabular-nums text-text-primary">{formatBytes(item.sizeBytes)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SOURCE_TEXT = { schedule: 'by itself', ui: 'from Resources', card: 'from a card', cli: 'by an agent' } as const;

function History({ data }: { data: MachineHealthData }) {
  if (data.history.length === 0) return null;
  return (
    <section aria-label="Recent cleanups">
      <h2 className="mb-2 text-base font-semibold text-text-primary">Recent cleanups</h2>
      <ul className="space-y-1 text-sm text-text-secondary">
        {data.history.slice(0, 10).map(run => (
          <li key={`${run.at}-${run.source}`}>
            {`${new Date(run.at).toLocaleString()}: ${run.removed.length} done${run.skipped.length ? `, ${run.skipped.length} skipped` : ''}${run.freedBytes ? `, freed ${formatBytes(run.freedBytes)}` : ''}, ${SOURCE_TEXT[run.source]}`}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Resources: what each Pane costs on a machine, and the cleanups that get it back. */
export function ResourcesView() {
  const machineId = useNavigationStore(state => state.resourcesMachineId) ?? 'local';
  const setMachine = useNavigationStore(state => state.navigateToResources);
  const { state, reload } = useMachineHealth(machineId);
  const [now, setNow] = useState(() => Date.now());
  const [pausing, setPausing] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const pauseHours = useConfigStore(store => store.config?.machineHealth?.pauseIdleHours ?? 2);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const data = state.status === 'ready' ? state.data : state.status === 'problem' ? state.last : null;
  const problem = state.status === 'problem' ? state.problem : null;
  const readOnlyReason = useMemo(() => (problem?.kind === 'offline' ? 'This machine is offline, so nothing can run there now.' : null), [problem]);

  const askAgent = async () => {
    if (!data) return;
    const where = machineId === 'local' ? '' : ` This is about the linked machine ${data.snapshot.hostname}; run each runpane command there as \`runpane workspace ${data.snapshot.hostname} <command>\`.`;
    try {
      await window.electronAPI.invoke(MACHINE_HEALTH_ASK_AGENT_CHANNEL, { prompt: `Help me free disk and memory on ${data.snapshot.hostname}.${where} Run \`runpane machine health --json\` to see what Pane can free, by tier. Clean up only through \`runpane machine cleanup --kind <kind>\`: run it without --yes first to see the list, then with --yes. Never delete files with rm, and ask me before you stop a process or archive a Pane.` });
      useNavigationStore.getState().navigateToPaneChat();
    } catch (error) {
      showActionError('Could not ask an agent', error);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface-primary" data-testid="resources-view">
      <div className="mx-auto flex w-full max-w-[1160px] flex-col gap-5 px-8 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-text-primary">Resources</h1>
          <MachineSwitcher machineId={machineId} onSelect={setMachine} />
          <span className="text-sm text-text-secondary">{data ? `Updated ${relativeTime(data.readAt, now)}` : ''}</span>
          <button type="button" disabled={measuring} onClick={async () => { setMeasuring(true); try { await reload(true); } finally { setMeasuring(false); } }}
            aria-label="Measure storage again" title="Measure storage again"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover disabled:opacity-50">
            <RefreshCw className={cn('h-4 w-4', measuring && 'animate-spin')} aria-hidden="true" />
          </button>
          <button type="button" disabled={!data} onClick={() => { void askAgent(); }}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-surface-secondary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-hover disabled:opacity-50">
            <Sparkles className="h-4 w-4" aria-hidden="true" />Ask an agent to clean up
          </button>
        </header>
        {problem && (
          <div className={cn('rounded-lg px-4 py-3 text-sm', problem.kind === 'error' ? 'bg-status-error/10 text-status-error' : 'bg-surface-secondary text-text-secondary')} role="status">
            {problem.kind === 'offline' && data ? `Offline. Showing what it reported ${relativeTime(data.readAt, now)}.` : problem.message}
          </div>
        )}
        {!data && !problem && <p className="text-sm text-text-secondary">Reading this machine's health…</p>}
        {data && (
          <>
            <DiskSection data={data} />
            <MemorySection data={data} hours={machineId === 'local' ? pauseHours : 2} busy={pausing || readOnlyReason !== null} onPause={async () => {
              setPausing(true);
              try {
                await runHealthAction(machineId, 'pause-idle', { source: 'ui' });
                await reload();
              } catch (error) {
                showActionError('Could not pause idle Panes', error);
              } finally {
                setPausing(false);
              }
            }} />
            <Recommendations data={data} machineId={machineId} reload={() => reload()} readOnlyReason={readOnlyReason} />
            <PerPane data={data} />
            <NotManaged data={data} />
            <History data={data} />
            {!data.inventory && <p className="text-sm text-text-secondary">Pane has not measured storage on this machine yet. <button type="button" className="underline" onClick={() => { void reload(true); }}>Measure now</button></p>}
          </>
        )}
      </div>
    </div>
  );
}

