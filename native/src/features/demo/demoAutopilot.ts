import type { AgentChatMessage, AgentChatReceipt } from '@shared/types/agentChat';
import type { AutopilotDocument, AutopilotSnapshot, AutopilotStackEntry } from '@shared/types/autopilot';
import type { ChatTabSend, ChatTabView } from '@shared/types/chatTab';
import type { NotifyItem } from '@shared/types/notify';
import type { JsonValue } from '@shared/validation/boundaryDecoder';

const MINUTE = 60_000;
const DEMO_AUTOPILOT_PANEL = '__autopilot_panel_demo';
const RUN_FOLDER = '/Users/you/.pane/autopilot/runs/demo';
const PLAN_FOLDER = '/Users/you/code/storefront/tmp/plans/dark-mode';

/** The sample Session the demo's Autopilot walks (DEMO_SESSION in demoData.ts). */
interface DemoSessionRef { id: string; name: string; paneId: string }

/** Autopilot's sample approvals: two from the Session's planner and one of its own (D-60). */
export function demoAutopilotItems(now: number, session: DemoSessionRef): NotifyItem[] {
  const fromPlanner = { panelId: `${session.id}claude`, paneId: session.paneId, name: 'planner', agent: 'Claude', session: { ...session, orchestrator: true } };
  return [
    {
      id: 'demo-ap-q14', ui: 'options', state: 'waiting', createdAt: now - 12 * MINUTE,
      title: 'Q-14 Approve the dark-mode plan (r3)?',
      context: 'Three packages, about a week. Package 1 swaps the 41 hard-coded colors for tokens and can ship alone.',
      detail: 'The plan keeps the storefront\'s current light theme exactly as it is. Package 1 only touches color values, so it can ship before the sale.',
      choices: [
        { label: 'Approve', detail: 'Build starts with package 1 (2 days, reversible)', recommended: true },
        { label: 'Request changes', detail: 'The planner revises the cover sheet first' },
      ],
      links: [
        { label: 'cover-sheet.html', path: `${PLAN_FOLDER}/cover-sheet.html` },
        { label: 'Test build', url: 'http://localhost:5173/' },
      ],
      source: fromPlanner,
    },
    {
      id: 'demo-ap-q5', ui: 'options', state: 'waiting', createdAt: now - 10 * MINUTE,
      title: 'Q-5 Toggle placement: where should the dark-mode switch go?',
      context: 'Shoppers look for it in the account menu; the design system puts it in the footer.',
      choices: [
        { label: 'Account menu', detail: 'Where most shoppers look first', recommended: true },
        { label: 'Footer', detail: 'Matches the design system; easy to miss' },
        { label: 'Both', detail: 'Two places to keep in sync' },
      ],
      links: [{ label: 'options.html', path: `${PLAN_FOLDER}/options.html` }],
      source: fromPlanner,
    },
    {
      id: 'demo-ap-own', ui: 'options', state: 'waiting', createdAt: now - 4 * MINUTE,
      title: `Close out finished work in ${session.name}?`,
      context: 'fix-checkout-race merged an hour ago and 2 worker tabs reported done.',
      choices: [
        { label: `Ask ${session.name} to wrap up`, detail: 'It closes 2 tabs and archives fix-checkout-race; keeps running work', recommended: true },
        { label: 'Not now', detail: 'I\'ll bring it back when more is finished' },
      ],
      links: [{ label: 'close-out.html', path: `${RUN_FOLDER}/docs/close-out.html` }],
      source: { name: 'Autopilot', agent: 'Claude', autopilot: true, session: { ...session } },
    },
  ];
}

const PAGE_STYLE = '<meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{color-scheme:light dark;--fg:#1f2328;--muted:#5d656e;--line:rgba(31,35,40,.14);--chip:#dafbe1;--chipfg:#1a7f37;--bg:#fafaf7}@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#8b949e;--line:rgba(240,246,252,.14);--chip:rgba(63,185,80,.18);--chipfg:#3fb950;--bg:#0d1117}}body{font:16px/1.55 -apple-system,system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:20px}h1{font-size:24px;line-height:1.25;margin:0 0 6px}h2{font-size:19px;margin:28px 0 8px}.chip{display:inline-block;background:var(--chip);color:var(--chipfg);border-radius:999px;padding:1px 10px;font-size:14px;font-weight:600}.sum{color:var(--muted);margin:10px 0 0}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:9px 6px;text-align:left;vertical-align:top}</style>';

/** The demo's documents, by file name. */
const DEMO_DOCS: Record<string, string> = {
  'cover-sheet.html': `<!doctype html>${PAGE_STYLE}<h1>Dark mode for the storefront <span class="chip">ready for approval · r3</span></h1><p class="sum">A dark theme for the storefront, on phones and computers, before the spring sale.</p><h2>Packages</h2><table><tr><th>#</th><th>Outcome</th><th>Size</th></tr><tr><td>1</td><td>Swap 41 hard-coded colors for tokens</td><td>2 days</td></tr><tr><td>2</td><td>The dark-mode switch</td><td>2 days</td></tr><tr><td>3</td><td>Product images on dark</td><td>1 day</td></tr></table><h2>How we will know it works</h2><table><tr><td>J1</td><td>Checkout reads well in dark on a phone</td></tr><tr><td>J2</td><td>The switch remembers your choice</td></tr><tr><td>J3</td><td>Light mode is unchanged, pixel for pixel</td></tr></table>`,
  'options.html': `<!doctype html>${PAGE_STYLE}<h1>Where the switch goes</h1><p class="sum">Trade-offs, recommendation first.</p><table><tr><th>Option</th><th>Gets you</th><th>Costs</th></tr><tr><td><b>Account menu</b></td><td>Found first</td><td>One more menu row</td></tr><tr><td>Footer</td><td>Design-system default</td><td>Easy to miss</td></tr><tr><td>Both</td><td>Everyone finds it</td><td>Two places to keep in sync</td></tr></table>`,
  'close-out.html': `<!doctype html>${PAGE_STYLE}<h1>Close out: Spring sale launch <span class="chip">written by Autopilot</span></h1><p class="sum">What /wrap-up would do now.</p><h2>Closes</h2><table><tr><td>reviewer · fix-checkout-race</td><td>done 58 min ago</td></tr><tr><td>qa · fix-checkout-race</td><td>done 1 h ago</td></tr></table><h2>Archives</h2><table><tr><td>fix-checkout-race</td><td>PR #131 merged · clean</td></tr></table><h2>Keeps</h2><table><tr><td>add-dark-mode</td><td>running</td></tr></table>`,
};

/**
 * The demo's Autopilot: Start, Pause and Go on, the stack, its chat tab and its documents, all in
 * memory. It brings the Session's items one at a time, naming each in an `autopilot-items` block,
 * and brings the next one when you answer.
 */
export class DemoAutopilot {
  private state: AutopilotSnapshot['state'] = 'stopped';
  private messages: AgentChatMessage[] = [];
  private revision = 0;
  private entries: AutopilotStackEntry[] = [];
  private shownId: string | null = null;
  private readonly receipts = new Map<string, AgentChatReceipt>();

  constructor(
    private readonly session: DemoSessionRef,
    private readonly items: () => NotifyItem[],
    private readonly emit: (channel: string, ...args: JsonValue[]) => void,
    private readonly startedAt: number,
  ) {}

  /** Answers an `autopilot:*` channel, or a `chat-tab:*` one for its tab; undefined for anything else. */
  invoke(channel: string, args: unknown[]): JsonValue | undefined {
    const [first, second] = args;
    if (channel.startsWith('chat-tab:') && first !== DEMO_AUTOPILOT_PANEL) return undefined;
    switch (channel) {
      case 'autopilot:snapshot': return toJson(this.snapshot());
      case 'autopilot:start': return this.start();
      case 'autopilot:pause': return this.setState('paused');
      case 'autopilot:go-on': return this.setState('running');
      // The demo has no Sentinel calls to sum up.
      case 'autopilot:opened': return toJson(this.snapshot());
      case 'autopilot:read-doc': return toJson(this.readDoc(String(first)));
      case 'chat-tab:get': return toJson(this.view());
      case 'chat-tab:history': return [];
      case 'chat-tab:send': return toJson(this.send(second as ChatTabSend));
      case 'chat-tab:receipt': return toJson(this.receipts.get(String(second)) ?? null);
      case 'chat-tab:cancel':
      case 'chat-tab:unqueue': return null;
      default: return undefined;
    }
  }

  /** An item was answered: its entry is done and Autopilot brings the next one. */
  answered(id: string): void {
    const entry = this.entries.find(candidate => candidate.ref.kind === 'item' && candidate.ref.notifyId === id && candidate.doneAt === undefined);
    if (!entry) return;
    entry.doneAt = Date.now();
    const next = this.entries.find(candidate => candidate.doneAt === undefined);
    this.shownId = next?.id ?? null;
    this.changed();
    if (this.state !== 'running') return;
    if (!next || next.ref.kind !== 'item') {
      this.say(`That's everything in **${this.session.name}** for now. I'll bring the next thing when it comes in.`);
      return;
    }
    const after = this.entries.filter(candidate => candidate.doneAt === undefined).length - 1;
    this.say(`Next in ${this.session.name}${after > 0 ? ` (${after} more after this)` : ''}:\n\n\`\`\`autopilot-items\n${next.ref.notifyId}\n\`\`\``);
  }

  private snapshot(): AutopilotSnapshot {
    const waiting = this.items().filter(item => item.state === 'waiting' && item.source.session?.id === this.session.id).length;
    return {
      enabled: true,
      chatTabsEnabled: true,
      sentinel: false,
      entitlement: { entitled: true },
      run: { id: 'demo', folder: RUN_FOLDER, docsFolder: `${RUN_FOLDER}/docs`, createdAt: new Date(this.startedAt - 60 * MINUTE).toISOString() },
      panelId: DEMO_AUTOPILOT_PANEL,
      ownerPaneId: '__autopilot_owner_demo',
      state: this.state,
      stack: { entries: this.entries, shownId: this.shownId },
      walk: { sessionId: this.state === 'stopped' ? undefined : this.session.id, sessions: [{ id: this.session.id, name: this.session.name, waiting }] },
    };
  }

  private start(): JsonValue {
    if (this.state !== 'stopped') return toJson(this.snapshot());
    this.state = 'running';
    const waiting = this.items().filter(item => item.state === 'waiting' && item.source.session?.id === this.session.id);
    this.entries = waiting.map((item, index) => ({
      id: `demo-entry-${index}`, ref: { kind: 'item', notifyId: item.id }, title: item.title, sessionId: this.session.id, sessionName: this.session.name, addedAt: Date.now(),
      tabs: [{ kind: 'item', label: 'Question', notifyId: item.id }],
      ...(item.source.autopilot ? { byAutopilot: true } : { note: 'Packages 2 and 3 wait on package 1, which is ready. Nothing else blocks.' }),
    }));
    this.shownId = this.entries[0]?.id ?? null;
    this.add({ id: 'demo-ap-start', role: 'user', parts: [{ type: 'text', text: '[Pane · Start] Read every Session and what waits on the person, then walk them from the top.' }] });
    const first = this.entries[0];
    this.say(first?.ref.kind === 'item'
      ? `**${this.session.name}**: ${waiting.length} things for you, oldest that blocks work first.\n\n\`\`\`autopilot-items\n${first.ref.notifyId}\n\`\`\`\n\nTap an option to answer, or open it for more context.`
      : 'Nothing waits on you right now. I\'ll bring the next thing when it comes in.');
    this.changed();
    return toJson(this.snapshot());
  }

  private setState(state: 'paused' | 'running'): JsonValue {
    if (this.state === 'stopped') throw new Error('Autopilot hasn\'t started. Nothing changed. Press Start first.');
    if (this.state !== state) {
      this.state = state;
      this.add({ id: `demo-ap-${state}-${this.messages.length}`, role: 'user', parts: [{ type: 'text', text: state === 'paused' ? '[Pane · Pause]' : '[Pane · Go on]' }] });
      this.changed();
    }
    return toJson(this.snapshot());
  }

  private readDoc(path: string): AutopilotDocument {
    const name = path.split('/').pop() ?? path;
    const html = DEMO_DOCS[name];
    return html ? { kind: 'html', url: `file://${path}`, path, html } : { kind: 'missing', path, message: `There is no file at ${path} in the demo.` };
  }

  private send(request: ChatTabSend): AgentChatReceipt {
    this.add({ id: `demo-ap-user-${request.operationId}`, role: 'user', parts: [{ type: 'text', text: request.text }] });
    this.say('In the demo I can\'t look anything up, but on your computer I\'d answer from the Session\'s files and its orchestrator. Answer the card above when you\'re ready.');
    const receipt: AgentChatReceipt = { operationId: request.operationId, generation: 1, fingerprint: request.operationId, state: 'completed' };
    this.receipts.set(request.operationId, receipt);
    return receipt;
  }

  private say(text: string): void {
    this.add({ id: `demo-ap-say-${this.messages.length}`, role: 'assistant', parts: [{ type: 'text', text }] });
  }

  private add(message: AgentChatMessage): void {
    const index = this.messages.length;
    this.messages.push(message);
    this.revision += 1;
    this.emit('chat-tab:event', toJson({ panelId: DEMO_AUTOPILOT_PANEL, generation: 1, revision: this.revision, index, change: { type: 'replace', message } }));
  }

  private changed(): void {
    this.emit('autopilot:changed', toJson(this.snapshot()));
  }

  private view(): ChatTabView {
    return {
      panelId: DEMO_AUTOPILOT_PANEL, agent: 'claude', generation: 1, status: 'idle', canAttachImages: false,
      controls: [], commands: [], permissions: [], questions: [], queue: [],
      transcript: { panelId: DEMO_AUTOPILOT_PANEL, generation: 1, revision: this.revision, start: 0, messages: this.messages },
      messageCount: this.messages.length,
    };
  }
}

function toJson(value: unknown): JsonValue {
  // SAFETY: the demo's values are plain data built in this file.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
