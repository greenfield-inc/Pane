import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { agentLabel, type ConfiguredAgentId } from '../../../../shared/agents';
import type { StartLinkRequest, StartLinkTarget } from '../../../../shared/types/startLinks';
import { useHotkey } from '../../hooks/useHotkey';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { startStartLinkListener, useStartLinkStore, type StartLinkChoice } from './startLinkStore';
import { StartLinkBuilderDialog } from './StartLinkBuilderDialog';

/** Start stays disabled this long after the dialog appears, so a click or key meant for something else can't press it. */
const START_DELAY_MS = 700;
const PREVIEW_LINES = 6;
const PREVIEW_CHARACTERS = 400;

/** The prompt's first lines, or null when the whole prompt fits. */
function promptPreview(prompt: string): string | null {
  const lines = prompt.split('\n');
  let preview = lines.slice(0, PREVIEW_LINES).join('\n');
  if (preview.length > PREVIEW_CHARACTERS) preview = preview.slice(0, PREVIEW_CHARACTERS);
  return preview.length < prompt.length ? `${preview.trimEnd()}…` : null;
}

/** `host/owner/repo` as `owner/repo`. */
function ownerRepo(identity: string): string {
  return identity.split('/').slice(-2).join('/');
}

function wherePhrase(target: StartLinkTarget): string {
  if (target.kind === 'new-session') return 'in a new Session';
  if (target.kind === 'repo') return `in a new Pane in ${target.repoName}`;
  return `in Session ${target.sessionName}`;
}

function targetLabel(target: StartLinkTarget): string {
  if (target.kind === 'new-session') return 'A new Session';
  if (target.kind === 'repo') return `A new Pane in ${target.repoName}`;
  return `Session ${target.sessionName}`;
}

const OPTION_ROW = 'flex items-center justify-between gap-3 rounded border px-3 py-1.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-interactive';

export function StartLinkDialog({ request, onAnswer }: { request: StartLinkRequest; onAnswer: (choice: StartLinkChoice) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const optionsId = useId();
  const [agent, setAgent] = useState<ConfiguredAgentId>(request.agent);
  const [targetIndex, setTargetIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [startReady, setStartReady] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setStartReady(true), START_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const target = request.targets[targetIndex] ?? request.targets[0];
  const runningAgent = target?.kind === 'session' ? target.agent : agent;
  const label = (id: ConfiguredAgentId) => request.agents.find((option) => option.id === id)?.label ?? agentLabel(id);
  const runningLabel = label(runningAgent);
  const preview = promptPreview(request.prompt);
  const linkAgentMissing = request.linkAgent !== null && !request.agents.some((option) => option.id === request.linkAgent && option.installed);

  const cancel = () => onAnswer({ start: false });
  // Enter cancels unless it lands on a button, which presses that button (Cancel has focus first).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    cancel();
  };

  return (
    <Modal isOpen onClose={cancel} size="md" showCloseButton={false} initialFocusRef={cancelRef}>
      <div onKeyDown={onKeyDown} className="flex min-h-0 flex-col" data-testid="start-link-dialog">
        <ModalHeader
          title={`Start ${runningLabel} on this prompt?`}
          description={`Runs ${target ? wherePhrase(target) : 'in a new Session'}.`}
          onClose={cancel}
        />
        <ModalBody className="space-y-3">
          <div>
            <pre
              aria-label="Prompt"
              className={cn(
                'whitespace-pre-wrap break-words rounded border border-border-primary bg-surface-secondary px-3 py-2 font-mono text-xs leading-relaxed text-text-primary',
                showAll && 'max-h-64 overflow-y-auto',
              )}
            >
              {preview && !showAll ? preview : request.prompt}
            </pre>
            {preview && (
              <button
                type="button"
                onClick={() => setShowAll((open) => !open)}
                className="mt-1 rounded text-xs font-medium text-interactive-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
              >
                {showAll ? 'Show less' : 'Show all'}
              </button>
            )}
          </div>
          {linkAgentMissing && request.linkAgent && target?.kind !== 'session' && (
            <p className="text-sm text-text-secondary">The link asks for {label(request.linkAgent)}, which isn't installed on this computer, so {runningLabel} runs instead.</p>
          )}
          <p className="text-sm text-text-secondary">{runningLabel} runs with full access: it can edit files and run commands without asking.</p>
          <div>
            <button
              type="button"
              aria-expanded={optionsOpen}
              aria-controls={optionsId}
              onClick={() => setOptionsOpen((open) => !open)}
              className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
            >
              <ChevronRight aria-hidden="true" className={cn('h-4 w-4 transition-transform', optionsOpen && 'rotate-90')} />
              Options
            </button>
            {optionsOpen && (
              <div id={optionsId} className="mt-2 space-y-4">
                <fieldset className="space-y-2" disabled={target?.kind === 'session'}>
                  <legend className="text-label font-medium text-text-primary">Agent</legend>
                  <div className="grid grid-cols-2 gap-1.5">
                    {request.agents.map((option) => {
                      const selected = runningAgent === option.id;
                      const unavailable = !option.installed || target?.kind === 'session';
                      return (
                        <label
                          key={option.id}
                          className={cn(
                            OPTION_ROW,
                            selected ? 'border-interactive bg-surface-selected text-text-primary' : 'border-border-primary text-text-secondary',
                            unavailable ? 'opacity-60' : 'hover:bg-surface-hover hover:text-text-primary',
                          )}
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="radio"
                              name={`${optionsId}-agent`}
                              checked={selected}
                              disabled={!option.installed}
                              onChange={() => setAgent(option.id)}
                              className="accent-interactive"
                            />
                            {option.label}
                          </span>
                          {!option.installed && <span className="text-xs text-text-muted">Not installed</span>}
                        </label>
                      );
                    })}
                  </div>
                  {target?.kind === 'session' && (
                    <p className="text-xs text-text-tertiary">Session {target.sessionName} runs {runningLabel}, so the prompt goes to {runningLabel}.</p>
                  )}
                </fieldset>
                <fieldset className="space-y-2">
                  <legend className="text-label font-medium text-text-primary">Runs in</legend>
                  <div className="grid gap-1.5">
                    {request.targets.map((option, index) => {
                      const selected = index === targetIndex;
                      return (
                        <label
                          key={index}
                          className={cn(
                            OPTION_ROW,
                            'justify-start gap-2',
                            selected ? 'border-interactive bg-surface-selected text-text-primary' : 'border-border-primary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                          )}
                        >
                          <input
                            type="radio"
                            name={`${optionsId}-target`}
                            checked={selected}
                            onChange={() => setTargetIndex(index)}
                            className="accent-interactive"
                          />
                          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                            {targetLabel(option)}
                            {option.kind === 'repo' && option.identity && (
                              <span className="truncate text-xs text-text-tertiary">{ownerRepo(option.identity)}</span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </div>
            )}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button ref={cancelRef} type="button" variant="secondary" onClick={cancel}>Cancel</Button>
          <Button
            type="button"
            disabled={!startReady || !target}
            onClick={() => onAnswer({ start: true, agent: runningAgent, target: targetIndex })}
          >
            Start
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}

/** Mounted once at the app root: the confirm for `pane://new` links, and the palette's link builder. */
export function StartLinkHost() {
  const request = useStartLinkStore((state) => state.request);
  const answer = useStartLinkStore((state) => state.answer);
  const [builderOpen, setBuilderOpen] = useState(false);
  useEffect(() => startStartLinkListener(), []);
  useHotkey({
    id: 'create-start-link',
    label: 'Create Open in Pane link…',
    category: 'tools',
    action: () => setBuilderOpen(true),
  });
  return (
    <>
      {request && <StartLinkDialog key={request.requestId} request={request} onAnswer={answer} />}
      <StartLinkBuilderDialog isOpen={builderOpen} onClose={() => setBuilderOpen(false)} />
    </>
  );
}
