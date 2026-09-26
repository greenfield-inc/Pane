import { validateCustomCommandResume, customResumeAgentType, type CustomCommandResume } from '../../../shared/types/customCommandResume';
import { findClaudeSessionTranscript } from './claudeSessionTranscript';
import { resolveAgentTypeFromCommand } from './agents/agentIdentity';
import { prepareSessionWorkspace, sessionWorkspacePath, discardSessionScaffold, isPristineSessionWorkspace } from './sessionWorkspace';
import { DEFAULT_SESSION_PROFILE } from '../../../shared/types/sessionProfile';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { withLock } from '../utils/mutex';
import { getAppDirectory } from '../utils/appDirectory';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import { databaseService } from './database';
import type { ConfigManager } from './configManager';
import type { SessionManager } from './sessionManager';
import type { Session } from '../types/session';
import type { SkillCacheManager } from './skillCacheManager';
import type { PaneChatManager } from './paneChatManager';
import type { GitStatusManager } from './gitStatusManager';
import type { ToolPanel, TerminalPanelState } from '../../../shared/types/panels';
import type { AgentState } from '../../../shared/types/agentStatus';
import {
  LEGACY_ORCHESTRATION_SESSION_ID,
  MAX_ORCHESTRATION_ACTIVITY,
  MAX_ORCHESTRATION_ITEMS,
  MAX_ORCHESTRATION_TEXT_LENGTH,
  ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX,
  type OrchestrationActivity,
  type OrchestrationAssociation,
  type OrchestrationAssociationInput,
  type OrchestrationLink,
  type OrchestrationPaneOverview,
  type OrchestrationPanelOverview,
  type OrchestrationReport,
  type OrchestrationSessionCreateInput,
  type OrchestrationSessionListResult,
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
  PANE_CHAT_SESSION_ID,
  type PaneChatAgent,
} from '../../../shared/types/paneChat';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { isAgentSupportedOnPlatform } from '../../../shared/constants/agentLaunchPresets';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { OrchestrationSessionStore } from './orchestrationSessionStore';

const ORCHESTRATION_SESSION_PANEL_PREFIX = '__orchestration_panel_';
const LEGACY_AGENT_SESSION_ID_PREFIX = `${LEGACY_ORCHESTRATION_SESSION_ID}-`;
const PANE_CHAT_AGENTS: readonly PaneChatAgent[] = ['claude', 'codex', 'cursor'];
const PANE_CHAT_AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
} satisfies Record<PaneChatAgent, string>;

const ORCHESTRATION_SESSION_TITLE = 'Session';
const ORCHESTRATION_BOOTSTRAP_VERSION = 2;

function getOrchestrationPanelId(sessionId: string, agent: PaneChatAgent): string {
  return `${ORCHESTRATION_SESSION_PANEL_PREFIX}${sessionId}_${agent}`;
}

export class OrchestrationSessionManager extends EventEmitter {
  private initialized = false;

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
  }

  async initialize(): Promise<void> {
    await withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
    });
  }

  async list(): Promise<OrchestrationSessionListResult> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      return {
        sessions: data.sessions.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone),
        selectedSessionId: data.selectedSessionId,
      };
    });
  }

  async select(selector: OrchestrationSessionSelector): Promise<OrchestrationSessionListResult> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const session = this.findSession(this.store.read(), selector);
      if (session.archived === true) {
        throw new Error(`Session ${session.name} is archived; restore it before selecting it`);
      }
      const data = this.store.read();
      const next: OrchestrationSessionStoreData = { ...data, selectedSessionId: session.id };
      this.store.write(next);
      this.emit('changed', { sessionId: session.id, kind: 'selected' });
      return {
        sessions: next.sessions.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone),
        selectedSessionId: next.selectedSessionId,
      };
    });
  }

  async get(selector: OrchestrationSessionSelector): Promise<OrchestrationSessionRecord> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      return clone(this.findSession(this.store.read(), selector));
    });
  }

  async getView(selector: OrchestrationSessionSelector): Promise<OrchestrationSessionView<Session>> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const record = this.findSession(this.store.read(), selector);
      if (record.archived === true) {
        throw new Error(`Session ${record.name} is archived; restore it before opening it`);
      }
      this.createInternalSession(record);
      const panel = await this.ensurePanelForAgent(record);
      const internalSession = this.sessionManager.getSession(record.internalSessionId);
      if (!internalSession) throw new Error(`Session ${record.id} internal terminal session is missing`);
      await panelManager.setActivePanel(internalSession.id, panel.id);
      return {
        session: clone(record),
        internalSession,
        panel,
        agent: record.agent,
        cwd: sessionWorkspacePath(record.id),
        guidePath: await this.ensureGuidePath(),
        started: terminalPanelManager.isTerminalInitialized(panel.id),
      };
    });
  }

  async create(input: OrchestrationSessionCreateInput, sourcePanelId?: string): Promise<OrchestrationSessionView<Session>> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      validateCreateInput(input);
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
      // App defaults apply only when they fit the agent the caller asked for.
      const fits = (command: string, resume?: CustomCommandResume | null) =>
        !explicitAgent || [explicitAgent, undefined].includes(launchAgent(command, resume));
      const defaultCommand = config.defaultSessionCommand ?? '';
      const launchCommand = sourceState?.agentType ? sourceState.initialCommand!
        : input.launchCommand ?? (fits(defaultCommand) ? defaultCommand : '');
      const customResume = sourcePanel ? sourceState?.customResume
        : input.customResume !== undefined ? input.customResume
          : fits('', config.defaultSessionResume) ? config.defaultSessionResume : null;
      const agent = resolveSessionAgent(explicitAgent, launchCommand, customResume)
        ?? normalizePaneChatAgent(config.defaultOrchestratorAgent);
      this.assertAgentSupported(agent);
      const record: OrchestrationSessionRecord = {
        id,
        name,
        promotedFrom: sourcePanel && sourcePane ? { paneId: sourcePane.id, panelId: sourcePanel.id } : undefined,
        archived: false,
        isPinned: false,
        agent,
        launchCommand,
        customResume,
        profile: input.profile ?? this.configManager.getConfig().defaultSessionProfile ?? DEFAULT_SESSION_PROFILE,
        internalSessionId,
        panelIds: {
          claude: sourceState?.agentType === 'claude' && sourcePanel ? sourcePanel.id : getOrchestrationPanelId(id, 'claude'),
          codex: sourceState?.agentType === 'codex' && sourcePanel ? sourcePanel.id : getOrchestrationPanelId(id, 'codex'),
          cursor: getOrchestrationPanelId(id, 'cursor'),
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
      const next: OrchestrationSessionStoreData = {
        version: data.version,
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
        if (sourcePanel) discardSessionScaffold(record.id);
        throw error;
      }
      try {
        // Persist the durable record before creating/publishing its hidden
        // terminal owner so a process exit can be repaired during startup.
        this.createInternalSession(record);
        const panel = await this.ensurePanelForAgent(record);
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
        if (!ownerExists && !panelExists && discardSessionScaffold(record.id)) {
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
      const agent = resolveSessionAgent(input.agent, launchCommand ?? '', customResume) ?? current.agent;
      const nextRecord: OrchestrationSessionRecord = {
        ...current,
        name,
        archived: input.archived ?? current.archived === true,
        isPinned: input.isPinned ?? current.isPinned === true,
        agent,
        launchCommand,
        customResume,
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
      if (input.name !== undefined && data.sessions.some(session => session.id !== current.id && normalizeSessionName(session.name) === normalizeSessionName(nextRecord.name))) {
        throw new Error(`A Session named ${nextRecord.name} already exists`);
      }
      this.assertAgentSupported(nextRecord.agent);
      if (nextRecord.archived === true && nextRecord.agent !== current.agent) {
        throw new Error(`Session ${current.name} is archived; restore it before changing its agent`);
      }
      const updateActivity = this.activity(input.report ? 'report' : 'updated', input.report ? `Reported: ${input.report.summary}` : 'Updated Session context.', input.source ?? 'user');
      nextRecord.activity.push(updateActivity);
      if (input.report) {
        nextRecord.reportActivityId = updateActivity.id;
        nextRecord.reportAcceptedAt = updateActivity.at;
      } else if (input.report === null) {
        nextRecord.reportActivityId = undefined;
        nextRecord.reportAcceptedAt = undefined;
      }
      trimActivity(nextRecord);
      if (nextRecord.archived !== true) await this.ensurePanelForAgent(nextRecord);
      const replaced = replaceSession(data, nextRecord);
      const isArchiving = current.archived !== true && nextRecord.archived === true;
      const selectedSessionId = isArchiving && data.selectedSessionId === current.id
        ? replaced.sessions.find(session => session.id !== current.id && session.archived !== true)?.id
        : data.selectedSessionId;
      const nextData: OrchestrationSessionStoreData = {
        ...replaced,
        selectedSessionId,
      };
      this.store.write(nextData);
      this.emitChanged(nextRecord, input.report ? 'report' : 'updated', selectedSessionId !== data.selectedSessionId);
      return clone(nextRecord);
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
          throw new Error(`Pane ${pane.name} is already associated with Session ${other.name}`);
        }
      }
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
      trimActivity(nextRecord);
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
      this.emitChanged(nextRecord, 'associated');
      return clone(nextRecord);
    });
  }

  async detach(selector: OrchestrationSessionSelector, paneId?: string): Promise<OrchestrationSessionRecord> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const data = this.store.read();
      const current = this.findSession(data, selector);
      const removed = paneId ? current.associations.filter(item => item.paneId === paneId) : current.associations;
      if (paneId && removed.length === 0) throw new Error(`Session ${current.name} is not associated with Pane ${paneId}`);
      const nextRecord = {
        ...current,
        associations: paneId ? current.associations.filter(item => item.paneId !== paneId) : [],
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        activity: [...current.activity, this.activity('detached', paneId ? `Detached Pane ${paneId}.` : 'Detached all Panes.', 'user', paneId)],
      };
      trimActivity(nextRecord);
      this.store.write(replaceSession(data, nextRecord));
      this.emitChanged(nextRecord, 'detached');
      return clone(nextRecord);
    });
  }

  async overview(selector: OrchestrationSessionSelector): Promise<OrchestrationSessionOverview> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      const record = this.findSession(this.store.read(), selector);
      const panes = await Promise.all(record.associations.map(association => this.readPaneOverview(association)));
      const statuses = panes.flatMap(pane => pane.panels.filter(panel => !panel.missing).map(panel => panel.state));
      const status = resolveOverallStatus(record.associations.length === 0, statuses, panes);
      const report = record.report
        ? { ...cloneReport(record.report), freshness: isReportCurrent(record) ? 'current' as const : 'stale' as const }
        : undefined;
      return {
        session: clone(record),
        status,
        panes,
        activity: [...record.activity].sort((left, right) => right.at.localeCompare(left.at)),
        report,
        refreshedAt: new Date().toISOString(),
      };
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
        trimActivity(nextRecord);
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
        await this.reconcilePersistedSessionOwner(record);
        await this.finishPromotion(record);
        if (!Object.values(record.panelIds).some(id => terminalPanelManager.isTerminalInitialized(id))) {
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
        trimActivity(failed);
        withFailures = replaceSession(withFailures, failed);
      }
    }
    if (withFailures !== normalized) this.store.write(withFailures);
    this.initialized = true;
  }

  private normalizePersistedSessionAgents(data: OrchestrationSessionStoreData): OrchestrationSessionStoreData {
    let changed = false;
    const sessions = data.sessions.map(session => {
      const agent = resolveSupportedPaneChatAgent(session.agent);
      if (agent === session.agent) return session;
      changed = true;
      return { ...session, agent };
    });
    return changed ? { ...data, sessions } : data;
  }

  private normalizePersistedSessionArchiveState(data: OrchestrationSessionStoreData): OrchestrationSessionStoreData {
    let changed = false;
    const sessions = data.sessions.map(session => {
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
        claude: getPaneChatPanelId('claude'),
        codex: getPaneChatPanelId('codex'),
        cursor: getPaneChatPanelId('cursor'),
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
      const workspace = prepareSessionWorkspace(record.id, record.profile, record);
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

  private async ensurePanelForAgent(record: OrchestrationSessionRecord): Promise<ToolPanel> {
    if (!Object.values(record.panelIds).some(id => terminalPanelManager.isTerminalInitialized(id))) {
      prepareSessionWorkspace(record.id, record.profile, record);
    }
    await this.finishPromotion(record);
    const panelId = record.panelIds[record.agent];
    const existing = panelManager.getPanel(panelId);
    if (existing) {
      await this.refreshPanelLaunchState(existing, record);
      return panelManager.getPanel(panelId) ?? existing;
    }
    return panelManager.createPanel({
      id: panelId,
      sessionId: record.internalSessionId,
      type: 'terminal',
      title: `${record.name} · ${RUNPANE_CONTRACT.agentTemplates[record.agent].title}`,
      initialState: this.buildTerminalState(record),
      metadata: { permanent: true },
    });
  }

  private async refreshPanelLaunchState(panel: ToolPanel, record: OrchestrationSessionRecord): Promise<void> {
    const desired = this.buildTerminalState(record);
    // SAFETY: Session-owned terminal panels persist their launch fields in the
    // TerminalPanelState custom state; resume ids and terminal buffers are
    // retained by spreading this previously validated state below.
    const current = panel.state.customState as TerminalPanelState | undefined;
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
    if ((current?.agentType && current.agentType !== desired.agentType) || current?.customResume?.mode !== desired.customResume?.mode) {
      nextCustomState.customResumeStarted = undefined;
      nextCustomState.agentSessionId = undefined;
      nextCustomState.hasClaudeSessionId = undefined;
      nextCustomState.wasInterrupted = undefined;
    }
    const nextTitle = `${record.name} · ${RUNPANE_CONTRACT.agentTemplates[record.agent].title}`;
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
      || current?.isCliPanel !== nextCustomState.isCliPanel;
    if (!stateNeedsRefresh && panel.title === nextTitle) return;
    await panelManager.updatePanel(panel.id, {
      title: nextTitle,
      state: stateNeedsRefresh ? { ...panel.state, customState: nextCustomState } : undefined,
    });
  }

  private buildTerminalState(record: OrchestrationSessionRecord): TerminalPanelState {
    const command = record.launchCommand?.trim() || RUNPANE_CONTRACT.agentTemplates[record.agent].command;
    const nativeCommand = /^(?:claude|codex|cursor-agent)(?:\s|$)/.test(command) && !/[;&|\n]/.test(command);
    return {
      initialCommand: record.launchCommand?.trim() || this.skillCacheManager?.launchCommand(record.agent) || command,
      customResume: record.customResume,
      initialInput: undefined,
      initialInputMode: 'argument',
      initialInputSubmitStrategy: 'enter',
      initialInputDeliveryVersion: ORCHESTRATION_BOOTSTRAP_VERSION,
      agentType: record.customResume ? customResumeAgentType(record.customResume) : resolveAgentTypeFromCommand(command) ?? record.agent,
      orchestrationSessionId: record.id,
      orchestrationWorkspace: sessionWorkspacePath(record.id),
      orchestrationProfile: record.profile,
      preserveLaunchCommand: !nativeCommand,
      isCliPanel: true,
      isCliReady: false,
    };
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
      cwd: sessionWorkspacePath(record.id),
      guidePath: await this.ensureGuidePath(),
      started: terminalPanelManager.isTerminalInitialized(panel.id),
    };
  }

  private async readPaneOverview(association: OrchestrationAssociation): Promise<OrchestrationPaneOverview> {
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
    const allPanels = association.panelIds.length === 0
      ? panelManager.getPanelsForSession(pane.id).filter(panel => panel.type === 'terminal')
      : association.panelIds.map(panelId => panelManager.getPanel(panelId)).filter((panel): panel is ToolPanel => panel !== undefined);
    const panels: OrchestrationPanelOverview[] = allPanels.map(panel => {
      const customState = decodeBoundary(panel.state.customState ?? {}, boundary.object({
        agentType: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor')),
        isInitialized: boundary.optional(boundary.boolean),
      }));
      const snapshot = panel.type === 'terminal' ? terminalPanelManager.getTerminalSnapshot(panel.id) : null;
      const initialized = panel.type === 'terminal' && terminalPanelManager.isTerminalInitialized(panel.id);
      return {
        panelId: panel.id,
        title: panel.title,
        agentType: snapshot?.agentType ?? customState.agentType,
        state: terminalPanelManager.getAgentStatus(panel.id) ?? 'unknown',
        initialized: initialized || customState.isInitialized === true,
        lastActivityAt: snapshot?.lastActivityTime,
      };
    });
    const panelIds = new Set(allPanels.map(panel => panel.id));
    for (const panelId of association.panelIds) {
      if (!panelIds.has(panelId)) panels.push(missingPanel(panelId));
    }
    const cachedGit = this.gitStatusManager?.getCachedStatus(pane.id);
    const branch = await this.readCurrentBranch(pane);
    return {
      paneId: pane.id,
      name: pane.name,
      worktreePath: pane.worktreePath,
      branch,
      archived: pane.archived === true,
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
    if (matches.length === 0) throw new Error(`Session ${selectorLabel} not found`);
    if (matches.length > 1) throw new Error(`Session selector ${selectorLabel} is ambiguous`);
    return matches[0];
  }

  private assertAgentSupported(agent: PaneChatAgent): void {
    if (!isAgentSupportedOnPlatform(agent, process.platform)) {
      throw new Error(`${RUNPANE_CONTRACT.agentTemplates[agent].title} is not supported on ${process.platform}.`);
    }
  }

  private activity(kind: OrchestrationActivity['kind'], message: string, source: OrchestrationActivity['source'], paneId?: string, panelId?: string): OrchestrationActivity {
    return { id: randomUUID(), kind, message: message.slice(0, MAX_ORCHESTRATION_TEXT_LENGTH), at: new Date().toISOString(), source, paneId, panelId };
  }

  private emitChanged(record: OrchestrationSessionRecord, kind: OrchestrationActivity['kind'] | 'selected', selectionChanged = false): void {
    this.emit('changed', selectionChanged ? { sessionId: record.id, kind, selectionChanged: true } : { sessionId: record.id, kind });
  }
}

function launchAgent(command: string, resume?: CustomCommandResume | null): PaneChatAgent | undefined {
  return customResumeAgentType(resume) ?? resolveAgentTypeFromCommand(command);
}

/** An explicit agent wins; a launch command for a different agent is rejected. */
function resolveSessionAgent(explicit: PaneChatAgent | undefined, command: string, resume?: CustomCommandResume | null): PaneChatAgent | undefined {
  const commandAgent = launchAgent(command, resume);
  if (explicit && commandAgent && commandAgent !== explicit) {
    throw new Error(`The launch command runs ${commandAgent}, but the Session agent is ${explicit}; change one to match`);
  }
  return explicit ?? commandAgent;
}

function validateCreateInput(input: OrchestrationSessionCreateInput): void {
  if (!input.name || input.name.trim().length === 0) throw new Error('Session name is required');
  if (input.name.length > MAX_ORCHESTRATION_TEXT_LENGTH) throw new Error('Session name is too long');
  if (input.customResume) validateCustomCommandResume(input.customResume);
  validateOptionalText(input.launchCommand, 'launch command');
  validateOptionalText(input.profile, 'profile');
  validateOptionalText(input.goal, 'goal');
  validateOptionalText(input.context, 'context');
  validateOptionalText(input.nextAction, 'next action');
  validateTextArray(input.decisions, 'decisions');
  validateTextArray(input.blockers, 'blockers');
  validateLinks(input.evidence, 'evidence');
  validateLinks(input.outputs, 'outputs');
}

function validateUpdateInput(input: OrchestrationSessionUpdateInput): void {
  validateOptionalText(input.name, 'name');
  if (input.name !== undefined && input.name.trim().length === 0) throw new Error('Session name is required');
  if (input.archived !== undefined) decodeBoundary(input.archived, boundary.boolean);
  if (input.isPinned !== undefined) decodeBoundary(input.isPinned, boundary.boolean);
  if (input.customResume) validateCustomCommandResume(input.customResume);
  validateOptionalText(input.launchCommand, 'launch command');
  validateOptionalText(input.profile, 'profile');
  validateOptionalText(input.goal, 'goal');
  validateOptionalText(input.context, 'context');
  validateOptionalText(input.nextAction, 'next action');
  validateTextArray(input.decisions, 'decisions');
  validateTextArray(input.blockers, 'blockers');
  validateLinks(input.evidence, 'evidence');
  validateLinks(input.outputs, 'outputs');
  if (input.report) {
    validateOptionalText(input.report.summary, 'report summary');
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
  if ((input.panelIds?.length ?? 0) > MAX_ORCHESTRATION_ITEMS) throw new Error('Too many associated panels');
}

function validateOptionalText(value: string | undefined, label: string): void {
  if (value !== undefined && value.length > MAX_ORCHESTRATION_TEXT_LENGTH) throw new Error(`${label} is too long`);
}

function validateTextArray(values: string[] | undefined, label: string): void {
  if (!values) return;
  if (values.length > MAX_ORCHESTRATION_ITEMS) throw new Error(`${label} contains too many entries`);
  values.forEach(value => validateOptionalText(value, label));
}

function validateLinks(links: OrchestrationLink[] | undefined, label: string): void {
  if (!links) return;
  if (links.length > MAX_ORCHESTRATION_ITEMS) throw new Error(`${label} contains too many links`);
  for (const link of links) {
    validateOptionalText(link.label, `${label} label`);
    validateOptionalText(link.url, `${label} URL`);
    if (!/^(?:https?:\/\/|file:\/\/|grain:\/\/)/i.test(link.url)) throw new Error(`${label} URL must use https, file, or grain scheme`);
  }
}

function replaceSession(data: OrchestrationSessionStoreData, record: OrchestrationSessionRecord): OrchestrationSessionStoreData {
  return { ...data, sessions: data.sessions.map(session => session.id === record.id ? record : session) };
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

function trimActivity(record: OrchestrationSessionRecord): void {
  record.activity = record.activity.slice(-MAX_ORCHESTRATION_ACTIVITY);
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
