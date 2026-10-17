import { useEffect, useState } from 'react';
import { API } from '../utils/api';
import { cn } from '../utils/cn';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { useConfigStore } from '../stores/configStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { moveTargets, moveToHostPrompt, sessionHostFor, type MoveTarget, type MoveTargetList } from '../utils/moveSessionToHost';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';

const NOT_RUNNING = /is not initialized/;
/** The part of `runpane panels submit`'s answer that says whether the agent took the text. */
const submitResultSchema = boundary.object({
  ok: boundary.boolean,
  blocked: boundary.optional(boundary.object({ message: boundary.string })),
});

/**
 * Sends the prompt the way a person's message reaches the agent: `runpane panels submit` on the
 * Session's own host, which waits for the composer and queues behind a running turn.
 */
async function submitToAgent(panelId: string, input: string): Promise<void> {
  let response: unknown;
  try {
    response = await window.electronAPI.invoke('runpane:panels:submit', { panelId, input, source: 'user' });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (NOT_RUNNING.test(message)) {
      throw new Error('The Session\'s agent is not running yet, so nothing was sent. Open the Session, wait for its agent to start, then choose Move to host… again.');
    }
    throw new Error(`Could not send the handoff request to the Session's agent: ${message}. Nothing was sent.`);
  }
  const result = decodeOptionalBoundary(response, submitResultSchema);
  if (result?.ok === false) {
    throw new Error(`The Session's agent did not take the handoff request: ${result.blocked?.message ?? 'the agent did not accept it'}. Open the Session to see its screen.`);
  }
}

interface MoveSessionToHostDialogProps {
  sessionId: string | null;
  onClose: () => void;
  /** Called after the agent has the request, so the person can watch it hand off. */
  onMoved: (sessionId: string) => void;
}

export function MoveSessionToHostDialog({ sessionId, onClose, onMoved }: MoveSessionToHostDialogProps) {
  const session = useOrchestrationSessionStore(state => state.sessions.find(candidate => candidate.id === sessionId));
  const remoteDaemon = useConfigStore(state => state.config?.remoteDaemon);
  const [targets, setTargets] = useState<MoveTargetList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOpen = sessionId !== null;
  const sessionHost = sessionHostFor(remoteDaemon);
  const hostKey = sessionHost.kind === 'tailnet' ? sessionHost.machine : sessionHost.kind;

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setTargets(null); setSelected(null); setError(null);
    const host = sessionHostFor(useConfigStore.getState().config?.remoteDaemon);
    if (host.kind === 'paired') return;
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
        const listed = moveTargets({ machines: machines.data, sessionHost: host, thisComputer });
        setTargets(listed);
        if (listed.ok) setSelected(listed.targets.find(target => target.available)?.name ?? null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not list your machines.');
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, sessionId, hostKey]);

  const close = () => { if (!busy) onClose(); };
  const target = targets?.ok ? targets.targets.find(candidate => candidate.name === selected && candidate.available) : undefined;

  return (
    <Modal isOpen={isOpen} onClose={close} ariaLabel="Move Session to another host">
      <form onSubmit={event => {
        event.preventDefault();
        if (!session || !target || busy) return;
        setBusy(true); setError(null);
        void submitToAgent(session.panelIds[session.agent], moveToHostPrompt(session.agent, target.name))
          .then(() => { onClose(); onMoved(session.id); })
          .catch(failure => setError(failure instanceof Error ? failure.message : 'Could not send the handoff request.'))
          .finally(() => setBusy(false));
      }}>
        <ModalHeader title={`Move ${session?.name ?? 'Session'} to another host`} />
        <ModalBody>
          <p className="text-sm text-text-secondary">
            Pane asks this Session's agent to hand it off with <code>runpane handoff</code>. With the same agent, the new Session continues this Session's own conversation when you open it; otherwise it starts from the agent's note. This one stays here.
          </p>
          {sessionHost.kind === 'paired' && <p className="mt-3 text-sm text-text-secondary">{sessionHost.reason}</p>}
          {sessionHost.kind !== 'paired' && !targets && !error && <p className="mt-3 text-sm text-text-tertiary">Looking for your machines…</p>}
          {targets && !targets.ok && (
            <p className="mt-3 text-sm text-text-secondary">{targets.reason}. {targets.fix}</p>
          )}
          {targets?.ok && (
            <fieldset className="mt-3 space-y-2" disabled={busy}>
              <legend className="sr-only">Destination machine</legend>
              {targets.noneReachable && (
                <p className="text-sm text-text-secondary">
                  No other machine can take this Session right now. Open Pane on the machine you want, check it is signed in to Tailscale, then try again.
                </p>
              )}
              {targets.targets.map(option => (
                <label
                  key={option.name}
                  data-testid={`move-session-target-${option.name}`}
                  className={cn(
                    'flex flex-col gap-0.5 rounded border px-3 py-2 text-sm transition-colors focus-within:ring-2 focus-within:ring-interactive',
                    !option.available ? 'cursor-not-allowed border-border-primary text-text-muted'
                      : selected === option.name ? 'border-interactive bg-surface-selected text-text-primary'
                        : 'border-border-primary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                  )}
                >
                  <input
                    type="radio"
                    name="move-session-target"
                    value={option.name}
                    aria-label={option.name}
                    aria-describedby={option.reason ? `move-session-target-reason-${option.name}` : undefined}
                    checked={selected === option.name}
                    disabled={!option.available}
                    onChange={() => setSelected(option.name)}
                    className="sr-only"
                  />
                  <span className="truncate font-medium">
                    {option.name}
                    {option.owner && <span className="font-normal text-text-tertiary"> · {option.owner}</span>}
                  </span>
                  {option.reason && <span id={`move-session-target-reason-${option.name}`} className="text-xs text-text-tertiary">{option.reason}</span>}
                </label>
              ))}
            </fieldset>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-status-error">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
          <Button type="submit" disabled={busy || !target || !session}>{busy ? 'Sending…' : 'Move Session'}</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
