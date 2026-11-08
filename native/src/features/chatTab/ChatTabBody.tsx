import { router } from 'expo-router';
import { useCallback } from 'react';

import { workerLines } from '@shared/chatTabPresentation';
import type { ChatPanelState } from '@shared/types/chatTab';
import type { OrchestrationSessionOverview } from '@shared/types/orchestrationSession';
import type { ToolPanel } from '@shared/types/panels';

import { useDaemonEvent, useInvokeQuery } from '@/daemon';

import { ChatTabScreen } from './ChatTabScreen';

/** Opens a worker's Pane; one function for every render, so the chat's memoized rows skip. */
const openWorker = (paneId: string) => router.push({ pathname: '/pane/[paneId]', params: { paneId } });

/** The Session's workers from Pane's own overview, refreshed when their states change. */
function useSessionWorkers(sessionId: string | undefined) {
  const overview = useInvokeQuery<OrchestrationSessionOverview>('orchestration-sessions:overview', [{ sessionId: sessionId ?? '' }], { enabled: !!sessionId });
  useDaemonEvent('orchestration-sessions:overview-updated', () => { if (sessionId) void overview.refetch(); });
  if (!overview.data) return undefined;
  const attached = new Map(overview.data.session.associations.map(association => [association.paneId, association.attachedAt]));
  return workerLines(overview.data.panes, attached);
}

/**
 * A chat tab in the phone's tab strip. The Session orchestrator's chat
 * lists its workers, each opening its Pane (D-18, D-19).
 */
export function ChatTabBody({ panel, panels }: { panel: ToolPanel; panels: readonly ToolPanel[] }) {
  // SAFETY: the panel type 'chat' carries ChatPanelState as its custom state.
  const state = panel.state.customState as ChatPanelState | undefined;
  const sessionId = state?.orchestrationSessionId;
  const workers = useSessionWorkers(sessionId);
  const diffId = panels.find(candidate => candidate.type === 'diff')?.id;
  const viewDiff = useCallback(() => router.setParams({ panelId: diffId }), [diffId]);
  return <ChatTabScreen key={panel.id} panelId={panel.id} workers={workers}
    placeholder={sessionId ? 'Ask the Session anything' : undefined}
    onOpenWorker={openWorker}
    onViewDiff={diffId ? viewDiff : undefined} />;
}
