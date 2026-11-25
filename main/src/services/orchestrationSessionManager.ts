import { validateCustomCommandResume, customResumeAgentType, type CustomCommandResume } from '../../../shared/types/customCommandResume';
import { validateWSLAvailable } from '../utils/wslUtils';
import { sessionRuntimePath } from './sessionRuntime';
import { findClaudeSessionTranscript } from './claudeSessionTranscript';
import { CLI_AGENT_TYPES, resolveAgentTypeFromCommand } from './agents/agentIdentity';
import { assertDirectOpenCodeLaunchCommand } from './agents/opencodeLaunch';
import { prepareSessionWorkspace, sessionWorkspacePath, discardSessionScaffold, isPristineSessionWorkspace } from './sessionWorkspace';
import { DEFAULT_SESSION_PROFILE } from '../../../shared/types/sessionProfile';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { withLock } from '../utils/mutex';
import { getAppDirectory } from '../utils/appDirectory';
import { panelManager } from './panelManager';
import { getChatTabManager } from './chatTabs';
import { sessionChatLaunch } from './chatTabs/launch';
import { agentFarmConfigRoot, listPaneAgentFarmProfiles } from './agentFarm/bundledAgentFarm';
import { installedPluginHash, plainProfileAgent, plainProfileRef, profilePlugin } from './agentFarm/agentFarmProfiles';
import type { AgentFarmProfileList, SessionAgentProfile } from '../../../shared/types/agentFarmProfiles';
import type { SessionAdoption } from './chatTabs/switchToChat';
import type { ChatPanelState, ChatTabLaunch } from '../../../shared/types/chatTab';
import type { NotifySession } from '../../../shared/types/notify';

/** What a Session needs from the host's chat tabs. */
export interface SessionChatTabs {
  ensure(panelId: string): Promise<void>;
  isRunning(panelId: string): boolean;
  agentState(panelId: string): AgentState;
}

/** What a Session needs from Pane's own Agent Farm (T-63). */
export interface SessionAgentFarm {
  /** An installed plugin's content hash, or undefined when it isn't installed. */
  pluginHash(plugin: string): Promise<string | undefined>;
  profiles(): Promise<AgentFarmProfileList>;
}
import { terminalPanelManager } from './terminalPanelManager';
import { databaseService } from './database';
import type { ConfigManager } from './configManager';
import type { SessionManager } from './sessionManager';
import { parseSessionTimestampMs } from './paneInactivity';
import type { Session } from '../types/session';
import type { SkillCacheManager } from './skillCacheManager';
import type { PaneChatManager } from './paneChatManager';
import type { GitStatusManager } from './gitStatusManager';
import type { TerminalAgentReport, ToolPanel, TerminalPanelState, TerminalPausedMark } from '../../../shared/types/panels';
import type { AgentState } from '../../../shared/types/agentStatus';
import {
  LEGACY_ORCHESTRATION_SESSION_ID,
  ORCHESTRATION_SESSION_DETAIL_FIELDS,
  ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX,
  resolveSessionRetention,
  type OrchestrationActivity,
  type OrchestrationAssociation,
  type OrchestrationAssociationInput,
  type OrchestrationLink,
  type OrchestrationMemberMachine,
  type OrchestrationPaneOverview,
  type OrchestrationPanelOverview,
  type OrchestrationPanelReport,
  type OrchestrationReport,
  type OrchestrationSessionCreateInput,
  type OrchestrationSessionListOptions,
  type OrchestrationSessionListResult,
  type OrchestrationSessionSummary,
  type OrchestrationSessionOverview,
  type OrchestrationSessionRecord,
  type OrchestrationSessionSelector,
  type OrchestrationSessionStatus,
  type OrchestrationSessionStoreData,
  type OrchestrationSessionUpdateInput,
  type OrchestrationSessionView,
} from '../../../shared/types/orchestrationSession';
import {
  DEFAULT_PANE_CHAT_AGENT,
  getPaneChatPanelId,
  normalizePaneChatAgent,
  PANE_CHAT_AGENT_LABELS,
  PANE_CHAT_SESSION_ID,
  PANE_ONE_TIME_PROMPT_OPENING,
  type PaneChatAgent,
} from '../../../shared/types/paneChat';
import { isAgentSupportedOnPlatform } from '../../../shared/constants/agentLaunchPresets';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { OrchestrationSessionStore, type RemoteJournalCursor, type RemoteMemberRecord } from './orchestrationSessionStore';
import { SessionActivityService, type SessionActivityMembers } from './sessionActivity';
import type { WorkspaceSessionMembership } from './workspaceJournal';
import { agentReportData, readPanelAgentReport } from './agentReport';
import { paneChatFirstPrompt } from './paneChatMigrateOffer';
import { readOnlyPaneCaller } from '../daemon/commandRegistry';
import { PaneError, reasonOf } from '../../../shared/paneError';
import type { SessionMoveMark } from '../../../shared/types/sessionMove';
import { releaseMoveHolds } from './sessionMove/restore';
import { moveWithinOwnPlaces } from '../../../shared/utils/sessionOrder';
import type { MobileAlertSubject } from '../daemon/mobilePushSender';

/** The desktop's saved machines, as the Session manager reads remote members through them. */
export interface RemoteMachineAccess {
  /** A remote member's row from its machine, or why it could not be read. */
  readPane(machineId: string, paneId: string): Promise<OrchestrationPaneOverview | 'unreachable' | 'older-pane'>;
  /** Whether the machine's Pane sends its reports here; undefined until it has connected once. */
  forwardsReports(machineId: string): boolean | undefined;
}
import { CONFIGURED_AGENT_IDS, agentConfig, agentTerminalCommand, configuredAgent, isConfiguredAgent } from '../../../shared/agents';

const ORCHESTRATION_SESSION_PANEL_PREFIX = '__orchestration_panel_';
const LEGACY_AGENT_SESSION_ID_PREFIX = `${LEGACY_ORCHESTRATION_SESSION_ID}-`;
const PANE_CHAT_AGENTS: readonly PaneChatAgent[] = CONFIGURED_AGENT_IDS;

const ORCHESTRATION_SESSION_TITLE = 'Session';
const ORCHESTRATION_BOOTSTRAP_VERSION = 2;

function getOrchestrationPanelId(sessionId: string, agent: PaneChatAgent): string {
  return `${ORCHESTRATION_SESSION_PANEL_PREFIX}${sessionId}_${agent}`;
}

function isPaneChatAgent(agent: string | undefined): agent is PaneChatAgent {
  return isConfiguredAgent(agent);
}

export class OrchestrationSessionManager extends EventEmitter {
  private initialized = false;
  /** Each counted tab's type, from the last member read, so the 500 ms check reads no database. */
  private activityPanelTypes = new Map<string, 'chat' | 'terminal'>();
  /** Each Session's live working/idle activity; bootstrap starts it, events.ts relays it. */
  readonly liveActivity = new SessionActivityService({
    members: () => this.activityMembers(),
    isMidTurn: (panelId, now) => {
      const type = this.activityPanelTypes.get(panelId);
      if (type === 'chat') return getChatTabManager().isMidTurn(panelId, now);
      return type === 'terminal' && terminalPanelManager.isMidTurn(panelId, now);
    },
  });
  private remoteMachines: RemoteMachineAccess | undefined;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly sessionManager: SessionManager,
    private readonly skillCacheManager: SkillCacheManager | undefined,
    private readonly paneChatManager: PaneChatManager | undefined,
    private readonly gitStatusManager: GitStatusManager | undefined,
    private readonly store = new OrchestrationSessionStore(`${getAppDirectory()}/orchestration-sessions.json`),
  ) {
    super();
    this.setMaxListeners(100);
    // Membership changes re-read the members at once; anything else waits for the 2 s refresh.
    this.on('changed', (change: { kind?: string }) => {
      if (change.kind !== undefined && ['created', 'updated', 'associated', 'detached'].includes(change.kind)) this.liveActivity.invalidateMembers();
    });
  }

  async initialize(): Promise<void> {
    await withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
    });
  }

  /** Every Session in order; `{ summary: true }` leaves out what only a full record's readers need (T-127). */
  async list(): Promise<OrchestrationSessionListResult>;
  async list(options: OrchestrationSessionListOptions | undefined): Promise<OrchestrationSessionListResult<OrchestrationSessionSummary>>;
  async list(options?: OrchestrationSessionListOptions): Promise<OrchestrationSessionListResult<OrchestrationSessionSummary>> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      return this.listed(this.store.read(), options);
    });
  }

  /** The list a read answers with, from the store data it just read or wrote. */
  private listed(data: OrchestrationSessionStoreData, options: OrchestrationSessionListOptions | undefined): OrchestrationSessionListResult<OrchestrationSessionSummary> {
    const sessions = orderedSessions(data).map(record => this.withComputed(options?.summary ? summaryOf(record) : clone(record)));
    return { sessions, selectedSessionId: data.selectedSessionId };
  }

  /**
   * Saves the order a person arranged Sessions in. The listed Sessions trade places among the
   * positions they already hold, so Sessions left out of the request (archived ones, ones in
   * another list, ones created during a drag) keep theirs. Unknown ids are ignored. The Sessions
   * themselves are untouched: no revision, timestamp or activity changes.
   */
  async reorder(sessionIds: string[]): Promise<OrchestrationSessionListResult>;
  async reorder(sessionIds: string[], options: OrchestrationSessionListOptions | undefined): Promise<OrchestrationSessionListResult<OrchestrationSessionSummary>>;
  async reorder(sessionIds: string[], options?: OrchestrationSessionListOptions): Promise<OrchestrationSessionListResult<OrchestrationSessionSummary>> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const order = moveWithinOwnPlaces(orderedSessions(data).map(session => session.id), sessionIds, id => id);
      const nextData: OrchestrationSessionStoreData = { ...data, order };
      this.store.write(nextData);
      this.emit('changed', { sessionId: sessionIds.find(id => order.includes(id)) ?? '', kind: 'reordered' });
      return this.listed(nextData, options);
    });
  }

  async select(selector: OrchestrationSessionSelector): Promise<OrchestrationSessionListResult>;
  async select(selector: OrchestrationSessionSelector, options: OrchestrationSessionListOptions | undefined): Promise<OrchestrationSessionListResult<OrchestrationSessionSummary>>;
  async select(selector: OrchestrationSessionSelector, options?: OrchestrationSessionListOptions): Promise<OrchestrationSessionListResult<OrchestrationSessionSummary>> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const session = this.findSession(this.store.read(), selector);
      if (session.archived === true) {
        throw new Error(`Session ${session.name} is archived; restore it before selecting it`);
      }
      // Opening a Session views its chat Pane, which is when the Session counts as last opened.
      this.sessionManager.markSessionAsViewed(session.internalSessionId);
      const data = this.store.read();
      const next: OrchestrationSessionStoreData = { ...data, selectedSessionId: session.id };
      this.store.write(next);
      this.emit('changed', { sessionId: session.id, kind: 'selected' });
      return this.listed(next, options);
    });
  }

  /**
   * Moves (docs/SESSIONS.md, "Move a Session to another machine"): sets or clears a Session's move
   * mark. `moving` freezes the source; `moved` also archives it.
   */
  async setMoveMark(sessionId: string, mark: SessionMoveMark | undefined, message?: string): Promise<OrchestrationSessionRecord> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const current = this.findSession(data, { sessionId });
      const next: OrchestrationSessionRecord = { ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(), activity: [...current.activity] };
      if (mark) next.move = { ...mark };
      else delete next.move;
      if (mark?.state === 'moved') {
        next.archived = true;
        next.archivedAt = next.archivedAt ?? new Date().toISOString();
      }
      if (message) next.activity.push(this.activity('updated', message, 'system'));
      this.trimActivity(next);
      const replaced = replaceSession(data, next);
      const selectedSessionId = mark?.state === 'moved' && data.selectedSessionId === current.id
        ? orderedSessions(replaced).find(session => session.id !== current.id && session.archived !== true)?.id
        : data.selectedSessionId;
      this.store.write({ ...replaced, selectedSessionId });
      this.emitChanged(next, 'updated', selectedSessionId !== data.selectedSessionId);
      return this.withComputed(clone(next));
    });
  }

  /**
   * The target of a move: saves a Session record that arrives with its own ID, marked arriving, and
   * creates its hidden owner Pane. Nothing starts. An archived copy that moved away from here earlier
   * is replaced (moving a Session back); any other Session with this ID or name refuses.
   */
  async importArriving(record: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const existing = data.sessions.find(session => session.id === record.id);
      if (existing && existing.move?.state !== 'moved') {
        throw new PaneError('ERR_MOVE_SESSION_EXISTS', `This machine already has Session “${existing.name}” with the same ID, and it didn't move away from here, so the arriving copy wasn't saved.`, 'Archive or remove that Session here, then move again.');
      }
      const clash = data.sessions.find(session => session.id !== record.id && session.archived !== true && normalizeSessionName(session.name) === normalizeSessionName(record.name));
      if (clash) {
        throw new PaneError('ERR_MOVE_SESSION_NAME_TAKEN', `This machine already has a Session named “${clash.name}”, so the arriving copy wasn't saved.`, 'Rename one of them, then move again.');
      }
      const arriving: OrchestrationSessionRecord = clone(record);
      arriving.archived = false;
      delete arriving.archivedAt;
      const sessions = existing ? data.sessions.map(session => session.id === record.id ? arriving : session) : [...data.sessions, arriving];
      this.store.write({ ...data, sessions });
      if (existing) {
        // The old archived copy's owner Pane comes back with the arriving one.
        const owner = databaseService.getSession(arriving.internalSessionId);
        if (owner?.archived) databaseService.restoreSession(arriving.internalSessionId);
      }
      this.createInternalSession(arriving);
      this.emitChanged(arriving, 'created');
      return clone(arriving);
    });
  }

  /**
   * T-39: rewrites Pane's section of every open Session folder's AGENTS.md, so turning To-dos on or off
   * reaches Sessions already open. Only the marked section changes; the person's own lines stay.
   */
  async refreshSessionInstructions(): Promise<void> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      for (const record of this.store.read().sessions) {
        if (record.archived === true) continue;
        try {
          prepareSessionWorkspace(record.id, record.profile, record);
        } catch (error) {
          console.warn(`[Sessions] Could not rewrite the instructions in Session ${record.id}'s folder:`, error);
        }
      }
    });
  }

  /**
   * To-dos (T-7): a to-do's Session made before Sessions carried `todoNumber` gets it here, at startup,
   * so every Session list hides it from its first read instead of waiting for the to-dos snapshot.
   */
  async markTodoSessions(links: ReadonlyArray<{ sessionId: string; todoNumber: number }>): Promise<void> {
    await withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const numbers = new Map(links.map(link => [link.sessionId, link.todoNumber]));
      const marked: string[] = [];
      const sessions = data.sessions.map(session => {
        const todoNumber = numbers.get(session.id);
        if (todoNumber === undefined || session.todoNumber !== undefined) return session;
        marked.push(session.id);
        return { ...session, todoNumber };
      });
      if (!marked.length) return;
      this.store.write({ ...data, sessions });
      for (const sessionId of marked) this.emit('changed', { sessionId, kind: 'updated' });
    });
  }

  /** The target removes a Session it was building when the move fails, or the old archived copy it replaced is put back. */
  async removeArriving(sessionId: string, restore?: OrchestrationSessionRecord): Promise<void> {
    await withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const current = data.sessions.find(session => session.id === sessionId);
      if (!current) return;
      if (current.move?.state !== 'arriving') {
        throw new PaneError('ERR_MOVE_NOT_ARRIVING', `Session “${current.name}” isn't arriving here, so it wasn't removed.`, 'Nothing to do.');
      }
      const sessions = restore ? data.sessions.map(session => session.id === sessionId ? clone(restore) : session) : data.sessions.filter(session => session.id !== sessionId);
      const selectedSessionId = data.selectedSessionId === sessionId ? orderedSessions({ ...data, sessions }).find(session => session.archived !== true)?.id : data.selectedSessionId;
      this.store.write({ ...data, sessions, selectedSessionId });
      this.emit('changed', { sessionId, kind: 'updated' });
    });
  }

  async get(selector: OrchestrationSessionSelector): Promise<OrchestrationSessionRecord> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      return this.withComputed(clone(this.findSession(this.store.read(), selector)));
    });
  }

  async getView(selector: OrchestrationSessionSelector): Promise<OrchestrationSessionView<Session>> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const record = this.findSession(this.store.read(), selector);
      if (record.archived === true) {
        throw new Error(`Session ${record.name} is archived; restore it before opening it`);
      }
      if (record.move?.state === 'arriving') {
        throw new PaneError('ERR_SESSION_ARRIVING', `Session ${record.name} is still arriving from ${record.move.machine}, so it can't open yet.`, `Wait for the move to finish on ${record.move.machine}.`);
      }
      if (readOnlyPaneCaller()) {
        // A read-only device's view creates no tab and moves no one's last-used tab.
        const shown = panelManager.getPanel(record.panelIds[record.agent]);
        if (!shown) throw new PaneError('ERR_SESSION_NOT_OPENED', `Session ${record.name} has no agent tab yet, and a read-only device can't open one.`, 'Ask the computer\'s owner to open the Session there, then try again.');
        return await this.viewFromRecord(record, shown);
      }
      this.createInternalSession(record);
      const panel = await this.ensurePanelForAgent(record);
      const internalSession = this.sessionManager.getSession(record.internalSessionId);
      if (!internalSession) throw new Error(`Session ${record.id} internal terminal session is missing`);
      // A client opening its view: last used only, so other clients on this Session stay put.
      await panelManager.rememberActivePanel(internalSession.id, panel.id);
      return {
        session: clone(record),
        internalSession,
        panel,
        agent: record.agent,
        cwd: sessionRuntimePath(sessionWorkspacePath(record.id), record),
        guidePath: sessionRuntimePath(await this.ensureGuidePath(), record),
        started: this.agentStarted(panel.id),
      };
    });
  }

  /** `terminal`: start the orchestrator in a terminal even with chat tabs on, for a client that can't show a chat (D-203). */
  async create(input: OrchestrationSessionCreateInput, sourcePanelId?: string, { terminal = () => false }: { terminal?: (agent: PaneChatAgent) => boolean } = {}): Promise<OrchestrationSessionView<Session>> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      validateCreateInput(input);
      if (input.runtime === 'wsl') {
        if (process.platform !== 'win32') throw new Error('WSL Sessions require Windows');
        if (!input.wslDistribution?.trim()) throw new Error('WSL Session requires a distribution');
        const runtimeError = await validateWSLAvailable(input.wslDistribution);
        if (runtimeError) throw new Error(runtimeError);
        if (sourcePanelId) throw new Error('Moving a chat cannot change its runtime');
      } else if (input.wslDistribution) throw new Error('A native Session cannot specify a WSL distribution');
      const data = this.store.read();
      const name = input.name.trim();
      if (data.sessions.some(session => normalizeSessionName(session.name) === normalizeSessionName(name))) {
        throw new Error(`A Session named ${name} already exists`);
      }
      const sourcePanel = sourcePanelId ? panelManager.getPanel(sourcePanelId) : undefined;
      const sourcePane = sourcePanel ? this.sessionManager.getSession(sourcePanel.sessionId) : undefined;
      // SAFETY: Terminal panel launch metadata is persisted as TerminalPanelState.
      const sourceState = sourcePanel?.state.customState as TerminalPanelState | undefined;
      if (sourcePanelId) {
        if (!sourcePanel || sourcePanel.type !== 'terminal' || !sourcePane || sourcePane.isHidden || sourcePane.archived) {
          throw new Error('Choose an agent chat in an active worktree');
        }
        if (data.sessions.some(item => item.associations.some(link => link.paneId === sourcePane.id))) {
          throw new Error('This worktree already belongs to a Session');
        }
        if (!sourceState?.agentSessionId || !['claude', 'codex'].includes(sourceState.agentType ?? '') || sourceState.preserveLaunchCommand || !/^(?:claude|codex)(?:\s|$)/.test(sourceState.initialCommand ?? '') || /[;&|\n]|(?:^|\s)(?:resume|exec|--resume|--continue|--session-id)(?:\s|=|$)/.test(sourceState.initialCommand ?? '')) {
          throw new Error('Moving a chat requires a saved Claude or Codex conversation ID and a built-in launch command');
        }
        // Launch only an idle interactive command: positional prompts, cwd overrides,
        // and shell wrappers could replay work or bypass the private directory.
        if (!/^(?:claude|codex)(?:\s+(?:--yolo|--dangerously-skip-permissions|--model\s+(?:"[^"$`]+"|'[^']+'|[^\s"'$`]+)))*\s*$/.test(sourceState.initialCommand ?? '')
          || resolveAgentTypeFromCommand(sourceState.initialCommand ?? '') !== sourceState.agentType) {
          throw new Error('This launch command cannot be safely resumed in a Session; use a built-in interactive chat');
        }
        if (sourceState.agentType === 'claude' && !findClaudeSessionTranscript(sourceState.agentSessionId)) {
          throw new Error('The Claude conversation transcript is unavailable; the chat has not been moved');
        }
      }
      const now = new Date().toISOString();
      const id = `${ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX}${randomUUID()}__`;
      const internalSessionId = `${id}terminal__`;
      const config = this.configManager.getConfig();
      const explicitAgent = input.agent ? normalizePaneChatAgent(input.agent) : undefined;
      // App defaults apply only when they fit the agent the caller asked for. OpenCode Sessions refuse
      // wrappers and custom resume, so such a default is left out instead of refusing the create.
      const fits = (command: string, resume?: CustomCommandResume | null) => {
        if (explicitAgent === 'opencode') return !resume && (!command.trim() || isDirectOpenCodeCommand(command));
        const commandAgent = launchAgent(command, resume);
        return !explicitAgent || commandAgent === undefined || commandAgent === explicitAgent;
      };
      const defaultCommand = config.defaultSessionCommand ?? '';
      const launchCommand = sourceState?.agentType ? sourceState.initialCommand!
        : input.launchCommand ?? (fits(defaultCommand) ? defaultCommand : '');
      const customResume = sourcePanel ? sourceState?.customResume
        : input.customResume !== undefined ? input.customResume
          // A resumed native conversation is the agent's own; no custom resume command applies.
          : input.resume ? null
          : fits('', config.defaultSessionResume) ? config.defaultSessionResume : null;
      const defaultAgent = normalizePaneChatAgent(config.defaultOrchestratorAgent);
      const agent = explicitAgent ?? launchAgent(launchCommand.trim() || agentTerminalCommand(defaultAgent), customResume)
        ?? defaultAgent;
      const explicitProfile = input.agentProfile ? await this.explicitAgentProfile(input, !!sourcePanel, terminal) : undefined;
      // A profile names its own agent and replaces the launch command and custom resume.
      const sessionAgent = explicitProfile?.agent ?? agent;
      const sessionLaunchCommand = explicitProfile ? '' : launchCommand;
      const sessionResume = explicitProfile ? null : customResume;
      resolveSessionAgent(sessionAgent, sessionLaunchCommand, sessionResume);
      this.assertAgentSupported(sessionAgent, input.runtime);
      const agentProfile = explicitProfile?.profile ?? (sourcePanel || terminal(sessionAgent) ? undefined
        : await this.implicitAgentProfile({ agent: sessionAgent, runtime: input.runtime, resume: input.resume, customResume: sessionResume, launchCommand: sessionLaunchCommand }));
      const record: OrchestrationSessionRecord = {
        // Omitted runtime is the native host; 'windows' is a legacy name for it.
        runtime: input.runtime === 'wsl' ? 'wsl' : undefined,
        wslDistribution: input.wslDistribution,
        id,
        name,
        nameIsDefault: !sourcePanel && input.nameFromFirstMessage ? true : undefined,
        promotedFrom: sourcePanel && sourcePane ? { paneId: sourcePane.id, panelId: sourcePanel.id } : undefined,
        archived: false,
        isPinned: input.isPinned ?? false,
        todoNumber: input.todoNumber,
        agent: sessionAgent,
        launchCommand: sessionLaunchCommand,
        customResume: sessionResume,
        resume: input.resume,
        openingPrompt: input.openingPrompt?.trim() || undefined,
        profile: input.profile ?? this.configManager.getConfig().defaultSessionProfile ?? DEFAULT_SESSION_PROFILE,
        internalSessionId,
        panelIds: {
          // A promoted terminal keeps its own panel as its agent's orchestrator.
          // SAFETY: built from every configured agent id, so it has exactly the PaneChatAgent keys.
          ...Object.fromEntries(CONFIGURED_AGENT_IDS.map(agent => [agent, sourceState?.agentType === agent && sourcePanel ? sourcePanel.id : getOrchestrationPanelId(id, agent)])) as Record<PaneChatAgent, string>,
        },
        goal: input.goal?.trim() ?? '',
        context: input.context?.trim() ?? (sourcePane ? `Conversation promoted from Pane ${sourcePane.id}. Project files remain at ${sourcePane.worktreePath}. Continue project work there; this Session folder holds coordination artifacts.` : ''),
        decisions: [...(input.decisions ?? [])],
        blockers: [...(input.blockers ?? [])],
        nextAction: input.nextAction?.trim() ?? '',
        evidence: cloneLinks(input.evidence ?? []),
        outputs: cloneLinks(input.outputs ?? []),
        associations: sourcePane ? [{ paneId: sourcePane.id, panelIds: [], attachedAt: now }] : [],
        activity: [this.activity('created', `Created Session “${name}”.`, 'user')],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (agentProfile) record.agentProfile = agentProfile;
      const next: OrchestrationSessionStoreData = {
        ...data,
        selectedSessionId: record.id,
        sessions: [...data.sessions, record],
      };
      try {
        if (sourcePanel) {
          // Validate the private location and guide before interrupting the source.
          prepareSessionWorkspace(record.id, record.profile, record);
          await this.ensureGuidePath();
          await terminalPanelManager.stopForPromotion(sourcePanel.id);
          const savedPanel = panelManager.getPanel(sourcePanel.id);
          if (!savedPanel || savedPanel.sessionId !== sourcePane?.id || decodeBoundary(savedPanel.state.customState, boundary.object({ agentSessionId: boundary.optional(boundary.string) })).agentSessionId !== sourceState?.agentSessionId) {
            throw new Error('The chat changed during promotion; reopen it and try again');
          }
        }
        this.store.write(next);
      } catch (error) {
        if (sourcePanel) discardSessionScaffold(record);
        throw error;
      }
      try {
        // Persist the durable record before creating/publishing its hidden
        // terminal owner so a process exit can be repaired during startup.
        this.createInternalSession(record);
        const panel = await this.ensurePanelForAgent(record, terminal(record.agent));
        const view = await this.viewFromRecord(record, panel);
        this.emitChanged(record, 'created');
        return view;
      } catch (error) {
        // If owner/panel provisioning started, keep the durable record linked
        // to those resources so startup can finish the same Session. Roll
        // back only when no resource was published and the write is otherwise
        // an unrecoverable duplicate-name orphan.
        const ownerExists = this.sessionManager.getSession(record.internalSessionId) !== undefined;
        const panelExists = panelManager.getPanel(record.panelIds[record.agent]) !== undefined;
        if (!ownerExists && !panelExists && discardSessionScaffold(record)) {
          this.store.write(data);
          throw error;
        }
        this.emitChanged(record, 'created');
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Session “${record.name}” was saved but could not be opened: ${detail}. Reopen it from the Sessions list.`, { cause: error });
      }
    });
  }

  async update(selector: OrchestrationSessionSelector, input: OrchestrationSessionUpdateInput): Promise<OrchestrationSessionRecord> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      validateUpdateInput(input);
      const data = this.store.read();
      const current = this.findSession(data, selector);
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new Error(`Session ${current.name} changed; expected revision ${input.expectedRevision}, found ${current.revision}`);
      }
      const name = input.name?.trim() ?? current.name;
      // A new agent drops the previous agent's command and resume settings.
      const agentChanging = input.agent !== undefined && input.agent !== current.agent;
      const launchCommand = input.launchCommand ?? (agentChanging ? '' : current.launchCommand);
      const customResume = input.customResume !== undefined ? input.customResume : agentChanging ? undefined : current.customResume;
      // The resumed conversation belongs to the previous agent.
      const resume = agentChanging ? undefined : current.resume;
      const command = launchCommand?.trim() || agentTerminalCommand(input.agent ?? current.agent);
      const agent = input.agent ?? launchAgent(command, customResume) ?? current.agent;
      resolveSessionAgent(agent, command, customResume);
      const nextRecord: OrchestrationSessionRecord = {
        ...current,
        name,
        archived: input.archived ?? current.archived === true,
        isPinned: input.isPinned ?? current.isPinned === true,
        agent,
        launchCommand,
        customResume,
        resume,
        profile: input.profile ?? current.profile,
        goal: input.goal?.trim() ?? current.goal,
        context: input.context?.trim() ?? current.context,
        decisions: input.decisions ? [...input.decisions] : [...current.decisions],
        blockers: input.blockers ? [...input.blockers] : [...current.blockers],
        nextAction: input.nextAction?.trim() ?? current.nextAction,
        evidence: input.evidence ? cloneLinks(input.evidence) : cloneLinks(current.evidence),
        outputs: input.outputs ? cloneLinks(input.outputs) : cloneLinks(current.outputs),
        report: input.report === null ? undefined : input.report ? cloneReport(input.report) : current.report ? cloneReport(current.report) : undefined,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        activity: [...current.activity],
      };
      if (input.name !== undefined) delete nextRecord.nameIsDefault;
      // A Session that runs through Agent Farm keeps doing so with its new agent or launch command.
      if (current.agentProfile && (agentChanging || input.launchCommand !== undefined || input.customResume !== undefined)) {
        let agentProfile = await this.implicitAgentProfile(nextRecord);
        // A named profile stays while the agent does: a new launch command for the same agent doesn't drop it,
        // but one that runs another agent does (review F-2), as an explicit agent change already did.
        if (agentProfile && nextRecord.agent === current.agent && !plainProfileAgent(current.agentProfile.ref) && plainProfileAgent(agentProfile.ref)) {
          const hash = await this.agentFarm().pluginHash(profilePlugin(current.agentProfile.ref));
          agentProfile = hash === undefined ? agentProfile : { ref: current.agentProfile.ref, hash };
        }
        if (agentProfile) nextRecord.agentProfile = agentProfile;
        else delete nextRecord.agentProfile;
      }
      // Restore here: a Session that moved away runs here again, so it is no longer marked moved.
      if (input.archived === false && nextRecord.move?.state === 'moved') delete nextRecord.move;
      if (nextRecord.move && nextRecord.move.state !== 'moved' && input.archived !== undefined) {
        throw new PaneError('ERR_SESSION_MOVING', `Session ${current.name} is ${nextRecord.move.state === 'arriving' ? `arriving from ${nextRecord.move.machine}` : `moving to ${nextRecord.move.machine}`}, so it can't be archived or restored now.`, 'Wait for the move to finish.');
      }
      if (input.name !== undefined && data.sessions.some(session => session.id !== current.id && normalizeSessionName(session.name) === normalizeSessionName(nextRecord.name))) {
        throw new Error(`A Session named ${nextRecord.name} already exists`);
      }
      this.assertAgentSupported(nextRecord.agent, nextRecord.runtime);
      if (nextRecord.archived === true && nextRecord.agent !== current.agent) {
        throw new Error(`Session ${current.name} is archived; restore it before changing its agent`);
      }
      const renamed = input.name !== undefined && nextRecord.name !== current.name;
      const updateMessage = input.report ? `Reported: ${input.report.summary}` : renamed ? `Renamed to “${nextRecord.name}”.` : 'Updated Session context.';
      const updateActivity = this.activity(input.report ? 'report' : 'updated', updateMessage, input.source ?? 'user');
      nextRecord.activity.push(updateActivity);
      if (input.report) {
        nextRecord.reportActivityId = updateActivity.id;
        nextRecord.reportAcceptedAt = updateActivity.at;
      } else if (input.report === null) {
        nextRecord.reportActivityId = undefined;
        nextRecord.reportAcceptedAt = undefined;
      }
      this.trimActivity(nextRecord);
      // Restore here after a move away: the orchestrator's tabs leave the move's hold first.
      if (input.archived === false && current.move?.state === 'moved') await releaseMoveHolds(current.internalSessionId);
      if (nextRecord.archived !== true) await this.ensurePanelForAgent(nextRecord);
      if (current.archived !== true && nextRecord.archived === true) nextRecord.archivedAt = new Date().toISOString();
      if (nextRecord.archived !== true) delete nextRecord.archivedAt;
      const replaced = replaceSession(data, nextRecord);
      const isArchiving = current.archived !== true && nextRecord.archived === true;
      const selectedSessionId = isArchiving && data.selectedSessionId === current.id
        ? orderedSessions(replaced).find(session => session.id !== current.id && session.archived !== true)?.id
        : data.selectedSessionId;
      const nextData: OrchestrationSessionStoreData = {
        ...replaced,
        selectedSessionId,
      };
      this.store.write(nextData);
      // An archive or restore can come with a report, whose change kind does not re-read the members.
      if ((current.archived === true) !== (nextRecord.archived === true)) this.liveActivity.invalidateMembers();
      this.emitChanged(nextRecord, input.report ? 'report' : 'updated', selectedSessionId !== data.selectedSessionId);
      // Every way of archiving (the app, a phone, the CLI, another machine) passes here.
      if (isArchiving) this.emit('archived', nextRecord.id);
      return this.withComputed(clone(nextRecord));
    });
  }

  async setAgent(selector: OrchestrationSessionSelector, agent: PaneChatAgent): Promise<OrchestrationSessionView<Session>> {
    const current = await this.get(selector);
    if (current.archived === true) {
      throw new Error(`Session ${current.name} is archived; restore it before opening it`);
    }
    const updated = await this.update({ sessionId: current.id }, { agent, source: 'user' });
    return withLock('orchestration-sessions', async () => {
      const panel = await this.ensurePanelForAgent(updated);
      return this.viewFromRecord(updated, panel);
    });
  }

  /**
   * Switch to chat: the Session whose agent runs in `fromPanelId` now runs it in the chat tab
   * `toPanelId`, which becomes its permanent tab. Any other tab is left alone.
   *
   * Saving the record is the single commit point. The chat is permanent before the record can
   * name it, so a Session never owns a chat that can be closed, and nothing has to be undone once
   * the record is saved. A store write that throws did not land (it publishes by atomic rename),
   * so on failure the terminal is the confirmed owner; `chatReleased` says whether the chat could
   * be made closable again.
   */
  async adoptAgentPanel(fromPanelId: string, toPanelId: string): Promise<SessionAdoption> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const record = data.sessions.find(session => session.panelIds[session.agent] === fromPanelId);
      if (!record) return { owner: 'chat' };
      const target = panelManager.getPanel(toPanelId);
      if (!target) return { owner: 'terminal', chatReleased: true, reason: `chat tab ${toPanelId} is missing` };
      const release = async (reason: string): Promise<SessionAdoption> => {
        try { await panelManager.updatePanel(toPanelId, { metadata: { ...target.metadata, permanent: false } }); }
        catch (error) { return { owner: 'terminal', chatReleased: false, reason: `${reason}; the chat tab could not be made closable again: ${reasonOf(error)}` }; }
        if (panelManager.getPanel(toPanelId)?.metadata.permanent) return { owner: 'terminal', chatReleased: false, reason: `${reason}; the chat tab could not be made closable again` };
        return { owner: 'terminal', chatReleased: true, reason };
      };
      try {
        await panelManager.updatePanel(toPanelId, { metadata: { ...target.metadata, permanent: true } });
        // updatePanel resolves without writing when the database refuses the row.
        if (!panelManager.getPanel(toPanelId)?.metadata.permanent) throw new Error('the chat tab could not be saved as permanent');
        this.store.write(replaceSession(data, {
          ...record,
          panelIds: { ...record.panelIds, [record.agent]: toPanelId },
          // The promoted conversation lives on in the chat tab.
          promotedFrom: record.promotedFrom?.panelId === fromPanelId ? { ...record.promotedFrom, panelId: toPanelId } : record.promotedFrom,
          revision: record.revision + 1,
          updatedAt: new Date().toISOString(),
        }));
      } catch (error) {
        return release(reasonOf(error));
      }
      // Committed. Closing the terminal clears this mark again if this write fails.
      const previous = panelManager.getPanel(fromPanelId);
      if (previous?.metadata.permanent) {
        await panelManager.updatePanel(fromPanelId, { metadata: { ...previous.metadata, permanent: false } })
          .catch(error => console.warn(`[OrchestrationSessionManager] ${fromPanelId} stays marked permanent for now: ${reasonOf(error)}`));
      }
      this.emitChanged(this.findSession(this.store.read(), { sessionId: record.id }), 'updated');
      return { owner: 'chat' };
    });
  }

  /** The launch a Session saved for its agent tab `panelId` (its template's when none was set); undefined for any other tab. */
  agentLaunchCommand(panelId: string): string | undefined {
    const record = this.store.read().sessions.find(session => session.panelIds[session.agent] === panelId);
    if (!record) return undefined;
    return record.launchCommand?.trim() || agentTerminalCommand(record.agent);
  }

  async associate(selector: OrchestrationSessionSelector, input: OrchestrationAssociationInput): Promise<OrchestrationSessionRecord> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      validateAssociationInput(input);
      const data = this.store.read();
      const current = this.findSession(data, selector);
      const pane = this.sessionManager.getSession(input.paneId);
      if (!pane || pane.isHidden) throw new Error(`Pane ${input.paneId} is missing or hidden`);
      if (pane.archived) throw new Error(`Cannot associate archived Pane ${input.paneId}`);
      const panelIds = input.panelIds ? [...new Set(input.panelIds)] : [];
      for (const panelId of panelIds) {
        const panel = panelManager.getPanel(panelId);
        if (!panel || panel.sessionId !== input.paneId) throw new Error(`Panel ${panelId} does not belong to Pane ${input.paneId}`);
      }
      for (const other of data.sessions) {
        if (other.id === current.id) continue;
        if (other.associations.some(association => association.paneId === input.paneId)) {
          throw new PaneError(
            'ERR_PANE_ALREADY_ASSOCIATED',
            `Pane ${pane.name} is already associated with Session ${other.name}`,
            `It stays with ${other.name}. To move it, detach it there first with \`runpane sessions detach --session ${other.id} --pane ${pane.id}\`, then associate it.`,
          );
        }
      }
      const joined = !current.associations.some(item => item.paneId === input.paneId);
      const association: OrchestrationAssociation = {
        paneId: input.paneId,
        panelIds,
        attachedAt: new Date().toISOString(),
      };
      const nextRecord = {
        ...current,
        associations: [...current.associations.filter(item => item.paneId !== input.paneId), association],
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        activity: [...current.activity, this.activity('associated', `Associated Pane “${pane.name}”.`, 'user', input.paneId)],
      };
      this.trimActivity(nextRecord);
      this.store.write(replaceSession(data, nextRecord));
      if (!current.associations.some(item => item.paneId === input.paneId) && pane.isFavorite) {
        try {
          const updated = databaseService.setSessionFavorite(pane.id, false);
          if (!updated) throw new Error(`Could not clear pin for Pane ${pane.id}`);
        } catch (error) {
          this.store.write(data);
          throw error;
        }
        pane.isFavorite = false;
        pane.favoritePinnedAt = undefined;
        this.sessionManager.emit('session-updated', pane);
      }
      this.emitChanged(nextRecord, 'associated', false, joined ? [input.paneId] : []);
      return this.withComputed(clone(nextRecord));
    });
  }

  /**
   * Adds a Pane on another saved machine. This computer can't see that Pane, so the caller names it;
   * its reports reach this Session over the machine's connection (`RemoteMemberEvents`).
   */
  async associateRemote(selector: OrchestrationSessionSelector, member: { paneId: string; name: string; panelIds?: string[]; machine: OrchestrationMemberMachine }): Promise<OrchestrationSessionRecord> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const current = this.findSession(data, selector);
      const owner = data.sessions.find(other => other.id !== current.id && other.associations.some(association => association.paneId === member.paneId));
      if (owner) {
        throw new PaneError('ERR_PANE_ALREADY_ASSOCIATED',
          `Pane ${member.name} on ${member.machine.label} is already associated with Session ${owner.name}`,
          `It stays with ${owner.name}. To move it, detach it there first with \`runpane sessions detach --session ${owner.id} --pane ${member.paneId}\`, then associate it.`);
      }
      const joined = !current.associations.some(item => item.paneId === member.paneId);
      const association: OrchestrationAssociation = {
        paneId: member.paneId,
        panelIds: [...new Set(member.panelIds ?? [])],
        attachedAt: new Date().toISOString(),
        machine: { id: member.machine.id, label: member.machine.label },
        name: member.name,
      };
      const nextRecord = {
        ...current,
        associations: [...current.associations.filter(item => item.paneId !== member.paneId), association],
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        activity: [...current.activity, this.activity('associated', `Associated Pane “${member.name}” on ${member.machine.label}.`, 'user', member.paneId)],
      };
      this.trimActivity(nextRecord);
      this.store.write(replaceSession(data, nextRecord));
      this.emitChanged(nextRecord, 'associated', false, joined ? [member.paneId] : []);
      return this.withComputed(clone(nextRecord));
    });
  }

  /** The remote member with this Pane id, and its Session; reads the in-memory store without the lock or a copy. */
  remoteMember(paneId: string): RemoteMemberRecord | undefined {
    return this.store.remoteMember(paneId);
  }

  /** The Pane ids of this saved machine's members in Sessions that are not archived. */
  remoteMemberPaneIds(machineId: string): string[] {
    return this.store.remoteMemberPaneIds(machineId);
  }

  /** Where the next catch-up read of a saved machine's journal starts, kept beside the remote members. */
  remoteCursor(machineId: string): RemoteJournalCursor | undefined {
    return this.store.remoteCursor(machineId);
  }

  saveRemoteCursor(machineId: string, cursor: RemoteJournalCursor): void {
    this.store.saveRemoteCursor(machineId, cursor);
  }

  /** Reads remote members from their machines; set by the desktop, which holds the machine connections. */
  setRemoteMachines(access: RemoteMachineAccess | undefined): void {
    this.remoteMachines = access;
  }

  /** False when the saved machine's Pane predates remote members; undefined when that isn't known yet. */
  remoteMachineForwardsReports(machineId: string): boolean | undefined {
    return this.remoteMachines?.forwardsReports(machineId);
  }

  async detach(selector: OrchestrationSessionSelector, paneId?: string): Promise<OrchestrationSessionRecord> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const current = this.findSession(data, selector);
      const removed = paneId ? current.associations.filter(item => item.paneId === paneId) : current.associations;
      if (paneId && removed.length === 0) throw new Error(`Session ${current.name} is not associated with Pane ${paneId}`);
      const paneName = paneId ? this.sessionManager.getSession(paneId)?.name : undefined;
      const message = !paneId ? 'Detached all Panes.' : paneName ? `Detached Pane “${paneName}”.` : `Detached Pane ${paneId}.`;
      const nextRecord = {
        ...current,
        associations: paneId ? current.associations.filter(item => item.paneId !== paneId) : [],
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        activity: [...current.activity, this.activity('detached', message, 'user', paneId)],
      };
      this.trimActivity(nextRecord);
      this.store.write(replaceSession(data, nextRecord));
      this.emitChanged(nextRecord, 'detached', false, removed.map(item => item.paneId));
      return this.withComputed(clone(nextRecord));
    });
  }

  async overview(selector: OrchestrationSessionSelector): Promise<OrchestrationSessionOverview> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const record = this.findSession(this.store.read(), selector);
      const panes = await Promise.all(record.associations.map(association => this.readPaneOverview(association)));
      // Only terminals carry an agent state; a page or Files tab never makes the Session's status unknown.
      const statuses = panes.flatMap(pane => pane.panels.filter(panel => panel.type === 'terminal').map(panel => panel.state));
      const status = resolveOverallStatus(record.associations.length === 0, statuses, panes);
      const report = record.report
        ? { ...cloneReport(record.report), freshness: isReportCurrent(record) ? 'current' as const : 'stale' as const }
        : undefined;
      const result: OrchestrationSessionOverview = {
        session: clone(record),
        status,
        panes,
        // Stable sort keeps later-recorded activity first when timestamps tie.
        activity: [...record.activity].reverse().sort((left, right) => right.at.localeCompare(left.at)),
        report,
        refreshedAt: new Date().toISOString(),
      };
      const terminalReason = this.terminalReason(record);
      if (terminalReason) result.terminalReason = terminalReason;
      return result;
    });
  }

  /**
   * What a phone alert about a Pane is titled and grouped under: a Session's own pane is the
   * Session, a worker is "Session › Pane", and any other Pane stands alone. `groupPaneId` is the
   * Session's workspace pane, which the phone opens a Session by. Reads the in-memory store, like
   * `workspaceMembership`.
   */
  alertSubject(paneId: string): MobileAlertSubject {
    const sessions = this.store.read().sessions;
    const own = sessions.find(session => session.internalSessionId === paneId);
    if (own) return { title: own.name, groupPaneId: paneId };
    const parent = sessions.find(session => session.associations.some(association => association.paneId === paneId));
    const paneName = this.sessionManager.getSession(paneId)?.name
      ?? parent?.associations.find(association => association.paneId === paneId)?.name ?? '';
    if (!parent) return { title: paneName, groupPaneId: paneId };
    return { title: paneName ? `${parent.name} › ${paneName}` : parent.name, groupPaneId: parent.internalSessionId };
  }

  /**
   * The Session an Approvals item from this Pane (and tab) belongs to: the Session whose
   * workspace Pane it is, which makes it the orchestrator's, or the Session it is associated
   * with. Archived Sessions don't count. Reads the in-memory store, like `alertSubject`.
   */
  approvalSession(paneId: string, panelId?: string): NotifySession | undefined {
    const sessions = this.store.memberships().filter(session => !session.archived);
    const own = sessions.find(session => session.internalSessionId === paneId
      || (panelId !== undefined && session.panelIds.includes(panelId)));
    if (own) return { id: own.id, name: own.name, paneId: own.internalSessionId, orchestrator: true };
    const parent = sessions.find(session => session.associations.some(association => association.paneId === paneId
      && (association.panelIds.length === 0 || panelId === undefined || association.panelIds.includes(panelId))));
    return parent ? { id: parent.id, name: parent.name, paneId: parent.internalSessionId } : undefined;
  }

  /** Every open Session for Approvals, by id, from one read: a fallback item keeps the Session its report was filed in. */
  /** A Session's name and state, archived too; undefined once it's gone. Approvals' liveness reads it. */
  approvalSessionRecord(sessionId: string): { name: string; paneId: string; archived: boolean } | undefined {
    const session = this.store.memberships().find(candidate => candidate.id === sessionId);
    return session && { name: session.name, paneId: session.internalSessionId, archived: session.archived === true };
  }

  /**
   * To-dos (D-408): a Session's name, orchestrator tab, archived flag and live member Panes, read
   * from the in-memory store without the lock (the to-do service reads it on every status).
   */
  todoSessionInfo(sessionId: string): TodoSessionRecord | undefined {
    // Membership only: cloning the whole store (every Session's history) per lookup stalls the 2 s to-dos tick.
    const record = this.store.membership(sessionId);
    if (!record) return undefined;
    const paneIds = record.associations.map(association => association.paneId)
      .filter(paneId => this.sessionManager.getSession(paneId)?.archived === false);
    return {
      id: record.id, name: record.name, agent: record.agent, orchestratorPanelId: record.agentPanelId,
      ownPaneId: record.internalSessionId, archived: record.archived, paneIds,
    };
  }

  /** To-dos: the Session a tab works in, and whether it is that Session's orchestrator. Reads without the lock. */
  todoSessionOfPanel(panelId: string, paneId: string | undefined): TodoPanelSession | undefined {
    const sessions = this.store.memberships();
    const own = sessions.find(session => session.panelIds.includes(panelId) || (paneId !== undefined && session.internalSessionId === paneId));
    if (own) return { sessionId: own.id, sessionName: own.name, orchestrator: own.panelIds.includes(panelId), ownPane: true, agent: own.agent };
    const member = paneId === undefined ? undefined : sessions.find(session => session.associations.some(association => association.paneId === paneId));
    return member ? { sessionId: member.id, sessionName: member.name, orchestrator: false, ownPane: false, agent: member.agent } : undefined;
  }

  approvalSessionsById(): Map<string, NotifySession> {
    return new Map(this.store.memberships()
      .filter(session => !session.archived)
      .map(session => [session.id, { id: session.id, name: session.name, paneId: session.internalSessionId }]));
  }

  /**
   * The Session's current members, for a Session-scoped `runpane watch`. The journal calls this on
   * every read, so it reads the in-memory store without taking the Session lock.
   */
  workspaceMembership(sessionId: string): WorkspaceSessionMembership | undefined {
    const record = this.store.read().sessions.find(session => session.id === sessionId);
    if (!record) return undefined;
    return {
      panes: new Map(record.associations.filter(association => {
        if (association.machine) return true;
        const pane = this.sessionManager.getSession(association.paneId);
        return pane !== undefined && !pane.archived;
      }).map(association => [association.paneId, association.panelIds])),
      ownPaneIds: new Set([record.internalSessionId]),
      ownPanelIds: new Set(Object.values(record.panelIds)),
    };
  }

  /**
   * The Sessions a panel works for: those associated with its Pane, for every panel or this one.
   * A Session's own orchestrator Pane never counts. Reads the in-memory store without the lock.
   */
  memberSessionIds(paneId: string, panelId: string): string[] {
    return this.store.read().sessions
      .filter(record => record.internalSessionId !== paneId && !Object.values(record.panelIds).includes(panelId))
      .filter(record => record.associations.some(association => association.paneId === paneId
        && (association.panelIds.length === 0 || association.panelIds.includes(panelId))))
      .map(record => record.id);
  }

  /** The Session's chat Pane and its Panes that are not archived: what Pause and Resume act on. */
  pausablePaneIds(sessionId: string): string[] {
    const record = this.store.read().sessions.find(session => session.id === sessionId);
    return record ? this.pausablePaneIdsOf(record) : [];
  }

  private pausablePaneIdsOf(record: Pick<OrchestrationSessionRecord, 'associations' | 'internalSessionId'>): string[] {
    const members = record.associations.map(association => association.paneId)
      .filter(paneId => this.sessionManager.getSession(paneId)?.archived === false);
    return [...new Set([record.internalSessionId, ...members])];
  }

  /** Tells clients that the Sessions holding these Panes may have paused or resumed. */
  notifyPausedChange(paneIds: readonly string[]): void {
    for (const record of this.store.read().sessions) {
      if (paneIds.includes(record.internalSessionId) || record.associations.some(association => paneIds.includes(association.paneId))) {
        this.emit('changed', { sessionId: record.id, kind: 'paused' });
      }
    }
  }

  /**
   * Adds what a read computes, never stored: `paused` when its chat and every Pane in it are paused,
   * and `openedAt`, its chat Pane's last view.
   */
  private withComputed<Session extends OrchestrationSessionSummary>(record: Session): Session {
    const viewedAt = this.sessionManager.getSession(record.internalSessionId)?.lastViewedAt;
    const openedMs = viewedAt ? parseSessionTimestampMs(viewedAt) : NaN;
    const openedAt = Number.isNaN(openedMs) ? undefined : new Date(openedMs).toISOString();
    let latest: TerminalPausedMark | undefined;
    for (const paneId of this.pausablePaneIdsOf(record)) {
      const mark = this.sessionManager.getSession(paneId)?.paused;
      if (!mark) return { ...record, paused: undefined, openedAt };
      if (!latest || mark.at > latest.at) latest = mark;
    }
    return { ...record, paused: latest, openedAt };
  }

  /**
   * What each open Session's activity counts: its orchestrator's own agent tabs, and the agent
   * tabs of its Panes that still exist and are not archived (an association's tab subset where
   * it has one). Other tabs in the orchestrator's Pane, shells and browsers never count. Reads the
   * in-memory store without the lock, like `workspaceMembership`.
   */
  activityMembers(): SessionActivityMembers[] {
    const types = new Map<string, 'chat' | 'terminal'>();
    const counted = (panels: Array<{ id: string; type: string; sessionId?: string } | undefined>, paneId?: string) => panels.flatMap(panel => {
      if (!panel || (paneId !== undefined && panel.sessionId !== undefined && panel.sessionId !== paneId)) return [];
      if (panel.type !== 'terminal' && panel.type !== 'chat') return [];
      types.set(panel.id, panel.type);
      return [panel.id];
    });
    // Read every 2 s for every open Session, so only the columns it needs: the Pane's archived
    // flag and its tabs' ids and types, never whole rows with their parsed state.
    const members = this.store.memberships().filter(session => !session.archived).map(session => ({
      sessionId: session.id,
      // Only tabs that exist: a Session keeps a panel id for each agent, most never created.
      orchestratorPanelIds: counted(session.panelIds.map(panelId => panelManager.getPanel(panelId))),
      panes: session.associations.filter(association => databaseService.isSessionArchived(association.paneId) === false).map(association => ({
        paneId: association.paneId,
        panelIds: association.panelIds.length > 0
          ? counted(association.panelIds.map(panelId => panelManager.getPanel(panelId)), association.paneId)
          : counted(databaseService.getPanelTypesForSession(association.paneId)),
      })),
    }));
    this.activityPanelTypes = types;
    return members;
  }

  /** The hidden owner Pane of each Session that is not archived, read like `activeMemberPaneIds`. */
  ownerPaneIds(): string[] {
    return this.store.read().sessions
      .filter(session => session.archived !== true)
      .map(session => session.internalSessionId);
  }

  /**
   * Panes associated with a Session that is not archived, for the Session PR monitor. Reads the
   * in-memory store without taking the Session lock, like `workspaceMembership`.
   */
  activeMemberPaneIds(): string[] {
    const paneIds = this.store.read().sessions
      .filter(session => session.archived !== true)
      .flatMap(session => session.associations.map(association => association.paneId));
    return [...new Set(paneIds)];
  }

  /**
   * The Session a Pane belongs to: the Session whose orchestrator panel or
   * hidden terminal owner this is, or the Session it is associated with.
   */
  async sessionIdForPane(paneId: string, panelId?: string): Promise<string | undefined> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const sessions = this.store.read().sessions;
      const byPanel = panelId ? sessions.find(session => Object.values(session.panelIds).includes(panelId)) : undefined;
      return (byPanel
        ?? sessions.find(session => session.internalSessionId === paneId)
        ?? sessions.find(session => session.associations.some(association => association.paneId === paneId)))?.id;
    });
  }

  /** Persist meaningful live state transitions and notify visible overviews. */
  async notifyLiveActivity(panelId: string, state: AgentState): Promise<void> {
    await withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const panel = panelManager.getPanel(panelId);
      const parentPaneId = panel?.sessionId;
      const changed: OrchestrationSessionRecord[] = [];
      const refreshed: Array<{ panelId: string; sessionId: string; state: AgentState }> = [];
      let nextData = data;
      for (const current of data.sessions) {
        const isOrchestratorPanel = Object.values(current.panelIds).includes(panelId);
        const association = parentPaneId
          ? current.associations.find(item => item.paneId === parentPaneId && (item.panelIds.length === 0 || item.panelIds.includes(panelId)))
          : undefined;
        if (!isOrchestratorPanel && !association) continue;
        const lastForPanel = [...current.activity].reverse().find(activity => activity.panelId === panelId);
        if (lastForPanel?.kind === state) {
          refreshed.push({ panelId, sessionId: current.id, state });
          continue;
        }
        const nextRecord: OrchestrationSessionRecord = {
          ...current,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
          activity: [...current.activity, this.activity(state, `Agent state changed to ${state}.`, 'agent', association?.paneId, panelId)],
        };
        this.trimActivity(nextRecord);
        nextData = replaceSession(nextData, nextRecord);
        changed.push(nextRecord);
        refreshed.push({ panelId, sessionId: current.id, state });
      }
      if (nextData !== data) {
        this.store.write(nextData);
        for (const item of changed) this.emitChanged(item, item.activity.at(-1)?.kind ?? state);
      }
      for (const item of refreshed) this.emit('overview-updated', item);
    });
  }

  /**
   * Record a worker's `runpane report` as activity on every Session its panel is associated
   * with. Returns the ids of those Sessions.
   */
  async recordAgentReport(panelId: string, report: TerminalAgentReport): Promise<string[]> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const parentPaneId = panelManager.getPanel(panelId)?.sessionId;
      if (!parentPaneId) return [];
      const changed: OrchestrationSessionRecord[] = [];
      let nextData = data;
      for (const current of data.sessions) {
        const association = current.associations.find(item =>
          item.paneId === parentPaneId && (item.panelIds.length === 0 || item.panelIds.includes(panelId)));
        if (!association) continue;
        const nextRecord: OrchestrationSessionRecord = {
          ...current,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
          activity: [...current.activity, this.activity('report', agentReportMessage(report), 'agent', parentPaneId, panelId)],
        };
        this.trimActivity(nextRecord);
        nextData = replaceSession(nextData, nextRecord);
        changed.push(nextRecord);
      }
      if (nextData !== data) {
        this.store.write(nextData);
        for (const item of changed) this.emitChanged(item, 'report');
      }
      return changed.map(item => item.id);
    });
  }

  private async ensureInitializedUnlocked(): Promise<void> {
    if (this.initialized) return;
    const data = this.store.read();
    const migrated = await this.migrateLegacySessions(data);
    const normalizedArchiveState = this.normalizePersistedSessionArchiveState(migrated);
    const normalizedPinState = this.normalizePersistedSessionPinState(normalizedArchiveState);
    const normalizedAgents = this.normalizePersistedSessionAgents(normalizedPinState);
    const normalized = { ...normalizedAgents, sessions: normalizedAgents.sessions.map(record => ({
      ...record,
      launchCommand: record.launchCommand ?? '',
      profile: record.profile ?? DEFAULT_SESSION_PROFILE,
    })) };
    if (JSON.stringify(normalized) !== JSON.stringify(data)) this.store.write(normalized);
    // Repair persisted launch metadata before any restored terminal can replay
    // a pre-upgrade bootstrap. Keep agent IDs and buffers, including inactive agents.
    // One broken Session must not block the others, Pane Chat included.
    let withFailures: OrchestrationSessionStoreData = normalized;
    for (const record of normalized.sessions) {
      try {
        this.buildTerminalState(record);
        await this.reconcilePersistedSessionOwner(record);
        await this.finishPromotion(record);
        // An archived Session's folder may have expired; its tab recreates it once the Session is restored and opened.
        if (record.archived !== true && !Object.values(record.panelIds).some(id => this.agentStarted(id))) {
          prepareSessionWorkspace(record.id, record.profile, record);
        }
        for (const agent of PANE_CHAT_AGENTS) {
          const panel = panelManager.getPanel(record.panelIds[agent]);
          if (panel) {
            // Inactive agents retain their own command and transcript identity.
            // SAFETY: Session-owned terminal panels persist TerminalPanelState exclusively.
            const state = panel.state.customState as TerminalPanelState | undefined;
            await this.refreshPanelLaunchState(panel, agent === record.agent ? record : {
              ...record, agent, launchCommand: state?.initialCommand, customResume: state?.customResume,
            });
          }
        }
      } catch (error) {
        const message = `Session could not be restored: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[OrchestrationSessionManager] ${record.name} (${record.id}): ${message}`);
        if (record.activity.at(-1)?.message === message) continue;
        const failed = { ...record, revision: record.revision + 1, activity: [...record.activity, this.activity('updated', message, 'system')] };
        this.trimActivity(failed);
        withFailures = replaceSession(withFailures, failed);
      }
    }
    if (withFailures !== normalized) this.store.write(withFailures);
    this.initialized = true;
  }

  private normalizePersistedSessionAgents(data: OrchestrationSessionStoreData): OrchestrationSessionStoreData {
    let changed = false;
    const sessions = data.sessions.map(session => {
      const agent = session.runtime === 'wsl' ? session.agent : resolveSupportedPaneChatAgent(session.agent);
      if (agent === session.agent) return session;
      changed = true;
      return { ...session, agent };
    });
    return changed ? { ...data, sessions } : data;
  }

  private normalizePersistedSessionArchiveState(data: OrchestrationSessionStoreData): OrchestrationSessionStoreData {
    let changed = false;
    // A Session archived before archive retention existed starts its retention period now, not at its last update.
    const now = new Date().toISOString();
    const sessions = data.sessions.map(session => {
      if (session.archived === true && !session.archivedAt) {
        changed = true;
        return { ...session, archivedAt: now };
      }
      if (session.archived !== undefined) return session;
      changed = true;
      return { ...session, archived: false };
    });
    let selectedSessionId = data.selectedSessionId;
    if (selectedSessionId && sessions.find(session => session.id === selectedSessionId)?.archived === true) {
      selectedSessionId = sessions.find(session => session.archived !== true)?.id;
      changed = true;
    }
    if (!changed) return data;
    return { ...data, sessions, selectedSessionId };
  }

  private normalizePersistedSessionPinState(data: OrchestrationSessionStoreData): OrchestrationSessionStoreData {
    let changed = false;
    const sessions = data.sessions.map(session => {
      if (session.isPinned !== undefined) return session;
      changed = true;
      return { ...session, isPinned: false };
    });
    return changed ? { ...data, sessions } : data;
  }

  private async reconcilePersistedSessionOwner(record: OrchestrationSessionRecord): Promise<void> {
    // The original Pane Chat keeps its fixed owner. Older supplemental rows
    // get independent owners; persisted IDs make interrupted moves retryable.
    if (record.internalSessionId === PANE_CHAT_SESSION_ID) return;
    this.createInternalSession(record);
    if (!PANE_CHAT_AGENTS.some(agent => record.id === getLegacyAgentSessionId(agent))) return;
    for (const panelId of Object.values(record.panelIds)) {
      const panel = panelManager.getPanel(panelId);
      if (panel?.sessionId === PANE_CHAT_SESSION_ID) {
        await panelManager.movePanel(panelId, PANE_CHAT_SESSION_ID, record.internalSessionId);
      } else if (panel && panel.sessionId !== record.internalSessionId) {
        throw new Error('Imported chat has conflicting ownership');
      }
    }
  }

  private async migrateLegacySessions(data: OrchestrationSessionStoreData): Promise<OrchestrationSessionStoreData> {
    let sessions = [...data.sessions];
    let selectedSessionId = data.selectedSessionId;
    const existingLegacy = sessions.find(session => session.id === LEGACY_ORCHESTRATION_SESSION_ID);
    let legacy: OrchestrationSessionRecord = existingLegacy ?? await this.migrateLegacyPaneChat();
    if (!existingLegacy) {
      sessions.push(legacy);
      selectedSessionId ??= legacy.id;
    }

    // Fresh upgrades retain all fixed agent panels in one Session. Only repair
    // supplemental rows written by older versions; never create new ones.
    for (const agent of PANE_CHAT_AGENTS) {
      const imported = sessions.find(session => session.id === getLegacyAgentSessionId(agent));
      if (!imported || imported.internalSessionId !== PANE_CHAT_SESSION_ID) continue;
      if (canReuniteLegacySession(legacy, imported, agent)) {
        const reunited: OrchestrationSessionRecord = { ...legacy, panelIds: { ...legacy.panelIds, [agent]: imported.panelIds[agent] } };
        legacy = reunited;
        sessions = sessions.filter(session => session.id !== imported.id)
          .map(session => session.id === reunited.id ? reunited : session);
        if (selectedSessionId === imported.id) selectedSessionId = legacy.id;
      } else {
        // A row that has its own files, settings, or another conversation is now
        // independent user work. Preserve it in place, removing only the shared
        // database owner. Its workspace path and every panel ID stay unchanged.
        sessions = sessions.map(session => session.id === imported.id
          ? { ...session, internalSessionId: `${ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX}${session.id}` }
          : session);
      }
    }
    return { ...data, selectedSessionId, sessions };
  }

  private async migrateLegacyPaneChat(): Promise<OrchestrationSessionRecord> {
    const now = new Date().toISOString();
    const configuredAgent = normalizePaneChatAgent(this.configManager.getConfig().defaultOrchestratorAgent);
    const supportedAgent = resolveSupportedPaneChatAgent(configuredAgent);
    if (supportedAgent !== configuredAgent) {
      await this.configManager.updateConfig({ defaultOrchestratorAgent: supportedAgent });
    }
    const state = this.paneChatManager ? await this.paneChatManager.getOrCreate() : undefined;
    const agent = state?.agent && isAgentSupportedOnPlatform(state.agent, process.platform)
      ? state.agent
      : supportedAgent;
    this.assertAgentSupported(agent);
    return {
      id: LEGACY_ORCHESTRATION_SESSION_ID,
      name: state?.session.name || 'Pane Chat',
      archived: false,
      isPinned: false,
      agent,
      internalSessionId: state?.session.id ?? PANE_CHAT_SESSION_ID,
      panelIds: {
        // SAFETY: built from every configured agent id, so it has exactly the PaneChatAgent keys.
        ...Object.fromEntries(CONFIGURED_AGENT_IDS.map(id => [id, getPaneChatPanelId(id)])) as Record<PaneChatAgent, string>,
      },
      goal: '',
      context: '',
      decisions: [],
      blockers: [],
      nextAction: '',
      evidence: [],
      outputs: [],
      associations: [],
      activity: [{
        id: randomUUID(),
        kind: 'created',
        message: 'Imported the existing Pane Chat terminal history.',
        at: now,
        source: 'system',
      }],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  private createInternalSession(record: OrchestrationSessionRecord): void {
    const existing = this.sessionManager.getSession(record.internalSessionId);
    if (existing) {
      const running = Object.values(record.panelIds).some(id => this.agentStarted(id));
      // An archived Session's folder may have expired: name it, create it only when the Session is restored and opened.
      const workspace = running || record.archived === true
        ? sessionWorkspacePath(record.id)
        : prepareSessionWorkspace(record.id, record.profile, record);
      if (existing.worktreePath !== workspace) {
        const updated = databaseService.updateSession(existing.id, { worktree_path: workspace });
        if (!updated) throw new Error('Could not update Session workspace location');
        existing.worktreePath = workspace;
      }
      return;
    }
    const session = this.sessionManager.createSessionWithId(
      record.internalSessionId,
      `${ORCHESTRATION_SESSION_TITLE}: ${record.name}`,
      prepareSessionWorkspace(record.id, record.profile, record),
      record.goal,
      'orchestration-session',
      'ignore',
      undefined,
      false,
      undefined,
      'none',
      undefined,
      undefined,
      false,
      { detached: true, hidden: true },
    );
    this.sessionManager.updateSession(session.id, { status: 'stopped' });
  }

  /** The store is the recovery journal if the app exits between owner writes. */
  private async finishPromotion(record: OrchestrationSessionRecord): Promise<void> {
    if (!record.promotedFrom) return;
    const { paneId, panelId } = record.promotedFrom;
    const panel = panelManager.getPanel(panelId);
    if (!panel) throw new Error('Promoted chat is missing; refusing to replace its history');
    const needsTransfer = panel.sessionId === paneId;
    if (needsTransfer) {
      await terminalPanelManager.stopForPromotion(panelId);
      await panelManager.movePanel(panelId, paneId, record.internalSessionId);
    } else if (panel.sessionId !== record.internalSessionId) {
      throw new Error('Promoted chat has conflicting ownership');
    }
    const pane = this.sessionManager.getSession(paneId);
    if (needsTransfer && pane?.isFavorite) {
      if (!databaseService.setSessionFavorite(paneId, false)) throw new Error('Could not clear the child worktree pin');
      pane.isFavorite = false;
      pane.favoritePinnedAt = undefined;
      this.sessionManager.emit('session-updated', pane);
    }
  }

  private async ensurePanelForAgent(record: OrchestrationSessionRecord, terminal = false): Promise<ToolPanel> {
    if (!Object.values(record.panelIds).some(id => this.agentStarted(id))) {
      prepareSessionWorkspace(record.id, record.profile, record);
    }
    await this.finishPromotion(record);
    const panelId = record.panelIds[record.agent];
    const existing = panelManager.getPanel(panelId);
    // A chat-tab orchestrator keeps its conversation in its own state; there is no terminal launch to refresh.
    if (existing?.type === 'chat') return existing;
    if (existing) {
      await this.refreshPanelLaunchState(existing, record);
      return panelManager.getPanel(panelId) ?? existing;
    }
    const chat = terminal ? undefined : this.chatLaunch(record);
    if (chat && 'launch' in chat && agentConfig(record.agent)?.chat) {
      const workspace = sessionRuntimePath(sessionWorkspacePath(record.id), record);
      const state: ChatPanelState = { agent: record.agent, launch: chat.launch, cwd: workspace, status: 'starting', orchestrationSessionId: record.id, sessionFolder: workspace };
      const opening = this.firstPrompt(record);
      if (opening) state.initialInput = opening;
      const panel = await panelManager.createPanel({
        id: panelId, sessionId: record.internalSessionId, type: 'chat',
        title: `${record.name} · ${configuredAgent(record.agent).title}`,
        initialState: { customState: state }, metadata: { permanent: true },
      });
      void this.chatTabs().ensure(panel.id).catch(error => console.warn(`[Sessions] ${record.name}'s chat did not start: ${error instanceof Error ? error.message : String(error)}`));
      return panel;
    }
    return panelManager.createPanel({
      id: panelId,
      sessionId: record.internalSessionId,
      type: 'terminal',
      title: `${record.name} · ${configuredAgent(record.agent).title}`,
      initialState: this.buildTerminalState(record),
      metadata: { permanent: true },
    });
  }

  /**
   * D-16: with chat tabs on, a new Claude or Codex Session runs its orchestrator in a chat
   * tab. Sessions that resume or promote a terminal conversation, run in WSL, use a truly
   * custom resume, or launch a wrapper keep their terminal (`sessionChatLaunch` says why).
   */
  private chatLaunch(record: Pick<OrchestrationSessionRecord, 'agent' | 'runtime' | 'resume' | 'promotedFrom' | 'customResume' | 'launchCommand' | 'agentProfile'>) {
    if (this.configManager.getConfig().chatTabsEnabled !== true) return undefined;
    const result = sessionChatLaunch({
      agent: record.agent, runtime: record.runtime, resume: record.resume, promoted: !!record.promotedFrom, customResume: record.customResume,
      launchCommand: record.launchCommand?.trim() || agentTerminalCommand(record.agent),
    });
    // T-63: a Session with a profile runs it through Agent Farm; the agent on its own is pane/<agent>,
    // which keeps the full access its launch command gave it. A launch command's own profile stays as it is.
    if (!record.agentProfile || !('launch' in result) || result.launch.kind !== 'agent') return result;
    const launch: ChatTabLaunch = { kind: 'profile', profile: record.agentProfile.ref };
    if (result.launch.fullAccess === true || result.launch.mode) launch.fullAccess = true;
    return { launch };
  }

  private agentFarmPort?: SessionAgentFarm;

  /** Pane's own Agent Farm, for a Session's profile; tests pass their own. */
  attachAgentFarm(port: SessionAgentFarm): void { this.agentFarmPort = port; }

  private agentFarm(): SessionAgentFarm {
    return this.agentFarmPort ?? {
      pluginHash: plugin => installedPluginHash(agentFarmConfigRoot(getAppDirectory()), plugin),
      profiles: () => listPaneAgentFarmProfiles(getAppDirectory()),
    };
  }

  /**
   * The profile a new chat Session runs when the caller named none (T-63): the launch command's own
   * Agent Farm profile, or the agent on its own (`pane/<agent>`). Undefined when the Session keeps a
   * terminal, its agent isn't one Agent Farm runs, or Pane's plugin isn't installed: it then starts
   * its agent directly, as before.
   */
  private async implicitAgentProfile(record: Pick<OrchestrationSessionRecord, 'agent' | 'runtime' | 'resume' | 'customResume' | 'launchCommand'>): Promise<SessionAgentProfile | undefined> {
    const chat = this.chatLaunch({ ...record, promotedFrom: undefined, agentProfile: undefined });
    if (!chat || !('launch' in chat)) return undefined;
    const ref = chat.launch.kind === 'profile' ? chat.launch.profile : plainProfileRef(record.agent);
    if (!ref) return undefined;
    const hash = await this.agentFarm().pluginHash(profilePlugin(ref));
    if (hash === undefined) {
      console.warn(`[Sessions] ${ref} isn't installed in Pane's Agent Farm, so the Session starts ${configuredAgent(record.agent).title} directly.`);
      return undefined;
    }
    return { ref, hash };
  }

  /** The profile a caller named for a new Session, and the agent it runs; refused when it can't start. */
  private async explicitAgentProfile(input: OrchestrationSessionCreateInput, promoted: boolean, terminal: (agent: PaneChatAgent) => boolean): Promise<{ profile: SessionAgentProfile; agent: PaneChatAgent }> {
    const ref = input.agentProfile ?? '';
    const refuse = (code: string, message: string, next: string): never => { throw new PaneError(code, `${message} No Session was created.`, next); };
    if (promoted || input.resume) refuse('SESSION_PROFILE_UNSUPPORTED', `A Session that continues an earlier conversation can't start with the profile ${ref}.`, 'Create the Session without a profile.');
    if (input.runtime === 'wsl') refuse('SESSION_PROFILE_UNSUPPORTED', `Profiles run in chat tabs, which don't run in WSL, so the Session can't start with ${ref}.`, 'Create a native Session, or leave out the profile.');
    if (this.configManager.getConfig().chatTabsEnabled !== true) refuse('SESSION_PROFILE_UNSUPPORTED', `Profiles run in chat tabs, which are off on this computer, so the Session can't start with ${ref}.`, 'Turn on Chat tabs in Settings > AI & Agents, then try again.');
    const [qualified, variant] = ref.split(':');
    const plain = plainProfileAgent(qualified);
    let agent: PaneChatAgent | undefined = plain;
    if (plain && variant) refuse('SESSION_PROFILE_UNKNOWN', `${qualified} has no variants, so ${ref} can't start.`, `Name ${qualified} without a variant.`);
    if (!agent) {
      const list: AgentFarmProfileList = await this.agentFarm().profiles();
      const entry = list.profiles.find(candidate => candidate.ref === qualified);
      if (!entry) return refuse('SESSION_PROFILE_UNKNOWN', `This computer's Pane has no Agent Farm profile named ${qualified}.${list.error ? ` ${list.error}` : ''}`, 'List them with agent-farm profiles list in a Pane terminal, or install the profile\'s plugin first.');
      if (variant && !entry.variants?.some(candidate => candidate.name === variant)) {
        refuse('SESSION_PROFILE_UNKNOWN', `${qualified} has no variant named ${variant}.`, entry.variants?.length ? `Pick one of ${entry.variants.map(candidate => candidate.name).join(', ')}.` : `Name ${qualified} without a variant.`);
      }
      // The list gives only the default variant's harness; another variant's comes from the caller.
      const otherVariant = !!variant && variant !== entry.defaultVariant;
      if (otherVariant && !input.agent) refuse('SESSION_PROFILE_AGENT_REQUIRED', `Pane can't tell which agent the variant ${ref} runs.`, 'Pass agent (claude or codex) with the profile.');
      agent = normalizePaneChatAgent(otherVariant && input.agent ? input.agent : entry.harness);
      if (!agentConfig(agent)?.chat?.adapter || (!otherVariant && agent !== entry.harness)) refuse('SESSION_PROFILE_UNSUPPORTED', `The profile ${ref} runs ${entry.harness}, which Pane can't start through Agent Farm.`, 'Pick a Claude or Codex profile.');
    }
    if (!agent || terminal(agent)) return refuse('SESSION_PROFILE_UNSUPPORTED', `This app can't show the chat tab a profile runs in, so the Session can't start with ${ref}.`, 'Create the Session from the desktop app, or leave out the profile.');
    const hash = await this.agentFarm().pluginHash(profilePlugin(ref));
    if (hash === undefined) return refuse('SESSION_PROFILE_UNKNOWN', `The plugin of ${ref} isn't installed in this computer's Pane.`, 'Restart Pane so it sets up its Agent Farm, or install the plugin, then try again.');
    return { profile: { ref, hash }, agent };
  }

  /** Why a Session with chat tabs on runs in a terminal, for its overview. */
  private terminalReason(record: OrchestrationSessionRecord): string | undefined {
    const result = this.chatLaunch(record);
    if (!result || panelManager.getPanel(record.panelIds[record.agent])?.type !== 'terminal') return undefined;
    return 'terminalReason' in result ? result.terminalReason : 'It started in a terminal, because Chat tabs were off then or a Pane app that cannot show chat tabs created it, and a Session keeps the kind of tab it started with.';
  }

  private chatTabPort?: SessionChatTabs;

  /** Chat tabs the Session drives; tests pass their own. */
  attachChatTabs(port: SessionChatTabs): void { this.chatTabPort = port; }

  private chatTabs(): SessionChatTabs { return this.chatTabPort ?? getChatTabManager(); }

  /** Whether the Session's agent runs: its terminal process, or its chat tab's adapter. */
  private agentStarted(panelId: string): boolean {
    return terminalPanelManager.isTerminalInitialized(panelId) || this.chatTabs().isRunning(panelId);
  }

  private async refreshPanelLaunchState(panel: ToolPanel, record: OrchestrationSessionRecord): Promise<void> {
    // A chat keeps its conversation in its own state; there is no terminal launch to refresh.
    if (panel.type === 'chat') return;
    // SAFETY: Session-owned terminal panels persist their launch fields in the
    // TerminalPanelState custom state; resume ids and terminal buffers are
    // retained by spreading this previously validated state below.
    const current = panel.state.customState as TerminalPanelState | undefined;
    // Validate saved OpenCode metadata before record overlays can erase an
    // incompatible wrapper/resume setting or reset the conversation selector.
    if (record.agent === 'opencode' || current?.agentType === 'opencode'
      || resolveAgentTypeFromCommand(current?.initialCommand) === 'opencode') {
      resolveSessionAgent('opencode', current?.initialCommand ?? '', current?.customResume);
      if (current?.launchMode === 'wrapped') throw openCodeSessionLaunchError('OpenCode Sessions cannot use wrapped launches');
    }
    const desired = this.buildTerminalState(record);
    const isInitialized = terminalPanelManager.isTerminalInitialized(panel.id);
    const nextCustomState: TerminalPanelState = isInitialized
      ? {
          ...current,
          initialCommand: desired.initialCommand,
          initialInput: desired.initialInput,
          initialInputMode: desired.initialInputMode,
          initialInputSubmitStrategy: desired.initialInputSubmitStrategy,
          initialInputDeliveryVersion: desired.initialInputDeliveryVersion,
          agentType: desired.agentType,
          orchestrationSessionId: desired.orchestrationSessionId,
          orchestrationWorkspace: desired.orchestrationWorkspace,
          orchestrationProfile: desired.orchestrationProfile,
          preserveLaunchCommand: desired.preserveLaunchCommand,
          customResume: desired.customResume,
          isCliPanel: true,
        }
      : { ...current, ...desired };
    // A conversation the tab already has (it may have moved on since) wins over the record's resume.
    if (!isInitialized && current?.agentSessionId && desired.agentSessionId) {
      nextCustomState.agentSessionId = current.agentSessionId;
      nextCustomState.hasClaudeSessionId = current.hasClaudeSessionId;
    }
    if ((current?.agentType && current.agentType !== desired.agentType) || current?.customResume?.mode !== desired.customResume?.mode) {
      nextCustomState.customResumeStarted = undefined;
      nextCustomState.agentSessionId = undefined;
      nextCustomState.hasClaudeSessionId = undefined;
      nextCustomState.wasInterrupted = undefined;
    }
    if (current?.agentSessionId && current.agentSessionId !== nextCustomState.agentSessionId) {
      console.log(`[OrchestrationSessionManager] Session ${record.id} panel ${panel.id}: saved conversation ${current.agentSessionId} ${nextCustomState.agentSessionId ? `replaced by ${nextCustomState.agentSessionId}` : 'cleared'} by the Session's launch (agent ${current.agentType ?? 'unknown'} -> ${desired.agentType}, resume ${current.customResume?.mode ?? 'none'} -> ${desired.customResume?.mode ?? 'none'}).`);
    }
    const nextTitle = `${record.name} · ${configuredAgent(record.agent).title}`;
    const stateNeedsRefresh = JSON.stringify(current?.customResume) !== JSON.stringify(nextCustomState.customResume)
      || current?.initialCommand !== nextCustomState.initialCommand
      || current?.initialInput !== nextCustomState.initialInput
      || current?.initialInputMode !== nextCustomState.initialInputMode
      || current?.initialInputSubmitStrategy !== nextCustomState.initialInputSubmitStrategy
      || current?.initialInputDeliveryVersion !== nextCustomState.initialInputDeliveryVersion
      || current?.orchestrationProfile !== nextCustomState.orchestrationProfile
      || current?.orchestrationWorkspace !== nextCustomState.orchestrationWorkspace
      || current?.preserveLaunchCommand !== nextCustomState.preserveLaunchCommand
      || current?.agentType !== nextCustomState.agentType
      || current?.orchestrationSessionId !== nextCustomState.orchestrationSessionId
      || current?.isCliPanel !== nextCustomState.isCliPanel
      || current?.agentSessionId !== nextCustomState.agentSessionId;
    if (!stateNeedsRefresh && panel.title === nextTitle) return;
    await panelManager.updatePanel(panel.id, {
      title: nextTitle,
      state: stateNeedsRefresh ? { ...panel.state, customState: nextCustomState } : undefined,
    });
  }

  private buildTerminalState(record: OrchestrationSessionRecord): TerminalPanelState {
    const command = record.launchCommand?.trim() || agentTerminalCommand(record.agent);
    const initialCommand = record.launchCommand?.trim()
      || (record.runtime === 'wsl' ? command : this.skillCacheManager?.launchCommand(record.agent)) || command;
    const effectiveAgent = launchAgent(initialCommand, record.customResume);
    const resolvedAgent = record.agent === 'opencode' || effectiveAgent === 'opencode'
      ? resolveSessionAgent(record.agent, initialCommand, record.customResume)
      : launchAgent(command, record.customResume);
    // A command that starts with the agent's executable and chains nothing lets the terminal add its own
    // resume or session flags; anything else runs as given.
    const nativeCommand = resolvedAgent === 'opencode'
      || (resolvedAgent !== undefined && configuredAgent(resolvedAgent).executables.includes(command.split(/\s/)[0]) && !/[;&|\n]/.test(command));
    // A resumed conversation is created with its id, so even a tab repaired at startup resumes it.
    const resumed: TerminalPanelState = {};
    if (record.resume) resumed.agentSessionId = record.resume;
    if (record.resume && record.agent === 'claude') resumed.hasClaudeSessionId = true;
    return {
      ...resumed,
      initialCommand,
      customResume: record.customResume,
      initialInput: record.resume ? undefined : this.firstPrompt(record),
      initialInputMode: 'argument',
      initialInputSubmitStrategy: 'enter',
      initialInputDeliveryVersion: ORCHESTRATION_BOOTSTRAP_VERSION,
      agentType: resolvedAgent ?? record.agent,
      orchestrationSessionId: record.id,
      orchestrationWorkspace: sessionRuntimePath(sessionWorkspacePath(record.id), record),
      orchestrationProfile: record.profile,
      preserveLaunchCommand: !nativeCommand,
      isCliPanel: true,
      isCliReady: false,
    };
  }

  /**
   * A Session speaks first only with the opening prompt it was created with, or, for the
   * built-in Pane Chat, the migrate offer (see paneChatMigrateOffer).
   */
  private firstPrompt(record: OrchestrationSessionRecord): string | undefined {
    if (record.customResume) return undefined;
    if (record.openingPrompt) {
      // The prompt belongs to the Session: once any of its agent tabs sent it, no tab sends it again.
      const sent = Object.values(record.panelIds).some(panelId => {
        // SAFETY: Session-owned terminal panels persist TerminalPanelState as their custom state.
        const state = panelManager.getPanel(panelId)?.state.customState as TerminalPanelState | undefined;
        return state?.initialInput === record.openingPrompt && Boolean(state?.initialInputSentAt);
      });
      if (!sent) return record.openingPrompt;
      this.forgetOpeningPrompt(record);
      return undefined;
    }
    if (record.id !== LEGACY_ORCHESTRATION_SESSION_ID) return undefined;
    // SAFETY: Session-owned terminal panels persist TerminalPanelState as their custom state.
    const current = panelManager.getPanel(record.panelIds[record.agent])?.state.customState as TerminalPanelState | undefined;
    return paneChatFirstPrompt(record.agent, current, this.skillCacheManager?.paneChatSkillsRoot);
  }

  /**
   * A terminal sent the opening prompt. Its own sent marker does not survive a later
   * rebuild of the launch state, so the record drops the prompt for good.
   */
  private forgetOpeningPrompt(record: OrchestrationSessionRecord): void {
    delete record.openingPrompt;
    const data = this.store.read();
    this.store.write({
      ...data,
      sessions: data.sessions.map(session => session.id === record.id ? { ...session, openingPrompt: undefined } : session),
    });
  }

  private async ensureGuidePath(): Promise<string> {
    if (!this.skillCacheManager) throw new Error('Pane Chat skill cache manager is not initialized');
    return this.skillCacheManager.ensurePaneChatGuide();
  }

  private async viewFromRecord(record: OrchestrationSessionRecord, panel: ToolPanel): Promise<OrchestrationSessionView<Session>> {
    const internalSession = this.sessionManager.getSession(record.internalSessionId);
    if (!internalSession) throw new Error(`Session ${record.id} internal terminal session is missing`);
    return {
      session: clone(record),
      internalSession,
      panel,
      agent: record.agent,
      cwd: sessionRuntimePath(sessionWorkspacePath(record.id), record),
      // Making sure the guide is there writes it; a read-only device runs no agent that reads it.
      guidePath: readOnlyPaneCaller() ? '' : sessionRuntimePath(await this.ensureGuidePath(), record),
      started: this.agentStarted(panel.id),
    };
  }

  private async readPaneOverview(association: OrchestrationAssociation): Promise<OrchestrationPaneOverview> {
    if (association.machine) return this.readRemotePaneOverview(association, association.machine);
    const pane = this.sessionManager.getSession(association.paneId);
    if (!pane) {
      return {
        paneId: association.paneId,
        name: association.paneId,
        archived: false,
        missing: true,
        panels: association.panelIds.map(panelId => missingPanel(panelId)),
      };
    }
    // A whole-Pane link lists every tab, with Explorer and Diff (the inspector's Files and Changes) last.
    const allPanels = association.panelIds.length === 0
      ? [...panelManager.getPanelsForSession(pane.id)].sort((a, b) => Number(isInspectorPanel(a)) - Number(isInspectorPanel(b)))
      : association.panelIds.map(panelId => panelManager.getPanel(panelId)).filter((panel): panel is ToolPanel => panel !== undefined);
    const panels: OrchestrationPanelOverview[] = allPanels.map(panel => {
      const customState = decodeBoundary(panel.state.customState ?? {}, boundary.object({
        agentType: boundary.optional(boundary.enumeration(...CLI_AGENT_TYPES)),
        agent: boundary.optional(boundary.string),
        isInitialized: boundary.optional(boundary.boolean),
      }));
      const snapshot = panel.type === 'terminal' ? terminalPanelManager.getTerminalSnapshot(panel.id) : null;
      const chat = panel.type === 'chat';
      const initialized = chat ? this.chatTabs().isRunning(panel.id) : panel.type === 'terminal' && terminalPanelManager.isTerminalInitialized(panel.id);
      const panelAgent = snapshot?.agentType ?? customState.agentType ?? (chat ? customState.agent : undefined);
      const overview: OrchestrationPanelOverview = {
        panelId: panel.id,
        title: panel.title,
        type: panel.type,
        agentType: isPaneChatAgent(panelAgent) ? panelAgent : undefined,
        state: chat ? this.chatTabs().agentState(panel.id) : terminalPanelManager.getAgentStatus(panel.id) ?? 'unknown',
        initialized: initialized || customState.isInitialized === true,
        lastActivityAt: snapshot?.lastActivityTime,
      };
      const report = panelOverviewReport(panel);
      if (report) overview.report = report;
      return overview;
    });
    const panelIds = new Set(allPanels.map(panel => panel.id));
    for (const panelId of association.panelIds) {
      if (!panelIds.has(panelId)) panels.push(missingPanel(panelId));
    }
    const report = newestAgentReport(allPanels);
    const cachedGit = this.gitStatusManager?.getCachedStatus(pane.id);
    const branch = await this.readCurrentBranch(pane);
    const overview: OrchestrationPaneOverview = {
      paneId: pane.id,
      name: pane.name,
      worktreePath: pane.worktreePath,
      branch,
      archived: Boolean(pane.archived),
      missing: false,
      panels,
      git: cachedGit ? {
        state: cachedGit.status.state,
        ahead: cachedGit.status.ahead,
        behind: cachedGit.status.behind,
        hasUncommittedChanges: cachedGit.status.hasUncommittedChanges,
        hasUntrackedFiles: cachedGit.status.hasUntrackedFiles,
        prNumber: cachedGit.status.prNumber,
        prUrl: cachedGit.status.prUrl,
        prTitle: cachedGit.status.prTitle,
        prState: cachedGit.status.prState,
      } : undefined,
    };
    if (report) overview.report = report;
    return overview;
  }

  /** A Pane's own row, as its machine reports it to a Session on another computer. */
  async paneOverview(paneId: string): Promise<OrchestrationPaneOverview> {
    return this.readPaneOverview({ paneId, panelIds: [], attachedAt: new Date().toISOString() });
  }

  private async readRemotePaneOverview(association: OrchestrationAssociation, machine: OrchestrationMemberMachine): Promise<OrchestrationPaneOverview> {
    const known: OrchestrationPaneOverview = {
      paneId: association.paneId,
      name: association.name ?? association.paneId,
      archived: false,
      missing: false,
      panels: [],
      machine: { ...machine, state: 'unreachable' },
    };
    // A read-only device reaches this computer, not the owner's other ones through it.
    if (readOnlyPaneCaller()) return known;
    const read = await this.remoteMachines?.readPane(machine.id, association.paneId).catch(() => undefined);
    if (!read || read === 'unreachable') return known;
    if (read === 'older-pane') return { ...known, machine: { ...machine, state: 'older-pane' } };
    const panels = association.panelIds.length === 0 ? read.panels : read.panels.filter(panel => association.panelIds.includes(panel.panelId));
    return { ...read, panels, machine: { ...machine, state: 'online' } };
  }

  private async readCurrentBranch(pane: Session): Promise<string | undefined> {
    const context = this.sessionManager.getProjectContext(pane.id);
    if (!context || !pane.worktreePath) return undefined;
    try {
      const result = await context.commandRunner.execAsync('git branch --show-current', pane.worktreePath, { silent: true });
      const branch = result.stdout.trim();
      return branch || undefined;
    } catch {
      return undefined;
    }
  }

  private findSession(data: OrchestrationSessionStoreData, selector: OrchestrationSessionSelector): OrchestrationSessionRecord {
    if (!selector.sessionId && !selector.name) throw new Error('Session id or name is required');
    let matches = data.sessions.filter(session =>
      (selector.sessionId ? session.id === selector.sessionId : true) &&
      (selector.name ? session.name === selector.name : true),
    );
    // RunPane's single --session selector accepts either a stable id or an
    // exact name. Keep the transport shape unambiguous by trying the id first,
    // then treating an unmatched id-shaped value as the exact name.
    if (matches.length === 0 && selector.sessionId && !selector.name) {
      matches = data.sessions.filter(session => session.name === selector.sessionId);
    }
    const selectorLabel = selector.name ?? selector.sessionId;
    if (matches.length === 0) throw new PaneError('ERR_SESSION_NOT_FOUND', `Session ${selectorLabel} not found`, 'Pick a Session from `runpane sessions list --json`.');
    if (matches.length > 1) throw new PaneError('ERR_SESSION_AMBIGUOUS', `Session selector ${selectorLabel} is ambiguous`, 'Use the Session id from `runpane sessions list --json`.');
    return matches[0];
  }

  private assertAgentSupported(agent: PaneChatAgent, runtime?: 'windows' | 'wsl'): void {
    if (!isAgentSupportedOnPlatform(agent, runtime === 'wsl' ? 'wsl' : process.platform)) {
      throw new Error(`${configuredAgent(agent).title} is not supported on ${process.platform}.`);
    }
  }

  private activity(kind: OrchestrationActivity['kind'], message: string, source: OrchestrationActivity['source'], paneId?: string, panelId?: string): OrchestrationActivity {
    return { id: randomUUID(), kind, message, at: new Date().toISOString(), source, paneId, panelId };
  }

  private trimActivity(record: OrchestrationSessionRecord): void {
    record.activity = record.activity.slice(-resolveSessionRetention(this.configManager.getConfig().retention).sessionActivity);
  }

  /** `paneIds` names the Panes an associate or detach added or removed; the workspace journal records them. */
  private emitChanged(
    record: OrchestrationSessionRecord,
    kind: OrchestrationActivity['kind'] | 'selected',
    selectionChanged = false,
    paneIds?: string[],
  ): void {
    const change = selectionChanged ? { sessionId: record.id, kind, selectionChanged: true } : { sessionId: record.id, kind };
    this.emit('changed', paneIds ? { ...change, sessionName: record.name, paneIds } : change);
  }
}

function launchAgent(command: string, resume?: CustomCommandResume | null): PaneChatAgent | undefined {
  const commandAgent = resolveAgentTypeFromCommand(command);
  if (commandAgent === 'opencode') return commandAgent;
  const agent = customResumeAgentType(resume) ?? commandAgent;
  return isPaneChatAgent(agent) ? agent : undefined;
}

/** An explicit agent wins; a launch command for a different agent is rejected. */
function resolveSessionAgent(explicit: PaneChatAgent | undefined, command: string, resume?: CustomCommandResume | null): PaneChatAgent | undefined {
  const commandAgent = launchAgent(command, resume);
  try {
    if (explicit === 'opencode' || commandAgent === 'opencode') {
      if (resume) throw new Error('OpenCode Sessions cannot use custom resume settings');
      if (command.trim()) assertDirectOpenCodeLaunchCommand(command, process.platform === 'win32');
    }
    if (explicit && commandAgent && commandAgent !== explicit) {
      throw new Error(`The launch command runs ${commandAgent}, but the Session agent is ${explicit}; change one to match`);
    }
  } catch (cause) {
    if (explicit !== 'opencode' && commandAgent !== 'opencode') throw cause;
    throw openCodeSessionLaunchError(cause);
  }
  return explicit ?? commandAgent;
}

function isDirectOpenCodeCommand(command: string): boolean {
  try {
    assertDirectOpenCodeLaunchCommand(command, process.platform === 'win32');
    return true;
  } catch {
    return false;
  }
}

function openCodeSessionLaunchError(cause: unknown): PaneError {
  return new PaneError(
    'ERR_SESSION_OPENCODE_LAUNCH',
    `OpenCode Session launch was refused: "${reasonOf(cause)}". No OpenCode terminal launch was started; saved conversation identity was kept.`,
    'Set the Session launch command to `opencode --auto` and remove wrapped-launch/custom-resume settings, or choose the agent that matches the command.',
  );
}

function validateCreateInput(input: OrchestrationSessionCreateInput): void {
  if (!input.name || input.name.trim().length === 0) throw new Error('Session name is required');
  if (input.customResume) validateCustomCommandResume(input.customResume);
  if (input.todoNumber !== undefined && !(Number.isInteger(input.todoNumber) && input.todoNumber > 0)) {
    throw new PaneError('ERR_SESSION_TODO_NUMBER', `A Session's to-do number must be a positive whole number, not ${input.todoNumber}; the Session was not created.`, 'Pass the to-do\'s number (12 for T-12), or leave it out.');
  }
  if (input.resume !== undefined) {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.resume)) throw new Error('Session resume must be a native session id');
    if (input.customResume) throw new Error('A Session resumes either a native session id or a custom resume command, not both');
  }
  if (input.openingPrompt !== undefined) {
    if (input.resume !== undefined || input.customResume) {
      throw new PaneError('ERR_SESSION_OPENING_PROMPT', 'A resumed conversation cannot take an opening prompt; the Session was not created.', 'Create the Session without resume, or without the opening prompt.');
    }
    if (!input.openingPrompt.trim().startsWith(PANE_ONE_TIME_PROMPT_OPENING)) {
      throw new PaneError('ERR_SESSION_OPENING_PROMPT', `A Session's opening prompt must begin with "${PANE_ONE_TIME_PROMPT_OPENING}" so its launch sends it only once; the Session was not created.`, `Start the opening prompt with "${PANE_ONE_TIME_PROMPT_OPENING}".`);
    }
  }
  validateLinks(input.evidence, 'evidence');
  validateLinks(input.outputs, 'outputs');
}

function validateUpdateInput(input: OrchestrationSessionUpdateInput): void {
  if (input.name !== undefined && input.name.trim().length === 0) throw new Error('Session name is required');
  if (input.archived !== undefined) decodeBoundary(input.archived, boundary.boolean);
  if (input.isPinned !== undefined) decodeBoundary(input.isPinned, boundary.boolean);
  if (input.customResume) validateCustomCommandResume(input.customResume);
  validateLinks(input.evidence, 'evidence');
  validateLinks(input.outputs, 'outputs');
  if (input.report) {
    validateLinks(input.report.evidence, 'report evidence');
    if (input.report.evidence.length === 0) throw new Error('Report evidence is required');
  }
  if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new Error('Expected revision must be a non-negative integer');
  }
}

function normalizeSessionName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function resolveSupportedPaneChatAgent(agent: PaneChatAgent): PaneChatAgent {
  return isAgentSupportedOnPlatform(agent, process.platform) ? agent : DEFAULT_PANE_CHAT_AGENT;
}

function getLegacyAgentSessionId(agent: PaneChatAgent): string {
  return `${LEGACY_AGENT_SESSION_ID_PREFIX}${agent}`;
}

function canReuniteLegacySession(
  legacy: OrchestrationSessionRecord,
  imported: OrchestrationSessionRecord,
  agent: PaneChatAgent,
): boolean {
  // Be conservative: even unrecognized files/settings may represent user work.
  // Retain such rows as isolated Sessions rather than silently merging content.
  const defaultName = `${legacy.name} · ${PANE_CHAT_AGENT_LABELS[agent]}`;
  if (imported.revision !== 1 || imported.name !== defaultName || imported.agent !== agent
    || imported.archived !== legacy.archived || imported.isPinned !== legacy.isPinned
    || imported.launchCommand || (imported.profile && imported.profile !== DEFAULT_SESSION_PROFILE)
    || imported.goal || imported.context || imported.nextAction || imported.report
    || imported.decisions.length || imported.blockers.length || imported.evidence.length
    || imported.outputs.length || imported.associations.length || imported.promotedFrom
    || imported.activity.length !== 1 || imported.activity[0].kind !== 'created'
    || !isPristineSessionWorkspace(imported)) return false;
  if (imported.panelIds[agent] !== getPaneChatPanelId(agent)) return false;
  const original = panelManager.getPanel(imported.panelIds[agent]);
  if (original && (original.sessionId !== PANE_CHAT_SESSION_ID
    || terminalPanelManager.isTerminalInitialized(original.id))) return false;
  if (legacy.panelIds[agent] !== imported.panelIds[agent] && panelManager.getPanel(legacy.panelIds[agent])) return false;
  return PANE_CHAT_AGENTS.every(other => other === agent || !panelManager.getPanel(imported.panelIds[other]));
}

function validateAssociationInput(input: OrchestrationAssociationInput): void {
  if (!input.paneId || input.paneId.trim().length === 0) throw new Error('Pane id is required');
}

function validateLinks(links: OrchestrationLink[] | undefined, label: string): void {
  if (!links) return;
  for (const link of links) {
    if (!/^(?:https?:\/\/|file:\/\/|grain:\/\/)/i.test(link.url)) throw new Error(`${label} URL must use https, file, or grain scheme`);
  }
}

/** Sessions the saved order does not name (new ones) first, newest first; then the saved order. */
function orderedSessions(data: OrchestrationSessionStoreData): OrchestrationSessionRecord[] {
  const position = new Map((data.order ?? []).map((id, index) => [id, index]));
  return [...data.sessions].sort((left, right) => {
    const leftPosition = position.get(left.id) ?? -1;
    const rightPosition = position.get(right.id) ?? -1;
    if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    return right.createdAt.localeCompare(left.createdAt);
  });
}

function replaceSession(data: OrchestrationSessionStoreData, record: OrchestrationSessionRecord): OrchestrationSessionStoreData {
  return { ...data, sessions: data.sessions.map(session => session.id === record.id ? record : session) };
}

/** A copy of the record without the fields a summary list leaves out; the stored record is untouched. */
function summaryOf(record: OrchestrationSessionRecord): OrchestrationSessionSummary {
  // Drop them before cloning, so the long activity log is never copied.
  const summary: Partial<OrchestrationSessionRecord> = { ...record };
  for (const field of ORCHESTRATION_SESSION_DETAIL_FIELDS) delete summary[field];
  // SAFETY: Every field but the detail fields came from a whole record, and those were just removed.
  return clone(summary as OrchestrationSessionSummary);
}

function clone<Value>(value: Value): Value {
  // SAFETY: Values cloned here are constrained by the Session boundary types and contain JSON data only.
  return JSON.parse(JSON.stringify(value)) as Value;
}

function cloneLinks(links: OrchestrationLink[]): OrchestrationLink[] {
  return links.map(link => ({ ...link }));
}

function cloneReport(report: OrchestrationReport): OrchestrationReport {
  return { ...report, evidence: cloneLinks(report.evidence) };
}

/** Activity text for a worker report: `Worker reported ready: PR #747 at fc5dce9.` */
function agentReportMessage(report: TerminalAgentReport): string {
  const details = [
    report.pr !== undefined ? `PR #${report.pr}` : undefined,
    report.head ? `at ${report.head.slice(0, 7)}` : undefined,
  ].filter(Boolean).join(' ');
  const question = report.question ? ` Question: ${report.question}` : '';
  return `Worker reported ${report.state}${details ? `: ${details}` : ''}.${question}`;
}

/** A panel's latest report, with its JSON object summary as `data` (derived on read, so older reports get it too). */
function panelOverviewReport(panel: ToolPanel): OrchestrationPanelReport | undefined {
  const report = readPanelAgentReport(panel);
  if (!report) return undefined;
  const data = agentReportData(report);
  return data ? { ...report, data } : report;
}

/** The most recent report among a Pane's panels, tagged with the panel that sent it. */
function newestAgentReport(panels: readonly ToolPanel[]): (TerminalAgentReport & { panelId: string }) | undefined {
  let newest: (TerminalAgentReport & { panelId: string }) | undefined;
  for (const panel of panels) {
    const report = readPanelAgentReport(panel);
    if (report && (!newest || report.reportedAt > newest.reportedAt)) newest = { ...report, panelId: panel.id };
  }
  return newest;
}

function isInspectorPanel(panel: ToolPanel): boolean {
  return panel.type === 'explorer' || panel.type === 'diff';
}

function missingPanel(panelId: string): OrchestrationPanelOverview {
  return { panelId, title: panelId, state: 'unknown', initialized: false, missing: true };
}

function resolveOverallStatus(
  hasNoAssociations: boolean,
  states: AgentState[],
  panes: OrchestrationPaneOverview[],
): OrchestrationSessionStatus {
  if (hasNoAssociations) return 'unassociated';
  if (panes.some(pane => pane.missing || pane.archived) || panes.some(pane => pane.panels.some(panel => panel.missing))) return 'unknown';
  if (states.includes('blocked')) return 'blocked';
  if (states.includes('working')) return 'working';
  if (states.includes('unknown') || states.length === 0) return 'unknown';
  return 'idle';
}

function isReportCurrent(record: OrchestrationSessionRecord): boolean {
  const report = record.report;
  if (!report) return false;
  const acceptedAt = Date.parse(record.reportAcceptedAt ?? report.reportedAt);
  if (!Number.isFinite(acceptedAt) || acceptedAt > Date.now()) return false;
  const markerIndex = record.reportActivityId
    ? record.activity.findIndex(activity => activity.id === record.reportActivityId)
    : -1;
  const laterActivity = markerIndex >= 0
    ? record.activity.slice(markerIndex + 1)
    : record.activity.filter(activity => Date.parse(activity.at) > acceptedAt);
  return !laterActivity.some(activity => !isOrchestratorActivity(record, activity));
}

function isOrchestratorActivity(record: OrchestrationSessionRecord, activity: OrchestrationActivity): boolean {
  return activity.panelId !== undefined && Object.values(record.panelIds).includes(activity.panelId);
}

/** To-dos' view of a Session (todoSessionInfo). */
export interface TodoSessionRecord {
  id: string;
  name: string;
  agent: PaneChatAgent;
  orchestratorPanelId: string | null;
  ownPaneId: string;
  archived: boolean;
  paneIds: string[];
}

/** To-dos' view of the Session a tab works in (todoSessionOfPanel). */
export interface TodoPanelSession {
  sessionId: string;
  sessionName: string;
  orchestrator: boolean;
  /** The tab is in the Session's own Pane, whose name is the Session's: the tab's own title names it. */
  ownPane: boolean;
  agent: PaneChatAgent;
}
