import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { RemoteDaemonEventEnvelope } from '../../../../shared/types/remoteDaemon';
import type { ChatStatusPullRequest } from '../../components/chatTab/ChatStatusBar';

/** What the PWA needs from its host to follow a Pane's git status. */
export interface PanePullRequestSource {
  /** The Pane's git status now; the host also sends a fresh one as `git-status-updated`. */
  gitStatus(paneId: string): Promise<JsonValue | undefined>;
  onEvent(listener: (event: RemoteDaemonEventEnvelope) => void): () => void;
}

/** The part of a git status the PR item reads. */
const pullRequestFields = boundary.object({
  prNumber: boundary.optional(boundary.number),
  prUrl: boundary.optional(boundary.string),
  prState: boundary.optional(boundary.string),
  prIsDraft: boundary.optional(boundary.boolean),
});
const gitStatusEvent = boundary.object({ sessionId: boundary.string, gitStatus: boundary.optional(boundary.json) });

function pullRequestOf(gitStatus: JsonValue | undefined): ChatStatusPullRequest | undefined {
  const status = decodeOptionalBoundary(gitStatus, pullRequestFields);
  if (!status?.prNumber || status.prNumber <= 0) return undefined;
  const pr: ChatStatusPullRequest = { number: status.prNumber };
  if (status.prUrl) pr.url = status.prUrl;
  if (status.prState) pr.state = status.prState;
  if (status.prIsDraft !== undefined) pr.draft = status.prIsDraft;
  return pr;
}

/**
 * Follows a Pane's pull request in the PWA (review F-3): its git status now, from a read that
 * waits for the connection, then each `git-status-updated` the host sends. A reply that arrives
 * after an event is older than it, so it is dropped. Calls back with undefined when the Pane has
 * no PR. Returns the stop.
 */
export function watchPanePullRequest(source: PanePullRequestSource, paneId: string, onPullRequest: (pr: ChatStatusPullRequest | undefined) => void): () => void {
  let live = true;
  let heard = false;
  const stop = source.onEvent(event => {
    if (event.channel !== 'git-status-updated') return;
    const update = decodeOptionalBoundary(event.args[0], gitStatusEvent);
    if (!update || update.sessionId !== paneId) return;
    heard = true;
    onPullRequest(pullRequestOf(update.gitStatus));
  });
  source.gitStatus(paneId).then(status => { if (live && !heard) onPullRequest(pullRequestOf(status)); }, () => undefined);
  return () => { live = false; stop(); };
}
