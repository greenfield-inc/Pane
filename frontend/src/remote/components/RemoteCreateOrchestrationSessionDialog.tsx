import { MessageSquare, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useState, type FormEvent, type RefObject } from 'react';
import {
  nextOrchestrationSessionName,
  type OrchestrationSessionRecord,
  type OrchestrationSessionView,
} from '../../../../shared/types/orchestrationSession';
import { DEFAULT_PANE_CHAT_AGENT, PANE_CHAT_AGENT_LABELS, type PaneChatAgent } from '../../../../shared/types/paneChat';
import type { RemotePwaSessionAgents } from '../../../../shared/types/remoteDaemon';
import type { Session } from '../../types/session';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';

const ALL_AGENTS: RemotePwaSessionAgents = { agents: ['claude', 'codex', 'cursor'], defaultAgent: DEFAULT_PANE_CHAT_AGENT };

interface RemoteCreateOrchestrationSessionDialogProps {
  adapter: RemoteRuntimeAdapter;
  /** Older hosts do not report their agents; the host still rejects one it cannot run. */
  sessionAgents: RemotePwaSessionAgents | undefined;
  sessions: readonly OrchestrationSessionRecord[];
  restoreFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreated: (view: OrchestrationSessionView<Session>) => void;
}

export function RemoteCreateOrchestrationSessionDialog({
  adapter,
  sessionAgents = ALL_AGENTS,
  sessions,
  restoreFocusRef,
  fallbackFocusRef,
  onClose,
  onCreated,
}: RemoteCreateOrchestrationSessionDialogProps) {
  const [name, setName] = useState('');
  // Follows the host default, which can arrive after the sheet opens, until the person picks one.
  const [pickedAgent, setPickedAgent] = useState<PaneChatAgent | null>(null);
  const agent = pickedAgent ?? sessionAgents.defaultAgent;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultName = nextOrchestrationSessionName(sessions);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const view = await adapter.createOrchestrationSession({ name: name.trim() || defaultName, agent });
      onCreated(view);
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create Session');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="pane-scrim fixed inset-0 z-[70] bg-black/65" />
        <Dialog.Content
          asChild
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => {
              if (document.activeElement?.closest('[aria-modal="true"]')) return;
              const target = restoreFocusRef.current?.isConnected ? restoreFocusRef.current : fallbackFocusRef.current;
              if (target?.isConnected) target.focus();
            });
          }}
          onEscapeKeyDown={(event) => { if (submitting) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (submitting) event.preventDefault(); }}
        >
          <form
            onSubmit={handleSubmit}
            aria-busy={submitting}
            className="pane-sheet fixed inset-x-0 bottom-0 z-[71] flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-xl border border-border-primary bg-surface-primary shadow-2xl outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border-primary px-5 py-4">
              <Dialog.Title asChild>
                <h2 className="min-w-0 truncate text-lg font-semibold text-text-primary">Create Session</h2>
              </Dialog.Title>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="ml-3 rounded-md p-2 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
                aria-label="Close"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              <div>
                <label htmlFor="remote-create-session-name" className="mb-2 block text-sm font-semibold text-text-primary">
                  Name your chat (optional)
                </label>
                <input
                  id="remote-create-session-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={defaultName}
                  className="h-12 w-full rounded-md border border-border-primary bg-surface-secondary px-3 text-text-primary outline-none placeholder:text-text-muted focus:border-interactive focus:ring-2 focus:ring-interactive"
                />
              </div>

              <fieldset>
                <legend className="mb-2 text-sm font-semibold text-text-primary">Choose an agent</legend>
                <div className="grid gap-2" role="radiogroup" aria-label="Session agent">
                  {sessionAgents.agents.map(option => (
                    <label
                      key={option}
                      className={`flex min-h-12 items-center justify-between rounded-md border px-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-interactive ${
                        agent === option
                          ? 'border-interactive bg-interactive-surface text-text-primary'
                          : 'border-border-primary text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                      }`}
                    >
                      <input
                        type="radio"
                        name="remote-session-agent"
                        value={option}
                        checked={agent === option}
                        onChange={() => setPickedAgent(option)}
                        aria-label={PANE_CHAT_AGENT_LABELS[option]}
                        className="sr-only"
                      />
                      <span className="flex items-center gap-2">
                        <MessageSquare className="h-4 w-4 text-text-tertiary" aria-hidden="true" />
                        {PANE_CHAT_AGENT_LABELS[option]}
                      </span>
                      {option === sessionAgents.defaultAgent && <span className="text-xs text-text-muted">Default</span>}
                    </label>
                  ))}
                </div>
              </fieldset>

              {error && (
                <div role="alert" className="rounded-md border border-status-error/40 bg-status-error/10 p-3 text-sm text-status-error">
                  {error}
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border-primary p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-md px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                aria-busy={submitting}
                className="rounded-md bg-interactive px-5 py-2 text-sm font-semibold text-text-on-interactive transition-colors hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Creating…' : 'Create Session'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
