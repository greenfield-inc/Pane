import { GitBranch, Clock, FileText, Plus, Minus, GitPullRequest } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Session, GitStatus } from '../types/session';
import { formatTimeAgo } from '../utils/timestampUtils';

interface SessionDetailTooltipProps {
  session: Session;
  gitStatus?: GitStatus;
  /** Hide session name when it's already visible inline (default: true) */
  showName?: boolean;
  /** Hide diff stats when they're already visible inline (default: true) */
  showDiffStats?: boolean;
  /** Session hotkey index (0-8) — shows ⌘N shortcut hint when provided */
  globalIndex?: number;
}

export function SessionDetailTooltip({ session, gitStatus, showName = true, showDiffStats = true, globalIndex }: SessionDetailTooltipProps) {
  const gs = gitStatus ?? session.gitStatus;
  const branch = session.worktreePath?.replace(/\\/g, '/').split('/').pop() || '';
  const createdDate = new Date(session.createdAt).toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  });
  const lastActiveAgo = session.lastActivity ? formatTimeAgo(session.lastActivity) : null;

  let statusText = '';
  let statusColor = 'text-text-tertiary';
  if (session.status === 'running' || session.status === 'initializing') {
    statusText = session.status === 'initializing' ? 'Initializing' : 'Running';
    statusColor = 'text-status-success';
  } else if (session.status === 'waiting') {
    statusText = 'Waiting for input';
    statusColor = 'text-status-warning';
  } else if (session.status === 'error') {
    statusText = 'Error';
    statusColor = 'text-status-error';
  } else if (gs) {
    if (gs.state === 'conflict') { statusText = 'Merge conflicts'; statusColor = 'text-status-error'; }
    else if (gs.isReadyToMerge) { statusText = 'Ready to merge'; statusColor = 'text-status-success'; }
    else if (gs.hasUncommittedChanges) { statusText = 'Uncommitted'; statusColor = 'text-status-warning'; }
    else if (gs.state === 'diverged') { statusText = 'Diverged'; statusColor = 'text-status-warning'; }
    else if (gs.state === 'ahead' && gs.ahead) { statusText = `${gs.ahead} ahead`; statusColor = 'text-status-warning'; }
    else if (gs.state === 'behind' && gs.behind) { statusText = `${gs.behind} behind`; }
    else if (gs.state === 'clean') { statusText = 'Up to date'; }
  }

  const adds = (gs?.commitAdditions ?? 0) + (gs?.additions ?? 0);
  const dels = (gs?.commitDeletions ?? 0) + (gs?.deletions ?? 0);
  const hasDiff = adds > 0 || dels > 0;
  const filesChanged = (gs?.commitFilesChanged ?? 0) + (gs?.filesChanged ?? 0);
  const shouldShowDiffStats = hasDiff && (showDiffStats || Boolean(gs?.prNumber));

  return (
    <div className="max-w-xs space-y-1.5">
      {showName && (
        <>
          <p className="text-[11px] text-text-primary font-medium whitespace-pre-wrap break-words leading-snug">
            {session.name || 'Untitled'}
          </p>
          <div className="border-t border-border-primary" />
        </>
      )}

      <div className="space-y-0.5 text-[10px]">
        {branch && (
          <div className="flex items-center gap-1.5">
            <GitBranch className="w-3 h-3 text-text-tertiary flex-shrink-0" />
            <span className="text-text-secondary font-mono break-all">{branch}</span>
          </div>
        )}
        {statusText && (
          <div className="flex items-center gap-1.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ml-[3px] ${
              statusColor.replace('text-', 'bg-')
            }`} />
            <span className={`${statusColor} ml-[3px]`}>{statusText}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Clock className="w-3 h-3 text-text-tertiary flex-shrink-0" />
          <span className="text-text-secondary">
            {createdDate}
            {lastActiveAgo && <span className="text-text-tertiary"> · active {lastActiveAgo}</span>}
          </span>
        </div>
      </div>

      {shouldShowDiffStats && (
        <>
          <div className="border-t border-border-primary" />
          <div className="flex items-center gap-3 text-[10px]">
            <span className="flex items-center gap-1 text-text-secondary">
              <FileText className="w-3 h-3 text-text-tertiary" />
              {filesChanged} {filesChanged === 1 ? 'file' : 'files'}
            </span>
            {adds > 0 && (
              <span className="flex items-center gap-0.5 text-status-success">
                <Plus className="w-3 h-3" />{adds}
              </span>
            )}
            {dels > 0 && (
              <span className="flex items-center gap-0.5 text-status-error">
                <Minus className="w-3 h-3" />{dels}
              </span>
            )}
          </div>
        </>
      )}

      {globalIndex != null && globalIndex >= 0 && globalIndex < 9 && (
        <>
          <div className="border-t border-border-primary" />
          <div className="text-[10px] text-text-muted">⌘{globalIndex + 1}</div>
        </>
      )}

      {gs?.prNumber && (
        <>
          <div className="border-t border-border-primary" />
          <div className="space-y-1 text-[10px]">
            {showName ? (
              <div className="flex items-center gap-1.5">
                <GitPullRequest className="w-3 h-3 text-text-tertiary flex-shrink-0" />
                <span className="text-text-secondary font-medium">
                  #{gs.prNumber}
                  {gs.prState && (
                    <span className={`ml-1 ${
                      gs.prState === 'MERGED' ? 'text-purple-400' :
                      gs.prState === 'CLOSED' ? 'text-red-400' :
                      'text-green-400'
                    }`}>
                      {gs.prState.charAt(0) + gs.prState.slice(1).toLowerCase()}
                    </span>
                  )}
                </span>
              </div>
            ) : gs.prState && (
              <div className="flex items-center gap-1.5">
                <span className={
                  gs.prState === 'MERGED' ? 'text-purple-400' :
                  gs.prState === 'CLOSED' ? 'text-red-400' :
                  'text-green-400'
                }>
                  {gs.prState.charAt(0) + gs.prState.slice(1).toLowerCase()}
                </span>
              </div>
            )}
            {showName && gs.prTitle && (
              <p className="text-[11px] text-text-primary font-medium whitespace-pre-wrap break-words leading-snug pl-[18px]">
                {gs.prTitle}
              </p>
            )}
            {gs.prBody && (
              <div className={`text-[10px] text-text-tertiary break-words leading-snug ${showName ? 'pl-[18px]' : ''} line-clamp-[32] prose prose-xs prose-invert max-w-none overflow-hidden [&_h1]:text-[11px] [&_h2]:text-[11px] [&_h3]:text-[10px] [&_p]:text-[10px] [&_li]:text-[10px] [&_code]:text-[9px] [&_code]:break-all [&_ul]:my-0.5 [&_ol]:my-0.5 [&_p]:my-0.5 [&_pre]:whitespace-pre-wrap [&_pre]:overflow-hidden`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{gs.prBody}</ReactMarkdown>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
