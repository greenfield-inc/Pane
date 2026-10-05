import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleDot, CircleSlash, CircleX, Loader2 } from 'lucide-react';
import { API } from '../../utils/api';
import { parsePullRequestUrl } from './pullRequestUrl';
import type { PullRequestChecksResult } from '../../../../shared/types/pullRequest';

/** How often CI state is re-read while a review panel is on screen. */
const POLL_MS = 60_000;

const ICONS = {
  pass: CircleCheck,
  fail: CircleX,
  pending: CircleDot,
  skipped: CircleSlash,
  cancelled: CircleSlash,
  none: CircleSlash,
} as const;

const TONES = {
  pass: 'text-status-success',
  fail: 'text-status-error',
  pending: 'text-status-warning',
  skipped: 'text-text-muted',
  cancelled: 'text-text-muted',
  none: 'text-text-muted',
} as const;

export interface PullRequestChecksProps {
  sessionId: string;
  /** The session's pull request URL; nothing renders without one. */
  prUrl?: string;
  isVisible?: boolean;
}

/**
 * CI state for the session's pull request.
 *
 * The point is not to replace GitHub's checks page but to answer "did my agent
 * break the build" without leaving the review panel — which is the moment the
 * question actually comes up.
 */
export function PullRequestChecks({ sessionId, prUrl, isVisible = true }: PullRequestChecksProps) {
  const target = parsePullRequestUrl(prUrl);
  const [result, setResult] = useState<PullRequestChecksResult | null>(null);
  const [loading, setLoading] = useState(false);

  const repo = target?.repo;
  const number = target?.number;

  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!isVisible || !repo || !number) return;
    const owned = ++requestId.current;
    setLoading(true);
    try {
      const response = await API.pullRequests.getChecks(sessionId, repo, number);
      if (owned === requestId.current && response.success && response.data) setResult(response.data);
    } catch {
      // CI state is garnish; a failed read must not disturb the review panel.
    } finally {
      if (owned === requestId.current) setLoading(false);
    }
  }, [sessionId, repo, number, isVisible]);

  useEffect(() => {
    requestId.current += 1;
    setResult(null);
    setLoading(false);
    if (!isVisible || !repo || !number) return;
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => { requestId.current += 1; window.clearInterval(timer); };
  }, [load, repo, number, isVisible]);

  if (!isVisible || !target) return null;
  if (!result && loading) {
    return <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-text-muted" aria-label="Reading checks" />;
  }
  if (!result || result.summary === 'none') return null;

  const Icon = ICONS[result.summary];
  const passed = result.checks.filter(check => check.state === 'pass').length;

  return (
    <button
      type="button"
      onClick={() => { if (prUrl) void window.electronAPI.openExternal(prUrl); }}
      title={result.checks.map(check => `${check.state.padEnd(9)} ${check.name}`).join('\n')}
      className={`inline-flex flex-shrink-0 items-center gap-1 rounded px-1 text-xs transition-colors hover:bg-surface-hover ${TONES[result.summary]}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span className="tabular-nums">{passed}/{result.checks.length}</span>
    </button>
  );
}
