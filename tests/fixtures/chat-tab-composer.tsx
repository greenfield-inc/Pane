import { createRoot } from 'react-dom/client';
import ChatTabPanel from '../../frontend/src/components/chatTab/ChatTabPanel';
import type { AgentChatConfigOption } from '../../shared/types/agentChat';
import type { ChatTabClient, ChatTabConversation, ChatTabSend, ChatTabSwitchBanner, ChatTabView } from '../../shared/types/chatTab';
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
  { id: 'mode', name: 'Mode', category: 'mode', currentValue: params.get('mode') ?? 'bypassPermissions', options: [option('default', 'Default'), option('acceptEdits', 'Accept edits'), option('plan', 'Plan mode'), option('bypassPermissions', 'Bypass permissions'), option('agent-full-access', 'Full access')] },
  { id: 'model', name: 'Model', category: 'model', currentValue: longLabels ? 'default' : labels === 'long' ? 'long' : 'opus', options: [option('default', 'Default (recommended)'), option('opus', 'Opus 5.5'), option('sonnet', 'Sonnet 5.5'), option('long', 'Claude Opus 5.5 with the extended one-million-token context window')] },
  { id: 'effort', name: 'Effort', category: 'thought_level', currentValue: longLabels ? 'default' : 'medium', options: [option('default', 'Default'), option('low', 'Low'), option('medium', 'Medium'), option('high', 'High')] },
  { id: 'fast_mode', name: 'Fast mode', category: 'model_config', currentValue: 'off', options: [option('on', 'On'), option('off', 'Off')] },
];
const view: ChatTabView = {
  panelId: 'composer', agent: 'claude', generation: 1, status: params.has('working') ? 'working' : 'idle', canAttachImages: true, commands: [], permissions: [], questions: [], queue: [], messageCount: 1, controls,
  // ?conversation=1: a turn with steps and a code block, for copying (D-140).
  transcript: { panelId: 'composer', generation: 1, revision: 0, start: 0, messages: params.has('conversation') ? [
    { id: 'user:1', role: 'user', parts: [{ type: 'text', text: 'Why does pnpm test fail?' }] },
    { id: 'a1', role: 'assistant', parts: [
      { type: 'tool', id: 't1', title: 'Read package.json', kind: 'read', status: 'completed', locations: [{ path: '/repo/package.json' }] },
      { type: 'tool', id: 't2', title: 'pnpm test', kind: 'execute', status: 'failed', input: { command: 'pnpm test' }, terminal: 'FAIL src/a.test.ts\n' },
      { type: 'text', text: 'The `a.test.ts` suite imports a file that moved. Change the import:\n\n```ts\nimport { a } from "./lib/a";\n```' },
    ] },
    { id: 'user:2', role: 'user', parts: [{ type: 'text', text: 'Thanks, fix it please.' }] },
    { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Done: the import now points at `./lib/a`, and the suite passes.' }] },
  ] : [
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Nothing is waiting on you right now.' }] },
  ] },
};
// ?banner=most-recent|none|known-empty|list-failed: what Switch to chat did (D-282); ✕ closes it.
const bannerParam = params.get('banner');
const banner: ChatTabSwitchBanner | undefined = bannerParam === 'most-recent' || bannerParam === 'none' || bannerParam === 'known-empty' ? { kind: bannerParam }
  : bannerParam === 'list-failed' ? { kind: 'list-failed', reason: 'Codex is signed out' } : undefined;
if (banner) view.banner = banner;
// The folder's conversations for the picker (/resume, Pick another); ?conversations=none lists none, ?busy=1 refuses a pick mid-turn.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const conversations: ChatTabConversation[] = params.get('conversations') === 'none' ? [] : [
  { sessionId: 'c-1', title: 'Orchestrate Pane UI/UX improvements', updatedAt: minutesAgo(2), current: true },
  { sessionId: 'c-2', title: 'Plan the approvals inbox', updatedAt: minutesAgo(60 * 24 + 30) },
  { sessionId: 'c-3', title: 'Session orchestrator', updatedAt: minutesAgo(60 * 24 * 5) },
  { sessionId: 'c-4', title: 'Review PR #1274', updatedAt: minutesAgo(12), openIn: { panelId: 'p-review', title: 'Review' } },
];
declare global { interface Window { qaResumed: string[]; qaDismissed: number } }
window.qaResumed = [];
window.qaDismissed = 0;
const stateListeners = new Set<(next: ChatTabView) => void>();
// ?files=1 copies dropped files "to the host" (D-139); what was copied and sent is kept for the test.
declare global { interface Window { qaCopied: string[]; qaSent: ChatTabSend[]; qaReleaseCopies?: () => void } }
window.qaCopied = [];
window.qaSent = [];
const holdCopies = params.has('holdCopies');
let release: Promise<void> = Promise.resolve();
if (holdCopies) release = new Promise(resolve => { window.qaReleaseCopies = resolve; });
const saveFile = params.has('files') ? async ({ name }: { name: string; dataUrl: string }) => {
  await release;
  if (name.startsWith('fail')) throw new Error('the host is offline');
  window.qaCopied.push(name);
  return `/repo/.pane/files/${name}`;
} : undefined;
const client: ChatTabClient = {
  get: async () => structuredClone(view), history: async () => [], send: async (_panel, request) => { window.qaSent.push(request); return { operationId: request.operationId, state: 'accepted' }; }, receipt: async () => undefined,
  unqueue: async () => {}, cancel: async () => {}, permission: async () => {}, answer: async () => {}, restart: async () => {}, signIn: async () => ({ panelId: 'composer' }),
  configure: async () => {}, onEvent: () => () => {}, onState: callback => { stateListeners.add(callback); return () => stateListeners.delete(callback); },
  conversations: async () => structuredClone(conversations),
  resume: async (_panel, sessionId) => {
    if (params.has('busy')) throw new Error("Error invoking remote method 'daemon:invoke': Error [CHAT_RESUME_BUSY]: Claude is in the middle of a turn, so the chat stayed on this conversation. Next: Stop the turn or wait for it to finish, then pick again.");
    window.qaResumed.push(sessionId);
    delete view.banner;
    stateListeners.forEach(listener => listener(structuredClone(view)));
  },
  dismissBanner: async () => { window.qaDismissed++; delete view.banner; stateListeners.forEach(listener => listener(structuredClone(view))); },
};
const width = Number(params.get('width') ?? 360);
createRoot(document.getElementById('root')!).render(
  <div className="bg-bg-secondary" style={{ height: '100vh', display: 'flex' }}>
    <div data-testid="column" className="bg-bg-primary" style={{ width, height: '100%', borderRight: '1px solid var(--color-border-primary)' }}>
      <ChatTabPanel panelId="composer" client={client} saveFile={saveFile} placeholder={params.get('placeholder') ?? 'Message Autopilot…'} />
    </div>
  </div>,
);
