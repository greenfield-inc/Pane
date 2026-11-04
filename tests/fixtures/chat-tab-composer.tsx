import { createRoot } from 'react-dom/client';
import ChatTabPanel from '../../frontend/src/components/chatTab/ChatTabPanel';
import type { AgentChatConfigOption } from '../../shared/types/agentChat';
import type { ChatTabClient, ChatTabView } from '../../shared/types/chatTab';
import '../../frontend/src/index.css';

// A chat tab's composer in a column of a chosen width (?width=360), with Claude's settings.
// ?labels=default uses the "Default (recommended)" model, as Autopilot showed (D-120); ?labels=long a very long one.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? ['dark', 'dusk', 'dusk-oled'] : ['light', 'folio'];
document.documentElement.classList.add(...theme);
document.documentElement.style.colorScheme = theme[0];
const labels = params.get('labels');
const longLabels = labels === 'default';
const option = (value: string, name: string) => ({ value, name });
const controls: AgentChatConfigOption[] = [
  { id: 'mode', name: 'Mode', category: 'mode', currentValue: 'bypassPermissions', options: [option('default', 'Default'), option('acceptEdits', 'Accept edits'), option('plan', 'Plan mode'), option('bypassPermissions', 'Bypass permissions')] },
  { id: 'model', name: 'Model', category: 'model', currentValue: longLabels ? 'default' : labels === 'long' ? 'long' : 'opus', options: [option('default', 'Default (recommended)'), option('opus', 'Opus 5.5'), option('sonnet', 'Sonnet 5.5'), option('long', 'Claude Opus 5.5 with the extended one-million-token context window')] },
  { id: 'effort', name: 'Effort', category: 'thought_level', currentValue: longLabels ? 'default' : 'medium', options: [option('default', 'Default'), option('low', 'Low'), option('medium', 'Medium'), option('high', 'High')] },
  { id: 'fast_mode', name: 'Fast mode', category: 'model_config', currentValue: 'off', options: [option('on', 'On'), option('off', 'Off')] },
];
const view: ChatTabView = {
  panelId: 'composer', agent: 'claude', generation: 1, status: 'idle', canAttachImages: true, commands: [], permissions: [], questions: [], queue: [], messageCount: 1, controls,
  transcript: { panelId: 'composer', generation: 1, revision: 0, start: 0, messages: [
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Nothing is waiting on you right now.' }] },
  ] },
};
const client: ChatTabClient = {
  get: async () => structuredClone(view), history: async () => [], send: async () => ({ operationId: 'x', state: 'accepted' }), receipt: async () => undefined,
  unqueue: async () => {}, cancel: async () => {}, permission: async () => {}, answer: async () => {}, restart: async () => {}, signIn: async () => ({ panelId: 'composer' }),
  configure: async () => {}, onEvent: () => () => {}, onState: () => () => {},
};
const width = Number(params.get('width') ?? 360);
createRoot(document.getElementById('root')!).render(
  <div className="bg-bg-secondary" style={{ height: '100vh', display: 'flex' }}>
    <div data-testid="column" className="bg-bg-primary" style={{ width, height: '100%', borderRight: '1px solid var(--color-border-primary)' }}>
      <ChatTabPanel panelId="composer" client={client} placeholder={params.get('placeholder') ?? 'Message Autopilot…'} />
    </div>
  </div>,
);
