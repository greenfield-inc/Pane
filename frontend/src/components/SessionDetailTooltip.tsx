import { Github } from 'lucide-react';
import type { Session, GitStatus } from '../types/session';
import { prStateLabel, prStateVariant } from '../utils/paneTitle';
import { Badge } from './ui/Badge';

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.floor(days / 30);
  return `${months} ${months === 1 ? 'month' : 'months'} ago`;
}

interface SessionDetailTooltipProps {
  session: Session;
  gitStatus?: GitStatus;
  /** Label to show as the heading; defaults to the session name. */
  name?: string;
  /** Session hotkey index (0-8) — shows ⌘N shortcut hint when provided */
  globalIndex?: number;
}

/**
 * Hover card for a Pane in the sidebar: the label, its branch, when it was last
 * active, and — when a pull request exists — the PR number, state, diff size,
 * title, and a link out. Deliberately no PR body or status prose: the row
 * already carries live status, and a hover card is for orientation, not reading.
 */
export function SessionDetailTooltip({ session, gitStatus, name, globalIndex }: SessionDetailTooltipProps) {
  const gs = gitStatus ?? session.gitStatus;
  const branch = session.worktreePath?.replace(/\\/g, '/').split('/').pop() || '';
  const lastActive = session.lastActivity || session.createdAt;
  const lastActiveAgo = lastActive ? formatTimeAgo(lastActive) : null;

  const adds = (gs?.commitAdditions ?? 0) + (gs?.additions ?? 0);
  const dels = (gs?.commitDeletions ?? 0) + (gs?.deletions ?? 0);
  const hasDiff = adds > 0 || dels > 0;
  const prState = gs?.prState?.toUpperCase();
  const stateLabel = prStateLabel(prState);
  const prStateTitle = stateLabel.charAt(0).toUpperCase() + stateLabel.slice(1);
  const hotkey = globalIndex != null && globalIndex >= 0 && globalIndex < 9 ? `⌘${globalIndex + 1}` : null;

  const diffStats = hasDiff ? (
    <span className="flex flex-shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      {adds > 0 && <span className="text-status-success">+{adds}</span>}
      {dels > 0 && <span className="text-status-error">-{dels}</span>}
    </span>
  ) : null;

  const openPr = () => {
    if (gs?.prUrl) void window.electronAPI.openExternal(gs.prUrl);
  };

  return (
    <div className="w-64 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-semibold leading-snug text-text-primary whitespace-pre-wrap break-words">
          {name ?? (session.name || 'Untitled')}
        </p>
        {hotkey && (
          <kbd className="mt-0.5 flex-shrink-0 rounded border border-border-primary px-1 font-sans text-[10px] leading-4 text-text-muted">
            {hotkey}
          </kbd>
        )}
      </div>

      {branch && (
        <div className="space-y-0.5">
          <p className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Branch</p>
          <p className="font-mono text-[13px] leading-snug text-text-primary break-all">{branch}</p>
        </div>
      )}

      {lastActiveAgo && <p className="text-xs text-text-tertiary">{lastActiveAgo}</p>}

      {gs?.prNumber ? (
        <div className="space-y-2 border-t border-border-primary pt-3">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-[13px] text-text-secondary">
              #{gs.prNumber}
              {prState && (
                <Badge variant={prStateVariant(prState)} size="sm" className="px-1.5 py-0 text-[11px] leading-4">
                  {prStateTitle}
                </Badge>
              )}
            </span>
            {diffStats}
          </div>
          {gs.prTitle && (
            <p className="line-clamp-2 text-[13px] leading-snug text-text-primary break-words">{gs.prTitle}</p>
          )}
          {gs.prUrl && (
            <button
              type="button"
              onClick={openPr}
              className="flex w-full items-center gap-2 rounded-md border border-border-primary bg-surface-secondary px-2.5 py-1.5 text-left text-xs text-text-primary transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive"
            >
              <Github className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" aria-hidden="true" />
              View on GitHub
            </button>
          )}
        </div>
      ) : diffStats && (
        <div className="flex items-center justify-between gap-3 border-t border-border-primary pt-3 text-xs text-text-tertiary">
          <span>Changes</span>
          {diffStats}
        </div>
      )}
    </div>
  );
}
