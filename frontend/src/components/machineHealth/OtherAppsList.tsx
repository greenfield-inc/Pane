import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, LoaderCircle, Lock, OctagonX } from 'lucide-react';
import type { OtherApp } from '../../../../shared/types/machineHealth';
import { formatMB } from '../../../../shared/utils/formatBytes';
import { ConfirmDialog } from '../ConfirmDialog';
import { Bone, Skeleton, TextBone, LoadingStatus } from '../ui/Skeleton';
import { showActionError } from '../../stores/errorStore';
import { healthReadProblem } from './healthReadError';
import { readOtherApps, runHealthAction } from './useMachineHealth';

/** Rows shown before "Show all". */
const FIRST_ROWS = 12;

/**
 * The apps behind the "Other apps" memory row, biggest first, each with a stop button that ends it
 * after a confirm. The machine itself refuses system apps, Pane itself and apps Pane runs inside;
 * those show a lock with the reason instead. Reads again when `readAt` changes (the page's poll).
 */
export function OtherAppsList({ machineId, readAt, readOnlyReason, onStopped }: {
  machineId: string; readAt: number; readOnlyReason: string | null; onStopped: () => void;
}) {
  const [apps, setApps] = useState<OtherApp[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [confirming, setConfirming] = useState<OtherApp | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  /** Icons by app key: the machine sends each once, since they don't change. */
  const icons = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    try {
      const list = await readOtherApps(machineId, [...icons.current.keys()]);
      for (const app of list) if (app.icon) icons.current.set(app.key, app.icon);
      setApps(list);
      setProblem(null);
    } catch (error) {
      const read = healthReadProblem(error);
      setProblem(read.kind === 'outdated' ? 'Update Pane on this machine to list its apps.' : `Could not list the apps: ${read.message}`);
    }
  }, [machineId]);
  useEffect(() => { void load(); }, [load, readAt]);

  const stop = async (app: OtherApp) => {
    setStopping(app.key);
    try {
      await runHealthAction(machineId, 'stop-app', { key: app.key, source: 'ui' });
    } catch (error) {
      showActionError(`Could not stop ${app.name}`, error);
    } finally {
      setStopping(null);
      // The page reloads, and its new reading reads this list again.
      onStopped();
    }
  };

  if (problem && !apps) return <p className="mt-3 text-sm text-text-secondary" role="status">{problem}</p>;
  if (!apps) return <OtherAppsSkeleton />;
  const shown = showAll ? apps : apps.slice(0, FIRST_ROWS);
  return (
    <>
    {problem && <p className="mt-3 text-sm text-status-error" role="status">{problem}</p>}
    <div className="mt-3 overflow-hidden rounded-lg border border-border-primary" aria-label="Other apps">
      <div className="flex items-center gap-3 border-b border-border-primary px-3 py-1.5 text-xs text-text-secondary">
        <span className="min-w-0 flex-1">App</span>
        <span className="w-20 text-right">Memory</span>
        <span className="w-14 text-right">CPU</span>
        <span className="w-7" />
      </div>
      <ul className="divide-y divide-border-primary text-sm">
        {shown.map(app => (
          <li key={app.key} className="flex items-center gap-3 px-3 py-1.5">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary">
              {icons.current.get(app.key) ? <img src={icons.current.get(app.key)} alt="" className="h-4 w-4" /> : <AppWindow className="h-4 w-4" aria-hidden="true" />}
            </span>
            <span className="min-w-0 flex-1 truncate" title={app.key}>
              <span className="text-text-primary">{app.name}</span>
              {app.processCount > 1 && <span className="ml-1.5 text-text-tertiary">{`${app.processCount} processes`}</span>}
            </span>
            <span className="w-20 text-right tabular-nums text-text-primary">{formatMB(app.rssMB)}</span>
            <span className="w-14 text-right tabular-nums text-text-primary">{`${Math.round(app.cpuPercent)}%`}</span>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center">
              {stopping === app.key ? (
                <LoaderCircle className="h-4 w-4 animate-spin text-text-tertiary" aria-label={`Stopping ${app.name}`} />
              ) : app.protectedReason ? (
                <span className="flex h-7 w-7 items-center justify-center text-text-tertiary" title={app.protectedReason} aria-label={`${app.name} cannot be stopped: ${app.protectedReason}`} role="img">
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              ) : (
                <button type="button" disabled={readOnlyReason !== null || stopping !== null} title={readOnlyReason ?? `Stop ${app.name}`} aria-label={`Stop ${app.name}`}
                  onClick={() => setConfirming(app)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-status-error/10 hover:text-status-error disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-text-secondary">
                  <OctagonX className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {apps.length > FIRST_ROWS && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="w-full border-t border-border-primary px-3 py-1.5 text-left text-sm text-text-secondary hover:bg-surface-hover">
          {showAll ? 'Show fewer' : `Show all ${apps.length} apps`}
        </button>
      )}
      <ConfirmDialog isOpen={confirming !== null} onClose={() => setConfirming(null)}
        onConfirm={() => { if (confirming) void stop(confirming); }}
        title={confirming ? `Stop ${confirming.name}?` : ''}
        message={confirming ? stopMessage(confirming) : ''}
        confirmText={confirming ? `Stop ${confirming.name}` : 'Stop'} />
    </div>
    </>
  );
}

/** The apps table while the list is read: header, the first rows, and Show all. */
function OtherAppsSkeleton() {
  return (
    <>
      <LoadingStatus label="Reading the apps on this machine" />
      <Skeleton className="mt-3 rounded-lg border border-border-primary">
        <div className="flex items-center gap-3 border-b border-border-primary px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1"><TextBone text="App" /></span>
          <span className="w-20 text-right"><TextBone text="Memory" /></span>
          <span className="w-14 text-right"><TextBone text="CPU" /></span>
          <span className="w-7" />
        </div>
        <div className="divide-y divide-border-primary text-sm">
          {Array.from({ length: FIRST_ROWS }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-3 py-1.5">
              <Bone className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1"><Bone className="h-3.5" style={{ width: `${[36, 24, 44, 30, 20, 38][index % 6]}%` }} /></span>
              <span className="flex w-20 justify-end"><TextBone text="000 MB" /></span>
              <span className="flex w-14 justify-end"><TextBone text="0%" /></span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center"><Bone className="h-4 w-4" /></span>
            </div>
          ))}
        </div>
        <div className="border-t border-border-primary px-3 py-1.5 text-sm"><TextBone text="Show all 00 apps" /></div>
      </Skeleton>
    </>
  );
}

function stopMessage(app: OtherApp): string {
  const count = app.processCount > 1 ? ` (${app.processCount} processes)` : '';
  return app.byName
    ? `Pane ends every ${app.name} process outside this Pane now${count}, including ones started in other terminals. Unsaved work in them may be lost.`
    : `Pane ends ${app.name} now${count}. Unsaved work in it may be lost.`;
}
