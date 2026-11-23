import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { API } from '../utils/api';
import { cn } from '../utils/cn';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { useConfigStore } from '../stores/configStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { openSessionOnMachineNamed } from '../utils/sessionMoveOpen';
import { moveTargets, moveToHostPrompt, sessionHostFor, sessionHostForMachine, type MoveTarget, type MoveTargetList, type SessionHost } from '../utils/moveSessionToHost';
import {
  cancelSessionMove, checkSessionMove, fixSessionMove, sessionMovePeers, sessionMoveStatus, startSessionMove, stopSessionMoveNow,
  type SessionMoveWhere,
} from '../utils/sessionMoveClient';
import {
  blockingChecks, confirmingLine, confirmingReason, doneView, isMoveRunning, moveIntro, needsFixLine, progressHeading, shownProgress, targetCheckLabel, waitingLine,
  wholeMoveTargets, workingFor,
} from '../utils/sessionMoveView';
import type { SessionMoveCheck, SessionMovePreflight, SessionMoveProgress, SessionMoveStep } from '../../../shared/types/sessionMove';
import type { RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';
import { Bone, LoadingStatus, Skeleton, useSkeletonHold } from './ui/Skeleton';

const NOT_RUNNING = /is not initialized/;
/** How often the dialog asks the Session's host how the move is going. */
const POLL_MS = 1000;
/** The part of `runpane panels submit`'s answer that says whether the agent took the text. */
const submitResultSchema = boundary.object({
  ok: boundary.boolean,
  blocked: boundary.optional(boundary.object({ message: boundary.string })),
});

/**
 * Which Session moves: one on the host the window shows, or, from All machines, one on a named
 * machine, whose record comes from that machine's list.
 */
export type MoveSessionTarget =
  | { kind: 'here'; sessionId: string }
  | { kind: 'machine'; machineId: string; session: OrchestrationSessionRecord };

/** The Session's host: the named machine's, or with none, the host on screen. */
function hostOf(machineId: string | null, config: Pick<RemoteDaemonConfig, 'client'> | undefined): SessionHost {
  return machineId === null ? sessionHostFor(config) : sessionHostForMachine(config, machineId);
}

/** The error's message without its closing period, for a sentence that goes on or adds its own. */
function messageOf(cause: unknown, fallback: string): string {
  return (cause instanceof Error && cause.message ? cause.message : fallback).replace(/\.+$/, '');
}

/**
 * "Hand off with a note…": sends the prompt the way a person's message reaches the agent,
 * `runpane panels submit` on the Session's own host, which waits for the composer and queues
 * behind a running turn.
 */
async function submitToAgent(target: MoveSessionTarget, panelId: string, input: string): Promise<void> {
  let response: unknown;
  try {
    response = target.kind === 'machine'
      ? (await window.electronAPI.machines.run(target.machineId, { type: 'submit-to-agent', panelId, input })).data
      : await window.electronAPI.invoke('runpane:panels:submit', { panelId, input, source: 'user' });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (NOT_RUNNING.test(message)) {
      throw new Error('The Session\'s agent is not running yet, so nothing was sent. Open the Session, wait for its agent to start, then choose Move to machine… again.');
    }
    throw new Error(`Could not send the handoff request to the Session's agent: ${message}. Nothing was sent.`);
  }
  const result = decodeOptionalBoundary(response, submitResultSchema);
  if (result?.ok === false) {
    throw new Error(`The Session's agent did not take the handoff request: ${result.blocked?.message ?? 'the agent did not accept it'}. Open the Session to see its screen.`);
  }
}

/** `idle`: a machine you can choose; `unavailable`: one that can't take the Session. */
type IndicatorKind = 'ok' | 'warning' | 'block' | 'running' | 'pending' | 'idle' | 'unavailable';

/** One fixed 18px box for every state, so a step that ticks off moves nothing. */
function Indicator({ kind }: { kind: IndicatorKind }) {
  return (
    <span aria-hidden="true" data-indicator={kind} className="flex h-[18px] w-[18px] flex-none items-center justify-center">
      {kind === 'running' ? (
        <span className="h-[14px] w-[14px] animate-spin rounded-full border-2 border-interactive border-r-transparent" />
      ) : kind === 'idle' ? (
        <span className="h-[14px] w-[14px] rounded-full border-2 border-border-secondary" />
      ) : (
        <span className={cn(
          'flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] font-bold leading-none',
          kind === 'ok' && 'bg-status-success text-text-on-status-success',
          kind === 'warning' && 'bg-status-warning text-text-on-status-warning',
          kind === 'block' && 'bg-status-error text-text-on-status-error',
          (kind === 'pending' || kind === 'unavailable') && 'bg-surface-tertiary text-text-tertiary',
        )}>
          {kind === 'ok' ? '✓' : kind === 'warning' ? '!' : kind === 'block' ? '×' : kind === 'unavailable' ? '–' : '·'}
        </span>
      )}
    </span>
  );
}

const CHECK_INDICATOR = { ok: 'ok', warning: 'warning', block: 'block' } as const satisfies Record<SessionMoveCheck['level'], IndicatorKind>;
const STEP_INDICATOR = { pending: 'pending', running: 'running', done: 'ok', failed: 'block' } as const satisfies Record<SessionMoveStep['state'], IndicatorKind>;
const STEP_STATE_LABEL = { pending: 'not started', running: 'in progress', done: 'done', failed: 'failed' } as const satisfies Record<SessionMoveStep['state'], string>;

function Line({ kind, title, detail, label, action, testId }: { kind: IndicatorKind; title: string; detail?: string; label?: string; action?: ReactNode; testId?: string }) {
  return (
    <li data-testid={testId} className="flex items-start gap-2 py-1">
      <span className="mt-px"><Indicator kind={kind} /></span>
      <span className="min-w-0 flex-1 text-sm text-text-primary">
        {label && <span className="sr-only">{label}: </span>}
        {title}
        {detail && <span className="block text-xs text-text-tertiary">{detail}</span>}
      </span>
      {action}
    </li>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-xs text-text-tertiary">{children}</p>;
}

interface MoveSessionToHostDialogProps {
  target: MoveSessionTarget | null;
  onClose: () => void;
  /** Called after the agent has a handoff note request, so the person can watch it hand off. */
  onMoved: (sessionId: string) => void;
}

/**
 * Move to machine…: Pane moves the whole Session (every Pane, tab, conversation, uncommitted
 * change and the Session folder) to another of your machines. The move runs on the Session's
 * host; closing the dialog only hides it, and opening it again shows the move where it is.
 * "Hand off with a note…" keeps the older path: the Session's agent runs `runpane handoff`.
 */
export function MoveSessionToHostDialog({ target: moving, onClose, onMoved }: MoveSessionToHostDialogProps) {
  const hereId = moving?.kind === 'here' ? moving.sessionId : null;
  const hereSession = useOrchestrationSessionStore(state => state.sessions.find(candidate => candidate.id === hereId));
  const session = moving?.kind === 'machine' ? moving.session : hereSession;
  const sessionId = moving?.kind === 'machine' ? moving.session.id : hereId;
  const machineId = moving?.kind === 'machine' ? moving.machineId : null;
  const remoteDaemon = useConfigStore(state => state.config?.remoteDaemon);
  const [requestedMode, setMode] = useState<'move' | 'note'>('move');
  const canHandOff = session !== undefined && session.terminalCommand === undefined;
  const mode = canHandOff ? requestedMode : 'move';
  const [targets, setTargets] = useState<MoveTargetList | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<SessionMovePreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  // Bumped whenever the dialog opens or checks a machine anew, so a Clone or Trust that finishes
  // afterwards can tell it was started for a destination no longer on screen.
  const checkGeneration = useRef(0);
  const [progress, setProgress] = useState<SessionMoveProgress | null>(null);
  // Until the host says whether a move is running, the chooser stays hidden.
  const [statusKnown, setStatusKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkRun, setCheckRun] = useState(0);
  const isOpen = moving !== null;
  const sessionHost = hostOf(machineId, remoteDaemon);
  const hostKey = sessionHost.kind === 'tailnet' ? sessionHost.machine : sessionHost.kind;
  const where = useMemo<SessionMoveWhere>(() => (machineId === null ? { kind: 'here' } : { kind: 'machine', machineId }), [machineId]);
  const running = isMoveRunning(progress);
  const name = session?.name || 'Session';

  // Opening: is a move already running on the Session's host? Then list the machines.
  useEffect(() => {
    if (!isOpen || !sessionId) return;
    let cancelled = false;
    checkGeneration.current += 1;
    setFixing(null);
    setMode('move'); setTargets(null); setPeers([]); setSelected(null); setPreflight(null); setError(null); setProgress(null); setStatusKnown(false);
    void sessionMoveStatus(where, sessionId).then(
      status => { if (!cancelled) { setProgress(isMoveRunning(status) ? shownProgress(status) : null); setStatusKnown(true); } },
      // A host that can't say (an older Pane) has no move running.
      () => { if (!cancelled) setStatusKnown(true); },
    );
    const host = hostOf(machineId, useConfigStore.getState().config?.remoteDaemon);
    if (host.kind === 'paired') return () => { cancelled = true; };
    void sessionMovePeers(where).then(found => { if (!cancelled) setPeers(found); });
    void (async () => {
      try {
        const [machines, access] = await Promise.all([
          API.remoteDaemon.listTailnetMachines(),
          // Discovery never lists the machine it runs on, which is a target when the Session lives elsewhere.
          host.kind === 'tailnet' ? API.remoteDaemon.getWorkspaceAccess() : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (!machines.success || !machines.data) throw new Error(machines.error ?? 'Could not list your machines.');
        const self = access?.success ? access.data : undefined;
        let thisComputer: MoveTarget | undefined;
        if (self?.machineName) {
          thisComputer = { name: self.machineName, available: self.state === 'on' };
          if (self.state !== 'on') thisComputer.reason = self.reason ?? 'Remote access to this computer is off';
        }
        setTargets(moveTargets({ machines: machines.data, sessionHost: host, thisComputer }));
      } catch (cause) {
        if (!cancelled) setError(`${messageOf(cause, 'Could not list your machines')}.`);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, sessionId, machineId, hostKey, where]);

  const shown = mode === 'move' && targets ? wholeMoveTargets(targets, peers, canHandOff) : targets;
  // The list waits for the machines, and in a move also for whether one is already running.
  const machinesHold = useSkeletonHold(sessionHost.kind !== 'paired' && ((!targets && !error) || (mode === 'move' && !statusKnown)));

  // The first machine that can take the Session starts selected, in each mode.
  useEffect(() => {
    const list = mode === 'move' && targets ? wholeMoveTargets(targets, peers, canHandOff) : targets;
    if (!list?.ok) return;
    if (selected && list.targets.some(target => target.name === selected && target.available)) return;
    setSelected(list.targets.find(target => target.available)?.name ?? null);
  }, [targets, peers, mode, selected, canHandOff]);

  // Choosing a machine runs its checks at once; nothing stops.
  useEffect(() => {
    // A fix still running belongs to the check this one replaces.
    checkGeneration.current += 1;
    setFixing(null);
    setPreflight(null);
    if (!isOpen || !sessionId || !selected || mode !== 'move' || running || !statusKnown) return;
    let cancelled = false;
    setChecking(true); setError(null);
    void checkSessionMove(where, sessionId, selected).then(
      result => { if (!cancelled) setPreflight(result); },
      cause => { if (!cancelled) setError(`Couldn’t check ${selected}: ${messageOf(cause, 'it did not answer')}. Nothing has been paused. Choose the machine again to retry.`); },
    ).finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [isOpen, sessionId, selected, mode, running, statusKnown, where, checkRun]);

  // While a move runs and the dialog is open, ask how it is going every second.
  const progressRef = useRef(progress);
  progressRef.current = progress;
  useEffect(() => {
    if (!isOpen || !sessionId || !running) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void sessionMoveStatus(where, sessionId).then(
        status => { if (!cancelled && status && status.moveId === progressRef.current?.moveId) setProgress(shownProgress(status)); },
        () => undefined,
      );
    }, POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isOpen, sessionId, running, where]);

  const act = useCallback((run: () => Promise<SessionMoveProgress | null>, failure: string) => {
    setBusy(true); setError(null);
    void run().then(
      next => { if (next) setProgress(shownProgress(next)); },
      cause => setError(`${failure}: ${messageOf(cause, 'the Session’s machine did not answer')}.`),
    ).finally(() => setBusy(false));
  }, []);

  // A running move only hides: it carries on, and opening the dialog again shows it.
  const close = () => { if (!busy || running) onClose(); };
  const destination = shown?.ok ? shown.targets.find(candidate => candidate.name === selected && candidate.available) : undefined;
  const blocks = blockingChecks(preflight);

  const startMove = () => {
    if (!sessionId || !destination || !preflight?.ready) return;
    act(() => startSessionMove(where, sessionId, destination.name), `Couldn’t start the move to ${destination.name}`);
  };

  const runFix = (check: SessionMoveCheck) => {
    if (!sessionId || !selected || !check.fix) return;
    const fix = check.fix;
    const target = selected;
    // The destination can't change while a fix runs, but closing and opening the dialog can.
    const generation = checkGeneration.current;
    const current = () => checkGeneration.current === generation;
    setFixing(check.id); setError(null);
    void fixSessionMove(where, sessionId, target, fix).then(
      result => { if (current()) setPreflight(result); },
      cause => { if (current()) setError(`${fix.label} didn’t finish on ${target}: ${messageOf(cause, 'it did not answer')}. Nothing has been paused. Try ${fix.label} again.`); },
    ).finally(() => { if (current()) setFixing(null); });
  };

  const tryAgain = () => {
    const previous = progress?.target ?? null;
    setProgress(null); setError(null);
    if (previous && previous === selected) setCheckRun(run => run + 1);
    else setSelected(previous);
  };

  const openThere = () => {
    const target = progress?.target;
    onClose();
    if (!target || !sessionId) return;
    // With no saved connection to the target, Close and Open there are the same: the Session runs there now.
    openSessionOnMachineNamed(target, { id: sessionId, name });
  };

  const machineList = (whole: boolean) => shown && (
    <>
      {!shown.ok && <p className={cn('mt-3 text-sm text-text-secondary', machinesHold.reveal && 'skeleton-reveal')}>{shown.reason}. {shown.fix}</p>}
      {shown.ok && (
        <fieldset className={cn('mt-3 space-y-1.5', machinesHold.reveal && 'skeleton-reveal')} disabled={busy || fixing !== null}>
          <legend className="sr-only">Destination machine</legend>
          {shown.noneReachable && (
            <p className="text-sm text-text-secondary">
              No other machine can take this Session right now. Open Pane on the machine you want, check it is signed in to Tailscale, then try again.
            </p>
          )}
          {shown.targets.map(option => {
            const isSelected = selected === option.name && option.available;
            const status = whole && isSelected ? targetCheckLabel(preflight, checking) : undefined;
            const kind: IndicatorKind = !option.available ? 'unavailable'
              : !isSelected ? 'idle'
                : checking || !preflight ? 'running' : blocks.length > 0 ? 'block' : 'ok';
            return (
              <label
                key={option.name}
                data-testid={`move-session-target-${option.name}`}
                className={cn(
                  'flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-interactive',
                  !option.available ? 'cursor-not-allowed border-border-primary text-text-muted opacity-70'
                    : isSelected ? 'border-interactive bg-surface-selected text-text-primary'
                      : 'cursor-pointer border-border-primary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                )}
              >
                <input
                  type="radio"
                  name="move-session-target"
                  value={option.name}
                  aria-label={option.name}
                  aria-describedby={option.reason || status ? `move-session-target-reason-${option.name}` : undefined}
                  checked={isSelected}
                  disabled={!option.available}
                  onChange={() => setSelected(option.name)}
                  className="sr-only"
                />
                {whole && <Indicator kind={kind} />}
                <span className="min-w-0 flex-1 truncate font-medium">
                  {option.name}
                  {option.owner && <span className="font-normal text-text-tertiary"> · {option.owner}</span>}
                </span>
                {(option.reason || status) && (
                  <span id={`move-session-target-reason-${option.name}`} className="max-w-[60%] text-right text-xs text-text-tertiary">{option.reason ?? status}</span>
                )}
              </label>
            );
          })}
        </fieldset>
      )}
    </>
  );

  const errorLine = error && <p role="alert" className="mt-3 text-sm text-status-error">{error}</p>;
  const pairedLine = sessionHost.kind === 'paired' && <p className="mt-3 text-sm text-text-secondary">{sessionHost.reason}</p>;

  let title = `Move “${name}”`;
  let body: ReactNode;
  let footer: ReactNode;

  if (mode === 'note') {
    title = `Hand off “${name}” with a note`;
    body = (
      <>
        <p className="text-sm text-text-secondary">
          Pane asks this Session's agent to hand it off with <code>runpane handoff</code>. With the same agent, the new Session continues this Session's own conversation when you open it; otherwise it starts from the agent's note. This one stays here.
        </p>
        {pairedLine}{machinesHold.holding ? <MachinesLoading /> : machineList(false)}{errorLine}
      </>
    );
    footer = (
      <>
        <Button type="button" variant="ghost" className="mr-auto" disabled={busy} onClick={() => { setMode('move'); setError(null); }}>Back</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
        <Button type="submit" disabled={busy || !destination || !session}>{busy ? 'Sending…' : 'Ask the agent to hand off'}</Button>
      </>
    );
  } else if (progress && progress.phase !== 'cancelled') {
    title = progressHeading(progress);
    const target = progress.target;
    if (progress.phase === 'waiting') {
      const now = Date.now();
      body = (
        <>
          <p className="text-sm text-text-secondary">{waitingLine(progress)}</p>
          <ul className="mt-3 space-y-1.5" aria-label="Tabs still working">
            {progress.waiting.map(tab => (
              <li key={tab.panelId} className="flex items-center gap-2.5 rounded-md border border-border-primary px-2.5 py-1.5 text-sm">
                <Indicator kind="running" />
                <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{tab.title} · Pane {tab.paneName}</span>
                <span className="flex-none text-xs text-text-tertiary">{workingFor(tab.since, now)}</span>
              </li>
            ))}
          </ul>
          <Note>Stop now interrupts them; they pick up the interrupted turn on {target}.</Note>
          {errorLine}
        </>
      );
      footer = (
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => sessionId && act(() => cancelSessionMove(where, sessionId), 'Couldn’t cancel the move')}>Cancel move</Button>
          <Button type="button" disabled={busy} onClick={() => sessionId && act(() => stopSessionMoveNow(where, sessionId), 'Couldn’t stop the tabs')}>Stop now</Button>
        </>
      );
    } else if (progress.phase === 'moving' || progress.phase === 'confirming') {
      const confirming = progress.phase === 'confirming';
      const reason = confirmingReason(progress);
      body = (
        <>
          <p className="text-sm text-text-secondary">
            {confirming ? confirmingLine(target) : 'The Session is paused here. Don’t close Pane on either machine.'}
          </p>
          {reason && (
            <p className="mt-2 text-sm text-text-primary" data-testid="move-confirming-reason">
              <span className="font-medium">{reason.title}.</span> {reason.detail}
            </p>
          )}
          <ul className="mt-3" aria-label="Move steps">
            {progress.steps.map(step => (
              <Line key={step.id} testId={`move-step-${step.id}`} kind={STEP_INDICATOR[step.state]} label={STEP_STATE_LABEL[step.state]} title={step.title} detail={step.detail} />
            ))}
          </ul>
          {!progress.frozen && <Note>Cancel stays available until the tabs resume on {target}.</Note>}
          {errorLine}
        </>
      );
      footer = (
        <>
          <Button type="button" variant="ghost" className="mr-auto" onClick={onClose}>Hide</Button>
          {!progress.frozen && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => sessionId && act(() => cancelSessionMove(where, sessionId), 'Couldn’t cancel the move')}>Cancel move</Button>
          )}
          {confirming && (
            <Button type="button" disabled={busy} onClick={() => sessionId && act(() => sessionMoveStatus(where, sessionId, true), `Couldn’t reach ${target}`)}>Check again</Button>
          )}
        </>
      );
    } else if (progress.phase === 'done') {
      const done = doneView(progress.summary, target);
      body = (
        <>
          <p className="text-sm text-text-secondary">{done.lead}</p>
          {done.lines.length > 0 && (
            <ul className="mt-3">
              {done.lines.map(line => <Line key={line.title} kind={line.level} label={line.level === 'ok' ? 'Done' : 'Note'} title={line.title} detail={line.detail} />)}
            </ul>
          )}
          <Note>This machine keeps the Session archived as &ldquo;Moved to {target}&rdquo;.</Note>
        </>
      );
      footer = (
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
          <Button type="button" onClick={openThere}>Open on {target}</Button>
        </>
      );
    } else {
      body = (
        <>
          <p className="text-sm text-text-secondary">{progress.error?.message ?? `The move to ${target} stopped and did not say why.`}</p>
          <Note>Next: {progress.error?.next ?? 'try the move again.'}</Note>
        </>
      );
      footer = (
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
          <Button type="button" onClick={tryAgain}>Try again</Button>
        </>
      );
    }
  } else if (progress?.phase === 'cancelled') {
    title = progressHeading(progress);
    body = <p className="text-sm text-text-secondary">The move to {progress.target} was cancelled. The Session is running here again, unchanged.</p>;
    footer = <Button type="button" onClick={onClose}>Close</Button>;
  } else {
    const ready = preflight?.ready === true && blocks.length === 0;
    body = (
      <>
        <p className="text-sm text-text-secondary">
          {preflight && blocks.length > 0 ? needsFixLine(preflight.target, blocks.length) : moveIntro(preflight)}
        </p>
        {pairedLine}
        {machinesHold.holding ? <MachinesLoading /> : statusKnown && machineList(true)}
        {preflight && (
          <ul className="mt-3" aria-label={`Checks on ${preflight.target}`}>
            {[...blocks, ...preflight.checks.filter(check => check.level !== 'block')].map(check => (
              <Line
                key={check.id}
                testId={`move-check-${check.id}`}
                kind={CHECK_INDICATOR[check.level]}
                label={check.level === 'ok' ? 'Ready' : check.level === 'warning' ? 'Warning' : 'Blocks the move'}
                title={check.title}
                detail={check.detail}
                action={check.fix && (
                  <Button type="button" size="sm" variant="secondary" className="h-6 flex-none px-2 text-xs" disabled={fixing !== null || busy} loading={fixing === check.id} onClick={() => runFix(check)}>
                    {check.fix.label}
                  </Button>
                )}
              />
            ))}
          </ul>
        )}
        {preflight && (blocks.length > 0
          ? <Note>Nothing has been paused yet.</Note>
          : <Note>Agents still working will finish their turn first. Nothing changes here until {preflight.target} confirms.</Note>)}
        {errorLine}
      </>
    );
    footer = (
      <>
        <Button type="button" variant="ghost" className="mr-auto" disabled={busy || fixing !== null || sessionHost.kind === 'paired' || !canHandOff} onClick={() => { setMode('note'); setError(null); }}>Hand off with a note…</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
        <Button type="button" disabled={busy || checking || !ready || !destination || !session} onClick={startMove}>{busy ? 'Starting…' : 'Move'}</Button>
      </>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={close} ariaLabel="Move Session to another machine" closeOnOverlayClick={!running}>
      <form onSubmit={event => {
        event.preventDefault();
        if (mode !== 'note' || !canHandOff || !moving || !session || !destination || busy) return;
        setBusy(true); setError(null);
        void submitToAgent(moving, session.panelIds[session.agent], moveToHostPrompt(session.agent, destination.name))
          .then(() => { onClose(); onMoved(session.id); })
          .catch(failure => setError(`${messageOf(failure, 'Could not send the handoff request')}.`))
          .finally(() => setBusy(false));
      }}>
        <ModalHeader title={title} />
        <ModalBody>
          <div aria-live="polite">{body}</div>
          {running && <Note>Closing this window doesn&rsquo;t stop the move. Choose Move to machine… again to see it.</Note>}
        </ModalBody>
        <ModalFooter>{footer}</ModalFooter>
      </form>
    </Modal>
  );
}

/** The destination list while it loads: two machine rows in the list's own row shape. */
function MachinesLoading() {
  return (
    <>
      <LoadingStatus label="Looking for your machines" />
      <Skeleton className="mt-3 flex flex-col gap-1.5">
        {[30, 42].map(width => (
          <div key={width} className="flex items-center gap-2.5 rounded-md border border-border-primary px-2.5 py-1.5 text-sm">
            <span className="flex h-5 flex-1 items-center"><Bone className="h-3.5" style={{ width: `${width}%` }} /></span>
          </div>
        ))}
      </Skeleton>
    </>
  );
}
