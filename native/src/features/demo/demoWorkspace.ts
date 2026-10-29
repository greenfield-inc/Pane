import type { AgentState } from '@shared/types/agentStatus';
import type { NotifyAnswer, NotifyItem, NotifyRemoteCommand, NotifySharedState } from '@shared/types/notify';
import type { OrchestrationSessionRecord, OrchestrationSessionView } from '@shared/types/orchestrationSession';
import type { PaneChatAgent } from '@shared/types/paneChat';
import type { ToolPanel } from '@shared/types/panels';
import type { RemotePwaAffordances, RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';
import type { RunpanePaneCreateRequest, RunpanePaneCreateResult, RunpaneWorkspaceStateResult } from '@shared/types/runpaneOrchestration';
import type { JsonValue } from '@shared/validation/boundaryDecoder';

import { DEMO_PANES, DEMO_PROJECTS, DEMO_SESSION, demoMachines, demoNotifyItems, demoReply, shellScreen, type DemoPaneSeed } from './demoData';

type Listener = (channel: string, args: JsonValue[]) => void;

interface DemoPane {
  id: string;
  name: string;
  projectId: number;
  baseBranch: string;
  isFavorite: boolean;
  favoritePinnedAt?: string;
  archived: boolean;
  isHidden?: boolean;
  createdAt: string;
  panels: DemoPanel[];
}

interface DemoPanel {
  id: string;
  title: string;
  agentType?: string;
  state: AgentState;
  buffer: string;
  /** Lines the agent prints once someone opens the tab. */
  pending: string[];
  /** What has been typed since the last Enter. */
  typed: string;
}

/** How long an answer waits for Undo before the agent gets it, as on the host. */
const UNDO_HOLD_MS = 3_000;
const LINE_EVERY_MS = 650;
const FINISH_AFTER_MS = 4_000;
export const NEEDS_COMPUTER = 'needs Pane on your own computer. The demo runs on this phone and connects to nothing.';
const MINUTE = 60_000;

const SHORTCUTS: RemotePwaTerminalShortcut[] = [
  { id: 'demo-s1', key: 't', label: 'Run the tests', text: 'pnpm test', enabled: true },
  { id: 'demo-s2', key: 'l', label: 'Lint and typecheck', text: 'pnpm lint && pnpm typecheck', enabled: true },
  { id: 'demo-s3', key: 'g', label: 'What changed?', text: 'git status --short', enabled: true },
];

/** The demo host's state: sample computers, Panes, a Session and questions, changed by what you do. */
export class DemoWorkspace {
  private readonly listeners = new Set<Listener>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private panes: DemoPane[];
  private notify: NotifyItem[];
  private revision = 1;
  /** Bumped by every answer and Undo, so a hold timer delivers only the answer it was set for. */
  private readonly answerGeneration = new Map<string, number>();
  private shortcuts = SHORTCUTS;
  private sessions: OrchestrationSessionRecord[];
  private readonly epoch: string;

  constructor(readonly startedAt: number = Date.now()) {
    this.epoch = `demo-${startedAt}`;
    this.panes = DEMO_PANES.map(seed => this.paneFromSeed(seed));
    this.notify = demoNotifyItems(startedAt);
    this.sessions = [this.sessionRecord(DEMO_SESSION.id, DEMO_SESSION.name, DEMO_SESSION.agent, { goal: DEMO_SESSION.goal })];
    this.panes.push(this.sessionPane(this.sessions[0], DEMO_SESSION.screen));
    // One agent finishes soon after you arrive, so its Pane shows Ready.
    this.later(FINISH_AFTER_MS, () => this.setState('demo-react-19', 'demo-react-19-agent', 'idle'));
  }

  async invoke(channel: string, args: unknown[]): Promise<JsonValue> {
    const [first, second] = args;
    switch (channel) {
      case 'sessions:get-all-with-projects': return this.projects(pane => !pane.archived);
      case 'sessions:get-archived-with-projects': return this.projects(pane => pane.archived).filter(project => project.sessions.length > 0);
      case 'sessions:get': return { id: this.pane(first).id, name: this.pane(first).name };
      case 'sessions:toggle-favorite': return this.toggleFavorite(this.pane(first));
      case 'sessions:delete': return this.setArchived(this.pane(first), true);
      case 'sessions:restore': return this.setArchived(this.pane(first), false);
      case 'sessions:permanent-delete': {
        const pane = this.pane(first);
        this.panes = this.panes.filter(candidate => candidate !== pane);
        this.emit('session:deleted', { id: pane.id });
        return null;
      }
      case 'projects:list-branches': return [
        { name: 'origin/main', isCurrent: false, hasWorktree: false, isRemote: true },
        { name: 'main', isCurrent: true, hasWorktree: false, isRemote: false },
        ...this.panes.filter(pane => pane.projectId === Number(first)).map(pane => ({ name: pane.name, isCurrent: false, hasWorktree: true, isRemote: false })),
      ];
      case 'runpane:panes:create': return this.createPane(first as RunpanePaneCreateRequest);
      case 'runpane:workspace:state': return this.workspaceState();
      case 'runpane:workspaces:machines': return { ok: true, tailnet: 'you@example.com', domain: 'demo.invalid', machines: toJson(demoMachines()) };
      case 'runpane:glasses:list': return { devices: [] };
      case 'permission:getPending': return [];
      case 'permission:respond': return null;
      case 'notify:remote-snapshot': return toJson(this.notifySnapshot());
      case 'notify:remote-command': return this.notifyCommand(first as NotifyRemoteCommand);
      case 'orchestration-sessions:list': return toJson({ sessions: this.sessions });
      case 'orchestration-sessions:get': return toJson(this.sessionView(this.session(first)));
      case 'orchestration-sessions:create': return toJson(this.createSession(first as { name?: string; agent?: PaneChatAgent; isPinned?: boolean }));
      case 'orchestration-sessions:update': {
        const session = this.session(first);
        Object.assign(session, second as Partial<Pick<OrchestrationSessionRecord, 'isPinned' | 'archived'>>, { updatedAt: new Date().toISOString(), revision: session.revision + 1 });
        this.emit('orchestration-sessions:changed', { sessionId: session.id });
        return toJson(session);
      }
      case 'remote:pwa-affordances': return toJson(this.affordances());
      case 'remote:settings:update': return this.updateSettings(first as { terminalShortcuts?: RemotePwaTerminalShortcut[] });
      case 'mobile:push-status':
      case 'mobile:push-register':
      case 'mobile:push-controls': return {
        platform: (first as { platform?: string } | undefined)?.platform ?? 'ios',
        registration: 'not-registered', provider: 'missing-config', code: 'ERR_DEMO',
        message: `Notifications ${NEEDS_COMPUTER}`,
      };
      case 'mobile:push-revoke': return { ok: true };
      case 'credentials:shared:get': return {};
      case 'credentials:shared:apply': return null;
      case 'panels:list': return toJson(this.panelsOf(this.pane(first)));
      case 'panels:getActive': return toJson(this.panelsOf(this.pane(first))[0] ?? null);
      case 'panels:set-active': return null;
      case 'panels:create': return toJson(this.createPanel(first as { sessionId: string; title: string }));
      case 'panels:delete': return this.deletePanel(first);
      case 'panels:checkInitialized': return true;
      case 'panels:initialize': return true;
      case 'terminal:getState': return { scrollbackBuffer: this.panel(first).buffer, isAlternateScreen: false };
      case 'terminal:setVisibility':
        if (second === true) this.startStreaming(this.panel(first));
        return null;
      case 'terminal:input': return this.input(this.panel(first), String(second));
      case 'terminal:resize':
      case 'terminal:ack': return null;
      case 'terminal:clearScrollback':
        this.panel(first).buffer = '';
        return null;
      case 'terminal:getScrollbackClean': {
        const content = stripAnsi(this.panel(first).buffer);
        return { content, lineCount: content.split('\n').length, panelTitle: this.panel(first).title };
      }
      case 'agent-chat:get': return { panelId: String(first), available: false, setupRequired: false, running: false, permissions: [] };
      case 'terminal:upload-start':
      case 'terminal:paste-image':
      case 'terminal:paste-file': throw new Error(`Sending files ${NEEDS_COMPUTER}`);
      case 'voice:transcribe':
      case 'voice:finalize-streaming': throw new Error(`Voice ${NEEDS_COMPUTER}`);
      case 'runpane:glasses:create-pairing-secret': throw new Error(`Glasses ${NEEDS_COMPUTER}`);
      default: throw new Error(`That ${NEEDS_COMPUTER}`);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }

  private emit(channel: string, ...args: JsonValue[]): void {
    for (const listener of this.listeners) listener(channel, args);
  }

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }

  // Panes

  private paneFromSeed(seed: DemoPaneSeed): DemoPane {
    const createdAt = new Date(this.startedAt - seed.minutesAgo * MINUTE).toISOString();
    const shell: DemoPanel = { id: `${seed.id}-shell`, title: 'Terminal', state: 'idle', buffer: shellScreen(seed), pending: [], typed: '' };
    const agent: DemoPanel | null = seed.agent
      ? { id: `${seed.id}-agent`, title: seed.agent.title, agentType: seed.agent.type, state: seed.state, buffer: seed.screen, pending: [...seed.stream ?? []], typed: '' }
      : null;
    if (!agent) shell.buffer = seed.screen;
    return {
      id: seed.id, name: seed.name, projectId: seed.projectId, baseBranch: seed.baseBranch,
      isFavorite: seed.favorite ?? false, favoritePinnedAt: seed.favorite ? createdAt : undefined,
      archived: false, createdAt, panels: agent ? [agent, shell] : [shell],
    };
  }

  private pane(id: unknown): DemoPane {
    const pane = this.panes.find(candidate => candidate.id === id);
    if (!pane) throw new Error('This sample Pane is gone. Pull down to refresh.');
    return pane;
  }

  private projects(include: (pane: DemoPane) => boolean) {
    return DEMO_PROJECTS.map((project, index) => ({
      ...project,
      active: index === 0,
      sessions: this.panes.filter(pane => pane.projectId === project.id && include(pane)).map(pane => ({
        id: pane.id, name: pane.name, baseBranch: pane.baseBranch, isFavorite: pane.isFavorite,
        archived: pane.archived, createdAt: pane.createdAt,
        ...(pane.favoritePinnedAt ? { favoritePinnedAt: pane.favoritePinnedAt } : {}),
      })),
    }));
  }

  private toggleFavorite(pane: DemoPane): JsonValue {
    pane.isFavorite = !pane.isFavorite;
    pane.favoritePinnedAt = pane.isFavorite ? new Date().toISOString() : undefined;
    this.emit('session:updated', { id: pane.id });
    return { isFavorite: pane.isFavorite, favoritePinnedAt: pane.favoritePinnedAt ?? null };
  }

  private setArchived(pane: DemoPane, archived: boolean): JsonValue {
    pane.archived = archived;
    this.emit(archived ? 'session:deleted' : 'session:created', { id: pane.id });
    return null;
  }

  private createPane(request: RunpanePaneCreateRequest): JsonValue {
    const repo = request.repo;
    const projectId = typeof repo === 'object' && 'id' in repo ? repo.id : DEMO_PROJECTS[0].id;
    const project = DEMO_PROJECTS.find(candidate => candidate.id === projectId) ?? DEMO_PROJECTS[0];
    const items = request.panes.map((item, index) => {
      const id = `demo-new-${Date.now()}-${index}`;
      const agentType = 'agent' in item.tool ? item.tool.agent : undefined;
      const seed: DemoPaneSeed = {
        id, name: item.name, projectId: project.id, baseBranch: item.baseBranch ?? 'origin/main', favorite: item.pinned,
        agent: agentType ? { title: agentType === 'codex' ? 'Codex' : agentType === 'claude' ? 'Claude Code' : agentType, type: agentType } : null,
        state: agentType ? 'working' : 'idle', minutesAgo: 0,
        screen: `Starting ${agentType ?? 'a shell'} in a new worktree of ${project.name}…\r\n`,
        stream: agentType ? demoReply(agentType, 'Ready when you are.') : undefined,
      };
      const pane = this.paneFromSeed(seed);
      this.panes.push(pane);
      this.emit('session:created', { id });
      if (agentType) this.later(FINISH_AFTER_MS, () => this.setState(id, `${id}-agent`, 'idle'));
      return { ok: true, index, name: item.name, pinned: item.pinned ?? false, paneId: id, sessionId: id, panelId: pane.panels[0].id };
    });
    const result: RunpanePaneCreateResult = {
      ok: true,
      repo: { ...project, active: project.id === DEMO_PROJECTS[0].id, sessionCount: this.panes.filter(pane => pane.projectId === project.id).length },
      items,
    };
    return toJson(result);
  }

  // Agent status

  private workspaceState(): JsonValue {
    const at = new Date().toISOString();
    let gen = 0;
    const result: RunpaneWorkspaceStateResult = {
      ok: true, epoch: this.epoch, generation: this.panes.length,
      entries: this.panes.filter(pane => !pane.archived).map(pane => ({
        gen: ++gen, at, kind: 'agent.idle', source: 'agent', paneId: pane.id, paneName: pane.name, baseline: true,
        panels: pane.panels.map(panel => ({ panelId: panel.id, title: panel.title, agentType: panel.agentType, agentState: panel.state, running: true })),
      })),
    };
    return toJson(result);
  }

  private setState(paneId: string, panelId: string, state: AgentState): void {
    const panel = this.panes.find(pane => pane.id === paneId)?.panels.find(candidate => candidate.id === panelId);
    if (!panel || panel.state === state) return;
    panel.state = state;
    this.emit('panel:agentStatus', { panelId, sessionId: paneId, state, reason: 'demo', ...(panel.agentType ? { agentType: panel.agentType } : {}) });
  }

  // Terminals

  private panelsOf(pane: DemoPane): ToolPanel[] {
    return pane.panels.map((panel, position) => ({
      id: panel.id, sessionId: pane.id, type: 'terminal', title: panel.title,
      state: { isActive: position === 0, hasBeenViewed: true, ...(panel.agentType ? { customState: { agentType: panel.agentType } } : {}) },
      metadata: { createdAt: pane.createdAt, lastActiveAt: pane.createdAt, position },
    }));
  }

  private panel(id: unknown): DemoPanel {
    for (const pane of this.panes) {
      const panel = pane.panels.find(candidate => candidate.id === id);
      if (panel) return panel;
    }
    throw new Error('This sample terminal is gone.');
  }

  private paneOfPanel(panel: DemoPanel): DemoPane | undefined {
    return this.panes.find(pane => pane.panels.includes(panel));
  }

  private createPanel(request: { sessionId: string; title: string }): ToolPanel {
    const pane = this.pane(request.sessionId);
    const panel: DemoPanel = { id: `${pane.id}-tab-${Date.now()}`, title: request.title || 'Terminal', state: 'idle', buffer: '\x1b[90m$\x1b[0m ', pending: [], typed: '' };
    pane.panels.push(panel);
    this.emit('panel:created', toJson(this.panelsOf(pane).at(-1) ?? null));
    return this.panelsOf(pane).at(-1) as ToolPanel;
  }

  private deletePanel(id: unknown): null {
    const panel = this.panel(id);
    const pane = this.paneOfPanel(panel);
    if (pane) pane.panels = pane.panels.filter(candidate => candidate !== panel);
    this.emit('panel:deleted', { panelId: panel.id, sessionId: pane?.id ?? null });
    return null;
  }

  private write(panel: DemoPanel, output: string): void {
    panel.buffer += output;
    this.emit('terminal:output', { panelId: panel.id, output });
  }

  /** Prints the tab's pending lines one at a time, then the agent finishes. */
  private startStreaming(panel: DemoPanel): void {
    const next = panel.pending.shift();
    if (next === undefined) return;
    this.later(LINE_EVERY_MS, () => {
      this.write(panel, panel.pending.length > 0 ? `${next}\r\n` : next);
      if (panel.pending.length > 0) this.startStreaming(panel);
      else {
        const pane = this.paneOfPanel(panel);
        if (pane && panel.agentType) this.setState(pane.id, panel.id, 'idle');
      }
    });
  }

  private input(panel: DemoPanel, data: string): JsonValue {
    for (const char of data) {
      if (char === '\r') {
        const text = panel.typed.trim();
        panel.typed = '';
        this.write(panel, '\r\n');
        if (!text) continue;
        panel.pending.push(...demoReply(panel.agentType, text));
        const pane = this.paneOfPanel(panel);
        if (pane && panel.agentType) this.setState(pane.id, panel.id, 'working');
        this.startStreaming(panel);
      } else if (char === '\x7f') {
        if (panel.typed) {
          panel.typed = panel.typed.slice(0, -1);
          this.write(panel, '\b \b');
        }
      } else if (char >= ' ') {
        panel.typed += char;
        this.write(panel, char);
      }
    }
    return null;
  }

  // Notify

  private notifySnapshot(): NotifySharedState {
    return {
      machine: 'studio-mac', epoch: this.epoch, revision: this.revision, enabled: true,
      items: this.notify,
      queue: this.notify.filter(item => item.state === 'waiting').map(item => item.id),
      hidden: [],
    };
  }

  private notifyChanged(): void {
    this.revision += 1;
    this.emit('notify:shared-changed', toJson(this.notifySnapshot()));
  }

  private notifyCommand(command: NotifyRemoteCommand): JsonValue {
    const item = this.notify.find(candidate => candidate.id === command.id);
    if (!item) throw new Error('This question is no longer waiting.');
    if (command.type === 'answer' && item.state === 'waiting') {
      const generation = this.nextAnswerGeneration(item.id);
      this.replaceNotify({ ...item, state: 'sent', answerSummary: summarize(command.answer) });
      this.later(UNDO_HOLD_MS, () => this.deliver(item.id, generation));
    } else if (command.type === 'undo' && item.state === 'sent') {
      this.nextAnswerGeneration(item.id);
      this.replaceNotify({ ...item, state: 'waiting', answerSummary: undefined });
    } else if (command.type === 'dismiss' || command.type === 'skip' || command.type === 'remind') {
      return null;
    }
    this.notifyChanged();
    return null;
  }

  private nextAnswerGeneration(id: string): number {
    const generation = (this.answerGeneration.get(id) ?? 0) + 1;
    this.answerGeneration.set(id, generation);
    return generation;
  }

  /** The hold ran out: the agent has its answer and gets back to work. */
  private deliver(id: string, generation: number): void {
    const item = this.notify.find(candidate => candidate.id === id);
    if (item?.state !== 'sent' || this.answerGeneration.get(id) !== generation) return;
    this.replaceNotify({ ...item, state: 'answered', resolvedAt: Date.now() });
    this.notifyChanged();
    // The question outlives its Pane when you delete the Pane first; then there is no agent to show.
    const { paneId, panelId } = item.source;
    const panel = this.panes.find(pane => pane.id === paneId)?.panels.find(candidate => candidate.id === panelId);
    if (!paneId || !panelId || !panel) return;
    this.setState(paneId, panelId, 'working');
    panel.pending.push('', `\x1b[32m●\x1b[0m Got it: ${item.answerSummary ?? 'thanks'}.`, '');
    this.startStreaming(panel);
    this.later(FINISH_AFTER_MS, () => this.setState(paneId, panelId, 'idle'));
  }

  private replaceNotify(next: NotifyItem): void {
    this.notify = this.notify.map(item => (item.id === next.id ? next : item));
  }

  // Sessions

  private sessionRecord(id: string, name: string, agent: PaneChatAgent, extra: Partial<OrchestrationSessionRecord> = {}): OrchestrationSessionRecord {
    const at = new Date(this.startedAt - 30 * MINUTE).toISOString();
    return {
      id, name, agent, archived: false, isPinned: false,
      internalSessionId: `${id}terminal__`,
      panelIds: { claude: `${id}claude`, codex: `${id}codex`, cursor: `${id}cursor` },
      goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
      associations: [
        { paneId: 'demo-fix-checkout-race', panelIds: [], attachedAt: at },
        { paneId: 'demo-dark-mode', panelIds: [], attachedAt: at },
      ],
      activity: [], revision: 1, createdAt: at, updatedAt: at,
      ...extra,
    };
  }

  /** A Session's own hidden Pane, holding its agent's tab. */
  private sessionPane(session: OrchestrationSessionRecord, screen: string): DemoPane {
    const title = session.agent === 'codex' ? 'Codex' : session.agent === 'cursor' ? 'Cursor' : 'Claude Code';
    return {
      id: session.internalSessionId, name: session.name, projectId: 0, baseBranch: 'main', isFavorite: false,
      archived: false, isHidden: true, createdAt: session.createdAt,
      panels: [{ id: session.panelIds[session.agent], title, agentType: session.agent, state: 'idle', buffer: screen, pending: [], typed: '' }],
    };
  }

  private session(selector: unknown): OrchestrationSessionRecord {
    const id = (selector as { sessionId?: string } | undefined)?.sessionId;
    const session = this.sessions.find(candidate => candidate.id === id);
    if (!session) throw new Error('Session not found');
    return session;
  }

  private sessionView(session: OrchestrationSessionRecord): OrchestrationSessionView<{ id: string; name: string }> {
    const pane = this.pane(session.internalSessionId);
    const panel = this.panelsOf(pane)[0];
    return { session, internalSession: { id: pane.id, name: session.name }, panel, agent: session.agent, cwd: '/Users/you/.pane/sessions/demo', guidePath: '/Users/you/.pane/guide.md', started: true };
  }

  private createSession(input: { name?: string; agent?: PaneChatAgent; isPinned?: boolean }): OrchestrationSessionView<{ id: string; name: string }> {
    const id = `__orchestration_session_demo-${Date.now()}__`;
    const session = this.sessionRecord(id, input.name?.trim() || 'New Session', input.agent ?? 'claude', {
      isPinned: input.isPinned ?? false, associations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    this.sessions.push(session);
    this.panes.push(this.sessionPane(session, '\x1b[1m>\x1b[0m '));
    this.emit('orchestration-sessions:changed', { sessionId: id });
    return this.sessionView(session);
  }

  // Settings

  private affordances(): RemotePwaAffordances {
    return {
      terminalShortcuts: this.shortcuts,
      customCommands: [{ name: 'review-bot', command: './bin/review-bot' }],
      sessionAgents: { agents: ['claude', 'codex', 'cursor'], defaultAgent: 'claude' },
      chatEnabled: false,
      voiceTranscription: {
        availableModes: [], defaultMode: 'streaming',
        configured: { cleanup: false, recorded: false, streaming: false, fal: false, deepgram: false, openRouter: false },
        modes: {
          streaming: { label: 'Live', priceLabel: '', latencyLabel: '', recommended: true },
          recorded: { label: 'Recorded', priceLabel: '', latencyLabel: '', recommended: false },
        },
      },
    };
  }

  private updateSettings(patch: { terminalShortcuts?: RemotePwaTerminalShortcut[] }): JsonValue {
    const keys = Object.keys(patch ?? {});
    if (!patch?.terminalShortcuts || keys.length !== 1) throw new Error(`Voice ${NEEDS_COMPUTER}`);
    this.shortcuts = patch.terminalShortcuts;
    this.emit('remote:settings-changed', {});
    return toJson(this.affordances());
  }
}

function summarize(answer: NotifyAnswer): string {
  if ('choice' in answer) return answer.choice;
  if ('approved' in answer) return answer.approved ? 'Approved' : 'Denied';
  return answer.text;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r\n/g, '\n');
}

/** The demo's typed records travel as JSON, like a host's replies. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
