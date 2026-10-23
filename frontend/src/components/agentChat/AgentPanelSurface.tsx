import { lazy, Suspense, type ReactNode } from 'react';
import type { TerminalPanelState, ToolPanel } from '../../../../shared/types/panels';
import type { AgentChatClient } from '../../../../shared/types/agentChat';
import { AgentChatHeader } from './AgentChatHeader';
const AgentChatPanel = lazy(() => import('./AgentChatPanel'));

export function AgentPanelSurface({ panel, client, connected, children }: { panel: ToolPanel; client: AgentChatClient; connected?: boolean; children: ReactNode }) {
  // SAFETY: This surface is only mounted for terminal panels.
  const conversation = (panel.state.customState as TerminalPanelState | undefined)?.agentChat?.conversation;
  if (conversation && conversation.active !== 'terminal' && !conversation.nativeStartup) return <Suspense fallback={<div role="status" className="p-4 text-sm text-text-secondary">Loading conversation…</div>}><AgentChatPanel panelId={panel.id} client={client} connected={connected} /></Suspense>;
  return <div className="relative flex h-full min-h-0 w-full flex-1 flex-col">
    {conversation && <AgentChatHeader panelId={panel.id} client={client} connected={connected} />}
    {children}
    {conversation?.pendingSwitch && <div role="status" className="absolute left-2 right-2 top-2 z-30 rounded border border-border-primary bg-surface-primary px-3 py-2 text-xs text-text-secondary"><span>Switch to {conversation.pendingSwitch.target === 'chat' ? 'Chat' : 'Terminal'} after this turn. {conversation.pendingSwitch.reason}</span><button type="button" className="ml-2 rounded border border-border-primary px-2 py-1" onClick={() => { void client.switch(panel.id, 'terminal', conversation.generation).catch(() => undefined); }}>Cancel pending switch</button></div>}
    {conversation?.transition && !conversation.nativeStartup && <div role="status" className="absolute inset-0 z-30 flex items-center justify-center bg-bg-primary/90 text-sm text-text-secondary">Switching interface…</div>}
  </div>;
}
