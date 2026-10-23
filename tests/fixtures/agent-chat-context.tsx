import React from 'react';
import { createRoot } from 'react-dom/client';
import { PanelTabStrip } from '../../frontend/src/components/panels/PanelTabStrip';
import { AgentChatHeader } from '../../frontend/src/components/agentChat/AgentChatHeader';
import { Dropdown } from '../../frontend/src/components/ui/Dropdown';
import type { AgentChatClient, AgentChatView } from '../../shared/types/agentChat';
import type { ToolPanel } from '../../shared/types/panels';
import '../../frontend/src/index.css';

const panel: ToolPanel = { id: 'context-tab', sessionId: 'context-pane', type: 'terminal', title: 'Claude fixture', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
const view: AgentChatView = { panelId: panel.id, available: true, setupRequired: true, running: true, permissions: [], conversation: { panelId: panel.id, workspaceId: panel.sessionId, provider: 'claude', nativeSessionId: 'context-original', generation: 1, active: 'terminal', preferred: 'terminal' } };
if (new URLSearchParams(location.search).has('legacy')) { view.available = false; view.identificationRequired = true; view.conversation = undefined; }
const client: AgentChatClient = {
  identify: async (_panel, nativeId, socketPath) => {
    document.getElementById('result')!.textContent = `${nativeId}:${socketPath}`;
    view.available = true; view.identificationRequired = false;
    view.conversation = { panelId: panel.id, workspaceId: panel.sessionId, provider: 'codex', nativeSessionId: nativeId, generation: 1, active: 'terminal', preferred: 'terminal' };
    return structuredClone(view);
  },
  get: async () => structuredClone(view), onState: () => () => {}, onEvent: () => () => {},
  setup: async () => ({ installed: true }), send: async () => { throw new Error('No inference in this UI fixture'); }, receipt: async () => undefined,
  permission: async () => {}, cancel: async () => {}, stop: async () => {},
  switch: async (_panel, mode, generation) => {
    document.getElementById('result')!.textContent = `${mode}:${generation}`;
    view.conversation = { ...view.conversation!, active: mode, preferred: mode, generation: generation + 1 };
    return view.conversation;
  }, recover: async () => view.conversation!,
};
Object.assign(window, { electronAPI: { agentChat: client } });
createRoot(document.getElementById('root')!).render(<main>
  <PanelTabStrip panels={[panel]} activePanelId={panel.id} onPanelSelect={() => {}} onPanelClose={() => {}} idNamespace="context-test" />
  <AgentChatHeader panelId={panel.id} client={client} />
  <output id="result" aria-label="Host switch result" />
  <Dropdown trigger={<button>Other actions</button>} selectedId="last" items={[{ id: 'first', label: 'First enabled' }, { id: 'middle', label: 'Middle disabled', disabled: true }, { id: 'last', label: 'Last selected' }]} />
</main>);
