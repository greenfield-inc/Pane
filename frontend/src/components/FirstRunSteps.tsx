import { ExternalLink, Loader2 } from 'lucide-react';
import { Button } from './ui/Button';
import { getCliBrandIcon } from './ui/brandIconRegistry';
import { AGENT_LAUNCH_PRESETS } from '../../../shared/constants/agentLaunchPresets';
import type { FirstRunAgent } from '../../../shared/types/onboarding';
import type { PaneChatAgent } from '../../../shared/types/paneChat';
import type { ImportSession } from '../../../shared/types/sessionImport';
import { TOOL_NAMES } from './sessionImport/sessionImportCopy';
import { cn } from '../utils/cn';

const INSTALL_URLS = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://github.com/openai/codex',
  cursor: 'https://cursor.com/docs/cli/installation',
} satisfies Record<PaneChatAgent, string>;

/** The Yes button and the scanning indicator share this box, so the footer never shifts. */
const ANSWER_BOX = 'h-9 w-24';

function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function sourceNames(sessions: ImportSession[]): string {
  return joinNames([...new Set(sessions.map(session => TOOL_NAMES[session.source]))]);
}

interface AgentStepProps {
  /** null while Pane looks for the CLIs. */
  agents: FirstRunAgent[] | null;
  disabled: boolean;
  onPick: (agent: PaneChatAgent) => void;
}

/** Step 1: one row per agent this platform supports; an agent whose CLI is missing links to its install page. */
export function AgentStep({ agents, disabled, onPick }: AgentStepProps) {
  return (
    <div className="space-y-3">
      <div role="group" aria-label="Agents" aria-busy={agents === null} className="min-h-[132px] space-y-1.5">
        {(agents ?? [{ id: 'claude', found: false }, { id: 'codex', found: false }, { id: 'cursor', found: false }]).map(agent => {
          const preset = AGENT_LAUNCH_PRESETS.find(candidate => candidate.id === agent.id);
          const title = preset?.title ?? agent.id;
          if (agents === null) {
            return (
              <div key={agent.id} className="flex h-10 items-center rounded-lg border border-border-secondary bg-surface-secondary px-3">
                <span className="h-2.5 w-[40%] animate-pulse rounded bg-surface-tertiary" />
              </div>
            );
          }
          return agent.found ? (
            <button
              key={agent.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(agent.id)}
              className="flex h-10 w-full items-center gap-2.5 rounded-lg border border-border-secondary bg-surface-secondary px-3 text-left text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive disabled:cursor-default disabled:opacity-50"
            >
              {getCliBrandIcon(preset?.iconKey ?? agent.id, 'h-4 w-4 flex-shrink-0')}
              {title}
            </button>
          ) : (
            <div key={agent.id} className="flex h-10 items-center gap-2.5 rounded-lg border border-border-secondary px-3 text-sm">
              <span className="opacity-50">{getCliBrandIcon(preset?.iconKey ?? agent.id, 'h-4 w-4 flex-shrink-0')}</span>
              <span className="font-medium text-text-tertiary">{title}</span>
              <span className="text-text-tertiary">Not found on this computer</span>
              <button
                type="button"
                onClick={() => window.electronAPI.openExternal(INSTALL_URLS[agent.id])}
                className="ml-auto inline-flex items-center gap-1 text-xs text-interactive hover:underline"
              >
                Install
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <p className="text-sm text-text-secondary">Pane runs it for you, with its permission prompts off. You can change it later in Settings.</p>
    </div>
  );
}

interface SessionsStepProps {
  /** null while scanning. */
  sessions: ImportSession[] | null;
}

/** Step 2's body: what was found and the promise that nothing moves or is deleted. */
export function SessionsStepBody({ sessions }: SessionsStepProps) {
  if (sessions === null) {
    return <p className="min-h-[40px] text-sm text-text-secondary">Checking Claude Code, Codex and other agent tools on this computer.</p>;
  }
  return (
    <p className="min-h-[40px] text-sm text-text-secondary">
      Found in {sourceNames(sessions)}: everything running or used in the last 7 days. Pane opens them in place and deletes nothing.
    </p>
  );
}

interface SessionsStepFooterProps extends SessionsStepProps {
  busy: boolean;
  onYes: () => void;
  onNotNow: () => void;
}

export function SessionsStepFooter({ sessions, busy, onYes, onNotNow }: SessionsStepFooterProps) {
  return (
    <>
      <Button variant="ghost" disabled={busy} onClick={onNotNow}>Not now</Button>
      {sessions === null ? (
        <span role="status" aria-label="Looking for your sessions" className={cn(ANSWER_BOX, 'inline-flex items-center justify-center rounded-button border border-border-primary bg-surface-secondary')}>
          <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" aria-hidden="true" />
        </span>
      ) : (
        <Button variant="primary" className={ANSWER_BOX} loading={busy} onClick={onYes}>Yes</Button>
      )}
    </>
  );
}
