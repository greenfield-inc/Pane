import type { PanelEvent, PanelEventType } from '../../../shared/types/panels';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';

type GitRefreshEvent = Pick<PanelEvent, 'type'> & { source: Pick<PanelEvent['source'], 'sessionId'> };
const gitRefreshEventSchema: BoundarySchema<GitRefreshEvent> = boundary.object({
  type: boundary.enumeration('git:operation_completed', 'diff:refreshed'),
  source: boundary.object({ sessionId: boundary.string }),
});
const gitStatusEventSchema = boundary.object({ sessionId: boundary.string });

/** Subscribe to authoritative git changes for one pane, including status polling. */
export function subscribeToSessionGitChanges(
  sessionId: string,
  refresh: () => void,
  panelTypes: readonly PanelEventType[] = ['git:operation_completed', 'diff:refreshed'],
): () => void {
  const onPanelEvent = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = decodeOptionalBoundary(event.detail, gitRefreshEventSchema);
    if (detail?.source.sessionId === sessionId && panelTypes.includes(detail.type)) refresh();
  };
  const onGitStatus = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = decodeOptionalBoundary(event.detail, gitStatusEventSchema);
    if (detail?.sessionId === sessionId) refresh();
  };
  window.addEventListener('panel:event', onPanelEvent);
  window.addEventListener('git-status-updated', onGitStatus);
  return () => {
    window.removeEventListener('panel:event', onPanelEvent);
    window.removeEventListener('git-status-updated', onGitStatus);
  };
}
