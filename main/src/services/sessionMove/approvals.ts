import { fileURLToPath } from 'url';
import type { NotifyItem, NotifyLink } from '../../../../shared/types/notify';
import { hasFileProtocol } from '../../../../shared/utils/browserUrl';
import { PaneError } from '../../../../shared/paneError';
import type { MovedApproval } from '../notify/notifyService';
import { relativeInside } from './filePreviews';

/** What the target's build set up, which an arriving approval may refer to. */
export interface ApprovalScope {
  sessionId: string;
  sessionName: string;
  /** The Session's own (orchestrator) Pane here. */
  ownerPaneId: string;
  /** Each terminal or chat tab the build created, with its Pane. */
  tabs: ReadonlyMap<string, string>;
  /** The folders the build placed here (worktrees, the Session folder). */
  roots: readonly string[];
}

/** Fields that route a card to other tabs, cards or machines, or record what already happened to it on the source. */
const SOURCE_ONLY_FIELDS = [
  'relay', 'relayedBy', 'reply', 'summaryOf', 'rewrittenFrom', 'rewrittenAs', 'todo', 'machineId', 'elsewhere', 'unreachable',
  'delivered', 'undelivered', 'answeredBy', 'answeredOn', 'answerSummary', 'corrections', 'reopened', 'resolvedAt', 'closed', 'pushed', 'decision',
] as const;

function inRoots(scope: ApprovalScope, file: string): boolean {
  return scope.roots.some(root => relativeInside(root, file) !== null);
}

function keepsLink(scope: ApprovalScope, link: NotifyLink): boolean {
  if ('path' in link) return inRoots(scope, link.path);
  if ('url' in link && hasFileProtocol(link.url)) {
    try {
      return inRoots(scope, fileURLToPath(link.url));
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Binds arriving approvals to what this build made (T-44): each card's asker must be a tab the build
 * created, in that tab's Pane, and a worker question's inbox item must be this Session's, from that tab.
 * Anything else refuses the move, since its answer would be typed into some other tab. Routing and
 * history from the source is dropped, the card is filed under this Session, and file references
 * outside what moved are dropped, so a card can only point at this move's own files.
 */
export function bindMovedApprovals(approvals: readonly MovedApproval[], scope: ApprovalScope): MovedApproval[] {
  return approvals.map(({ item, report }) => {
    const panelId = item.source.panelId ?? '';
    const paneId = scope.tabs.get(panelId);
    if (!paneId || (item.source.paneId !== undefined && item.source.paneId !== paneId)) {
      throw new PaneError('ERR_MOVE_APPROVAL_ASKER', `Approval “${item.title}” came with the move for a tab that didn't come with it.`, 'Nothing was set up here. Answer it on the other machine, then move again.');
    }
    if (report && (report.sessionId !== scope.sessionId || report.panelId !== panelId || report.paneId !== paneId)) {
      throw new PaneError('ERR_MOVE_APPROVAL_ASKER', `Approval “${item.title}” came with another Session's or tab's question.`, 'Nothing was set up here. Answer it on the other machine, then move again.');
    }
    const bound: NotifyItem = { ...item, state: 'waiting', source: { ...item.source, paneId } };
    for (const field of SOURCE_ONLY_FIELDS) delete bound[field];
    bound.source.session = { ...item.source.session, id: scope.sessionId, name: scope.sessionName, paneId: scope.ownerPaneId };
    bound.connected = { kind: 'session', id: scope.sessionId, name: scope.sessionName, paneId: scope.ownerPaneId };
    if (bound.links) bound.links = bound.links.filter(link => keepsLink(scope, link));
    if (bound.summaryPage && !inRoots(scope, bound.summaryPage)) delete bound.summaryPage;
    if (bound.statusFile && !inRoots(scope, bound.statusFile)) delete bound.statusFile;
    const result: MovedApproval = { item: bound };
    if (report) result.report = report;
    return result;
  });
}
