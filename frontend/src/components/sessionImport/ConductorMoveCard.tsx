import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import { API } from '../../utils/api';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import type { MachineState } from '../../../../shared/types/machineConnections';
import type {
  ConductorMoveProgress,
  ConductorMoveResult,
  ConductorMoveScan,
  MovableWorkspace,
  MovedWorkspaceResult,
} from '../../../../shared/types/conductorMove';

const PROGRESS_POLL_MS = 500;
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const;

function agentName(agent: string): string {
  return Object.entries(AGENT_NAMES).find(([id]) => id === agent)?.[1] ?? agent;
}

export const CONDUCTOR_MOVE_TITLE = 'Move from Conductor';
const SUBTITLE = 'Each Conductor workspace opens as a Pane on the machine you pick, with its unpushed commits, uncommitted files and chats. Nothing is pushed to GitHub, and nothing on this Mac changes.';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function isMovable(workspace: MovableWorkspace): boolean {
  return !workspace.unavailable && !workspace.running;
}

function workspaceMeta(workspace: MovableWorkspace): string {
  if (workspace.unavailable) return `Can't move: ${workspace.unavailable}`;
  if (workspace.running) return 'A chat is running. Quit it in Conductor, then press Check again';
  const work = [
    workspace.unpushed > 0 && plural(workspace.unpushed, 'unpushed commit'),
    workspace.uncommitted > 0 && plural(workspace.uncommitted, 'uncommitted file'),
  ].filter(Boolean).join(', ');
  const chats = workspace.chats.length > 0
    ? [...new Set(workspace.chats.map(chat => agentName(chat.agent)))].join(' and ') + (workspace.chats.length > 1 ? ` (${workspace.chats.length} chats)` : ' chat')
    : 'no chats';
  return [workspace.branch, work || 'all pushed', chats].filter(Boolean).join(' · ');
}

function moveHeadline(result: ConductorMoveResult): string {
  const moved = result.results.filter(entry => entry.outcome === 'moved').length;
  const there = result.results.filter(entry => entry.outcome === 'already there').length;
  const parts = [
    moved > 0 && `Moved ${plural(moved, 'workspace')} to ${result.machine}.`,
    there > 0 && `${plural(there, 'workspace')} ${there === 1 ? 'was' : 'were'} already there.`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : `Nothing was moved to ${result.machine}.`;
}

interface ConductorMoveCardProps {
  scan: ConductorMoveScan;
  /** Saved machines from `machines:list`. */
  machines: MachineState[];
  onClose: () => void;
  onRescanned: (scan: ConductorMoveScan) => void;
  onBusyChange?: (busy: boolean) => void;
}

/** Pick Conductor workspaces and a machine, then move them there. */
export function ConductorMoveCard({ scan, machines, onClose, onRescanned, onBusyChange }: ConductorMoveCardProps) {
  const remotes = machines.filter(machine => machine.kind === 'remote');
  const [machineId, setMachineId] = useState<string | undefined>(() => (remotes.find(machine => machine.status === 'online') ?? remotes[0])?.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(scan.workspaces.filter(isMovable).map(workspace => workspace.key)));
  const [progress, setProgress] = useState<ConductorMoveProgress | undefined>();
  const [result, setResult] = useState<ConductorMoveResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const working = Boolean(progress?.running);
  const machine = remotes.find(candidate => candidate.id === machineId);

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => {
      void API.conductorMove.progress().then(next => setProgress(previous => previous?.running ? { ...next, running: true } : previous)).catch(() => undefined);
    }, PROGRESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [working]);

  const groups = useMemo(() => {
    const byRepo = new Map<string, MovableWorkspace[]>();
    for (const workspace of scan.workspaces) {
      const repo = workspace.repoName ?? 'Other folders';
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), workspace]);
    }
    return [...byRepo.entries()];
  }, [scan.workspaces]);

  const move = async () => {
    if (!machineId) return;
    setError(undefined);
    setProgress({ running: true, done: 0, total: selected.size });
    onBusyChange?.(true);
    try {
      setResult(await API.conductorMove.run({ machineId, workspaces: [...selected] }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProgress(undefined);
      onBusyChange?.(false);
    }
  };

  const checkAgain = async () => {
    setChecking(true);
    setError(undefined);
    try {
      const next = await API.conductorMove.scan();
      setSelected(previous => new Set(next.workspaces.filter(workspace => isMovable(workspace) && (previous.has(workspace.key) || !scan.workspaces.some(old => old.key === workspace.key))).map(workspace => workspace.key)));
      onRescanned(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  };

  const toggle = (key: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const empty = scan.status !== 'ok' || scan.workspaces.length === 0;
  const emptyText = scan.status === 'absent'
    ? 'Pane didn\'t find Conductor on this computer.'
    : scan.status === 'unreadable'
      ? `Pane couldn't read Conductor's workspaces: ${scan.reason ?? 'its database has a shape Pane doesn\'t know'}.`
      : 'Conductor has no workspaces on this computer.';
  const anyRunning = scan.workspaces.some(workspace => workspace.running);

  return (
    <div className="w-full rounded-2xl border border-border-secondary bg-surface-primary p-5 shadow-sm" data-testid="conductor-move-card">
      <div className="flex items-center gap-2.5">
        <ArrowRightLeft className="h-[18px] w-[18px] flex-none text-interactive" aria-hidden />
        <h2 className="text-base font-semibold text-text-primary">{CONDUCTOR_MOVE_TITLE}</h2>
      </div>
      {empty ? (
        <>
          <p className="mt-2 text-sm text-text-tertiary">{emptyText}</p>
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          </div>
        </>
      ) : result ? (
        <MoveResult result={result} onDone={onClose} />
      ) : (
        <>
          <p className="mt-1.5 text-sm text-text-tertiary">{SUBTITLE}</p>
          <div className="mt-3 flex items-center gap-3">
            <span className="flex-none text-sm text-text-secondary">Move to</span>
            {remotes.length > 0 ? (
              <Select value={machineId} onValueChange={setMachineId} disabled={working}>
                <SelectTrigger aria-label="Machine to move to" className="h-8 min-w-0 flex-1"><SelectValue placeholder="Pick a machine" /></SelectTrigger>
                <SelectContent>
                  {remotes.map(candidate => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.label}{candidate.status === 'online' ? '' : ` (${candidate.status})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-sm text-text-tertiary">No other machine yet. Add one under Settings → Remote Access.</span>
            )}
          </div>
          <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-border-secondary bg-surface-secondary px-3 pb-2 pt-1">
            {groups.map(([repo, workspaces]) => (
              <div key={repo} className="mt-1.5">
                <div className="text-xs font-medium text-text-secondary">{repo}</div>
                {workspaces.map(workspace => {
                  const movable = isMovable(workspace);
                  const current = working && progress?.current === workspace.name;
                  return (
                    <label key={workspace.key} className={cn('mt-1 flex items-start gap-2 text-sm', movable ? 'cursor-pointer' : 'cursor-default')}>
                      <input
                        type="checkbox"
                        className="mt-0.5 h-3.5 w-3.5 flex-none accent-interactive"
                        checked={selected.has(workspace.key)}
                        disabled={!movable || working}
                        onChange={() => toggle(workspace.key)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate', movable ? 'text-text-primary' : 'text-text-tertiary')}>{workspace.name}</span>
                        <span className="block truncate text-xs text-text-tertiary">{workspaceMeta(workspace)}</span>
                      </span>
                      {/* Fixed box, so the row keeps its size while the spinner comes and goes. */}
                      <span className="mt-0.5 flex h-3.5 w-3.5 flex-none items-center justify-center" aria-hidden>
                        {current && <Loader2 className="h-3.5 w-3.5 animate-spin text-text-tertiary" />}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
          <ReadDisclosure scan={scan} />
          {error && <p className="mt-2 text-sm text-status-error" role="alert">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            {anyRunning && (
              <Button variant="ghost" size="sm" onClick={() => void checkAgain()} disabled={working || checking}>Check again</Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={working}>Not now</Button>
              <Button size="sm" onClick={() => void move()} disabled={working || selected.size === 0 || !machine} aria-busy={working}>
                {/* Both labels share one grid cell, so the button keeps the wider one's size in either state. */}
                <span className="grid">
                  <span className={cn('[grid-area:1/1] inline-flex items-center justify-center whitespace-nowrap', working && 'invisible')}>
                    Move {plural(selected.size, 'workspace')}
                  </span>
                  <span className={cn('[grid-area:1/1] inline-flex items-center justify-center gap-1.5 whitespace-nowrap', !working && 'invisible')} aria-hidden={!working}>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Moving {Math.min((progress?.done ?? 0) + 1, progress?.total ?? 1)} of {progress?.total ?? selected.size}…
                  </span>
                </span>
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ReadDisclosure({ scan }: { scan: ConductorMoveScan }) {
  return (
    <div className="mt-2 text-xs text-text-tertiary">
      Pane reads Conductor&apos;s workspace list and each workspace&apos;s git checkout, and copies its chats from your Claude Code and Codex folders.{' '}
      {scan.storePaths.length > 0 && (
        <details className="inline">
          <summary className="inline cursor-pointer text-interactive">What Pane reads</summary>
          <ul className="mt-1 space-y-0.5 break-all font-mono">
            {scan.storePaths.map(storePath => <li key={storePath}>{storePath}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function MoveResult({ result, onDone }: { result: ConductorMoveResult; onDone: () => void }) {
  const failed = result.results.filter(entry => entry.outcome === 'not moved');
  const moved = result.results.filter(entry => entry.outcome === 'moved');
  const notes = moved.flatMap(entry => workspaceNotes(entry));
  return (
    <div className="mt-2 space-y-2 text-sm">
      <p className="text-text-primary">{moveHeadline(result)}</p>
      {moved.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-text-tertiary">
          {moved.map(entry => <li key={entry.key}><span className="text-text-secondary">{entry.paneName ?? entry.name}</span>{entry.worktreePath ? ` · ${entry.worktreePath}` : ''}</li>)}
        </ul>
      )}
      {notes.length > 0 && (
        <details>
          <summary className="cursor-pointer text-status-warning">{plural(notes.length, 'thing')} to check</summary>
          <ul className="mt-1 space-y-1 pl-4 text-xs text-text-tertiary">
            {notes.map(note => <li key={note.key}><span className="text-text-secondary">{note.label}</span>: {note.text}</li>)}
          </ul>
        </details>
      )}
      {failed.length > 0 && (
        <details>
          <summary className="cursor-pointer text-status-warning">{plural(failed.length, 'workspace')} not moved</summary>
          <ul className="mt-1 space-y-1 pl-4 text-xs text-text-tertiary">
            {failed.map(entry => <li key={entry.key}><span className="text-text-secondary">{entry.name}</span>: {entry.reason}</li>)}
          </ul>
        </details>
      )}
      {result.recordError && (
        <p className="text-status-warning">
          Pane couldn&apos;t update its import record ({result.recordError}), so Bring sessions into Pane may offer these chats again.
        </p>
      )}
      <div className="flex justify-end">
        <Button size="sm" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/** A moved workspace's chats that didn't resume, and a setup script that failed. */
function workspaceNotes(entry: MovedWorkspaceResult): Array<{ key: string; label: string; text: string }> {
  const notes = entry.chats
    .filter(chat => chat.outcome !== 'continued')
    .map(chat => ({
      key: `${entry.key}:${chat.key}`,
      label: `${entry.name} · ${chat.title ?? agentName(chat.agent)}`,
      text: chat.outcome === 'waiting for trust' ? 'answer the trust prompt in its tab'
        : chat.outcome === 'still starting' ? 'its agent is still loading; check its tab'
          : chat.reason ?? 'it didn\'t resume',
    }));
  if (entry.setup && !entry.setup.ok) {
    notes.push({ key: `${entry.key}:setup`, label: `${entry.name} · setup script`, text: `failed (from ${entry.setup.source})${entry.setup.detail ? `: ${entry.setup.detail}` : ''}. Run it again in a terminal there.` });
  }
  return notes;
}
