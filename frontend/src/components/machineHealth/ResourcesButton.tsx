import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import type { HealthLevel, MachineHealthSnapshot } from '../../../../shared/types/machineHealth';
import { MACHINE_HEALTH_CHANGED_EVENT } from '../../../../shared/types/machineHealth';
import { useNavigationStore } from '../../stores/navigationStore';
import { cn } from '../../utils/cn';
import { Tooltip } from '../ui/Tooltip';
import { formatBytes } from '../../../../shared/utils/formatBytes';
import { HEALTH_POLL_MS, readHealthSnapshot } from './useMachineHealth';

const RANK = { ok: 0, warning: 1, critical: 2 } as const satisfies Record<HealthLevel, number>;

/** "Resources: 13 GB free, memory pressure high". */
function resourcesSummary(snapshot: MachineHealthSnapshot | null): string {
  if (!snapshot) return 'Resources';
  const volume = snapshot.disk.volumes.find(item => item.roles.includes('pane-data')) ?? snapshot.disk.volumes[0];
  const pressure = snapshot.memory.level === 'ok' ? 'normal' : snapshot.memory.level === 'warning' ? 'high' : 'critical';
  return `Resources: ${volume ? `${formatBytes(volume.freeBytes)} free, ` : ''}memory pressure ${pressure}`;
}

/** This machine's worst level, for the icon's dot. */
function resourcesLevel(snapshot: MachineHealthSnapshot | null): HealthLevel {
  if (!snapshot) return 'ok';
  return RANK[snapshot.disk.level] >= RANK[snapshot.memory.level] ? snapshot.disk.level : snapshot.memory.level;
}

/** The sidebar's Resources icon: opens Resources for this computer; its dot keeps one fixed box and only changes colour. */
export function ResourcesButton({ className, rail = false }: { className?: string; rail?: boolean }) {
  const [snapshot, setSnapshot] = useState<MachineHealthSnapshot | null>(null);
  const active = useNavigationStore(state => state.activeView === 'resources');
  const navigateToResources = useNavigationStore(state => state.navigateToResources);

  useEffect(() => {
    let live = true;
    const load = () => readHealthSnapshot('local').then(next => { if (live) setSnapshot(next); }).catch(() => undefined);
    void load();
    const poll = setInterval(() => { void load(); }, HEALTH_POLL_MS);
    const off = window.electronAPI.machines.onEvent(event => {
      if (event.type === 'event' && event.machineId === 'local' && event.channel === MACHINE_HEALTH_CHANGED_EVENT) void load();
    });
    return () => { live = false; clearInterval(poll); off(); };
  }, []);

  const level = resourcesLevel(snapshot);
  const summary = resourcesSummary(snapshot);
  return (
    <Tooltip content={summary} side={rail ? 'right' : 'bottom'}>
      <button
        type="button"
        data-testid="resources-button"
        aria-label={summary}
        aria-pressed={active}
        onClick={() => navigateToResources('local')}
        className={cn('relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary',
          active && 'bg-surface-selected text-text-primary', className)}
      >
        <Gauge className="h-4 w-4" aria-hidden="true" />
        <span
          data-testid="resources-dot"
          data-level={level}
          aria-hidden="true"
          className={cn('absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-surface-primary',
            level === 'critical' ? 'bg-status-error' : level === 'warning' ? 'bg-status-warning' : 'bg-transparent ring-transparent')}
        />
      </button>
    </Tooltip>
  );
}
