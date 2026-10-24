import React from 'react';
import { createRoot } from 'react-dom/client';
import { PanelTabStrip } from '../../frontend/src/components/panels/PanelTabStrip';
import { AgentChatHeader } from '../../frontend/src/components/agentChat/AgentChatHeader';
import { Dropdown } from '../../frontend/src/components/ui/Dropdown';
import { AgentPanelSurface } from '../../frontend/src/components/agentChat/AgentPanelSurface';
import { useConfigStore } from '../../frontend/src/stores/configStore';
import type { AgentChatClient, AgentChatView } from '../../shared/types/agentChat';
import { decodeAgentChatView } from '../../shared/types/agentChatDecoders';
import type { ToolPanel } from '../../shared/types/panels';
import '../../frontend/src/index.css';

const panel: ToolPanel = { id: 'context-tab', sessionId: 'context-pane', type: 'terminal', title: 'Claude fixture', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
const view: AgentChatView = { panelId: panel.id, available: true, setupRequired: true, running: true, permissions: [], conversation: { panelId: panel.id, workspaceId: panel.sessionId, provider: 'claude', nativeSessionId: 'context-original', generation: 1, active: 'terminal', preferred: 'terminal' } };
// ?chat-off renders a tab saved in Chat, with the experimental flag off and a host that fails every switch.
const chatOff = new URLSearchParams(location.search).has('chat-off');
if (new URLSearchParams(location.search).has('legacy')) { view.available = false; view.identificationRequired = true; view.identificationSocketRequired = new URLSearchParams(location.search).get('legacy') !== 'embedded'; view.conversation = undefined; }
const client: AgentChatClient = {
  identify: async (_panel, nativeId, socketPath) => {
    document.getElementById('result')!.textContent = `${nativeId}:${socketPath}`;
    view.available = true; view.identificationRequired = false;
    view.conversation = { panelId: panel.id, workspaceId: panel.sessionId, provider: 'codex', nativeSessionId: nativeId, generation: 1, active: 'terminal', preferred: 'terminal' };
    return structuredClone(view);
  },
  get: async () => decodeAgentChatView(structuredClone(view)), onState: () => () => {}, onEvent: () => () => {},
  setup: async () => ({ installed: true }), send: async () => { throw new Error('No inference in this UI fixture'); }, receipt: async () => undefined,
  permission: async () => {}, cancel: async () => {}, stop: async () => {},
  switch: async (_panel, mode, generation) => {
    document.getElementById('result')!.textContent = `${mode}:${generation}`;
    view.conversation = { ...view.conversation!, active: mode, preferred: mode, generation: generation + 1 };
    return view.conversation;
  }, recover: async () => view.conversation!,
};
if (chatOff) client.switch = client.recover = async () => { document.getElementById('result')!.textContent = 'switch attempted'; throw new Error('CHAT_SPAWN_UNVERIFIED'); };
const chatTab: ToolPanel = { ...panel, state: { ...panel.state, customState: { agentType: 'claude', agentChat: { conversation: { ...view.conversation!, active: 'chat', preferred: 'chat' }, launch: { command: 'claude', cwd: '/tmp', shellType: 'bash', executable: 'claude', version: 'fixture', strictMcpConfig: false, journalFile: '', settingsFile: '' }, processes: { terminal: [], chat: [] } } } } };
useConfigStore.setState({ config: { experimentalChatEnabled: !chatOff } });
Object.assign(window, { electronAPI: { agentChat: client } });
createRoot(document.getElementById('root')!).render(<main>
  <PanelTabStrip panels={[panel]} activePanelId={panel.id} onPanelSelect={() => {}} onPanelClose={() => {}} idNamespace="context-test" />
  {chatOff ? <AgentPanelSurface panel={chatTab} client={client} chatEnabled={false}><p>Native terminal</p></AgentPanelSurface> : <AgentChatHeader panelId={panel.id} client={client} />}
  <output id="result" aria-label="Host switch result" />
  <Dropdown trigger={<button>Other actions</button>} selectedId="last" items={[{ id: 'first', label: 'First enabled' }, { id: 'middle', label: 'Middle disabled', disabled: true }, { id: 'last', label: 'Last selected' }]} />
  <Dropdown trigger={<button>Actions with footer</button>} items={[{ id: 'action', label: 'Menu action' }]} footer={<button>Footer action</button>} />
</main>);
