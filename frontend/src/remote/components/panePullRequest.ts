import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { RemoteDaemonEventEnvelope } from '../../../../shared/types/remoteDaemon';
import type { ChatStatusPullRequest } from '../../components/chatTab/ChatStatusBar';

/** What the PWA needs from its host to follow a Pane's git status. */
export interface PanePullRequestSource {
  invoke(channel: string, args: unknown[]): Promise<void | object>;
  onEvent(listener: (event: RemoteDaemonEventEnvelope) => void): () => void;
}

/** The part of a host `git-status-updated` event the PR item reads. */
const gitStatusEvent = boundary.object({
  sessionId: boundary.string,
  gitStatus: boundary.optional(boundary.object({
    prNumber: boundary.optional(boundary.number),
    prUrl: boundary.optional(boundary.string),
    prState: boundary.optional(boundary.string),
    prIsDraft: boundary.optional(boundary.boolean),
  })),
});

/**
 * Follows a Pane's pull request in the PWA (review F-3): the host's `git-status-updated`
 * events carry each Pane's git status, and a non-blocking status read makes the host send
 * one now. Calls back with undefined when the Pane has no PR. Returns the stop.
 */
export function watchPanePullRequest(source: PanePullRequestSource, paneId: string, onPullRequest: (pr: ChatStatusPullRequest | undefined) => void): () => void {
  const stop = source.onEvent(event => {
    if (event.channel !== 'git-status-updated') return;
    const update = decodeOptionalBoundary(event.args[0], gitStatusEvent);
    if (!update || update.sessionId !== paneId) return;
    const status = update.gitStatus;
    if (!status?.prNumber || status.prNumber <= 0) { onPullRequest(undefined); return; }
    const pr: ChatStatusPullRequest = { number: status.prNumber };
    if (status.prUrl) pr.url = status.prUrl;
    if (status.prState) pr.state = status.prState;
    if (status.prIsDraft !== undefined) pr.draft = status.prIsDraft;
    onPullRequest(pr);
  });
  source.invoke('sessions:get-git-status', [paneId, true]).catch(() => undefined);
  return stop;
}
