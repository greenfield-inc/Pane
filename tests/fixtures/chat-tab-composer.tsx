import { createRoot } from 'react-dom/client';
import ChatTabPanel from '../../frontend/src/components/chatTab/ChatTabPanel';
import type { AgentChatConfigOption } from '../../shared/types/agentChat';
import type { ChatTabAnswer, ChatTabClient, ChatTabSend, ChatTabView } from '../../shared/types/chatTab';
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
// ?queue=2: messages waiting behind a running turn (D-211); ?cleared=1: the conversation started fresh with /clear.
const queued = Number(params.get('queue') ?? 0);
view.queue = Array.from({ length: queued }, (_, index) => ({ operationId: `q${index + 1}`, text: ['Also run the linter before you push', 'Then open a draft PR'][index] ?? `Queued ${index + 1}`, queuedAt: '2026-11-08T10:00:00.000Z', stored: true }));
// ?questions=2: Claude's AskUserQuestion with two questions, taken one at a time (D-230); ?questions=1 asks one.
const asked = Number(params.get('questions') ?? 0);
// ?questions=text: a form with no choices, a project name then a retention period (review F-4).
if (params.get('questions') === 'text') {
  view.questions = [{ id: 'q', generation: 1, message: 'Set up the project', schema: { type: 'object', required: ['name', 'days'], properties: { name: { type: 'string', title: 'Project name' }, days: { type: 'integer', title: 'Keep logs for (days)' } } } }];
  view.status = 'blocked';
}
if (asked) {
  const first = {
    question_0: { type: 'string', title: '#1491 P1', description: 'Workspaces P1 is validated. Start the agent review? (Nothing merges.)', oneOf: [{ const: 'Ready', title: 'Ready: start agent review (Recommended)', description: 'A reviewer posts findings on #1491.' }, { const: 'Wait', title: 'Wait for plan v9' }, { const: 'Changes', title: 'I have changes first' }] },
    question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer, or add a note to the option you chose above (optional).' },
  };
  const second = {
    question_1: { type: 'string', title: 'Versioning', description: "Take the planner's four revised recommendations?", oneOf: [{ const: 'All', title: 'Take all four (Recommended)' }, { const: 'Some', title: 'Change some' }] },
    question_1_custom: { type: 'string', title: 'Other', description: 'Type your own answer, or add a note to the option you chose above (optional).' },
  };
  const properties = asked > 1 ? { ...first, ...second } : first;
  view.questions = [{ id: 'q', generation: 1, message: asked > 1 ? 'Please answer the following questions.' : '#1491 P1', schema: { type: 'object', properties } }];
  view.status = 'blocked';
}
// ?status=1: what the status bar reads (D-222): context used, background tasks and the Pane's PR; ?ctx=low nears the limit.
if (params.has('status')) {
  view.context = { used: params.get('ctx') === 'low' ? 172_000 : 118_000, size: 200_000 };
  const started = new Date(Date.now() - 95_000).toISOString();
  view.tasks = [{ id: 't1', kind: 'bash', title: 'pnpm --filter frontend test --watch', startedAt: started }, { id: 't2', kind: 'subagent', title: 'Explore: find the queue code', startedAt: started, canStop: false }];
}
// ?agents=3: a Session orchestrator's chat with 3 workers working, plus one waiting and one idle, which don't count (D-276).
const agentCount = Number(params.get('agents') ?? 0);
const workingNames = ['csv-export', 'switch-to-chat', 'onboarding-copy', 'docs-pass'];
const workers = params.has('agents') ? [
  ...workingNames.slice(0, agentCount).map((name, index) => ({ paneId: `p${index + 1}`, name, state: 'running' as const, label: 'Running', tab: { panelId: `t${index + 1}`, title: index === 1 ? 'Codex' : 'Claude Code' } })),
  { paneId: 'pw', name: 'approvals-global', state: 'waiting' as const, label: 'Waiting' },
  { paneId: 'pi', name: 'release-notes', state: 'idle' as const, label: 'Idle' },
] : undefined;
const actions = { onOpenWorker: (paneId: string, panelId?: string) => { window.qaCalls.push(`open:${paneId}:${panelId ?? ''}`); } };
const pr = params.has('status') ? { number: 1272, url: 'https://github.com/greenfield-inc/Pane/pull/1272', state: 'OPEN' } : undefined;
if (params.has('cleared')) view.clearedAt = '2026-11-08T14:04:00.000Z';
// ?files=1 copies dropped files "to the host" (D-139); what was copied and sent is kept for the test.
declare global { interface Window { qaCopied: string[]; qaSent: ChatTabSend[]; qaCalls: string[]; qaAnswers: ChatTabAnswer[]; qaReleaseCopies?: () => void } }
window.qaCopied = [];
window.qaSent = [];
window.qaCalls = [];
window.qaAnswers = [];
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
  unqueue: async (_panel, id) => { window.qaCalls.push(`unqueue:${id}`); }, sendNow: async (_panel, id) => { window.qaCalls.push(`sendNow:${id}`); },
  editQueued: async (_panel, id, text) => { window.qaCalls.push(`edit:${id}:${text}`); }, clear: async () => { window.qaCalls.push('clear'); }, stopTask: async (_panel, id) => { window.qaCalls.push(`stopTask:${id}`); }, cancel: async () => {}, permission: async () => {}, answer: async (_panel, _id, response) => { window.qaAnswers.push(response); }, restart: async () => {}, signIn: async () => ({ panelId: 'composer' }),
  configure: async (_panel, id, value) => { window.qaCalls.push(`configure:${id}:${value}`); }, onEvent: () => () => {}, onState: () => () => {},
};
const width = Number(params.get('width') ?? 360);
createRoot(document.getElementById('root')!).render(
  <div className="bg-bg-secondary" style={{ height: '100vh', display: 'flex' }}>
    <div data-testid="column" className="bg-bg-primary" style={{ width, height: '100%', borderRight: '1px solid var(--color-border-primary)' }}>
      <ChatTabPanel panelId="composer" client={client} saveFile={saveFile} placeholder={params.get('placeholder') ?? 'Message Autopilot…'} pr={pr} workers={workers} actions={actions} />
    </div>
  </div>,
);
