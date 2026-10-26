import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, Send, Trophy, UserMinus, UserPlus } from 'lucide-react';
import { API } from '../../utils/api';
import type {
  LeaderboardEntry,
  LeaderboardResponse,
  LeaderboardStatus,
} from '../../../../shared/types/leaderboard';
import { formatTokens, formatUsd } from '../ui/charts/chartScales';

function JoinBanner({
  status,
  onJoin,
  joining,
}: {
  status: LeaderboardStatus;
  onJoin: () => void;
  joining: boolean;
}) {
  return (
    <div className="rounded border border-border-primary bg-surface-secondary p-4">
      <h3 className="text-sm font-medium text-text-primary">Join the leaderboard</h3>
      <p className="mt-1 text-xs text-text-secondary">
        Share your aggregate usage with runpane.com to see where you rank.
        Your GitHub name is used when <code className="font-mono text-[11px]">gh</code> is logged in;
        otherwise you appear under an anonymous name.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Pane sends</h4>
          <ul className="mt-1 space-y-0.5 text-[11px] text-text-secondary">
            <li><span className="font-medium text-text-primary">GitHub username</span> or a one-way hash of your git email</li>
            <li><span className="font-medium text-text-primary">Token totals</span>: input, output, cache read, cache write</li>
            <li><span className="font-medium text-text-primary">Message count</span> and estimated cost at API prices</li>
            <li><span className="font-medium text-text-primary">Per-model totals</span>, time window (30 days), Pane version</li>
          </ul>
        </div>
        <div>
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Pane never sends</h4>
          <ul className="mt-1 space-y-0.5 text-[11px] text-text-secondary">
            <li><span className="font-medium text-text-primary">Prompts, responses</span>, or any session content</li>
            <li><span className="font-medium text-text-primary">File paths</span>, project or folder names</li>
            <li><span className="font-medium text-text-primary">Transcripts</span>, session ids, message ids</li>
            <li><span className="font-medium text-text-primary">Your email address</span></li>
          </ul>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onJoin}
          disabled={joining || status.doNotTrack}
          className="inline-flex items-center gap-1.5 rounded bg-interactive px-3 py-1.5 text-xs font-medium text-text-on-interactive transition-colors hover:bg-interactive-hover disabled:opacity-50"
        >
          {joining ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <Trophy className="h-3 w-3" aria-hidden="true" />
          )}
          Join the leaderboard
        </button>
        <button
          type="button"
          onClick={() => { window.electronAPI?.openExternal('https://runpane.com/leaderboard'); }}
          className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-hover"
        >
          See it on runpane.com
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      {status.doNotTrack && (
        <p className="mt-2 text-[11px] text-status-warning">
          DO_NOT_TRACK is set in your environment — leaderboard submissions are blocked while it is active.
        </p>
      )}
    </div>
  );
}

function JoinedBanner({
  status,
  onLeave,
  onSendNow,
  leaving,
  sending,
}: {
  status: LeaderboardStatus;
  onLeave: () => void;
  onSendNow: () => void;
  leaving: boolean;
  sending: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded border border-interactive/30 bg-interactive/5 p-4">
      <div>
        <h3 className="text-sm font-medium text-text-primary">
          You're on the leaderboard
          {status.lastRank != null && (
            <span className="tabular-nums"> · ranked #{status.lastRank}</span>
          )}
          {status.lastDisplayName && (
            <span> as <code className="font-mono text-[11px]">{status.lastDisplayName}</code></span>
          )}
        </h3>
        {status.lastSubmittedAtMs && (
          <p className="mt-0.5 text-[11px] text-text-tertiary">
            Last sent {new Date(status.lastSubmittedAtMs).toLocaleString()}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSendNow}
          disabled={sending || status.doNotTrack}
          className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
        >
          {sending ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-3 w-3" aria-hidden="true" />
          )}
          Send now
        </button>
        <button
          type="button"
          onClick={onLeave}
          disabled={leaving}
          className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs text-status-error transition-colors hover:bg-status-error/10 hover:text-text-primary disabled:opacity-50"
        >
          {leaving ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <UserMinus className="h-3 w-3" aria-hidden="true" />
          )}
          Leave
        </button>
      </div>
    </div>
  );
}

function LeaderboardTable({
  entries,
  total,
  currentDisplayName,
}: {
  entries: LeaderboardEntry[];
  total: number;
  currentDisplayName: string | null;
}) {
  return (
    <div className="rounded border border-border-primary bg-surface-secondary p-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-border-primary">
              <th className="px-2 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-text-tertiary w-10">#</th>
              <th className="px-2 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-text-tertiary">User</th>
              <th className="px-2 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Est. cost (30d)</th>
              <th className="px-2 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Output tokens</th>
              <th className="px-2 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Messages</th>
              <th className="px-2 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Top model</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => {
              const isMe = currentDisplayName != null && entry.displayName === currentDisplayName;
              const githubUrl = entry.verified && entry.displayName.startsWith('@')
                ? `https://github.com/${encodeURIComponent(entry.displayName.slice(1))}`
                : null;
              return (
                <tr
                  key={`${entry.rank}-${entry.displayName}`}
                  className={`border-b border-border-primary last:border-b-0 ${
                    isMe ? 'bg-interactive/8' : ''
                  }`}
                >
                  <td className="px-2 py-2 tabular-nums text-text-muted">{entry.rank}</td>
                  <td className="px-2 py-2">
                    {githubUrl ? (
                      <button
                        type="button"
                        onClick={() => { void window.electronAPI.openExternal(githubUrl); }}
                        className={`font-medium hover:underline ${isMe ? 'text-interactive' : 'text-text-primary'}`}
                        title={`Open ${entry.displayName} on GitHub`}
                      >
                        {entry.displayName}
                      </button>
                    ) : (
                      <span className={`font-medium ${isMe ? 'text-interactive' : 'text-text-primary'}`}>
                        {entry.displayName}
                      </span>
                    )}
                    {entry.verified && (
                      <span className="ml-1 text-[10px] text-status-success" title="GitHub verified">✓</span>
                    )}
                    {isMe && (
                      <span className="ml-1.5 text-[10px] text-text-muted">you</span>
                    )}
                    {githubUrl && !isMe && (
                      <button
                        type="button"
                        onClick={() => { void window.electronAPI.openExternal(githubUrl); }}
                        className="ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                        aria-label={`Follow ${entry.displayName} on GitHub`}
                        title="Open GitHub profile to follow"
                      >
                        <UserPlus className="h-2.5 w-2.5" aria-hidden="true" />
                        Follow
                      </button>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-text-secondary">
                    {entry.costIncomplete ? 'n/a' : formatUsd(entry.estimatedCostUsd)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-text-secondary">
                    {formatTokens(entry.outputTokens)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-text-secondary">
                    {entry.messageCount.toLocaleString()}
                  </td>
                  <td className="px-2 py-2 text-text-tertiary">
                    {entry.topModel ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {total > entries.length && (
        <p className="mt-2 text-center text-[10px] text-text-muted">
          Showing top {entries.length} of {total} users
        </p>
      )}
    </div>
  );
}

export function LeaderboardTab() {
  const [status, setStatus] = useState<LeaderboardStatus | null>(null);
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadAll = useCallback(async (): Promise<LeaderboardStatus | null> => {
    try {
      const [statusRes, boardRes] = await Promise.all([
        API.leaderboard.getStatus(),
        API.leaderboard.fetch(),
      ]);
      if (statusRes.success && statusRes.data) setStatus(statusRes.data);
      if (boardRes.success && boardRes.data) setBoard(boardRes.data);
      if (!statusRes.success) throw new Error(statusRes.error);
      if (!boardRes.success) throw new Error(boardRes.error);
      setError(null);
      return statusRes.data ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leaderboard');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll().then(loadedStatus => {
      if (!loadedStatus?.optIn || loadedStatus.doNotTrack) return;
      // Silent fire-and-forget — never surface errors from auto-submit
      void API.leaderboard.sendNow().then(submitRes => {
        if (submitRes.success && submitRes.data) {
          const data = submitRes.data;
          setStatus(prev => prev ? {
            ...prev,
            lastRank: data.rank,
            lastDisplayName: data.displayName,
            lastSubmittedAtMs: Date.now(),
          } : prev);
          // Re-fetch board after submit to pick up updated data
          void API.leaderboard.fetch().then(boardRes => {
            if (boardRes.success && boardRes.data) setBoard(boardRes.data);
          });
        }
      }).catch(() => {});
    });
  }, [loadAll]);

  const handleJoin = useCallback(async () => {
    setJoining(true);
    try {
      const res = await API.leaderboard.join();
      if (!res.success) throw new Error(res.error);
      setStatus(prev => prev ? {
        ...prev,
        optIn: true,
        lastRank: res.data?.rank ?? null,
        lastDisplayName: res.data?.displayName ?? null,
        lastSubmittedAtMs: Date.now(),
      } : prev);
      // Refresh the board to show updated data
      const boardRes = await API.leaderboard.fetch();
      if (boardRes.success && boardRes.data) setBoard(boardRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join');
    } finally {
      setJoining(false);
    }
  }, []);

  const handleLeave = useCallback(async () => {
    setLeaving(true);
    try {
      const res = await API.leaderboard.leave();
      if (!res.success) throw new Error(res.error);
      setStatus(prev => prev ? {
        ...prev,
        optIn: false,
        lastRank: null,
        lastDisplayName: null,
        lastSubmittedAtMs: null,
      } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave');
    } finally {
      setLeaving(false);
    }
  }, []);

  const handleSendNow = useCallback(async () => {
    setSending(true);
    try {
      const res = await API.leaderboard.sendNow();
      if (!res.success) {
        const msg = res.error ?? '';
        if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
          setError('Already sent recently — try again in a few minutes.');
        } else {
          throw new Error(msg);
        }
        return;
      }
      setError(null);
      setStatus(prev => prev ? {
        ...prev,
        lastRank: res.data?.rank ?? prev.lastRank,
        lastDisplayName: res.data?.displayName ?? prev.lastDisplayName,
        lastSubmittedAtMs: Date.now(),
      } : prev);
      const boardRes = await API.leaderboard.fetch();
      if (boardRes.success && boardRes.data) setBoard(boardRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const boardRes = await API.leaderboard.fetch();
      if (boardRes.success && boardRes.data) {
        setBoard(boardRes.data);
        setError(null);
      }
    } catch {
      // silent
    } finally {
      setRefreshing(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-tertiary">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading leaderboard…
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      {error && (
        <div className="rounded border border-status-error/30 bg-status-error/10 p-3 text-xs text-text-primary">
          {error}
        </div>
      )}

      {status && !status.optIn && (
        <JoinBanner status={status} onJoin={handleJoin} joining={joining} />
      )}

      {status?.optIn && (
        <JoinedBanner
          status={status}
          onLeave={handleLeave}
          onSendNow={handleSendNow}
          leaving={leaving}
          sending={sending}
        />
      )}

      <div className="flex items-center justify-between">
        <p className="text-[10px] text-text-muted">
          Last 30 days · all providers · top 100
          {board?.generatedAtMs && (
            <> · updated {formatRelativeTime(board.generatedAtMs)}</>
          )}
        </p>
        <button
          type="button"
          onClick={() => { void handleRefresh(); }}
          disabled={refreshing}
          aria-label="Refresh leaderboard"
          className="rounded p-1 transition-colors hover:bg-surface-hover disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 text-text-tertiary ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </div>

      {board && board.entries.length > 0 ? (
        <LeaderboardTable
          entries={board.entries}
          total={board.total}
          currentDisplayName={status?.lastDisplayName ?? null}
        />
      ) : board ? (
        <div className="rounded border border-border-primary bg-surface-secondary p-6 text-center text-xs text-text-muted">
          No entries yet. Be the first to join!
        </div>
      ) : null}

      <p className="text-[10px] text-text-muted">
        Ranked by estimated cost at API prices. The rank comes from the server's reply to your last submission, never computed locally.
      </p>
    </div>
  );
}

function formatRelativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
