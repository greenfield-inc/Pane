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
type PaneChatPanelIds = { claude: string; codex: string; cursor: string };
const PANE_CHAT_AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
} satisfies Record<PaneChatAgent, string>;

const ORCHESTRATION_SESSION_TITLE = 'Session';
const ORCHESTRATION_BOOTSTRAP_VERSION = 1;

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
      const panel = await this.ensurePanelForAgent(record);
      const internalSession = this.sessionManager.getSession(record.internalSessionId);
      if (!internalSession) throw new Error(`Session ${record.id} internal terminal session is missing`);
      await panelManager.setActivePanel(internalSession.id, panel.id);
      return {
        session: clone(record),
        internalSession,
        panel,
        agent: record.agent,
        cwd: getAppDirectory(),
        guidePath: await this.ensureGuidePath(),
        started: terminalPanelManager.isTerminalInitialized(panel.id),
      };
    });
  }

  async create(input: OrchestrationSessionCreateInput): Promise<OrchestrationSessionView<Session>> {
    return withLock('orchestration-sessions', async () => {
      await this.ensureInitializedUnlocked();
      validateCreateInput(input);
      const data = this.store.read();
      const name = input.name.trim();
      if (data.sessions.some(session => normalizeSessionName(session.name) === normalizeSessionName(name))) {
        throw new Error(`A Session named ${name} already exists`);
      }
      const now = new Date().toISOString();
      const id = `${ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX}${randomUUID()}__`;
      const internalSessionId = `${id}terminal__`;
      const agent = input.agent
        ? normalizePaneChatAgent(input.agent)
        : normalizePaneChatAgent(this.configManager.getConfig().defaultOrchestratorAgent);
      this.assertAgentSupported(agent);
      const record: OrchestrationSessionRecord = {
        id,
        name,
        archived: false,
        isPinned: false,
        agent,
        internalSessionId,
        panelIds: {
          claude: getOrchestrationPanelId(id, 'claude'),
          codex: getOrchestrationPanelId(id, 'codex'),
          cursor: getOrchestrationPanelId(id, 'cursor'),
        },
        goal: input.goal?.trim() ?? '',
        context: input.context?.trim() ?? '',
        decisions: [...(input.decisions ?? [])],
        blockers: [...(input.blockers ?? [])],
        nextAction: input.nextAction?.trim() ?? '',
        evidence: cloneLinks(input.evidence ?? []),
        outputs: cloneLinks(input.outputs ?? []),
        associations: [],
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
      this.store.write(next);
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
        if (!ownerExists && !panelExists) {
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
      const nextRecord: OrchestrationSessionRecord = {
        ...current,
        name,
        archived: input.archived ?? current.archived === true,
        isPinned: input.isPinned ?? current.isPinned === true,
        agent: input.agent ? normalizePaneChatAgent(input.agent) : current.agent,
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
      if (nextRecord.agent !== current.agent) await this.ensurePanelForAgent(nextRecord);
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
    const normalized = this.normalizePersistedSessionAgents(normalizedPinState);
    if (normalized !== data) this.store.write(normalized);
    this.reconcilePersistedSessionOwners(normalized);
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

  private reconcilePersistedSessionOwners(data: OrchestrationSessionStoreData): void {
    for (const record of data.sessions) {
      // Pane Chat and its imported agent rows intentionally share one hidden
      // owner managed by PaneChatManager.
      if (record.id === LEGACY_ORCHESTRATION_SESSION_ID || record.internalSessionId === PANE_CHAT_SESSION_ID) continue;
      this.createInternalSession(record);
    }
  }

  private async migrateLegacySessions(data: OrchestrationSessionStoreData): Promise<OrchestrationSessionStoreData> {
    let sessions = [...data.sessions];
    let selectedSessionId = data.selectedSessionId;
    let legacy = sessions.find(session => session.id === LEGACY_ORCHESTRATION_SESSION_ID);
    let changed = false;

    if (!legacy) {
      legacy = await this.migrateLegacyPaneChat();
      sessions.push(legacy);
      selectedSessionId ??= legacy.id;
      changed = true;
    }

    const legacyRecord = legacy;
    const hadSupplementalLayout = PANE_CHAT_AGENTS.some(agent =>
      legacyRecord.panelIds[agent] !== getPaneChatPanelId(agent)
      || sessions.some(session => session.id === getLegacyAgentSessionId(agent)),
    );
    const importedAgents = new Set<PaneChatAgent>();
    for (const agent of PANE_CHAT_AGENTS) {
      const importedId = getLegacyAgentSessionId(agent);
      const existing = sessions.find(session => session.id === importedId);
      if (existing) {
        // Supplemental rows keep their original fixed panel owner even when a
        // user later switches the row's active agent.
        importedAgents.add(agent);
        continue;
      }
      const ownsFixedPanel = legacyRecord.panelIds[agent] === getPaneChatPanelId(agent);
      if ((hadSupplementalLayout && ownsFixedPanel) || (!hadSupplementalLayout && agent === legacyRecord.agent)) continue;
      const panel = panelManager.getPanel(getPaneChatPanelId(agent));
      const hasHistory = panel?.sessionId === legacyRecord.internalSessionId && panelHasLegacyHistory(panel);
      if (!hasHistory) continue;

      importedAgents.add(agent);
      sessions.push(this.createLegacyAgentSession(legacyRecord, agent, sessions));
      changed = true;
    }

    // A legacy record starts with the three fixed IDs. Normalize that layout
    // once, then preserve it across mutable active-agent changes and restarts.
    if (!hadSupplementalLayout) {
      const legacyId = legacyRecord.id;
      const legacyPanelIds = legacyPanelIdsForOwner(legacyId, legacyRecord.agent, importedAgents);
      if (!samePanelIds(legacyRecord.panelIds, legacyPanelIds)) {
        const nextLegacy = { ...legacyRecord, panelIds: legacyPanelIds };
        legacy = nextLegacy;
        sessions = sessions.map(session => session.id === legacyId ? nextLegacy : session);
        changed = true;
      }
    }

    return changed ? { ...data, selectedSessionId, sessions } : data;
  }

  private createLegacyAgentSession(
    legacy: OrchestrationSessionRecord,
    agent: PaneChatAgent,
    sessions: OrchestrationSessionRecord[],
  ): OrchestrationSessionRecord {
    const id = getLegacyAgentSessionId(agent);
    const now = legacy.createdAt;
    return {
      id,
      name: uniqueLegacyAgentName(legacy.name, agent, sessions),
      archived: legacy.archived === true,
      isPinned: legacy.isPinned === true,
      agent,
      internalSessionId: legacy.internalSessionId,
      panelIds: legacyAgentPanelIdsForOwner(id, agent),
      goal: '',
      context: '',
      decisions: [],
      blockers: [],
      nextAction: '',
      evidence: [],
      outputs: [],
      associations: [],
      activity: [{
        id: `${id}-imported`,
        kind: 'created',
        message: `Imported existing ${PANE_CHAT_AGENT_LABELS[agent]} Pane Chat terminal history.`,
        at: now,
        source: 'system',
      }],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
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
      name: 'Pane Chat',
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
    if (this.sessionManager.getSession(record.internalSessionId)) return;
    const session = this.sessionManager.createSessionWithId(
      record.internalSessionId,
      `${ORCHESTRATION_SESSION_TITLE}: ${record.name}`,
      getAppDirectory(),
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

  private async ensurePanelForAgent(record: OrchestrationSessionRecord): Promise<ToolPanel> {
    const guidePath = await this.ensureGuidePath();
    const panelId = record.panelIds[record.agent];
    const existing = panelManager.getPanel(panelId);
    if (existing) {
      await this.refreshPanelLaunchState(existing, record, guidePath);
      return panelManager.getPanel(panelId) ?? existing;
    }
    return panelManager.createPanel({
      id: panelId,
      sessionId: record.internalSessionId,
      type: 'terminal',
      title: `${record.name} · ${RUNPANE_CONTRACT.agentTemplates[record.agent].title}`,
      initialState: this.buildTerminalState(record, guidePath),
      metadata: { permanent: true },
    });
  }

  private async refreshPanelLaunchState(panel: ToolPanel, record: OrchestrationSessionRecord, guidePath: string): Promise<void> {
    const desired = this.buildTerminalState(record, guidePath);
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
          isCliPanel: true,
        }
      : { ...current, ...desired };
    const nextTitle = `${record.name} · ${RUNPANE_CONTRACT.agentTemplates[record.agent].title}`;
    const stateNeedsRefresh = current?.initialCommand !== nextCustomState.initialCommand
      || current?.initialInput !== nextCustomState.initialInput
      || current?.initialInputMode !== nextCustomState.initialInputMode
      || current?.initialInputSubmitStrategy !== nextCustomState.initialInputSubmitStrategy
      || current?.initialInputDeliveryVersion !== nextCustomState.initialInputDeliveryVersion
      || current?.agentType !== nextCustomState.agentType
      || current?.orchestrationSessionId !== nextCustomState.orchestrationSessionId
      || current?.isCliPanel !== nextCustomState.isCliPanel;
    if (!stateNeedsRefresh && panel.title === nextTitle) return;
    await panelManager.updatePanel(panel.id, {
      title: nextTitle,
      state: stateNeedsRefresh ? { ...panel.state, customState: nextCustomState } : undefined,
    });
  }

  private buildTerminalState(record: OrchestrationSessionRecord, guidePath: string): TerminalPanelState {
    const lines = [
      `Read ${guidePath} and initialize yourself as the “${record.name}” Session orchestrator.`,
      `Durable Session id: ${record.id}`,
      `The terminal also exports PANE_ORCHESTRATION_SESSION_ID=${record.id} for resume-safe identity lookup.`,
      `Use --session ${record.id} for every Sessions API update; do not infer identity from the selected Session.`,
      'This is a control-plane conversation. Coordinate implementation through explicitly associated user-visible Panes and keep project implementation work in those Panes.',
      record.goal ? `Goal: ${record.goal}` : '',
      record.context ? `Context: ${record.context}` : '',
      record.decisions.length > 0 ? `Decisions:\n${record.decisions.map(value => `- ${value}`).join('\n')}` : '',
      record.blockers.length > 0 ? `Blockers:\n${record.blockers.map(value => `- ${value}`).join('\n')}` : '',
      record.nextAction ? `Next action: ${record.nextAction}` : '',
      record.associations.length > 0
        ? `Associated Panes:\n${record.associations.map(association => `- ${association.paneId}${association.panelIds.length > 0 ? ` (panels: ${association.panelIds.join(', ')})` : ' (whole Pane)'}`).join('\n')}`
        : 'Associated Panes: none',
      record.evidence.length > 0 ? `Evidence:\n${record.evidence.map(link => `- ${link.label}: ${link.url}`).join('\n')}` : '',
      record.outputs.length > 0 ? `Outputs:\n${record.outputs.map(link => `- ${link.label}: ${link.url}`).join('\n')}` : '',
      record.report ? `Latest report (${record.report.status}, ${record.report.provenance}): ${record.report.summary}` : '',
      'Keep the Session overview, evidence, decisions, blockers, next action, and output links current.',
    ];
    const prompt = lines.filter(Boolean).join('\n').slice(0, MAX_ORCHESTRATION_TEXT_LENGTH);
    return {
      initialCommand: RUNPANE_CONTRACT.agentTemplates[record.agent].command,
      initialInput: prompt,
      initialInputMode: 'argument',
      initialInputSubmitStrategy: 'enter',
      initialInputDeliveryVersion: ORCHESTRATION_BOOTSTRAP_VERSION,
      agentType: record.agent,
      orchestrationSessionId: record.id,
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
      cwd: getAppDirectory(),
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

function validateCreateInput(input: OrchestrationSessionCreateInput): void {
  if (!input.name || input.name.trim().length === 0) throw new Error('Session name is required');
  if (input.name.length > MAX_ORCHESTRATION_TEXT_LENGTH) throw new Error('Session name is too long');
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

function legacyPanelIdsForOwner(
  ownerId: string,
  ownerAgent: PaneChatAgent,
  importedAgents: ReadonlySet<PaneChatAgent>,
): PaneChatPanelIds {
  return {
    claude: ownerAgent === 'claude' || !importedAgents.has('claude')
      ? getPaneChatPanelId('claude')
      : getOrchestrationPanelId(ownerId, 'claude'),
    codex: ownerAgent === 'codex' || !importedAgents.has('codex')
      ? getPaneChatPanelId('codex')
      : getOrchestrationPanelId(ownerId, 'codex'),
    cursor: ownerAgent === 'cursor' || !importedAgents.has('cursor')
      ? getPaneChatPanelId('cursor')
      : getOrchestrationPanelId(ownerId, 'cursor'),
  };
}

function legacyAgentPanelIdsForOwner(ownerId: string, ownerAgent: PaneChatAgent): PaneChatPanelIds {
  return {
    claude: ownerAgent === 'claude' ? getPaneChatPanelId('claude') : getOrchestrationPanelId(ownerId, 'claude'),
    codex: ownerAgent === 'codex' ? getPaneChatPanelId('codex') : getOrchestrationPanelId(ownerId, 'codex'),
    cursor: ownerAgent === 'cursor' ? getPaneChatPanelId('cursor') : getOrchestrationPanelId(ownerId, 'cursor'),
  };
}

function samePanelIds(left: Record<PaneChatAgent, string>, right: Record<PaneChatAgent, string>): boolean {
  return PANE_CHAT_AGENTS.every(agent => left[agent] === right[agent]);
}

function panelHasLegacyHistory(panel: ToolPanel): boolean {
  // SAFETY: PanelManager returns the persisted ToolPanel boundary and legacy
  // terminal panels store their launch metadata in TerminalPanelState.
  const customState = panel.state.customState as TerminalPanelState | undefined;
  if (customState?.isInitialized === true
    || customState?.isCliReady === true
    || customState?.initialInputSentAt !== undefined
    || customState?.agentSessionId !== undefined) {
    return true;
  }
  const buffers = databaseService.getPanelBuffers(panel.id);
  return buffers !== null && [buffers.scrollback, buffers.serialized, buffers.alternate]
    .some(buffer => buffer !== null && buffer.length > 0);
}

function uniqueLegacyAgentName(
  baseName: string,
  agent: PaneChatAgent,
  sessions: OrchestrationSessionRecord[],
): string {
  const base = `${baseName} · ${PANE_CHAT_AGENT_LABELS[agent]}`;
  const existingNames = new Set(sessions.map(session => normalizeSessionName(session.name)));
  let candidate = base;
  let suffix = 2;
  while (existingNames.has(normalizeSessionName(candidate))) {
    candidate = `${base} ${suffix}`;
    suffix += 1;
  }
  return candidate;
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
