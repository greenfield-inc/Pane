import { router } from 'expo-router';

import { workerLines } from '@shared/chatTabPresentation';
import type { ChatPanelState } from '@shared/types/chatTab';
import type { OrchestrationSessionOverview } from '@shared/types/orchestrationSession';
import type { ToolPanel } from '@shared/types/panels';

import { useDaemonEvent, useInvokeQuery } from '@/daemon';

import { ChatTabScreen } from './ChatTabScreen';

/** The Session's workers from Pane's own overview, refreshed when their states change. */
function useSessionWorkers(sessionId: string | undefined) {
  const overview = useInvokeQuery<OrchestrationSessionOverview>('orchestration-sessions:overview', [{ sessionId: sessionId ?? '' }], { enabled: !!sessionId });
  useDaemonEvent('orchestration-sessions:overview-updated', () => { if (sessionId) void overview.refetch(); });
  if (!overview.data) return undefined;
  const attached = new Map(overview.data.session.associations.map(association => [association.paneId, association.attachedAt]));
  return workerLines(overview.data.panes, attached);
}

/**
 * A chat tab in the phone's tab strip. The Session orchestrator's chat is quiet and
 * lists its workers, each opening its Pane (D-18, D-19).
 */
export function ChatTabBody({ panel, panels }: { panel: ToolPanel; panels: readonly ToolPanel[] }) {
  // SAFETY: the panel type 'chat' carries ChatPanelState as its custom state.
  const state = panel.state.customState as ChatPanelState | undefined;
  const sessionId = state?.orchestrationSessionId;
  const workers = useSessionWorkers(sessionId);
  const diff = panels.find(candidate => candidate.type === 'diff');
  return <ChatTabScreen key={panel.id} panelId={panel.id} quiet={!!sessionId} workers={workers}
    placeholder={sessionId ? 'Message the Session…' : undefined}
    onOpenWorker={paneId => router.push({ pathname: '/pane/[paneId]', params: { paneId } })}
    onViewDiff={diff ? () => router.setParams({ panelId: diff.id }) : undefined} />;
}
