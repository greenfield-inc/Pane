import { GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { STATUS_WORD, type Agent, type Status } from './model';

// Ports of Pane's own primitives (frontend AgentStatusDot, StatusAccentBar, ProjectSessionList row),
// drawn with ChatGPT's system font and colors. Pane blue appears only on primary buttons and badges.

/** Working spins; blocked pulses red; ready is blue, idle green. A plain shell gets no badge. */
export function StatusDot({ status }: { status: Status }) {
  if (status === 'unknown' || status === 'gone') return <span className="dot-slot" aria-hidden="true" />;
  return (
    <span className="dot-slot" role="status" aria-label={`Agent ${STATUS_WORD[status]}`} title={STATUS_WORD[status]}>
      <span className={`dot dot-${status}`} />
    </span>
  );
}

export function StatusWord({ status }: { status: Status }) {
  return <span className={`status-word status-word-${status}`}>{STATUS_WORD[status]}</span>;
}

/** The 4px bar on the left of a Pane row; it carries a moving sheen while the agent works. */
export function AccentBar({ status }: { status: Status }) {
  return <span className={`accent-bar accent-${status}`} aria-hidden="true" />;
}

/** A git-branch icon, or the pull-request icon in its state's color once the branch has a PR. */
export function BranchIcon({ agent }: { agent: Agent }) {
  const pr = agent.pr;
  if (!pr) return <GitBranch className="icon" aria-hidden="true" />;
  if (pr.state === 'merged') return <GitMerge className="icon pr-merged" aria-label="Merged pull request" />;
  if (pr.state === 'closed') return <GitPullRequestClosed className="icon pr-closed" aria-label="Closed pull request" />;
  if (pr.draft) return <GitPullRequestDraft className="icon pr-draft" aria-label="Draft pull request" />;
  return <GitPullRequest className="icon pr-open" aria-label="Open pull request" />;
}

export function DiffStat({ agent }: { agent: Agent }) {
  if (!agent.diff) return null;
  return (
    <span className="diff">
      <span className="adds">+{agent.diff.adds}</span>
      <span className="dels">-{agent.diff.dels}</span>
    </span>
  );
}

/** `#41 · +41 -6 · web`, the metadata line under a Pane row. */
export function MetaLine({ agent, showRepo = true }: { agent: Agent; showRepo?: boolean }) {
  const parts: ReactNode[] = [];
  if (agent.pr) parts.push(<span key="pr">#{agent.pr.number}</span>);
  if (agent.diff) parts.push(<DiffStat key="diff" agent={agent} />);
  if (showRepo && agent.repo) parts.push(<span key="repo">{agent.repo}</span>);
  if (parts.length === 0) return null;
  return <span className="meta">{parts.flatMap((part, index) => (index === 0 ? [part] : [<span key={`sep${index}`} className="sep">·</span>, part]))}</span>;
}

/** PR state as a badge: the one place PR colors appear as fills. */
export function PrBadge({ agent }: { agent: Agent }) {
  const pr = agent.pr;
  if (!pr) return null;
  const state = pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open';
  return <span className={`badge badge-${state}`}>{state}</span>;
}

/** The agent's last lines, in Pane's terminal block. A cursor blinks while it works. */
export function Terminal({ agent, lines, header = true }: { agent: Agent; lines?: number; header?: boolean }) {
  const shown = lines === undefined ? agent.screen : agent.screen.slice(-lines);
  return (
    <div className={`terminal terminal-${agent.status}`}>
      {header && (
        <div className="terminal-header">
          <SquareTerminal className="icon" aria-hidden="true" />
          <span>terminal</span>
        </div>
      )}
      <pre className="terminal-body">
        {shown.length === 0 ? <span className="faint">{agent.status === 'gone' ? 'This Pane was archived.' : 'No output yet.'}</span> : shown.join('\n')}
        {agent.status === 'working' && <span className="cursor">▍</span>}
      </pre>
    </div>
  );
}

export function Button({ children, onClick, submit = false, primary = false, disabled = false, label }: {
  children: ReactNode;
  onClick?: () => void;
  submit?: boolean;
  primary?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button type={submit ? 'submit' : 'button'} className={primary ? 'btn btn-primary' : 'btn'} onClick={onClick} disabled={disabled} aria-label={label}>
      {children}
    </button>
  );
}
