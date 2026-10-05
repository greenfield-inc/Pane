import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  MessageSquare,
  RefreshCw,
  TriangleAlert,
  UserCheck,
} from 'lucide-react';
import { API } from '../../utils/api';
import { parsePullRequestUrl } from './pullRequestUrl';
import type { PullRequestStatus } from '../../../../shared/types/pullRequest';

/** Re-read while the review panel is on screen; GitHub state changes slowly. */
const POLL_MS = 90_000;

const DECISION_LABEL = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  review_required: 'Review required',
  none: 'No review yet',
} as const;

const DECISION_TONE = {
  approved: 'text-status-success',
  changes_requested: 'text-status-error',
  review_required: 'text-status-warning',
  none: 'text-text-muted',
} as const;

function stateVisual(status: PullRequestStatus) {
  if (status.state === 'MERGED') return { Icon: GitMerge, tone: 'text-[#a371f7]', label: 'Merged' };
  if (status.state === 'CLOSED') return { Icon: GitPullRequestClosed, tone: 'text-status-error', label: 'Closed' };
  if (status.isDraft) return { Icon: GitPullRequestDraft, tone: 'text-text-muted', label: 'Draft' };
  return { Icon: CircleDot, tone: 'text-status-success', label: 'Open' };
}

export interface PullRequestStatusBarProps {
  sessionId: string;
  /** The session's pull request URL; nothing renders without one. */
  prUrl?: string;
  isVisible?: boolean;
}

/**
 * What became of the pull request, next to the review it belongs to.
 *
 * Creating one is a single action and lives in the git menu; *watching* one is
 * what you keep coming back to — whether anyone approved it, whether it still
 * merges, how much it grew. That belongs where the changes are reviewed rather
 * than behind a browser tab.
 */
export function PullRequestStatusBar({ sessionId, prUrl, isVisible = true }: PullRequestStatusBarProps) {
  const target = parsePullRequestUrl(prUrl);
  const repo = target?.repo;
  const number = target?.number;

  const [status, setStatus] = useState<PullRequestStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!isVisible || !repo || !number) return;
    const owned = ++requestId.current;
    setLoading(true);
    try {
      const response = await API.pullRequests.getStatus(sessionId, repo, number);
      if (owned === requestId.current && response.success && response.data) setStatus(response.data);
    } catch {
      // Leave the previous state on screen: a failed refresh is not news.
    } finally {
      if (owned === requestId.current) setLoading(false);
    }
  }, [sessionId, repo, number, isVisible]);

  useEffect(() => {
    requestId.current += 1;
    setStatus(null);
    setLoading(false);
    if (!isVisible || !repo || !number) return;

    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => { requestId.current += 1; clearInterval(timer); };
  }, [load, repo, number, isVisible]);

  if (!isVisible || !repo || !number) return null;

  if (!status) {
    return loading ? (
      <div className="flex items-center gap-1.5 border-b border-border-primary bg-surface-secondary px-3 py-1 text-[11px] text-text-muted">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Reading pull request #{number}…
      </div>
    ) : null;
  }

  const { Icon, tone, label } = stateVisual(status);
  const conflicting = status.mergeable === 'CONFLICTING';

  return (
    <div className="border-b border-border-primary bg-surface-secondary text-[11px]">
      <div className="flex items-center gap-2 px-3 py-1">
        <button
          type="button"
          onClick={() => setExpanded(current => !current)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-text-primary"
        >
          {expanded
            ? <ChevronDown className="h-3 w-3 flex-shrink-0 text-text-muted" aria-hidden="true" />
            : <ChevronRight className="h-3 w-3 flex-shrink-0 text-text-muted" aria-hidden="true" />}
          <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${tone}`} aria-hidden="true" />
          <span className={`flex-shrink-0 font-medium ${tone}`}>{label}</span>
          <span className="flex-shrink-0 text-text-muted">#{status.number}</span>
          <span className="truncate text-text-secondary">{status.title}</span>
        </button>

        <span className={`flex flex-shrink-0 items-center gap-1 ${DECISION_TONE[status.reviewDecision]}`}>
          <UserCheck className="h-3 w-3" aria-hidden="true" />
          {DECISION_LABEL[status.reviewDecision]}
        </span>

        {status.commentCount > 0 && (
          <span className="flex flex-shrink-0 items-center gap-1 text-text-muted">
            <MessageSquare className="h-3 w-3" aria-hidden="true" />
            {status.commentCount}
          </span>
        )}

        {conflicting && (
          <span className="flex flex-shrink-0 items-center gap-1 text-status-error" title="This branch has conflicts with its base">
            <TriangleAlert className="h-3 w-3" aria-hidden="true" />
            Conflicts
          </span>
        )}

        <button
          type="button"
          onClick={() => { void load(); }}
          title="Refresh pull request state"
          aria-label="Refresh pull request state"
          className="flex-shrink-0 rounded p-0.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </div>

      {expanded && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-secondary px-3 py-1.5 text-text-muted">
          <span className="font-mono">
            {status.headRepositoryOwner ? `${status.headRepositoryOwner}:` : ''}{status.headRefName}
            {' → '}
            {repo}:{status.baseRefName}
          </span>

          <span>
            {status.changedFiles} {status.changedFiles === 1 ? 'file' : 'files'}
            {' '}
            <span className="text-status-success">+{status.additions}</span>{' '}
            <span className="text-status-error">-{status.deletions}</span>
          </span>

          {status.reviewers.length > 0 && (
            <span className="truncate">
              Reviewed by {status.reviewers.map(reviewer => `${reviewer.login} (${reviewer.state.toLowerCase().replace('_', ' ')})`).join(', ')}
            </span>
          )}

          {status.url && (
            <a
              href={status.url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto flex items-center gap-1 text-interactive hover:underline"
            >
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              Open on GitHub
            </a>
          )}
        </div>
      )}
    </div>
  );
}
