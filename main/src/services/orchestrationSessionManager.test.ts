import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
import { PaneChatManager } from './paneChatManager';
import type { SessionManager } from './sessionManager';
import { SkillCacheManager } from './skillCacheManager';
import type { Session } from '../types/session';
import type { ChatConversationExport } from '../../../shared/types/chatTab';
import type { ToolPanel, TerminalPanelState } from '../../../shared/types/panels';
import type { AgentState } from '../../../shared/types/agentStatus';
import { databaseService } from './database';
import { panelManager } from './panelManager';
import { setPaneRuntime, type PaneRuntime } from '../core/runtime';
import type {
  OrchestrationLink,
  OrchestrationSessionCreateInput,
  OrchestrationSessionRecord,
  OrchestrationSessionStoreData,
  OrchestrationSessionUpdateInput,
} from '../../../shared/types/orchestrationSession';
import { LEGACY_ORCHESTRATION_SESSION_ID } from '../../../shared/types/orchestrationSession';
import { getPaneChatPanelId, PANE_CHAT_SESSION_ID, type PaneChatAgent } from '../../../shared/types/paneChat';
import { OrchestrationSessionStore } from './orchestrationSessionStore';
import { terminalPanelManager, TerminalPanelManager } from './terminalPanelManager';
import { sessionWorkspacePath, prepareSessionWorkspace, writeSessionProfile } from './sessionWorkspace';
import { OrchestrationSessionManager } from './orchestrationSessionManager';
import { normalizeAgentReport } from './agentReport';
import { serializeJsonTransport } from '../daemon/jsonTransport';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { registerOrchestrationSessionHandlers } from '../ipc/orchestrationSessions';
import * as wslUtils from '../utils/wslUtils';
import { PaneError, toPaneDaemonError } from '../../../shared/paneError';
import { agentTerminalCommand } from '../../../shared/agents';

const liveStates = new Map<string, AgentState>();

const temporaryDirectories: string[] = [];


function createSession(
  id: string,
  name: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    name,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status: 'stopped',
    createdAt: new Date('2026-09-16T12:00:00.000Z'),
    lastActivity: new Date('2026-09-16T12:00:00.000Z'),
    output: [],
    jsonMessages: [],
    permissionMode: 'ignore',
    toolType: 'none',
    archived: false,
    isHidden: false,
    ...overrides,
  };
}

function createPanel(id: string, sessionId: string, title = 'Pane terminal'): ToolPanel {
  return {
    id,
    sessionId,
    type: 'terminal',
    title,
    state: {
      isActive: false,
      hasBeenViewed: true,
      customState: { agentType: 'claude', isInitialized: false },
    },
    metadata: {
      createdAt: '2026-09-16T12:00:00.000Z',
      lastActiveAt: '2026-09-16T12:00:00.000Z',
      position: 0,
    },
  };
}

function createLink(label: string, url = 'https://example.test/evidence'): OrchestrationLink {
  return {
    label,
    url,
    kind: 'evidence',
    provenance: 'test fixture',
    addedAt: '2026-09-16T12:00:00.000Z',
  };
}

function createStore(): OrchestrationSessionStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-orchestration-manager-'));
  temporaryDirectories.push(directory);
  return new OrchestrationSessionStore(path.join(directory, 'orchestration-sessions.json'));
}

function serviceStub<Service>(value: Partial<Service>): Service {
  // SAFETY: The fixture exposes exactly the service methods reached by the
  // manager in these tests; an unexpected method call fails at its own site.
  return value as Service;
}

function ensureDatabaseSession(session: Session): void {
  if (!databaseService.getSession(session.id)) {
    databaseService.createSession({
      id: session.id,
      name: session.name,
      initial_prompt: session.prompt,
      worktree_name: session.id,
      worktree_path: session.worktreePath,
      project_id: null,
      permission_mode: session.permissionMode,
      tool_type: session.toolType,
      is_hidden: session.isHidden,
    });
  }
  databaseService.getDb().prepare('UPDATE sessions SET archived = ?, is_hidden = ? WHERE id = ?')
    .run(session.archived ? 1 : 0, session.isHidden ? 1 : 0, session.id);
}

function createFixture(
  legacyAgent: PaneChatAgent = 'codex',
  initialData?: OrchestrationSessionStoreData,
  configuredAgent: PaneChatAgent = 'claude',
) {
  const sessions = new Map<string, Session>();
  const legacySession = createSession('__pane_chat_session__', 'Pane Chat', {
    output: ['prior conversation line'],
    jsonMessages: [{ type: 'assistant', text: 'prior conversation' }],
    isHidden: true,
  });
  sessions.set(legacySession.id, legacySession);
  ensureDatabaseSession(legacySession);

  const sessionManager = serviceStub<SessionManager>({
    emit: vi.fn(),
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    createSessionWithId: vi.fn((id: string, name: string, worktreePath: string, prompt: string): Session => {
      const session = createSession(id, name, { worktreePath, prompt, isHidden: true });
      sessions.set(id, session);
      ensureDatabaseSession(session);
      return session;
    }),
    updateSession: vi.fn((id: string, update: Partial<Session>) => {
      const session = sessions.get(id);
      if (!session) throw new Error(`Fixture session ${id} is missing`);
      Object.assign(session, update);
    }),
    getProjectContext: vi.fn(() => null),
    markSessionAsViewed: vi.fn((id: string) => {
      const session = sessions.get(id);
      if (session) session.lastViewedAt = '2026-11-25 09:30:00';
    }),
  });

  const configState = { defaultOrchestratorAgent: configuredAgent };
  const configManager = serviceStub<ConfigManager>({
    on: vi.fn(),
    getConfig: vi.fn(() => configState),
    updateConfig: vi.fn(async updates => {
      Object.assign(configState, updates);
      return configState;
    }),
  });
  const paneChatManager = serviceStub<PaneChatManager>({
    getOrCreate: vi.fn(async () => ({
      session: legacySession,
      panel: createPanel(getPaneChatPanelId(legacyAgent), legacySession.id, 'Pane Chat'),
      agent: legacyAgent,
      cwd: '/tmp/issue-653',
      guidePath: '/tmp/issue-653/guide.md',
      started: false,
    })),
  });
  const skillCacheManager = serviceStub<SkillCacheManager>({
    ensurePaneChatGuide: vi.fn(async () => '/tmp/issue-653/guide.md'),
    launchCommand: vi.fn((agent: PaneChatAgent) => agentTerminalCommand(agent)),
  });
  const store = createStore();
  if (initialData) store.write(initialData);
  const manager = new OrchestrationSessionManager(
    configManager,
    sessionManager,
    skillCacheManager,
    paneChatManager,
    undefined,
    store,
  );

  return { manager, sessions, sessionManager, paneChatManager, skillCacheManager, configManager, store };
}

function paneFixture(
  fixture: ReturnType<typeof createFixture>,
  id: string,
  overrides: Partial<Session> = {},
): Session {
  const pane = createSession(id, id, overrides);
  fixture.sessions.set(id, pane);
  ensureDatabaseSession(pane);
  return pane;
}

async function seedPanel(panel: ToolPanel): Promise<ToolPanel> {
  const existing = panelManager.getPanel(panel.id);
  if (existing) return existing;
  return panelManager.createPanel({
    id: panel.id,
    sessionId: panel.sessionId,
    type: panel.type,
    title: panel.title,
    activate: false,
    initialState: { customState: panel.state.customState },
    metadata: panel.metadata,
  });
}

async function seedLegacyPanel(agent: PaneChatAgent, agentSessionId: string): Promise<ToolPanel> {
  const panel = createPanel(getPaneChatPanelId(agent), PANE_CHAT_SESSION_ID, `Pane Chat · ${agent}`);
  panel.state.customState = {
    agentType: agent,
    agentSessionId,
    isInitialized: true,
    scrollbackBuffer: `${agent} historical terminal output`,
  };
  const existing = panelManager.getPanel(panel.id);
  if (existing) {
    if (existing.sessionId !== PANE_CHAT_SESSION_ID) {
      await panelManager.movePanel(existing.id, existing.sessionId, PANE_CHAT_SESSION_ID);
    }
    await panelManager.updatePanel(panel.id, { title: panel.title, state: panel.state });
    return panelManager.getPanel(panel.id) ?? existing;
  }
  return seedPanel(panel);
}

function orchestrationRecord(id: string, name: string): OrchestrationSessionRecord {
  const timestamp = '2026-09-16T12:00:00.000Z';
  return {
    id,
    name,
    agent: 'claude',
    internalSessionId: `${id}-terminal`,
    panelIds: {
      claude: `${id}-claude`,
      codex: `${id}-codex`,
      cursor: `${id}-cursor`,
      opencode: `${id}-opencode`,
      pi: `${id}-pi`,
    },
    goal: 'Existing goal',
    context: 'Existing context',
    decisions: ['Keep this record'],
    blockers: [],
    nextAction: 'Review existing context',
    evidence: [createLink('Existing evidence')],
    outputs: [createLink('Existing output')],
    associations: [],
    activity: [{
      id: `${id}-created`,
      kind: 'created',
      message: 'Created existing Session.',
      at: timestamp,
      source: 'user',
    }],
    report: {
      summary: 'Existing report',
      status: 'reported',
      evidence: [createLink('Report evidence')],
      reportedAt: timestamp,
      provenance: 'test fixture',
    },
    reportActivityId: `${id}-created`,
    reportAcceptedAt: timestamp,
    revision: 4,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  liveStates.clear();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('OrchestrationSessionManager', () => {
  it('opens a new Claude Session as a chat tab with its opening prompt when chat tabs are on (D-16)', async () => {
    const fixture = createFixture();
    const chatEnsure = vi.fn(async () => undefined);
    fixture.manager.attachChatTabs({ ensure: chatEnsure, isRunning: () => false, agentState: () => 'unknown' });
    Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: true });
    try {
      const created = await fixture.manager.create({ name: 'Chat orchestrator', agent: 'claude', openingPrompt: 'Pane sent this once, to start. Plan the work.' });
      expect(created.panel.type).toBe('chat');
      expect(created.panel.state.customState).toMatchObject({
        agent: 'claude', launch: { kind: 'agent', mode: 'bypassPermissions' }, orchestrationSessionId: created.session.id,
        initialInput: 'Pane sent this once, to start. Plan the work.',
      });
      expect(chatEnsure).toHaveBeenCalledWith(created.panel.id);
      const resumed = await fixture.manager.create({ name: 'Resumed stays a terminal', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' });
      expect(resumed.panel.type).toBe('terminal');
    } finally {
      Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: false });
    }
  });

  describe('through Agent Farm (T-63)', () => {
    let snapshots = 0;
    const agentFarm = (installed: string[] = ['pane', 'greenfield']) => ({
      pluginHash: vi.fn(async (plugin: string) => installed.includes(plugin) ? `hash-${plugin}` : undefined),
      // T-110: each snapshot is numbered; its plugins hash as the installed ones did when it was taken.
      snapshot: vi.fn(async (_folder: string) => ({ path: `.agent-farm/snapshots/d${++snapshots}`, digest: `d${snapshots}`, plugins: Object.fromEntries(installed.map(plugin => [plugin, '1.0.0'])) })),
      snapshotHashes: vi.fn(async (_folder: string): Promise<Record<string, string>> => Object.fromEntries(installed.map(plugin => [plugin, `receipt-${plugin}`]))),
      // The installed plugin's receipt-listed files, as a snapshot copies them (review r2).
      receiptHash: vi.fn(async (plugin: string) => installed.includes(plugin) ? `receipt-${plugin}` : undefined),
      profiles: vi.fn(async () => ({ profiles: [
        { ref: 'greenfield/orchestrator', plugin: 'greenfield', version: '0.0.46', harness: 'claude', hidden: false, defaultVariant: 'claude', variants: [{ name: 'claude', model: 'claude-opus-5-5' }, { name: 'codex', model: 'gpt-6-astra' }, { name: 'fast', model: 'claude-haiku-5-5' }] },
        { ref: 'greenfield/product-researcher', plugin: 'greenfield', version: '0.0.46', harness: 'codex', hidden: false },
      ] })),
      harness: vi.fn(async (ref: string) => (ref === 'greenfield/orchestrator:codex' ? 'codex' : ref === 'greenfield/orchestrator:fast' ? 'claude' : undefined)),
    });
    const withChatTabs = async (run: (fixture: ReturnType<typeof createFixture>, port: ReturnType<typeof agentFarm>) => Promise<void>, installed?: string[], profiles = true) => {
      const fixture = createFixture();
      const port = agentFarm(installed);
      fixture.manager.attachChatTabs({ ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' });
      fixture.manager.attachAgentFarm(port);
      Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: true, sessionProfilesEnabled: profiles });
      try { await run(fixture, port); }
      finally { Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: false, sessionProfilesEnabled: undefined }); }
    };
    const withProfilesOff = (run: (fixture: ReturnType<typeof createFixture>, port: ReturnType<typeof agentFarm>) => Promise<void>) => withChatTabs(run, undefined, false);

    // Settings › Advanced › Profiles off (T-63's flag): Sessions start their agent as main does.
    it('starts a new Session\'s agent directly with Profiles off, as main does', async () => withProfilesOff(async (fixture, port) => {
      const claude = await fixture.manager.create({ name: 'Plain Claude', agent: 'claude' });
      expect(claude.session.agentProfile).toBeUndefined();
      expect(claude.panel.state.customState).toMatchObject({ agent: 'claude', launch: { kind: 'agent', mode: 'bypassPermissions' } });
      // A launch command's own profile runs as it did on main, and nothing is recorded.
      const fromDialog = await fixture.manager.create({ name: 'From the dialog', agent: 'claude', launchCommand: 'agent-farm run greenfield/orchestrator --arg task=x' });
      expect(fromDialog.session.agentProfile).toBeUndefined();
      expect(fromDialog.panel.state.customState).toMatchObject({ launch: { kind: 'profile', profile: 'greenfield/orchestrator', args: { task: 'x' } } });
      expect(port.pluginHash).not.toHaveBeenCalled();
      expect(port.profiles).not.toHaveBeenCalled();
      // T-110: no snapshot, and no --snapshot for the lead.
      expect(port.snapshot).not.toHaveBeenCalled();
      expect(claude.session.agentFarmSnapshot).toBeUndefined();
      expect(JSON.stringify(fromDialog.panel.state.customState)).not.toContain('snapshot');
    }));

    // T-110 (D-4): every Profiles-on Session gets one snapshot, and its lead starts from it.
    it('saves a snapshot in a new Session\'s folder and starts its lead from it', async () => withChatTabs(async (fixture, port) => {
      const created = await fixture.manager.create({ name: 'Frozen', agentProfile: 'greenfield/orchestrator' });
      const folder = sessionWorkspacePath(created.session.id);
      expect(port.snapshot).toHaveBeenCalledWith(folder);
      const saved = created.session.agentFarmSnapshot;
      expect(saved).toMatch(/^\.agent-farm\/snapshots\/d\d+$/);
      expect(fixture.store.read().sessions.find(session => session.id === created.session.id)?.agentFarmSnapshot).toBe(saved);
      expect(created.panel.state.customState).toMatchObject({ launch: { kind: 'profile', profile: 'greenfield/orchestrator', snapshot: path.join(folder, ...String(saved).split('/')) } });
      // A Session whose agent keeps a terminal gets one too: its typed agent-farm commands share it.
      const terminal = await fixture.manager.create({ name: 'Terminal lead', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' });
      expect(terminal.panel.type).toBe('terminal');
      expect(terminal.session.agentFarmSnapshot).toMatch(/^\.agent-farm\/snapshots\//);
    }));

    it('still creates the Session when its snapshot can\'t be saved, and its lead starts as before', async () => withChatTabs(async (fixture, port) => {
      port.snapshot.mockRejectedValueOnce(new Error('disk full'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const created = await fixture.manager.create({ name: 'No snapshot', agentProfile: 'greenfield/orchestrator' });
        expect(created.session.agentFarmSnapshot).toBeUndefined();
        expect(JSON.stringify(created.panel.state.customState)).not.toContain('snapshot');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
        // Review F-2: the Session's own activity says it isn't pinned.
        expect(created.session.activity.at(-1)?.message).toContain('No Agent Farm snapshot');
        expect(created.session.activity.at(-1)?.message).toContain('until Reload profile');
        // QA r3: a terminal lead with no snapshot has nothing Reload can act on, so the line points elsewhere.
        port.snapshot.mockRejectedValueOnce(new Error('disk full'));
        const terminal = await fixture.manager.create({ name: 'Terminal, no snapshot', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' });
        expect(terminal.session.agentFarmSnapshot).toBeUndefined();
        expect(terminal.session.activity.at(-1)?.message).toContain('No Agent Farm snapshot');
        expect(terminal.session.activity.at(-1)?.message).not.toContain('Reload profile');
        expect(terminal.session.activity.at(-1)?.message).toContain('Start a new Session');
      } finally { warn.mockRestore(); }
    }));

    it('refuses a named profile with Profiles off, and creates nothing', async () => withProfilesOff(async fixture => {
      await expect(fixture.manager.create({ name: 'Named', agentProfile: 'greenfield/orchestrator' })).rejects.toMatchObject({ code: 'SESSION_PROFILE_UNSUPPORTED', next: expect.stringContaining('Settings > Advanced') });
      expect(fixture.store.read().sessions.map(session => session.name)).not.toContain('Named');
    }));

    it('starts a profile saved while Profiles was on without it once it is off, and drops it when the agent changes', async () => withChatTabs(async fixture => {
      const created = await fixture.manager.create({ name: 'Was on', agent: 'claude' });
      expect(created.session.agentProfile?.ref).toBe('pane/claude');
      const folder = sessionWorkspacePath(created.session.id);
      writeSessionProfile(folder, 'pane/claude', 'Profile pane/claude');
      Object.assign(fixture.configManager.getConfig(), { sessionProfilesEnabled: false });
      const second = await fixture.manager.create({ name: 'Made off', agent: 'codex' });
      expect(second.session.agentProfile).toBeUndefined();
      // A restart starts the Session's agent again, now without the profile's files.
      const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager, fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
      restarted.attachChatTabs({ ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' });
      restarted.attachAgentFarm(agentFarm());
      await restarted.initialize();
      await restarted.getView({ sessionId: created.session.id });
      expect(fs.existsSync(path.join(folder, 'PROFILE.md'))).toBe(false);
      expect(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8')).not.toContain('pane-session-profile');
      const updated = await restarted.update({ sessionId: created.session.id }, { agent: 'codex' });
      expect(updated.agentProfile).toBeUndefined();
    }));

    it('starts a new Session with no profile as the plain agent, pane/<agent>, keeping its full access', async () => withChatTabs(async fixture => {
      const claude = await fixture.manager.create({ name: 'Plain Claude', agent: 'claude' });
      expect(claude.session.agentProfile).toEqual({ ref: 'pane/claude', hash: 'hash-pane' });
      expect(claude.panel.state.customState).toMatchObject({ agent: 'claude', launch: { kind: 'profile', profile: 'pane/claude', fullAccess: true } });
      const codex = await fixture.manager.create({ name: 'Plain Codex', agent: 'codex', launchCommand: 'codex' });
      expect(codex.session.agentProfile?.ref).toBe('pane/codex');
      expect(codex.panel.state.customState).toMatchObject({ agent: 'codex', launch: { kind: 'profile', profile: 'pane/codex' } });
      expect(JSON.stringify(codex.panel.state.customState)).not.toContain('fullAccess');
      // Saved with the record, so it survives a restart.
      expect(fixture.store.read().sessions.find(session => session.id === claude.session.id)?.agentProfile).toEqual({ ref: 'pane/claude', hash: 'hash-pane' });
    }));

    it('records a launch command\'s own profile and keeps its launch', async () => withChatTabs(async fixture => {
      const created = await fixture.manager.create({ name: 'From the dialog', agent: 'claude', launchCommand: 'agent-farm run greenfield/orchestrator --arg task=x' });
      expect(created.session.agentProfile).toEqual({ ref: 'greenfield/orchestrator', hash: 'hash-greenfield' });
      expect(created.panel.state.customState).toMatchObject({ launch: { kind: 'profile', profile: 'greenfield/orchestrator', args: { task: 'x' } } });
      // A launch command's profile isn't Pane's choice, so it keeps running through Agent Farm with Profiles off (review F-2).
      expect(created.panel.state.customState).not.toHaveProperty('launch.fromSession');
    }));

    it('starts a named profile with the agent it runs, and refuses one this computer lacks', async () => withChatTabs(async fixture => {
      const created = await fixture.manager.create({ name: 'Researcher', agentProfile: 'greenfield/product-researcher' });
      expect(created.session).toMatchObject({ agent: 'codex', launchCommand: '', agentProfile: { ref: 'greenfield/product-researcher', hash: 'hash-greenfield' } });
      // Marked as Pane's choice, so the next start with Profiles off runs Codex directly (review F-2).
      expect(created.panel.state.customState).toMatchObject({ agent: 'codex', launch: { kind: 'profile', profile: 'greenfield/product-researcher', fromSession: true } });
      await expect(fixture.manager.create({ name: 'Unknown', agentProfile: 'team/missing' })).rejects.toMatchObject({ code: 'SESSION_PROFILE_UNKNOWN' });
      await expect(fixture.manager.create({ name: 'Resumed', agent: 'claude', agentProfile: 'pane/claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' })).rejects.toMatchObject({ code: 'SESSION_PROFILE_UNSUPPORTED' });
      expect(fixture.store.read().sessions.map(session => session.name)).not.toEqual(expect.arrayContaining(['Unknown']));
      expect(fixture.store.read().sessions.map(session => session.name)).not.toEqual(expect.arrayContaining(['Resumed']));
    }));

    it('starts the agent directly when Pane\'s plugin is missing, a Session keeps a terminal, or the agent has no plain profile', async () => withChatTabs(async fixture => {
      const missing = await fixture.manager.create({ name: 'No plugin', agent: 'claude' });
      expect(missing.session.agentProfile).toBeUndefined();
      expect(missing.panel.state.customState).toMatchObject({ launch: { kind: 'agent' } });
    }, []));

    it('leaves a Session from before T-63 starting its agent directly', async () => withChatTabs(async fixture => {
      fixture.manager.attachAgentFarm(agentFarm([]));
      const old = await fixture.manager.create({ name: 'Before', agent: 'claude' });
      expect(old.session.agentProfile).toBeUndefined();
      fixture.manager.attachAgentFarm(agentFarm());
      // Repaired at startup (its tab gone), it still starts the agent directly.
      await panelManager.deletePanel(old.panel.id);
      const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager, fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
      restarted.attachChatTabs({ ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' });
      restarted.attachAgentFarm(agentFarm());
      await restarted.initialize();
      const view = await restarted.getView({ sessionId: old.session.id });
      expect(view.session.agentProfile).toBeUndefined();
      expect(view.panel.state.customState).toMatchObject({ launch: { kind: 'agent' } });
    }));

    // QA F1, F2, review F-4: a variant must exist, and one that isn't the default runs the agent Agent Farm says it does.
    it('checks a named variant before creating anything', async () => withChatTabs(async fixture => {
      await expect(fixture.manager.create({ name: 'No such variant', agentProfile: 'greenfield/orchestrator:nope' })).rejects.toMatchObject({ code: 'SESSION_PROFILE_UNKNOWN', next: expect.stringContaining('claude, codex') });
      await expect(fixture.manager.create({ name: 'Plain variant', agentProfile: 'pane/claude:x' })).rejects.toMatchObject({ code: 'SESSION_PROFILE_UNKNOWN' });
      // The caller's agent must be the one the variant really runs; a mismatch saves nothing.
      await expect(fixture.manager.create({ name: 'Wrong agent', agent: 'claude', agentProfile: 'greenfield/orchestrator:codex' })).rejects.toMatchObject({ code: 'SESSION_PROFILE_AGENT_MISMATCH', next: expect.stringContaining('codex') });
      const codex = await fixture.manager.create({ name: 'Codex variant', agent: 'codex', agentProfile: 'greenfield/orchestrator:codex' });
      expect(codex.session).toMatchObject({ agent: 'codex', agentProfile: { ref: 'greenfield/orchestrator:codex' } });
      // Without an agent, the variant picks its own.
      const picked = await fixture.manager.create({ name: 'Variant picks', agentProfile: 'greenfield/orchestrator:codex' });
      expect(picked.session.agent).toBe('codex');
      const byDefault = await fixture.manager.create({ name: 'Default variant', agentProfile: 'greenfield/orchestrator:claude' });
      expect(byDefault.session.agent).toBe('claude');
      expect(fixture.store.read().sessions.map(session => session.name)).not.toEqual(expect.arrayContaining(['No such variant', 'Plain variant', 'Wrong agent']));
    }));

    // QA F3: a new launch command alone must not turn a named profile into the plain one.
    it('keeps a named profile when only the launch command changes', async () => withChatTabs(async fixture => {
      const created = await fixture.manager.create({ name: 'Orchestrator', agentProfile: 'greenfield/orchestrator' });
      const updated = await fixture.manager.update({ sessionId: created.session.id }, { launchCommand: 'claude --dangerously-skip-permissions' });
      expect(updated.agentProfile?.ref).toBe('greenfield/orchestrator');
      // Review F-2: a launch command that runs another agent drops the named profile for that agent's plain one.
      const other = await fixture.manager.create({ name: 'Becomes Codex', agentProfile: 'greenfield/orchestrator' });
      const codex = await fixture.manager.update({ sessionId: other.session.id }, { launchCommand: 'codex' });
      expect(codex).toMatchObject({ agent: 'codex', agentProfile: { ref: 'pane/codex' } });
      const moved = await fixture.manager.update({ sessionId: created.session.id }, { launchCommand: 'agent-farm run greenfield/product-researcher' });
      expect(moved.agentProfile?.ref).toBe('greenfield/product-researcher');
    }));

    it('moves a plain Session to the new agent\'s plain profile when its agent changes', async () => withChatTabs(async fixture => {
      const created = await fixture.manager.create({ name: 'Changes agent', agent: 'claude' });
      const updated = await fixture.manager.update({ sessionId: created.session.id }, { agent: 'codex' });
      expect(updated.agentProfile).toEqual({ ref: 'pane/codex', hash: 'hash-pane' });
    }));

    describe('Switch and Reload profile', () => {
      const chatTabs = () => {
        const port = {
          ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' as const,
          relaunch: vi.fn(), exportConversation: vi.fn((): ChatConversationExport => ({ transcript: '/sessions/s/transcripts/old.md' })), stop: vi.fn(async () => undefined), replying: vi.fn(() => false),
        };
        return port;
      };
      /** A switch as the menu sends it: what the person saw is the Session as it is now. */
      const switchTo = (fixture: ReturnType<typeof createFixture>, sessionId: string, ref: string, effect: 'kept' | 'new-conversation', agent?: 'claude' | 'codex') => {
        const record = fixture.store.read().sessions.find(session => session.id === sessionId);
        if (!record) throw new Error(`No Session ${sessionId}`);
        return fixture.manager.switchProfile({ sessionId }, { ref, agent, expect: { agent: record.agent, ref: record.agentProfile?.ref, effect } });
      };

      it('switches between Claude profiles at once, keeping the conversation, and back again for Undo', async () => withChatTabs(async fixture => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Planner', agent: 'claude' });
        const switched = await switchTo(fixture, created.session.id, 'greenfield/orchestrator', 'kept');
        expect(switched).toMatchObject({ effect: 'kept', previous: { agent: 'claude', ref: 'pane/claude' }, session: { agent: 'claude', agentProfile: { ref: 'greenfield/orchestrator', hash: 'hash-greenfield' } } });
        expect(port.relaunch).toHaveBeenCalledWith(created.panel.id, { launch: expect.objectContaining({ kind: 'profile', profile: 'greenfield/orchestrator' }), divider: 'Switched to Greenfield orchestrator · conversation kept' });
        expect(fixture.store.read().sessions.find(session => session.id === created.session.id)?.activity.at(-1)?.message).toBe('Switched to Greenfield orchestrator · conversation kept.');
        const undone = await switchTo(fixture, created.session.id, 'pane/claude', 'kept');
        expect(undone).toMatchObject({ effect: 'kept', session: { agentProfile: { ref: 'pane/claude' } } });
        // Already there: nothing restarts.
        port.relaunch.mockClear();
        expect((await switchTo(fixture, created.session.id, 'pane/claude', 'kept')).effect).toBe('current');
        expect(port.relaunch).not.toHaveBeenCalled();
      }));

      it('switches Claude to a Codex profile in the Session\'s Codex tab, a new conversation given the transcript (A-2)', async () => withChatTabs(async fixture => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Crosses agents', agent: 'claude' });
        // A reply in progress must end first: the other agent gets the transcript as it stands.
        port.replying.mockReturnValueOnce(true);
        await expect(switchTo(fixture, created.session.id, 'greenfield/product-researcher', 'new-conversation')).rejects.toMatchObject({ code: 'SESSION_PROFILE_BUSY' });
        expect(port.exportConversation).not.toHaveBeenCalled();
        const switched = await switchTo(fixture, created.session.id, 'greenfield/product-researcher', 'new-conversation');
        expect(switched).toMatchObject({ effect: 'new-conversation', session: { agent: 'codex', launchCommand: '', agentProfile: { ref: 'greenfield/product-researcher' } } });
        expect(port.exportConversation).toHaveBeenCalledWith(created.panel.id);
        const codexPanel = panelManager.getPanel(switched.session.panelIds.codex);
        expect(codexPanel?.type).toBe('chat');
        expect(codexPanel?.state.customState).toMatchObject({
          agent: 'codex', launch: { kind: 'profile', profile: 'greenfield/product-researcher' },
          initialInput: expect.stringContaining('saved in /sessions/s/transcripts/old.md'),
          // A leading divider names who writes from here on; no replies sit above it (T-63 round 5).
          dividers: [expect.objectContaining({ leading: true, text: 'Switched to Greenfield product-researcher · new Codex conversation, given the transcript', profile: 'greenfield/product-researcher' })],
        });
        expect(port.stop).toHaveBeenCalledWith(created.panel.id, expect.objectContaining({ message: expect.stringContaining('now runs Greenfield product-researcher') }));
        // Back to Claude: its tab exists, so it restarts on a new conversation given Codex's transcript.
        await switchTo(fixture, created.session.id, 'pane/claude', 'new-conversation');
        expect(port.relaunch).toHaveBeenLastCalledWith(created.panel.id, expect.objectContaining({ newConversation: { transcript: '/sessions/s/transcripts/old.md', reason: expect.stringContaining('can\'t continue a Codex conversation') } }));
      }));

      // Review F-1: the host starts a new conversation only when the person agreed to one, for the Session as they saw it.
      it('refuses a switch whose Session or effect changed since the person chose it, and changes nothing', async () => withChatTabs(async fixture => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Stale menu', agent: 'claude' });
        const id = created.session.id;
        const before = fixture.store.read().sessions.find(session => session.id === id);
        // A menu that said "conversation kept" for a switch that would start a new one.
        await expect(switchTo(fixture, id, 'greenfield/product-researcher', 'kept')).rejects.toMatchObject({ code: 'SESSION_PROFILE_CHANGED', message: expect.stringContaining('would now start a new conversation') });
        // A menu opened before the Session changed in another window.
        await expect(fixture.manager.switchProfile({ sessionId: id }, { ref: 'greenfield/orchestrator', expect: { agent: 'codex', ref: 'pane/codex', effect: 'kept' } })).rejects.toMatchObject({ code: 'SESSION_PROFILE_CHANGED' });
        expect(port.exportConversation).not.toHaveBeenCalled();
        expect(port.relaunch).not.toHaveBeenCalled();
        expect(fixture.store.read().sessions.find(session => session.id === id)).toEqual(before);
      }));

      // Review F-3: a new conversation is given the whole outgoing one, or the switch doesn't happen.
      it('refuses a switch whose outgoing conversation can\'t be saved, and says so when it was empty', async () => withChatTabs(async fixture => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Unsaved', agent: 'claude' });
        const id = created.session.id;
        port.exportConversation.mockImplementationOnce(() => { throw new PaneError('CHAT_TRANSCRIPT_UNAVAILABLE', 'its conversation hasn\'t been loaded since Pane started', 'Open the Session\'s tab, then switch again.'); });
        await expect(switchTo(fixture, id, 'greenfield/product-researcher', 'new-conversation')).rejects.toMatchObject({ code: 'SESSION_PROFILE_TRANSCRIPT', next: 'Open the Session\'s tab, then switch again.' });
        expect(fixture.store.read().sessions.find(session => session.id === id)).toMatchObject({ agent: 'claude', agentProfile: { ref: 'pane/claude' } });
        expect(panelManager.getPanel(fixture.store.read().sessions.find(session => session.id === id)?.panelIds.codex ?? '')).toBeUndefined();
        expect(port.stop).not.toHaveBeenCalled();
        // Nothing said yet: a new conversation with no transcript, and words that say so.
        port.exportConversation.mockImplementationOnce(() => ({}));
        const switched = await switchTo(fixture, id, 'greenfield/product-researcher', 'new-conversation');
        const codexPanel = panelManager.getPanel(switched.session.panelIds.codex);
        expect(codexPanel?.state.customState).toMatchObject({ dividers: [expect.objectContaining({ text: 'Switched to Greenfield product-researcher · new Codex conversation' })] });
        expect(codexPanel?.state.customState).not.toHaveProperty('initialInput');
        // Between Codex profiles a new conversation starts too, so a reply in progress must end first.
        port.replying.mockReturnValueOnce(true);
        await expect(switchTo(fixture, id, 'pane/codex', 'new-conversation')).rejects.toMatchObject({ code: 'SESSION_PROFILE_BUSY' });
      }));

      // Review F-2 and F-5: the switched launch replaces a launch command's own profile, marked as Pane's choice.
      it('switches a Session started from an Agent Farm launch command to the new profile, without the old one\'s args', async () => withChatTabs(async fixture => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'From the dialog', agent: 'claude', launchCommand: 'agent-farm run greenfield/orchestrator --arg task=x' });
        expect(created.session.agentProfile?.ref).toBe('greenfield/orchestrator');
        expect(created.panel.state.customState).toMatchObject({ launch: { kind: 'profile', profile: 'greenfield/orchestrator', args: { task: 'x' } } });
        const switched = await switchTo(fixture, created.session.id, 'pane/claude', 'kept');
        expect(switched.session.launchCommand).toBe('');
        expect(port.relaunch).toHaveBeenCalledWith(created.panel.id, expect.objectContaining({ launch: { kind: 'profile', profile: 'pane/claude', fromSession: true, fullAccess: true, snapshot: expect.stringContaining('snapshots') } }));
        // A Session that took a named profile is marked too, so Profiles off starts its agent on its own.
        const named = await fixture.manager.create({ name: 'Named', agentProfile: 'greenfield/orchestrator' });
        expect(named.panel.state.customState).toMatchObject({ launch: { kind: 'profile', profile: 'greenfield/orchestrator', fromSession: true } });
      }));

      // Review F-9: Undo names the agent the Session ran; the host reads a variant's own agent from Agent Farm (PR 2, review F-4).
      it('switches back to a non-default Claude variant', async () => withChatTabs(async fixture => {
        fixture.manager.attachChatTabs(chatTabs());
        const created = await fixture.manager.create({ name: 'Fast', agent: 'claude', agentProfile: 'greenfield/orchestrator:fast' });
        const switched = await switchTo(fixture, created.session.id, 'pane/claude', 'kept');
        expect(switched.previous).toEqual({ agent: 'claude', ref: 'greenfield/orchestrator:fast' });
        const undone = await switchTo(fixture, created.session.id, switched.previous.ref ?? '', 'kept', switched.previous.agent);
        expect(undone).toMatchObject({ effect: 'kept', session: { agent: 'claude', agentProfile: { ref: 'greenfield/orchestrator:fast' } } });
      }));

      it('marks a Session whose profile changed, and Reload takes the new files and clears the mark', async () => withChatTabs(async (fixture, farm) => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Reloads', agentProfile: 'greenfield/orchestrator' });
        farm.pluginHash.mockImplementation(async (plugin: string) => plugin === 'greenfield' ? 'hash-greenfield-2' : `hash-${plugin}`);
        // The Session has a snapshot (T-110), so its mark follows the installed receipt-listed files.
        farm.receiptHash.mockImplementation(async (plugin: string) => plugin === 'greenfield' ? 'receipt-greenfield-2' : `receipt-${plugin}`);
        await fixture.manager.refreshPluginHashes(true);
        const marked = (await fixture.manager.list()).sessions.find(session => session.id === created.session.id);
        expect(marked?.agentProfileChanged).toBe(true);
        const reloaded = await fixture.manager.reloadProfile({ sessionId: created.session.id });
        expect(reloaded.agentProfile).toEqual({ ref: 'greenfield/orchestrator', hash: 'hash-greenfield-2' });
        expect(reloaded.agentProfileChanged).toBeUndefined();
        expect(port.relaunch).toHaveBeenCalledWith(created.panel.id, { launch: expect.objectContaining({ profile: 'greenfield/orchestrator' }), divider: 'Reloaded Greenfield orchestrator · conversation kept' });
      }));

      // T-110: the dot compares every plugin in the Session's snapshot with the installed one; Reload takes a new snapshot.
      it('marks a Session when any plugin in its snapshot changed, and Reload restarts the lead on a new snapshot', async () => withChatTabs(async (fixture, farm) => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Snapshotted', agentProfile: 'greenfield/orchestrator' });
        const first = created.session.agentFarmSnapshot;
        const folder = sessionWorkspacePath(created.session.id);
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileChanged).toBeUndefined();
        // Review r2: a file the receipt doesn't list (a cache, .DS_Store) changes the folder's hash but not what a snapshot holds.
        farm.pluginHash.mockImplementation(async (plugin: string) => `cluttered-${plugin}`);
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileChanged).toBeUndefined();
        // Only pane changed, not the profile's own plugin: workers may run any plugin, so it shows.
        farm.receiptHash.mockImplementation(async (plugin: string) => plugin === 'pane' ? 'receipt-pane-2' : `receipt-${plugin}`);
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileChanged).toBe(true);
        expect(farm.snapshotHashes).toHaveBeenCalledWith(path.join(folder, ...String(first).split('/')));
        farm.snapshotHashes.mockImplementation(async () => ({ greenfield: 'receipt-greenfield', pane: 'receipt-pane-2' }));
        const reloaded = await fixture.manager.reloadProfile({ sessionId: created.session.id });
        expect(reloaded.agentFarmSnapshot).not.toBe(first);
        expect(reloaded.agentProfileChanged).toBeUndefined();
        expect(port.relaunch).toHaveBeenCalledWith(created.panel.id, expect.objectContaining({ launch: expect.objectContaining({ snapshot: path.join(folder, ...String(reloaded.agentFarmSnapshot).split('/')) }) }));
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileChanged).toBeUndefined();
      }));

      // QA F1: with the sidebar idle nothing lists Sessions, so the host re-checks on its own every 10 s.
      it('lights the dot on its own within one 10 s check while nothing lists Sessions', async () => withChatTabs(async (fixture, farm) => {
        fixture.manager.attachChatTabs(chatTabs());
        const created = await fixture.manager.create({ name: 'Watched', agentProfile: 'greenfield/orchestrator' });
        await fixture.manager.refreshPluginHashes(true);
        const changed = vi.fn();
        fixture.manager.on('changed', changed);
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        try {
          fixture.manager.watchProfileChanges();
          farm.receiptHash.mockImplementation(async (plugin: string) => plugin === 'greenfield' ? 'receipt-greenfield-2' : `receipt-${plugin}`);
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: created.session.id, kind: 'updated' })));
          fixture.manager.stopWatchingProfileChanges();
        } finally {
          fixture.manager.stopWatchingProfileChanges();
          vi.useRealTimers();
        }
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileChanged).toBe(true);
      }));

      // Review F-1 (D-9): a terminal lead keeps its snapshot; Reload re-snapshots it without relaunching the lead.
      it('reloads a terminal-lead Session\'s snapshot without relaunching its lead, so tabs opened afterwards get it', async () => withChatTabs(async (fixture, farm) => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Terminal lead', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' });
        expect(created.panel.type).toBe('terminal');
        expect(created.session.agentProfile).toBeUndefined();
        const first = created.session.agentFarmSnapshot;
        farm.receiptHash.mockImplementation(async (plugin: string) => `receipt-${plugin}-2`);
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileChanged).toBe(true);
        farm.snapshotHashes.mockImplementation(async () => ({ pane: 'receipt-pane-2', greenfield: 'receipt-greenfield-2' }));
        const reloaded = await fixture.manager.reloadProfile({ sessionId: created.session.id });
        expect(reloaded.agentFarmSnapshot).not.toBe(first);
        expect(reloaded.agentProfileChanged).toBeUndefined();
        expect(port.relaunch).not.toHaveBeenCalled();
        expect(reloaded.activity.at(-1)?.message).toContain('tabs opened from now on');
        // #1762 F-6: the lead tab is permanent, so the activity never says to close it.
        expect(reloaded.activity.at(-1)?.message).not.toMatch(/close/i);
        expect(reloaded.activity.at(-1)?.message).toContain('start a new Session');
        expect(fixture.store.read().sessions.find(session => session.id === created.session.id)?.agentFarmSnapshot).toBe(reloaded.agentFarmSnapshot);
      }));

      // Review F-3: a Reload or Switch refused for a cheap reason takes no snapshot.
      it('takes no snapshot for a Reload or Switch it refuses before changing anything', async () => withChatTabs(async (fixture, farm) => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const terminal = await fixture.manager.create({ name: 'Terminal lead', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' });
        const chat = await fixture.manager.create({ name: 'Chat lead', agentProfile: 'greenfield/product-researcher' });
        const taken = () => farm.snapshot.mock.calls.length;
        let before = taken();
        await expect(switchTo(fixture, terminal.session.id, 'pane/claude', 'kept')).rejects.toMatchObject({ code: 'SESSION_PROFILE_TERMINAL' });
        expect(taken()).toBe(before);
        expect((await switchTo(fixture, chat.session.id, 'greenfield/product-researcher', 'kept')).effect).toBe('current');
        expect(taken()).toBe(before);
        farm.profiles.mockResolvedValue({ profiles: [{ ref: 'greenfield/orchestrator', plugin: 'greenfield', version: '0.1.0', harness: 'claude', hidden: false }], linked: [] });
        before = taken();
        await expect(fixture.manager.reloadProfile({ sessionId: chat.session.id })).rejects.toMatchObject({ code: 'SESSION_PROFILE_GONE' });
        expect(taken()).toBe(before);
        // A Session with neither a profile nor a snapshot (from before both) has nothing to reload.
        fixture.store.write({ ...fixture.store.read(), sessions: fixture.store.read().sessions.map(session => session.id === terminal.session.id ? { ...session, agentFarmSnapshot: undefined } : session) });
        await expect(fixture.manager.reloadProfile({ sessionId: terminal.session.id })).rejects.toMatchObject({ code: 'SESSION_PROFILE_NONE' });
        expect(taken()).toBe(before);
        expect(port.relaunch).not.toHaveBeenCalled();
      }));

      // Review F-5: a Switch whose new snapshot fails changes nothing.
      it('switches nothing when the new snapshot can\'t be saved', async () => withChatTabs(async (fixture, farm) => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Keeps its profile', agent: 'claude' });
        farm.snapshot.mockRejectedValueOnce(new PaneError('AGENT_FARM_SNAPSHOT_FAILED', 'Agent Farm couldn\'t save the Session\'s snapshot: disk full.', 'Restart Pane.'));
        await expect(switchTo(fixture, created.session.id, 'greenfield/orchestrator', 'kept')).rejects.toMatchObject({ code: 'AGENT_FARM_SNAPSHOT_FAILED', message: expect.stringContaining('The Session was not switched.') });
        expect(port.relaunch).not.toHaveBeenCalled();
        expect(fixture.store.read().sessions.find(session => session.id === created.session.id)).toMatchObject({ agentProfile: { ref: 'pane/claude' }, agentFarmSnapshot: created.session.agentFarmSnapshot });
      }));

      // Review F-4: the 10 s check reads only what the mark needs.
      it('makes the 10 s check skip the profile list and the whole-folder hash of plugins only snapshotted Sessions use', async () => withChatTabs(async (fixture, farm) => {
        fixture.manager.attachChatTabs(chatTabs());
        await fixture.manager.create({ name: 'Snapshotted', agentProfile: 'greenfield/orchestrator' });
        await fixture.manager.refreshPluginHashes(true);
        farm.profiles.mockClear();
        farm.pluginHash.mockClear();
        farm.receiptHash.mockClear();
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        try {
          fixture.manager.watchProfileChanges();
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() => expect(farm.receiptHash).toHaveBeenCalled());
        } finally {
          fixture.manager.stopWatchingProfileChanges();
          vi.useRealTimers();
        }
        expect(farm.profiles).not.toHaveBeenCalled();
        expect(farm.pluginHash).not.toHaveBeenCalled();
      }));

      // Review r2 N-1: with the 10 s check running, listing Sessions still refreshes the gone mark, both ways.
      it('keeps the gone mark current from listing while the 10 s check runs', async () => withChatTabs(async (fixture, farm) => {
        fixture.manager.attachChatTabs(chatTabs());
        const created = await fixture.manager.create({ name: 'Goes and comes back', agentProfile: 'greenfield/product-researcher' });
        const listed = { profiles: [{ ref: 'greenfield/product-researcher', plugin: 'greenfield', version: '0.1.0', harness: 'codex', hidden: false }], linked: [] };
        const removed = { profiles: [{ ref: 'greenfield/orchestrator', plugin: 'greenfield', version: '0.1.0', harness: 'claude', hidden: false }], linked: [] };
        farm.profiles.mockResolvedValue(listed);
        const gone = async () => (await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileGone;
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        try {
          fixture.manager.watchProfileChanges();
          await vi.advanceTimersByTimeAsync(10_000);
          farm.profiles.mockResolvedValue(removed);
          await vi.advanceTimersByTimeAsync(10_000);
          await fixture.manager.list();
          await vi.waitFor(async () => expect(await gone()).toBe(true));
          farm.profiles.mockResolvedValue(listed);
          await vi.advanceTimersByTimeAsync(10_000);
          await fixture.manager.list();
          await vi.waitFor(async () => expect(await gone()).toBeUndefined());
        } finally {
          fixture.manager.stopWatchingProfileChanges();
          vi.useRealTimers();
        }
      }));

      // Review r2 F-3: a chat lead's Reload with Chat tabs off is refused before it writes a snapshot.
      it('refuses a chat lead\'s Reload with Chat tabs off before taking a snapshot', async () => withChatTabs(async (fixture, farm) => {
        fixture.manager.attachChatTabs(chatTabs());
        const created = await fixture.manager.create({ name: 'Chat lead', agentProfile: 'greenfield/orchestrator' });
        Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: false });
        const before = farm.snapshot.mock.calls.length;
        await expect(fixture.manager.reloadProfile({ sessionId: created.session.id })).rejects.toMatchObject({ code: 'SESSION_PROFILE_UNSUPPORTED' });
        expect(farm.snapshot.mock.calls.length).toBe(before);
      }));

      // Review r2 N-5: a chat lead whose profile update() dropped is told the truth.
      it('tells a chat lead that lost its profile to switch, not that it started before profiles', async () => withChatTabs(async fixture => {
        fixture.manager.attachChatTabs(chatTabs());
        const created = await fixture.manager.create({ name: 'Lost its profile', agent: 'claude' });
        fixture.store.write({ ...fixture.store.read(), sessions: fixture.store.read().sessions.map(session => session.id === created.session.id ? { ...session, agentProfile: undefined } : session) });
        const refusal = fixture.manager.reloadProfile({ sessionId: created.session.id });
        await expect(refusal).rejects.toMatchObject({ code: 'SESSION_PROFILE_NONE', next: expect.stringContaining('Switch profile') });
        await expect(refusal).rejects.not.toMatchObject({ message: expect.stringContaining('started before') });
      }));

      // Review r2 N-3: with no snapshot, the mark shows only for a chat lead, where Reload can act.
      it('shows no changed mark for a terminal lead with a profile and no snapshot', async () => withChatTabs(async (fixture, farm) => {
        fixture.manager.attachChatTabs(chatTabs());
        const created = await fixture.manager.create({ name: 'Old terminal lead', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' });
        fixture.store.write({ ...fixture.store.read(), sessions: fixture.store.read().sessions.map(session => session.id === created.session.id ? { ...session, agentProfile: { ref: 'pane/claude', hash: 'hash-pane' }, agentFarmSnapshot: undefined } : session) });
        farm.pluginHash.mockImplementation(async (plugin: string) => `changed-${plugin}`);
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileChanged).toBeUndefined();
      }));

      it('reloads nothing when the new snapshot can\'t be saved', async () => withChatTabs(async (fixture, farm) => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Keeps its snapshot', agentProfile: 'greenfield/orchestrator' });
        farm.snapshot.mockRejectedValueOnce(new PaneError('AGENT_FARM_SNAPSHOT_FAILED', 'Agent Farm couldn\'t save the Session\'s snapshot: disk full.', 'Restart Pane.'));
        await expect(fixture.manager.reloadProfile({ sessionId: created.session.id })).rejects.toMatchObject({ code: 'AGENT_FARM_SNAPSHOT_FAILED', message: expect.stringContaining('Nothing was reloaded.') });
        expect(port.relaunch).not.toHaveBeenCalled();
        expect(fixture.store.read().sessions.find(session => session.id === created.session.id)?.agentFarmSnapshot).toBe(created.session.agentFarmSnapshot);
      }));

      it('takes a new snapshot when the Session switches profile, so a plugin installed since is in it', async () => withChatTabs(async (fixture, farm) => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Switches', agent: 'claude' });
        const calls = farm.snapshot.mock.calls.length;
        const switched = await switchTo(fixture, created.session.id, 'greenfield/orchestrator', 'kept');
        expect(farm.snapshot.mock.calls.length).toBe(calls + 1);
        expect(switched.session.agentFarmSnapshot).not.toBe(created.session.agentFarmSnapshot);
        expect(port.relaunch).toHaveBeenCalledWith(created.panel.id, expect.objectContaining({ launch: expect.objectContaining({ snapshot: expect.stringContaining(String(switched.session.agentFarmSnapshot).split('/').pop()) }) }));
      }));

      // T-83 P3: greenfield 0.1.0 removed most profiles; a Session that ran one asks the person to pick again.
      it('marks a Session whose profile Agent Farm no longer lists, and Reload asks to pick a profile again', async () => withChatTabs(async (fixture, farm) => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Ran a removed profile', agentProfile: 'greenfield/product-researcher' });
        // QA rerun: Pane's first start lists nothing from greenfield until it installs it; that proves nothing.
        farm.profiles.mockResolvedValue({ profiles: [{ ref: 'pane/claude', plugin: 'pane', version: '1.0.0', harness: 'claude', hidden: true }], linked: [] });
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileGone).toBeUndefined();
        // QA finding 2: an agent a profile links to (a Session started from a launch link's command) isn't gone.
        farm.profiles.mockResolvedValue({ profiles: [{ ref: 'greenfield/orchestrator', plugin: 'greenfield', version: '0.1.0', harness: 'claude', hidden: false }], linked: ['greenfield/product-researcher'] });
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileGone).toBeUndefined();
        farm.profiles.mockResolvedValue({ profiles: [{ ref: 'greenfield/orchestrator', plugin: 'greenfield', version: '0.1.0', harness: 'claude', hidden: false }], linked: ['greenfield/planner'] });
        await fixture.manager.refreshPluginHashes(true);
        const marked = (await fixture.manager.list()).sessions.find(session => session.id === created.session.id);
        expect(marked).toMatchObject({ agentProfileGone: true });
        expect(marked?.agentProfileChanged).toBeUndefined();
        await expect(fixture.manager.reloadProfile({ sessionId: created.session.id })).rejects.toMatchObject({ code: 'SESSION_PROFILE_GONE', next: expect.stringContaining('Switch profile') });
        expect(port.relaunch).not.toHaveBeenCalled();
        // A list Pane couldn't read changes nothing; picking a listed profile clears the mark.
        farm.profiles.mockResolvedValue({ profiles: [], error: 'Pane couldn\'t list its Agent Farm profiles.' });
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileGone).toBe(true);
        const switched = await switchTo(fixture, created.session.id, 'pane/codex', 'new-conversation');
        expect(switched.session.agentProfileGone).toBeUndefined();
      }));

      // Review F-6: the plugin keeps the profile but drops the Session's variant.
      it('marks a Session whose saved variant its profile no longer has, and Reload asks to pick again', async () => withChatTabs(async (fixture, farm) => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        const created = await fixture.manager.create({ name: 'Ran codex', agentProfile: 'greenfield/orchestrator:codex', agent: 'codex' });
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileGone).toBeUndefined();
        farm.profiles.mockResolvedValue({ profiles: [{ ref: 'greenfield/orchestrator', plugin: 'greenfield', version: '0.1.0', harness: 'claude', hidden: false, defaultVariant: 'claude', variants: [{ name: 'claude', model: 'claude-opus-5-5' }] }] });
        await fixture.manager.refreshPluginHashes(true);
        expect((await fixture.manager.list()).sessions.find(session => session.id === created.session.id)?.agentProfileGone).toBe(true);
        await expect(fixture.manager.reloadProfile({ sessionId: created.session.id })).rejects.toMatchObject({ code: 'SESSION_PROFILE_GONE' });
        expect(port.relaunch).not.toHaveBeenCalled();
      }));

      it('with Profiles off, refuses Switch and Reload, reads no plugin and shows no changed mark, as on main', async () => withChatTabs(async (fixture, farm) => {
        const port = chatTabs();
        fixture.manager.attachChatTabs(port);
        // A Session that took a profile while Profiles was on, then the switch goes off.
        const created = await fixture.manager.create({ name: 'Was profiled', agentProfile: 'greenfield/orchestrator' });
        Object.assign(fixture.configManager.getConfig(), { sessionProfilesEnabled: false });
        farm.pluginHash.mockClear();
        farm.pluginHash.mockImplementation(async (plugin: string) => `changed-${plugin}`);
        await fixture.manager.refreshPluginHashes(true);
        const listed = (await fixture.manager.list()).sessions.find(session => session.id === created.session.id);
        expect(listed?.agentProfileChanged).toBeUndefined();
        expect(farm.pluginHash).not.toHaveBeenCalled();
        await expect(switchTo(fixture, created.session.id, 'pane/claude', 'kept')).rejects.toMatchObject({ code: 'SESSION_PROFILE_UNSUPPORTED', message: expect.stringContaining('Profiles is off') });
        await expect(fixture.manager.reloadProfile({ sessionId: created.session.id })).rejects.toMatchObject({ code: 'SESSION_PROFILE_UNSUPPORTED' });
        expect(port.relaunch).not.toHaveBeenCalled();
        expect(fixture.store.read().sessions.find(session => session.id === created.session.id)?.agentProfile?.ref).toBe('greenfield/orchestrator');
      }));

      it('refuses a Session with no profile to reload, and one whose agent runs in a terminal', async () => withChatTabs(async fixture => {
        fixture.manager.attachChatTabs(chatTabs());
        const legacy = await fixture.manager.create({ name: 'Before profiles', agent: 'claude' });
        // A Session from before T-63 has no profile.
        fixture.store.write({ ...fixture.store.read(), sessions: fixture.store.read().sessions.map(session => session.id === legacy.session.id ? { ...session, agentProfile: undefined } : session) });
        await expect(fixture.manager.reloadProfile({ sessionId: legacy.session.id })).rejects.toMatchObject({ code: 'SESSION_PROFILE_NONE' });
        // J14: switching it gives it a profile and keeps its conversation.
        expect((await switchTo(fixture, legacy.session.id, 'greenfield/orchestrator', 'kept')).effect).toBe('kept');
        const terminal = await fixture.manager.create({ name: 'Terminal', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' });
        expect(terminal.panel.type).toBe('terminal');
        await expect(switchTo(fixture, terminal.session.id, 'greenfield/orchestrator', 'kept')).rejects.toMatchObject({ code: 'SESSION_PROFILE_TERMINAL' });
        await expect(switchTo(fixture, terminal.session.id, 'team/missing', 'kept')).rejects.toMatchObject({ code: 'SESSION_PROFILE_UNKNOWN', message: expect.stringContaining('The Session was not switched.') });
      }));
    });
  });

  it('starts a Session created by a phone app too old for chat tabs in a terminal (D-203)', async () => {
    const fixture = createFixture();
    fixture.manager.attachChatTabs({ ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' });
    Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: true });
    const registry = new PaneCommandRegistry();
    // SAFETY: The handlers only call ipcMain.handle; the create channel reads only orchestrationSessionManager.
    registerOrchestrationSessionHandlers({ handle: () => undefined } as never, { orchestrationSessionManager: fixture.manager } as never, registry);
    const panelType = async (args: PaneCommandValue[]) => decodeBoundary(
      await registry.invoke('orchestration-sessions:create', args),
      boundary.object({ data: boundary.object({ panel: boundary.object({ type: boundary.string }) }) }),
    ).data.panel.type;
    try {
      // Apps released before chat tabs send no options, and crash on a tab kind they do not know.
      expect(await panelType([{ name: 'From an old phone', agent: 'claude' }])).toBe('terminal');
      expect(await panelType([{ name: 'From a current client', agent: 'claude' }, { chatTabs: true }])).toBe('chat');
    } finally {
      Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: false });
    }
  });

  // D-185: every real Agent Farm Session carries the dialog's standard resume template.
  it('opens an Agent Farm Session as a chat, whatever the standard resume template says', async () => {
    const fixture = createFixture();
    const chatEnsure = vi.fn(async () => undefined);
    fixture.manager.attachChatTabs({ ensure: chatEnsure, isRunning: () => false, agentState: () => 'unknown' });
    Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: true });
    try {
      const created = await fixture.manager.create({
        name: 'Agent Farm Session', agent: 'claude', launchCommand: 'agent-farm run greenfield/orchestrator',
        customResume: { mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} --resume {sessionId}' },
      });
      expect(created.panel.type).toBe('chat');
      expect(created.panel.state.customState).toMatchObject({ agent: 'claude', launch: { kind: 'profile', profile: 'greenfield/orchestrator' }, orchestrationSessionId: created.session.id });
      expect(chatEnsure).toHaveBeenCalledWith(created.panel.id);
      expect((await fixture.manager.overview({ sessionId: created.session.id })).terminalReason).toBeUndefined();
    } finally {
      Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: false });
    }
  });

  it('leaves a chat orchestrator\'s state alone when Pane restarts', async () => {
    const fixture = createFixture();
    fixture.manager.attachChatTabs({ ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' });
    Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: true });
    try {
      const created = await fixture.manager.create({ name: 'Survives restart', agent: 'claude', launchCommand: 'agent-farm run greenfield/orchestrator', customResume: { mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} --resume {sessionId}' } });
      const before = structuredClone(panelManager.getPanel(created.panel.id)?.state.customState);
      const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager, fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
      restarted.attachChatTabs({ ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' });
      await restarted.initialize();
      expect(panelManager.getPanel(created.panel.id)?.type).toBe('chat');
      expect(panelManager.getPanel(created.panel.id)?.state.customState).toEqual(before);
    } finally {
      Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: false });
    }
  });

  it('keeps a truly custom resume or a wrapper in a terminal, and the overview says why', async () => {
    const fixture = createFixture();
    fixture.manager.attachChatTabs({ ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' });
    Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: true });
    try {
      const custom = await fixture.manager.create({
        name: 'Custom resume', agent: 'claude', launchCommand: 'agent-farm run greenfield/orchestrator',
        customResume: { mode: 'reported', initialTemplate: '{command}', resumeTemplate: 'resume-it {sessionId}' },
      });
      expect(custom.panel.type).toBe('terminal');
      expect((await fixture.manager.overview({ sessionId: custom.session.id })).terminalReason).toContain('custom resume command');
      const wrapper = await fixture.manager.create({ name: 'Wrapper', agent: 'claude', launchCommand: 'my-wrapper claude' });
      expect(wrapper.panel.type).toBe('terminal');
      expect((await fixture.manager.overview({ sessionId: wrapper.session.id })).terminalReason).toContain('my-wrapper claude');
    } finally {
      Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: false });
    }
    // With chat tabs off, a terminal needs no explaining.
    const off = await fixture.manager.create({ name: 'Chat tabs off', agent: 'claude', launchCommand: 'my-wrapper claude' });
    expect((await fixture.manager.overview({ sessionId: off.session.id })).terminalReason).toBeUndefined();
  });

  // Cursor runs no Session on Windows, so there is nothing to check there.
  it.skipIf(process.platform === 'win32')('opens a Cursor Session orchestrator as a chat tab when chat tabs are on', async () => {
    const fixture = createFixture();
    fixture.manager.attachChatTabs({ ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' });
    Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: true });
    try {
      const cursor = await fixture.manager.create({ name: 'Cursor as a chat', agent: 'cursor' });
      expect(cursor.panel.type).toBe('chat');
    } finally {
      Object.assign(fixture.configManager.getConfig(), { chatTabsEnabled: false });
    }
  });

  it('hands a Session to the chat tab its terminal orchestrator switched to (D-129)', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Switched orchestrator', agent: 'claude' });
    expect(created.panel.metadata.permanent).toBe(true);
    const chat = await panelManager.createPanel({ sessionId: created.internalSession.id, type: 'chat', title: created.panel.title, initialState: { customState: { agent: 'claude', launch: { kind: 'agent' }, cwd: created.cwd, status: 'starting' } }, activate: false });
    fixture.manager.attachChatTabs({ ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' });

    await fixture.manager.adoptAgentPanel(created.panel.id, chat.id);

    const view = await fixture.manager.getView({ sessionId: created.session.id });
    expect(view.panel.id).toBe(chat.id);
    expect(view.panel.metadata.permanent).toBe(true);
    expect(panelManager.getPanel(created.panel.id)?.metadata.permanent).toBe(false);
    await fixture.manager.adoptAgentPanel('some-other-tab', 'another-chat');
    expect((await fixture.manager.getView({ sessionId: created.session.id })).panel.id).toBe(chat.id);
  });

  describe('when handing a Session to its chat fails part way (D-129, review F-8)', () => {
    const prepare = async () => {
      const fixture = createFixture();
      const created = await fixture.manager.create({ name: 'Half switched', agent: 'claude', launchCommand: 'agent-farm run greenfield/orchestrator --arg docs=grain' });
      const chat = await panelManager.createPanel({ sessionId: created.internalSession.id, type: 'chat', title: created.panel.title, initialState: { customState: { agent: 'claude', launch: { kind: 'agent' }, cwd: created.cwd, status: 'starting' } }, activate: false });
      fixture.manager.attachChatTabs({ ensure: vi.fn(async () => undefined), isRunning: () => false, agentState: () => 'unknown' });
      const owner = async () => (await fixture.manager.getView({ sessionId: created.session.id })).panel.id;
      return { fixture, created, chat, owner };
    };
    afterEach(() => { vi.restoreAllMocks(); });

    it('reads the Session\'s saved launch', async () => {
      const { fixture, created } = await prepare();
      expect(fixture.manager.agentLaunchCommand(created.panel.id)).toBe('agent-farm run greenfield/orchestrator --arg docs=grain');
    });

    it('confirms the terminal still owns the Session when the chat cannot be made permanent and is released', async () => {
      const { fixture, created, chat, owner } = await prepare();
      vi.spyOn(panelManager, 'updatePanel').mockRejectedValueOnce(new Error('disk full'));
      await expect(fixture.manager.adoptAgentPanel(created.panel.id, chat.id)).resolves.toEqual({ owner: 'terminal', chatReleased: true, reason: 'disk full' });
      expect(await owner()).toBe(created.panel.id);
      expect(panelManager.getPanel(created.panel.id)?.metadata.permanent).toBe(true);
      expect(panelManager.getPanel(chat.id)?.metadata.permanent).toBeFalsy();
    });

    it('treats a silently refused metadata write as a failure', async () => {
      const { fixture, created, chat, owner } = await prepare();
      vi.spyOn(panelManager, 'updatePanel').mockResolvedValueOnce(undefined);
      await expect(fixture.manager.adoptAgentPanel(created.panel.id, chat.id)).resolves.toMatchObject({ owner: 'terminal', chatReleased: true });
      expect(await owner()).toBe(created.panel.id);
    });

    it('withholds Switch back when both the metadata write and its compensation fail, and the Session never names the chat', async () => {
      const { fixture, created, chat, owner } = await prepare();
      vi.spyOn(panelManager, 'updatePanel').mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce(new Error('still full'));
      await expect(fixture.manager.adoptAgentPanel(created.panel.id, chat.id)).resolves.toMatchObject({ owner: 'terminal', chatReleased: false, reason: expect.stringContaining('disk full') });
      expect(await owner()).toBe(created.panel.id);
      expect(panelManager.getPanel(created.panel.id)?.metadata.permanent).toBe(true);
    });

    it('keeps the chat protected when the record cannot be saved and the chat cannot be released', async () => {
      const { fixture, created, chat, owner } = await prepare();
      vi.spyOn(fixture.store, 'write').mockImplementationOnce(() => { throw new Error('store is read-only'); });
      const real = panelManager.updatePanel.bind(panelManager);
      let writes = 0;
      vi.spyOn(panelManager, 'updatePanel').mockImplementation(async (id, updates) => {
        writes += 1;
        if (writes === 2) throw new Error('still full');
        await real(id, updates);
      });
      await expect(fixture.manager.adoptAgentPanel(created.panel.id, chat.id)).resolves.toMatchObject({ owner: 'terminal', chatReleased: false, reason: expect.stringContaining('store is read-only') });
      expect(await owner()).toBe(created.panel.id);
      expect(panelManager.getPanel(chat.id)?.metadata.permanent).toBe(true);
    });

    it('releases the chat when only the record could not be saved', async () => {
      const { fixture, created, chat, owner } = await prepare();
      vi.spyOn(fixture.store, 'write').mockImplementationOnce(() => { throw new Error('store is read-only'); });
      await expect(fixture.manager.adoptAgentPanel(created.panel.id, chat.id)).resolves.toMatchObject({ owner: 'terminal', chatReleased: true });
      expect(await owner()).toBe(created.panel.id);
      expect(panelManager.getPanel(chat.id)?.metadata.permanent).toBeFalsy();
    });

    it('the chat owns the Session once the record is saved, even if the terminal keeps its permanent mark', async () => {
      const { fixture, created, chat, owner } = await prepare();
      const real = panelManager.updatePanel.bind(panelManager);
      vi.spyOn(panelManager, 'updatePanel').mockImplementation(async (id, updates) => {
        if (id === created.panel.id) throw new Error('terminal row locked');
        await real(id, updates);
      });
      await expect(fixture.manager.adoptAgentPanel(created.panel.id, chat.id)).resolves.toEqual({ owner: 'chat' });
      vi.restoreAllMocks();
      expect(await owner()).toBe(chat.id);
      expect(panelManager.getPanel(chat.id)?.metadata.permanent).toBe(true);
    });
  });

  it('keeps Session orchestrators in terminals while chat tabs are off', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Terminal orchestrator', agent: 'claude' });
    expect(created.panel.type).toBe('terminal');
  });

  it('opens a Session view as a client-local read that asks no client to move', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Quiet open' });
    const send = vi.fn();
    setPaneRuntime(partialRuntime({ eventSink: { send } }));

    const view = await fixture.manager.getView({ sessionId: created.session.id });

    expect(databaseService.getActivePanel(view.internalSession.id)?.id).toBe(view.panel.id);
    expect(send.mock.calls.filter(([channel]) => channel === 'panel:activeChanged')).toEqual([]);
    setPaneRuntime(partialRuntime({ eventSink: { send: () => undefined } }));
  });

  it('creates a Session whose agent tab resumes a native conversation when it opens', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Moved here', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' });
    expect(created.panel.state.customState).toMatchObject({
      agentType: 'claude', agentSessionId: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35', hasClaudeSessionId: true,
    });
    await expect(fixture.manager.create({ name: 'Bad id', agent: 'codex', resume: 'not an id; rm -rf' }))
      .rejects.toThrow('Session resume must be a native session id');
  });

  it('marks a to-do\'s Session in its first write, so the first changed event already reads as the to-do\'s (T-7)', async () => {
    const fixture = createFixture();
    await fixture.manager.initialize();
    const writes: OrchestrationSessionStoreData[] = [];
    const write = fixture.store.write.bind(fixture.store);
    vi.spyOn(fixture.store, 'write').mockImplementation(next => { writes.push(next); write(next); });
    const atChange: Array<number | undefined> = [];
    fixture.manager.on('changed', (event: { sessionId: string }) => {
      atChange.push(fixture.store.read().sessions.find(session => session.id === event.sessionId)?.todoNumber);
    });
    const created = await fixture.manager.create({ name: 'T-26 · Invoice PDFs', todoNumber: 26 });
    expect(writes[0]?.sessions.find(session => session.id === created.session.id)?.todoNumber).toBe(26);
    expect(created.session.todoNumber).toBe(26);
    expect(atChange[0]).toBe(26);
    // It survives a restart (a fresh store reads the file), and a Session made without one has none.
    const storePath = path.join(temporaryDirectories[temporaryDirectories.length - 1], 'orchestration-sessions.json');
    const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
      fixture.skillCacheManager, fixture.paneChatManager, undefined, new OrchestrationSessionStore(storePath));
    expect((await restarted.list()).sessions.find(session => session.id === created.session.id)?.todoNumber).toBe(26);
    expect((await fixture.manager.create({ name: 'Plain' })).session.todoNumber).toBeUndefined();
    await expect(fixture.manager.create({ name: 'Bad number', todoNumber: 0 })).rejects.toThrow('to-do number');
  });

  it('marks a to-do\'s Session made before Sessions carried the number, once, at startup (T-7)', async () => {
    const fixture = createFixture();
    const older = await fixture.manager.create({ name: 'T-26 · Add animation for moving' });
    const plain = await fixture.manager.create({ name: 'Plain' });
    const changed: string[] = [];
    fixture.manager.on('changed', (event: { sessionId: string }) => { changed.push(event.sessionId); });
    await fixture.manager.markTodoSessions([{ sessionId: older.session.id, todoNumber: 26 }, { sessionId: 'gone', todoNumber: 3 }]);
    const sessions = (await fixture.manager.list()).sessions;
    expect(sessions.find(session => session.id === older.session.id)?.todoNumber).toBe(26);
    expect(sessions.find(session => session.id === plain.session.id)?.todoNumber).toBeUndefined();
    expect(changed).toEqual([older.session.id]);
    // Already marked: nothing is written or announced again.
    await fixture.manager.markTodoSessions([{ sessionId: older.session.id, todoNumber: 26 }]);
    expect(changed).toEqual([older.session.id]);
  });

  it('saves the resumed conversation with the Session, so a tab created after an interrupted create still resumes it', async () => {
    const fixture = createFixture();
    const id = '0e5c1b2a-7d3f-4a69-9b84-3c2d1e0f9a87';
    // The durable record is written, then the tab can't be created (the app exits, or a write fails).
    vi.spyOn(panelManager, 'createPanel').mockRejectedValueOnce(new Error('interrupted'));
    await expect(fixture.manager.create({ name: 'Moved mid-create', agent: 'codex', resume: id })).rejects.toThrow('was saved but could not be opened');
    const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
      fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    const [saved] = (await restarted.list()).sessions.filter(session => session.name === 'Moved mid-create');
    expect(saved.resume).toBe(id);
    // Startup repair creates the missing tab from the record: with the conversation, not a fresh one.
    const repaired = await restarted.getView({ sessionId: saved.id });
    expect(repaired.panel.state.customState).toMatchObject({ agentType: 'codex', agentSessionId: id });
    expect(repaired.panel.state.customState?.initialInput).toBeUndefined();
  });

  it('repairs a resumed Session\'s tab without replacing a conversation the tab has moved on to', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Moved on', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' });
    // The tab lost its id (a crash before it was saved), so repair fills it in from the record.
    await panelManager.updatePanel(created.panel.id, { state: { ...created.panel.state, customState: { ...created.panel.state.customState, agentSessionId: undefined } } });
    const filled = await fixture.manager.getView({ sessionId: created.session.id });
    expect(filled.panel.state.customState?.agentSessionId).toBe('5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35');
    // Later the conversation moved on (Claude /clear); repair keeps the tab's own id.
    await panelManager.updatePanel(created.panel.id, { state: { ...filled.panel.state, customState: { ...filled.panel.state.customState, agentSessionId: '9a9a9a9a-0000-4000-8000-000000000000' } } });
    const kept = await fixture.manager.getView({ sessionId: created.session.id });
    expect(kept.panel.state.customState?.agentSessionId).toBe('9a9a9a9a-0000-4000-8000-000000000000');
  });

  it('drops the resumed conversation when the Session changes agent', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Switching', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35' });
    const updated = await fixture.manager.update({ sessionId: created.session.id }, { agent: 'codex' });
    expect(updated.resume).toBeUndefined();
  });

  it('sends a Session\'s opening prompt as its first message, even from a tab repaired before launch, and only once', async () => {
    const fixture = createFixture();
    const openingPrompt = 'Pane sent this once, to introduce Pane Chat. Suggest two tasks.';
    vi.spyOn(panelManager, 'createPanel').mockRejectedValueOnce(new Error('interrupted'));
    await expect(fixture.manager.create({ name: 'Intro', agent: 'claude', openingPrompt })).rejects.toThrow('was saved but could not be opened');
    const restart = () => new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
      fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);

    const repairedManager = restart();
    const [saved] = (await repairedManager.list()).sessions.filter(session => session.name === 'Intro');
    const repaired = await repairedManager.getView({ sessionId: saved.id });
    expect(repaired.panel.state.customState).toMatchObject({ initialInput: openingPrompt, initialInputMode: 'argument' });

    // The terminal launch passes it to the agent and marks it sent.
    await panelManager.updatePanel(repaired.panel.id, { state: { ...repaired.panel.state, customState: {
      ...repaired.panel.state.customState, initialInputSentAt: '2026-10-26T12:00:00.000Z', hasClaudeSessionId: true,
    } } });
    const relaunched = await restart().getView({ sessionId: saved.id });
    expect(relaunched.panel.state.customState?.initialInput).toBeUndefined();
    expect(relaunched.session.openingPrompt).toBeUndefined();

    // A later rebuild that loses the terminal's sent marker still sends nothing.
    await panelManager.updatePanel(relaunched.panel.id, { state: { ...relaunched.panel.state, customState: {
      ...relaunched.panel.state.customState, initialInputSentAt: undefined,
    } } });
    expect((await restart().getView({ sessionId: saved.id })).panel.state.customState?.initialInput).toBeUndefined();
  });

  it('does not send the opening prompt again to another agent after one agent sent it', async () => {
    const fixture = createFixture();
    const openingPrompt = 'Pane sent this once, to introduce Pane Chat. Suggest two tasks.';
    const created = await fixture.manager.create({ name: 'Switch after intro', agent: 'claude', openingPrompt });
    await panelManager.updatePanel(created.panel.id, { state: { ...created.panel.state, customState: {
      ...created.panel.state.customState, initialInputSentAt: '2026-10-26T12:00:00.000Z', hasClaudeSessionId: true,
    } } });

    const switched = await fixture.manager.setAgent({ sessionId: created.session.id }, 'codex');

    expect(switched.agent).toBe('codex');
    expect(switched.panel.state.customState?.initialInput).toBeUndefined();
    expect(switched.session.openingPrompt).toBeUndefined();
  });

  it('refuses an opening prompt for a resumed conversation or one that does not say Pane sends it once', async () => {
    const fixture = createFixture();
    await expect(fixture.manager.create({ name: 'Resumed', agent: 'claude', resume: '5d0c7a1e-2b9f-4e3a-8c61-0f7d2e4b9a35', openingPrompt: 'Pane sent this once, hello' }))
      .rejects.toThrow('A resumed conversation cannot take an opening prompt');
    await expect(fixture.manager.create({ name: 'Unmarked', openingPrompt: 'Run the tests' }))
      .rejects.toThrow('must begin with "Pane sent this once"');
  });

  it('keeps the newest activity entries up to the configured retention', async () => {
    const fixture = createFixture();
    Object.assign(fixture.configManager.getConfig(), { retention: { sessionActivity: 2 } });
    const created = await fixture.manager.create({ name: 'Busy' });
    const selector = { sessionId: created.session.id };
    for (const goal of ['one', 'two', 'three']) await fixture.manager.update(selector, { goal });

    const { activity } = await fixture.manager.get(selector);
    expect(activity).toHaveLength(2);
    expect(activity.every(entry => entry.kind === 'updated')).toBe(true);
  });

  describe('the Session list (T-127)', () => {
    async function busySession() {
      const fixture = createFixture();
      const created = await fixture.manager.create({ name: 'Busy', profile: 'Answer in French.' });
      const selector = { sessionId: created.session.id };
      for (const goal of ['one', 'two']) await fixture.manager.update(selector, { goal });
      return { fixture, selector };
    }

    it('leaves out each Session\'s activity log and profile when a reader asks for the summary', async () => {
      const { fixture, selector } = await busySession();

      const { sessions, selectedSessionId } = await fixture.manager.list({ summary: true });

      const listed = sessions.find(session => session.id === selector.sessionId);
      expect(listed).toMatchObject({ name: 'Busy', goal: 'two', revision: expect.any(Number) });
      expect(listed).not.toHaveProperty('activity');
      expect(listed).not.toHaveProperty('profile');
      expect(selectedSessionId).toBe(selector.sessionId);
    });

    it('still gives full records to a reader that does not ask for the summary', async () => {
      const { fixture, selector } = await busySession();

      const listed = (await fixture.manager.list()).sessions.find(session => session.id === selector.sessionId);

      expect(listed?.profile).toBe('Answer in French.');
      expect(listed?.activity.length).toBeGreaterThanOrEqual(3);
      expect((await fixture.manager.get(selector)).profile).toBe('Answer in French.');
    });

    it('answers a select with the summary list when asked, and with full records otherwise', async () => {
      const { fixture, selector } = await busySession();

      const summary = (await fixture.manager.select(selector, { summary: true })).sessions.find(session => session.id === selector.sessionId);
      const full = (await fixture.manager.select(selector)).sessions.find(session => session.id === selector.sessionId);

      expect(summary).not.toHaveProperty('activity');
      expect(summary).not.toHaveProperty('profile');
      expect(full?.profile).toBe('Answer in French.');
      expect(full?.activity.length).toBeGreaterThanOrEqual(3);
    });

    it('never changes the saved record when it leaves fields out of the summary', async () => {
      const { fixture, selector } = await busySession();

      await fixture.manager.list({ summary: true });

      const saved = await fixture.manager.get(selector);
      expect(saved.profile).toBe('Answer in French.');
      expect(saved.activity.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('creates a pinned Session and persists declarative pin updates', async () => {
    const fixture = createFixture();
    const input = { name: 'Pinned coordinator', isPinned: true };
    const created = await fixture.manager.create(input);
    const selector = { sessionId: created.session.id };
    expect((await fixture.manager.get(selector)).isPinned).toBe(true);
    await fixture.manager.update(selector, { isPinned: false });
    expect((await fixture.manager.get(selector)).isPinned).toBe(false);
    await fixture.manager.update(selector, { isPinned: true });
    await fixture.manager.update(selector, { isPinned: true });
    expect((await fixture.manager.get(selector)).isPinned).toBe(true);
  });

  it('reopens WSL Sessions with Linux paths, native commands, and durable distro choice', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(wslUtils, 'validateWSLAvailable').mockResolvedValue(null);
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'WSL planning', agent: 'cursor', runtime: 'wsl', wslDistribution: 'Ubuntu' });
    const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
      fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    const reopened = await restarted.getView({ sessionId: created.session.id });
    expect(reopened.agent).toBe('cursor');
    expect(reopened.session).toMatchObject({ runtime: 'wsl', wslDistribution: 'Ubuntu' });
    expect(reopened.panel.state.customState).toMatchObject({
      orchestrationWorkspace: wslUtils.windowsPathToWSLMount(sessionWorkspacePath(created.session.id)),
      initialCommand: agentTerminalCommand('cursor'),
    });
    const workspace = sessionWorkspacePath(created.session.id);
    expect(fs.readFileSync(path.join(workspace, 'runtime-context.md'), 'utf8')).toContain('powershell.exe');
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain('WSL RunPane Routing');
    await expect(fixture.manager.create({ name: 'Missing distro', runtime: 'wsl' })).rejects.toThrow('distribution');
  });
  it('points migrated Pane Chat file tools at its private Session directory', async () => {
    const fixture = createFixture();
    const view = await fixture.manager.getView({ sessionId: LEGACY_ORCHESTRATION_SESSION_ID });
    expect(view.internalSession.worktreePath).toBe(view.cwd);
    expect(databaseService.getSession(view.internalSession.id)?.worktree_path).toBe(view.cwd);
  });

  it('promotes a saved conversation without moving project files or losing panel identity', async () => {
    const fixture = createFixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-promote-worktree-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'unfinished.txt'), 'Uncommitted user work');
    const pane = paneFixture(fixture, 'promote-child', { worktreePath: directory, isFavorite: true });
    const source = createPanel('promote-chat', pane.id);
    source.state.customState = { agentType: 'codex', agentSessionId: 'saved-conversation', initialCommand: 'codex --yolo --model example', scrollbackBuffer: 'Existing conversation' };
    await seedPanel(source);
    const moved = await fixture.manager.create({ name: 'Promoted chat' }, source.id);
    expect(moved.panel.id).toBe(source.id);
    expect(moved.panel.sessionId).toBe(moved.session.internalSessionId);
    expect(moved.panel.state.customState).toMatchObject({ agentSessionId: 'saved-conversation', initialCommand: 'codex --yolo --model example' });
    expect(databaseService.getPanelBuffers(source.id)?.scrollback).toBe('Existing conversation');
    expect(panelManager.getPanelsForSession(pane.id)).toHaveLength(0);
    expect(moved.session.associations[0].paneId).toBe(pane.id);
    expect(pane.isFavorite).toBe(false);
    expect(fs.readFileSync(path.join(directory, 'unfinished.txt'), 'utf8')).toBe('Uncommitted user work');
    expect(fs.readdirSync(directory)).toEqual(['unfinished.txt']);
    await expect(fixture.manager.create({ name: 'Duplicate move' }, source.id)).rejects.toThrow('active worktree');
  });

  it('leaves chats in place when resume information is unavailable or stopping fails', async () => {
    const fixture = createFixture();
    const pane = paneFixture(fixture, 'promotion-failure');
    const source = createPanel('promotion-failure-chat', pane.id);
    await seedPanel(source);
    await expect(fixture.manager.create({ name: 'No history' }, source.id)).rejects.toThrow('conversation ID');
    await panelManager.updatePanel(source.id, { state: { ...source.state, customState: { agentType: 'codex', agentSessionId: 'saved', initialCommand: 'codex --yolo' } } });
    vi.spyOn(terminalPanelManager, 'stopForPromotion').mockRejectedValue(new Error('Agent is busy'));
    await expect(fixture.manager.create({ name: 'Busy chat' }, source.id)).rejects.toThrow('Agent is busy');
    expect(panelManager.getPanel(source.id)?.sessionId).toBe(pane.id);
    expect((await fixture.manager.list()).sessions.some(item => item.name === 'Busy chat')).toBe(false);
  });

  it('recovers promotion after the durable record is saved but panel transfer fails', async () => {
    const fixture = createFixture();
    const pane = paneFixture(fixture, 'promotion-recovery');
    const source = createPanel('promotion-recovery-chat', pane.id);
    source.state.customState = { agentType: 'codex', agentSessionId: 'saved', initialCommand: 'codex --yolo' };
    await seedPanel(source);
    const move = vi.spyOn(panelManager, 'movePanel').mockRejectedValueOnce(new Error('Transfer failed'));
    await expect(fixture.manager.create({ name: 'Recoverable chat' }, source.id)).rejects.toThrow('saved but could not be opened');
    expect(panelManager.getPanel(source.id)?.sessionId).toBe(pane.id);
    const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager, fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    await restarted.initialize();
    const view = await restarted.getView({ name: 'Recoverable chat' });
    expect(move).toHaveBeenCalledTimes(2);
    expect(view.panel.id).toBe(source.id);
    expect(view.panel.sessionId).toBe(view.session.internalSessionId);
  });

  it('keeps opening other Sessions when one cannot be restored on startup', async () => {
    const fixture = createFixture();
    const healthy = await fixture.manager.create({ name: 'Healthy' });
    const broken = await fixture.manager.create({ name: 'Broken' });
    const data = fixture.store.read();
    fixture.store.write({ ...data, sessions: data.sessions.map(record => record.id === broken.session.id
      ? { ...record, promotedFrom: { paneId: 'gone-pane', panelId: 'gone-chat' } }
      : record) });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager, fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    await restarted.initialize();

    const view = await restarted.getView({ sessionId: healthy.session.id });
    expect(view.panel.id).toBe(healthy.panel.id);
    const failed = fixture.store.read().sessions.find(record => record.id === broken.session.id);
    expect(failed?.activity.at(-1)?.message).toBe('Session could not be restored: Promoted chat is missing; refusing to replace its history');
  });

  it('keeps opening other Sessions when one Session owner cannot be prepared', async () => {
    const fixture = createFixture();
    const healthy = await fixture.manager.create({ name: 'Healthy owner' });
    const broken = await fixture.manager.create({ name: 'Edited instructions' });
    const instructions = path.join(broken.cwd, 'AGENTS.md');
    fs.writeFileSync(instructions, fs.readFileSync(instructions, 'utf8').replace('<!-- pane-session-context:end -->', ''));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager, fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    await restarted.initialize();

    expect((await restarted.getView({ sessionId: healthy.session.id })).panel.id).toBe(healthy.panel.id);
    expect(fixture.store.read().sessions.find(record => record.id === broken.session.id)?.activity.at(-1)?.message)
      .toMatch(/^Session could not be restored: Session instruction file .*AGENTS\.md: Pane's markers in it don't pair up/);
  });

  it('keeps an inactive agent conversation across restart when the active agent has custom resume', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Two agents', agent: 'codex' });
    await panelManager.updatePanel(created.panel.id, { state: { ...created.panel.state, customState: {
      ...created.panel.state.customState, agentSessionId: 'codex-thread',
    } } });
    await fixture.manager.update({ sessionId: created.session.id }, {
      agent: 'claude', launchCommand: 'my-launcher run',
      customResume: { mode: 'claude', initialTemplate: '{command} -- --session-id {sessionId}', resumeTemplate: '{command} -- --resume {sessionId}' },
    });

    const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager, fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    await restarted.initialize();
    const codex = await restarted.setAgent({ sessionId: created.session.id }, 'codex');

    expect(codex.panel.id).toBe(created.panel.id);
    expect(codex.panel.state.customState).toMatchObject({ agentSessionId: 'codex-thread' });
    expect(codex.panel.state.customState?.customResume).toBeFalsy();
  });

  it.each([
    'claude --append-system-prompt "$(cat rules.md)"',
    'claude --model opus # pinned for this Session',
  ])('keeps resume and prompt hooks for an existing Claude Session launched with %s', async (launchCommand) => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Claude with a custom command', agent: 'claude', launchCommand });
    // Not preserved: the terminal still adds Claude's session flags and prompt hooks to this command.
    expect(created.panel.state.customState).toMatchObject({ agentType: 'claude', initialCommand: launchCommand, preserveLaunchCommand: false });
  });

  it('lets the terminal add Pi\'s session flag so a Pi Session reopens its conversation', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Pi orchestrator', agent: 'pi' });
    expect(created.panel.state.customState).toMatchObject({ agentType: 'pi', preserveLaunchCommand: false });
    const wrapped = await fixture.manager.create({ name: 'Pi wrapped', agent: 'pi', launchCommand: 'bash -lc pi' });
    expect(wrapped.panel.state.customState).toMatchObject({ preserveLaunchCommand: true });
  });

  it('uses the requested agent over a default command for another agent and rejects a conflicting command', async () => {
    const fixture = createFixture();
    Object.assign(fixture.configManager.getConfig(), { defaultSessionCommand: 'claude --model default' });
    const created = await fixture.manager.create({ name: 'Codex requested', agent: 'codex' });
    expect(created.session).toMatchObject({ agent: 'codex', launchCommand: '' });
    await expect(fixture.manager.create({ name: 'Mismatch', agent: 'codex', launchCommand: 'claude --model x' }))
      .rejects.toThrow('The launch command runs claude, but the Session agent is codex');
  });

  it.each([
    'opencode --auto', '"/opt/agent tools/opencode" --auto',
    'PANE_TEST_FLAG=value opencode --auto', 'env PANE_TEST_FLAG=value opencode --auto',
  ])('routes direct OpenCode Session commands: %s', async launchCommand => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Native OpenCode', launchCommand });
    expect(created.session.agent).toBe('opencode');
    expect(created.panel.state.customState).toMatchObject({
      agentType: 'opencode', initialCommand: launchCommand, preserveLaunchCommand: false,
      orchestrationSessionId: created.session.id,
    });
    expect(created.panel.state.customState?.initialInput).toBeUndefined();
    expect(created.panel.state.customState?.agentSessionId).toBeUndefined();
    expect(created.panel.id).toBe(`__orchestration_panel_${created.session.id}_opencode`);
  });

  it.each([
    { defaultSessionCommand: 'my-launcher run' },
    { defaultSessionResume: { mode: 'reported' as const, initialTemplate: '{command}', resumeTemplate: '{command} --resume {sessionId}' } },
    { defaultSessionResume: { mode: 'generated' as const, initialTemplate: '{command} {sessionId}', resumeTemplate: '{command} {sessionId}' } },
  ])('creates an explicit OpenCode Session when the app default does not suit OpenCode: %j', async defaults => {
    const fixture = createFixture();
    Object.assign(fixture.configManager.getConfig(), defaults);
    const created = await fixture.manager.create({ name: 'OpenCode despite defaults', agent: 'opencode' });
    expect(created.session).toMatchObject({ agent: 'opencode', launchCommand: '' });
    expect(created.session.customResume ?? null).toBeNull();
    expect(created.panel.state.customState).toMatchObject({ agentType: 'opencode', initialCommand: 'opencode --auto' });
  });

  it('accepts native OpenCode through default commands, default agents and updates', async () => {
    const fixture = createFixture();
    Object.assign(fixture.configManager.getConfig(), { defaultSessionCommand: 'opencode --auto' });
    expect((await fixture.manager.create({ name: 'OpenCode default command' })).agent).toBe('opencode');

    Object.assign(fixture.configManager.getConfig(), { defaultSessionCommand: '', defaultOrchestratorAgent: 'opencode' });
    const created = await fixture.manager.create({ name: 'OpenCode default agent' });
    expect(created.panel.state.customState).toMatchObject({ agentType: 'opencode', preserveLaunchCommand: false });
    const changed = await fixture.manager.create({ name: 'OpenCode update', agent: 'claude' });
    await fixture.manager.update({ sessionId: changed.session.id }, { launchCommand: 'opencode --auto' });
    expect((await fixture.manager.getView({ sessionId: changed.session.id })).panel.state.customState)
      .toMatchObject({ agentType: 'opencode', preserveLaunchCommand: false });
  });

  it.each([
    { agent: 'opencode' as const, launchCommand: 'opencode "unterminated', reason: 'OpenCode launch command has an unmatched quote' },
    { agent: 'opencode' as const, launchCommand: 'opencode --auto', customResume: { mode: 'generated' as const, initialTemplate: '{command} {sessionId}', resumeTemplate: '{command} {sessionId}' }, reason: 'OpenCode Sessions cannot use custom resume settings' },
    { agent: 'claude' as const, launchCommand: 'opencode --auto', reason: 'The launch command runs opencode, but the Session agent is claude; change one to match' },
  ])('reports actionable OpenCode Session refusals before provisioning: $reason', async ({ agent, launchCommand, customResume, reason }) => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Safe baseline', agent: 'claude' });
    const before = fixture.store.read();
    const createPanelSpy = vi.spyOn(panelManager, 'createPanel');
    const updatePanelSpy = vi.spyOn(panelManager, 'updatePanel');
    const initializeTerminal = vi.spyOn(terminalPanelManager, 'initializeTerminal');
    for (const operation of [
      () => fixture.manager.create({ name: 'Refused OpenCode', agent, launchCommand, customResume }),
      () => fixture.manager.update({ sessionId: created.session.id }, { agent, launchCommand, customResume }),
    ]) {
      const failure = await operation().catch(error => error);
      expect(failure).toBeInstanceOf(PaneError);
      expect(toPaneDaemonError(failure, 'ERR_INTERNAL')).toMatchObject({
        code: 'ERR_SESSION_OPENCODE_LAUNCH',
        message: expect.stringContaining(reason),
        next: expect.stringContaining('opencode --auto'),
      });
      expect(failure.message).toContain('No OpenCode terminal launch was started');
    }
    expect(fixture.store.read()).toEqual(before);
    expect(createPanelSpy).not.toHaveBeenCalled();
    expect(updatePanelSpy).not.toHaveBeenCalled();
    expect(initializeTerminal).not.toHaveBeenCalled();
  });

  it.each(['my-launcher run', 'bash -lc "opencode --auto"', 'env -i opencode --auto', 'command opencode --auto'])(
    'rejects incompatible OpenCode Session wrappers before provisioning: %s', async launchCommand => {
      const fixture = createFixture();
      const created = await fixture.manager.create({ name: 'Safe baseline', agent: 'claude' });
      const before = fixture.store.read();
      const createPanelSpy = vi.spyOn(panelManager, 'createPanel');
      await expect(fixture.manager.create({ name: 'Unsafe OpenCode', agent: 'opencode', launchCommand })).rejects.toThrow(/OpenCode.*wrapper/i);
      await expect(fixture.manager.update({ sessionId: created.session.id }, { agent: 'opencode', launchCommand })).rejects.toThrow(/OpenCode.*wrapper/i);
      expect(fixture.store.read()).toEqual(before);
      expect(createPanelSpy).not.toHaveBeenCalled();
    });

  it.each(['claude', 'generated', 'reported'] as const)('rejects effective inherited and explicit OpenCode resume settings: %s', async mode => {
    const fixture = createFixture();
    const customResume = { mode, initialTemplate: '{command} {sessionId}', resumeTemplate: '{command} {sessionId}' };
    Object.assign(fixture.configManager.getConfig(), { defaultSessionCommand: 'opencode --auto', defaultSessionResume: customResume });
    await expect(fixture.manager.create({ name: 'Inherited resume' })).rejects.toThrow(/OpenCode.*custom resume/i);
    Object.assign(fixture.configManager.getConfig(), { defaultSessionCommand: '', defaultOrchestratorAgent: 'opencode' });
    await expect(fixture.manager.create({ name: 'Inherited default-agent resume' })).rejects.toThrow(/OpenCode.*custom resume/i);
    await expect(fixture.manager.create({ name: 'Explicit resume', agent: 'opencode', customResume })).rejects.toThrow(/OpenCode.*custom resume/i);
    Object.assign(fixture.configManager.getConfig(), { defaultSessionResume: null });
    const created = await fixture.manager.create({ name: 'Native without resume', agent: 'opencode' });
    const before = fixture.store.read();
    await expect(fixture.manager.update({ sessionId: created.session.id }, { customResume })).rejects.toThrow(/OpenCode.*custom resume/i);
    expect(fixture.store.read()).toEqual(before);
  });

  it('does not let a custom resume agent mask an existing OpenCode default command on update', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'OpenCode implicit command', agent: 'opencode' });
    const before = fixture.store.read();
    await expect(fixture.manager.update({ sessionId: created.session.id }, {
      customResume: { mode: 'claude', initialTemplate: '{command} {sessionId}', resumeTemplate: '{command} {sessionId}' },
    })).rejects.toThrow(/OpenCode.*custom resume/i);
    expect(fixture.store.read()).toEqual(before);
  });

  it('rejects OpenCode launch commands even when custom resume identifies another agent', async () => {
    const fixture = createFixture();
    const customResume = {
      mode: 'claude',
      initialTemplate: '{command} -- --session-id {sessionId}',
      resumeTemplate: '{command} -- --resume {sessionId}',
    } as const;

    await expect(fixture.manager.create({
      name: 'OpenCode with resume',
      launchCommand: 'opencode --auto',
      customResume,
    })).rejects.toThrow(/OpenCode.*custom resume/i);

    const created = await fixture.manager.create({
      name: 'Update OpenCode with resume',
      launchCommand: 'my-launcher run',
      customResume,
    });
    await expect(fixture.manager.update({ sessionId: created.session.id }, {
      launchCommand: 'opencode --auto',
    })).rejects.toThrow(/OpenCode.*custom resume/i);
  });

  it('starts the retention period at upgrade for a Session archived before archive retention existed', async () => {
    const before = Date.now();
    const record = { ...orchestrationRecord('archived-before-retention', 'Old archived'), archived: true };
    const fixture = createFixture('claude', { version: 1, sessions: [record] });
    await fixture.manager.initialize();
    const archivedAt = fixture.store.read().sessions.find(item => item.id === record.id)?.archivedAt;
    expect(Date.parse(archivedAt ?? '')).toBeGreaterThanOrEqual(before);
  });

  it.each(['bash -lc "opencode --auto"', 'opencode --auto'])('guards persisted OpenCode restoration without creating an unused panel: %s', async launchCommand => {
    const record = orchestrationRecord('invalid-opencode-restoration', 'Invalid saved OpenCode');
    record.agent = 'opencode';
    record.launchCommand = launchCommand;
    if (launchCommand === 'opencode --auto') {
      record.customResume = { mode: 'generated', initialTemplate: '{command} {sessionId}', resumeTemplate: '{command} {sessionId}' };
    }
    const fixture = createFixture('claude', { version: 1, sessions: [record] });
    await fixture.manager.initialize();
    expect(fixture.store.read().sessions.find(item => item.id === record.id)?.activity.at(-1)?.message)
      .toMatch(/Session could not be restored:.*OpenCode/i);
    expect(panelManager.getPanel(record.panelIds.opencode)).toBeUndefined();
    await expect(fixture.manager.getView({ sessionId: record.id })).rejects.toThrow(/OpenCode/i);
  });

  it.each([undefined, '2026-10-06T12:00:00.000Z'])('preserves inactive OpenCode across agent switches and restart with delivery marker %s', async initialInputSentAt => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Inactive OpenCode', agent: 'opencode' });
    const saved = {
      ...created.panel.state.customState, agentSessionId: 'ses_Unconfirmed123',
      initialInputSentAt, initialInputError: 'Saved delivery failure',
      scrollbackBuffer: 'OpenCode historical output', serializedBuffer: 'OpenCode serialized screen',
    };
    await panelManager.updatePanel(created.panel.id, { state: { ...created.panel.state, customState: saved } });
    liveStates.set(created.panel.id, 'blocked');
    await fixture.manager.setAgent({ sessionId: created.session.id }, 'claude');
    // Force stale inactive launch metadata so restart must refresh it.
    const inactive = panelManager.getPanel(created.panel.id);
    if (!inactive) throw new Error('Inactive OpenCode panel is missing');
    await panelManager.updatePanel(inactive.id, { state: { ...inactive.state, customState: {
      ...inactive.state.customState, preserveLaunchCommand: true, initialInput: 'Do not replay this bootstrap', initialInputDeliveryVersion: 1,
    } } });
    const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
      fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    await restarted.initialize();
    const refreshed = panelManager.getPanel(created.panel.id);
    expect(refreshed?.state.customState).toMatchObject({
      agentType: 'opencode', agentSessionId: saved.agentSessionId, initialInputError: saved.initialInputError,
      preserveLaunchCommand: false, initialInputDeliveryVersion: 2,
    });
    expect(refreshed?.state.customState?.initialInputSentAt).toBe(initialInputSentAt);
    expect(refreshed?.state.customState?.initialInput).toBeUndefined();
    const restored = await restarted.setAgent({ sessionId: created.session.id }, 'opencode');
    expect(restored.panel.id).toBe(created.panel.id);
    expect(restored.panel.state.customState?.agentSessionId).toBe(saved.agentSessionId);
    expect(restored.panel.state.customState?.initialInputError).toBe(saved.initialInputError);
    expect(restored.panel.state.customState?.initialInputSentAt).toBe(initialInputSentAt);
    expect(databaseService.getPanelBuffers(restored.panel.id)).toMatchObject({
      scrollback: saved.scrollbackBuffer, serialized: saved.serializedBuffer,
    });
    expect(terminalPanelManager.getAgentStatus(restored.panel.id)).toBe('blocked');
  });

  it('guards incompatible inactive OpenCode restoration without changing its saved identity or buffers', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Claude with incompatible inactive OpenCode', agent: 'claude' });
    const inactive = createPanel(created.session.panelIds.opencode, created.session.internalSessionId, 'Inactive OpenCode');
    inactive.state.customState = {
      agentType: 'opencode', initialCommand: 'opencode --auto', agentSessionId: 'ses_Inactive123', preserveLaunchCommand: true,
      customResume: { mode: 'claude', initialTemplate: '{command} {sessionId}', resumeTemplate: '{command} {sessionId}' },
      initialInputSentAt: '2026-10-06T12:00:00.000Z', initialInputError: 'Saved input failure', scrollbackBuffer: 'Retain incompatible history',
    };
    await seedPanel(inactive);
    const before = panelManager.getPanel(inactive.id)?.state.customState;
    const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
      fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    await restarted.initialize();
    expect(fixture.store.read().sessions.find(record => record.id === created.session.id)?.activity.at(-1)?.message)
      .toMatch(/Session could not be restored:.*OpenCode.*custom resume/i);
    expect(panelManager.getPanel(inactive.id)?.state.customState).toEqual(before);
    expect(databaseService.getPanelBuffers(inactive.id)?.scrollback).toBe('Retain incompatible history');
    expect((await restarted.getView({ sessionId: created.session.id })).agent).toBe('claude');
  });

  it.each((['generated', 'claude', 'reported'] as const).flatMap(mode =>
    [true, false].flatMap(selected => [true, false].map(hasAgentType => ({ mode, selected, hasAgentType }))),
  ))('rejects panel-only OpenCode resume without sanitizing saved state: $mode, selected=$selected, agentType=$hasAgentType', async ({ mode, selected, hasAgentType }) => {
    const record = orchestrationRecord(`panel-resume-${mode}-${selected}-${hasAgentType}`, 'Saved OpenCode resume');
    record.agent = selected ? 'opencode' : 'claude';
    record.launchCommand = selected ? 'opencode --auto' : 'claude';
    const fixture = createFixture('claude', { version: 1, sessions: [record] });
    paneFixture(fixture, record.internalSessionId);
    const panel = createPanel(record.panelIds.opencode, record.internalSessionId, 'Saved OpenCode title');
    panel.state.customState = {
      agentType: hasAgentType ? 'opencode' : undefined,
      initialCommand: 'opencode --auto', agentSessionId: 'ses_Saved123',
      customResume: { mode, initialTemplate: '{command} {sessionId}', resumeTemplate: '{command} {sessionId}' },
      customResumeStarted: true, wasInterrupted: true, preserveLaunchCommand: true,
      initialInput: 'Retain rejected pending input', initialInputDeliveryVersion: 1,
      initialInputSentAt: '2026-10-06T12:00:00.000Z', initialInputError: 'Saved input failure',
      scrollbackBuffer: 'Retain saved OpenCode history', serializedBuffer: 'Retain saved OpenCode screen',
    };
    await seedPanel(panel);
    const savedPanel = structuredClone(panelManager.getPanel(panel.id));
    const savedRow = structuredClone(databaseService.getPanel(panel.id));
    const savedBuffers = structuredClone(databaseService.getPanelBuffers(panel.id));
    const updatePanel = vi.spyOn(panelManager, 'updatePanel');
    const createPanelSpy = vi.spyOn(panelManager, 'createPanel');
    const assertUnchanged = () => {
      expect(panelManager.getPanel(panel.id)).toEqual(savedPanel);
      expect(databaseService.getPanel(panel.id)).toEqual(savedRow);
      expect(databaseService.getPanelBuffers(panel.id)).toEqual(savedBuffers);
      expect(updatePanel.mock.calls.some(([id]) => id === panel.id)).toBe(false);
      expect(createPanelSpy).not.toHaveBeenCalled();
    };

    await fixture.manager.initialize();
    expect(fixture.store.read().sessions.find(item => item.id === record.id)?.activity.at(-1)?.message)
      .toMatch(/Session could not be restored:.*OpenCode.*custom resume/i);
    assertUnchanged();
    const failedRecord = fixture.store.read();
    if (selected) {
      await expect(fixture.manager.getView({ sessionId: record.id })).rejects.toThrow(/OpenCode.*custom resume/i);
      assertUnchanged();
    }
    await expect(fixture.manager.setAgent({ sessionId: record.id }, 'opencode')).rejects.toThrow(/OpenCode.*custom resume/i);
    assertUnchanged();
    await expect(fixture.manager.update({ sessionId: record.id }, { agent: 'opencode', launchCommand: 'opencode --auto', customResume: null }))
      .rejects.toThrow(/OpenCode.*custom resume/i);
    await expect(fixture.manager.setAgent({ sessionId: record.id }, 'opencode')).rejects.toMatchObject({
      code: 'ERR_SESSION_OPENCODE_LAUNCH', next: expect.stringContaining('opencode --auto'),
    });
    assertUnchanged();
    expect(fixture.store.read()).toEqual(failedRecord);
  });

  it.each([
    { initialCommand: 'bash -lc "opencode --auto"', launchMode: undefined },
    { initialCommand: 'my-launcher run', launchMode: undefined },
    { initialCommand: 'opencode --auto', launchMode: 'wrapped' as const },
  ].flatMap((command, index) => [true, false].flatMap(selected => [true, false].map(hasAgentType => ({ ...command, index, selected, hasAgentType })))))(
    'rejects saved OpenCode wrapper metadata before overlays: $initialCommand, mode=$launchMode, selected=$selected, agentType=$hasAgentType',
    async ({ initialCommand, launchMode, index, selected, hasAgentType }) => {
      const record = orchestrationRecord(`saved-wrapper-${index}-${selected}-${hasAgentType}`, 'Saved OpenCode wrapper');
      record.agent = selected ? 'opencode' : 'claude';
      record.launchCommand = selected ? 'opencode --auto' : 'claude';
      const fixture = createFixture('claude', { version: 1, sessions: [record], selectedSessionId: record.id });
      paneFixture(fixture, record.internalSessionId);
      if (!selected) await seedPanel(createPanel(record.panelIds.claude, record.internalSessionId));
      const panel = createPanel(record.panelIds.opencode, record.internalSessionId, 'Saved wrapper title');
      panel.state.customState = {
        agentType: hasAgentType ? 'opencode' : undefined, initialCommand, launchMode,
        agentSessionId: 'ses_SavedWrapper123', preserveLaunchCommand: true, wasInterrupted: true,
        initialInput: 'Retain rejected pending input', initialInputDeliveryVersion: 1,
        initialInputSentAt: '2026-10-06T12:00:00.000Z', initialInputError: 'Saved delivery error',
        scrollbackBuffer: 'Saved wrapper history', serializedBuffer: 'Saved wrapper screen',
      };
      await seedPanel(panel);
      const savedPanel = structuredClone(panelManager.getPanel(panel.id));
      const savedRow = structuredClone(databaseService.getPanel(panel.id));
      const savedBuffers = structuredClone(databaseService.getPanelBuffers(panel.id));
      const updatePanel = vi.spyOn(panelManager, 'updatePanel');
      const createPanelSpy = vi.spyOn(panelManager, 'createPanel');
      const initializeTerminal = vi.spyOn(terminalPanelManager, 'initializeTerminal');
      const assertUnchanged = () => {
        expect(panelManager.getPanel(panel.id)).toEqual(savedPanel);
        expect(databaseService.getPanel(panel.id)).toEqual(savedRow);
        expect(databaseService.getPanelBuffers(panel.id)).toEqual(savedBuffers);
        expect(updatePanel.mock.calls.some(([id]) => id === panel.id)).toBe(false);
        expect(createPanelSpy).not.toHaveBeenCalled();
        expect(initializeTerminal).not.toHaveBeenCalled();
      };

      await fixture.manager.initialize();
      expect(fixture.store.read().sessions.find(item => item.id === record.id)?.activity.at(-1)?.message)
        .toMatch(/Session could not be restored:.*OpenCode.*wrap/i);
      assertUnchanged();
      const failedRecord = fixture.store.read();
      if (selected) {
        await expect(fixture.manager.getView({ sessionId: record.id })).rejects.toThrow(/OpenCode.*wrap/i);
      }
      assertUnchanged();
      await expect(fixture.manager.setAgent({ sessionId: record.id }, 'opencode')).rejects.toThrow(/OpenCode.*wrap/i);
      assertUnchanged();
      await expect(fixture.manager.update({ sessionId: record.id }, { agent: 'opencode', launchCommand: 'opencode --auto' }))
        .rejects.toThrow(/OpenCode.*wrap/i);
      await expect(fixture.manager.setAgent({ sessionId: record.id }, 'opencode')).rejects.toMatchObject({
        code: 'ERR_SESSION_OPENCODE_LAUNCH', next: expect.stringContaining('opencode --auto'),
      });
      assertUnchanged();
      expect(fixture.store.read()).toEqual(failedRecord);
    },
  );

  it.each([
    'opencode --auto', '"/opt/agent tools/opencode" --auto',
    'PANE_TEST_FLAG=value opencode --auto', 'env PANE_TEST_FLAG=value opencode --auto',
  ].flatMap((initialCommand, index) => [true, false].map(selected => ({ initialCommand, index, selected }))))(
    'keeps valid saved OpenCode native metadata: $initialCommand, selected=$selected', async ({ initialCommand, index, selected }) => {
      const record = orchestrationRecord(`saved-native-${index}-${selected}`, 'Saved native OpenCode');
      record.agent = selected ? 'opencode' : 'claude';
      record.launchCommand = selected ? initialCommand : 'claude';
      const fixture = createFixture('claude', { version: 1, sessions: [record] });
      paneFixture(fixture, record.internalSessionId);
      if (!selected) await seedPanel(createPanel(record.panelIds.claude, record.internalSessionId));
      const panel = createPanel(record.panelIds.opencode, record.internalSessionId);
      const saved = {
        agentType: selected ? 'opencode' as const : undefined, initialCommand,
        agentSessionId: 'ses_ValidSaved123', preserveLaunchCommand: true,
        initialInputSentAt: '2026-10-06T12:00:00.000Z', initialInputError: 'Saved delivery error',
        scrollbackBuffer: 'Native saved history', serializedBuffer: 'Native saved screen',
      };
      panel.state.customState = saved;
      await seedPanel(panel);
      const createPanelSpy = vi.spyOn(panelManager, 'createPanel');
      await fixture.manager.initialize();
      expect(panelManager.getPanel(panel.id)?.state.customState).toMatchObject({
        initialCommand, agentType: 'opencode', preserveLaunchCommand: false, agentSessionId: saved.agentSessionId,
        initialInputSentAt: saved.initialInputSentAt, initialInputError: saved.initialInputError,
      });
      const reopened = await fixture.manager.setAgent({ sessionId: record.id }, 'opencode');
      expect(reopened.panel.state.customState).toMatchObject({
        agentType: 'opencode', agentSessionId: saved.agentSessionId,
        initialInputSentAt: saved.initialInputSentAt, initialInputError: saved.initialInputError,
      });
      expect(reopened.panel.state.customState?.initialInput).toBeUndefined();
      expect(databaseService.getPanelBuffers(panel.id)).toMatchObject({
        scrollback: saved.scrollbackBuffer, serialized: saved.serializedBuffer,
      });
      expect(createPanelSpy).not.toHaveBeenCalled();
    },
  );

  it('restores default Codex natively with generated helper config paths containing quoted ampersands', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-codex-quoted-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('PANE_DIR', path.join(directory, 'Pane & work'));
    try {
      const skills = new SkillCacheManager();
      await skills.ensurePaneChatGuide();
      const fixture = createFixture('claude', undefined, 'codex');
      vi.mocked(fixture.skillCacheManager.launchCommand).mockImplementation(agent => skills.launchCommand(agent));
      const command = skills.launchCommand('codex');
      expect(command).toContain(`agents.explorer.config_file=${JSON.stringify(path.join(skills.codexProjectAgentsRoot, 'explorer.toml'))}`);
      expect(command).toContain('Pane & work');
      const created = await fixture.manager.create({ name: 'Default Codex quoted helper' });
      expect(created.session).toMatchObject({ agent: 'codex', launchCommand: '' });
      expect(created.panel.state.customState).toMatchObject({ agentType: 'codex', initialCommand: command, preserveLaunchCommand: false });
      await panelManager.updatePanel(created.panel.id, { state: { ...created.panel.state, customState: {
        ...created.panel.state.customState, agentSessionId: 'saved-codex-thread',
      } } });
      const restarted = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
        fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
      const reopened = await restarted.getView({ sessionId: created.session.id });
      expect(reopened.panel.state.customState).toMatchObject({
        agentType: 'codex', initialCommand: command, preserveLaunchCommand: false, agentSessionId: 'saved-codex-thread',
      });
      type LaunchCommandAccess = {
        resolveCliLaunchCommand(panelId: string, initialCommand: string, customState: TerminalPanelState, shellType?: string): {
          commandToRun: string;
          customState: TerminalPanelState;
          isCliCommand: boolean;
        };
      };
      const testAccess = <Access,>(manager: TerminalPanelManager): Access => {
        // SAFETY: LaunchCommandAccess mirrors the private resolver, following terminalPanelManager.test.ts; no PTY is started.
        return manager as Access;
      };
      const terminal = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
      const resumed = terminal.resolveCliLaunchCommand(reopened.panel.id, command, reopened.panel.state.customState ?? {});
      expect(resumed.commandToRun).toContain(' resume "saved-codex-thread"');
      expect(resumed.commandToRun).toContain(`agents.explorer.config_file=${JSON.stringify(path.join(skills.codexProjectAgentsRoot, 'explorer.toml'))}`);
      expect(resumed.customState.agentSessionId).toBe('saved-codex-thread');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['opencode', undefined] as const)('repairs Pane Chat OpenCode without clearing unconfirmed conversation and delivery state with prior agent %s', async agentType => {
    const fixture = createFixture('opencode', undefined, 'opencode');
    const existing = await seedLegacyPanel('opencode', 'ses_PaneChat123');
    try {
      await panelManager.updatePanel(existing.id, { state: { ...existing.state, customState: {
        ...existing.state.customState, agentType, initialInput: 'Do not replay bootstrap', initialInputDeliveryVersion: 1,
        initialInputSentAt: '2026-10-06T12:00:00.000Z', initialInputError: 'Saved input error',
        serializedBuffer: 'Saved Pane Chat screen', preserveLaunchCommand: true,
      } } });
      const paneChat = new PaneChatManager(fixture.configManager, fixture.sessionManager, fixture.skillCacheManager);
      const repaired = await paneChat.getOrCreate();
      expect(repaired.panel.id).toBe('__pane_chat_terminal_opencode__');
      expect(repaired.panel.state.customState).toMatchObject({
        agentType: 'opencode', agentSessionId: 'ses_PaneChat123', initialInputDeliveryVersion: 10,
        initialInputSentAt: '2026-10-06T12:00:00.000Z', initialInputError: 'Saved input error', preserveLaunchCommand: false,
      });
      expect(repaired.panel.state.customState?.initialInput).toBeUndefined();
      await paneChat.setAgent('claude');
      const restored = await new PaneChatManager(fixture.configManager, fixture.sessionManager, fixture.skillCacheManager).setAgent('opencode');
      expect(restored.panel.state.customState?.agentSessionId).toBe('ses_PaneChat123');
      expect(restored.panel.state.customState?.initialInputError).toBe('Saved input error');
      expect(databaseService.getPanelBuffers(existing.id)).toMatchObject({ scrollback: 'opencode historical terminal output', serialized: 'Saved Pane Chat screen' });
    } finally {
      await panelManager.deletePanel(existing.id);
    }
  });

  it('titles phone alerts by Session and groups workers under their Session', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Launch' });
    const worker = paneFixture(fixture, 'worker', { name: 'api-fix' });
    paneFixture(fixture, 'loose', { name: 'docs' });
    await fixture.manager.associate({ sessionId: created.session.id }, { paneId: worker.id });
    const sessionPane = created.session.internalSessionId;

    expect(fixture.manager.alertSubject(sessionPane)).toEqual({ title: 'Launch', groupPaneId: sessionPane });
    expect(fixture.manager.alertSubject('worker')).toEqual({ title: 'Launch › api-fix', groupPaneId: sessionPane });
    expect(fixture.manager.alertSubject('loose')).toEqual({ title: 'docs', groupPaneId: 'loose' });
  });

  it('files Approvals under the Session a Pane works in, marking its orchestrator tabs', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Launch' });
    const worker = paneFixture(fixture, 'worker', { name: 'api-fix' });
    paneFixture(fixture, 'loose', { name: 'docs' });
    await fixture.manager.associate({ sessionId: created.session.id }, { paneId: worker.id });
    const sessionPane = created.session.internalSessionId;
    const orchestratorPanel = Object.values(created.session.panelIds)[0];
    const session = { id: created.session.id, name: 'Launch', paneId: sessionPane };

    expect(fixture.manager.approvalSession(sessionPane, orchestratorPanel)).toEqual({ ...session, orchestrator: true });
    expect(fixture.manager.approvalSession(sessionPane)).toEqual({ ...session, orchestrator: true });
    expect(fixture.manager.approvalSession('worker', 'worker-panel')).toEqual(session);
    expect(fixture.manager.approvalSession('loose', 'loose-panel')).toBeUndefined();
  });

  it('lists open Sessions for Approvals by id in one read, leaving archived ones out', async () => {
    const fixture = createFixture();
    const kept = await fixture.manager.create({ name: 'Launch' });
    const gone = await fixture.manager.create({ name: 'Old' });
    await fixture.manager.update({ sessionId: gone.session.id }, { archived: true, expectedRevision: gone.session.revision });

    const byId = fixture.manager.approvalSessionsById();
    expect(byId.get(kept.session.id)).toEqual({ id: kept.session.id, name: 'Launch', paneId: kept.session.internalSessionId });
    expect(byId.has(gone.session.id)).toBe(false);
  });

  it('unpins first-time Session children and preserves later manual pins', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Coordinator' });
    const pane = paneFixture(fixture, 'pin-child', { isFavorite: true });
    databaseService.setSessionFavorite(pane.id, true);
    await fixture.manager.associate({ sessionId: created.session.id }, { paneId: pane.id });
    expect(pane.isFavorite).toBe(false);
    expect(Boolean(databaseService.getSession(pane.id)?.is_favorite)).toBe(false);
    pane.isFavorite = true;
    databaseService.setSessionFavorite(pane.id, true);
    await fixture.manager.associate({ sessionId: created.session.id }, { paneId: pane.id });
    expect(pane.isFavorite).toBe(true);
    expect(Boolean(databaseService.getSession(pane.id)?.is_favorite)).toBe(true);
  });

  beforeEach(() => {
    vi.spyOn(terminalPanelManager, 'getAgentStatus').mockImplementation(panelId => liveStates.get(panelId));
    vi.spyOn(terminalPanelManager, 'getTerminalSnapshot').mockReturnValue(null);
    vi.spyOn(terminalPanelManager, 'isTerminalInitialized').mockReturnValue(false);
  });

  it('persists custom resume configuration into Session panels and clears it explicitly', async () => {
    const fixture = createFixture();
    const customResume = { mode: 'generated', initialTemplate: '{command} --id {sessionId}', resumeTemplate: '{command} --continue {sessionId}' } as const;
    const created = await fixture.manager.create({ name: 'Custom CLI', launchCommand: 'my-wrapper profile', customResume });
    expect(created.panel.state.customState).toMatchObject({ customResume });
    const reloaded = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
      fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    const reopened = await reloaded.getView({ sessionId: created.session.id });
    expect(reopened.session.customResume).toEqual(customResume);
    expect(reopened.panel.state.customState).toMatchObject({ customResume });
    await reloaded.update({ sessionId: created.session.id }, { customResume: null });
    expect((await reloaded.getView({ sessionId: created.session.id })).panel.state.customState).toMatchObject({ customResume: null });
  });

  it('still clears other-agent conversation identity when custom resume mode changes', async () => {
    const fixture = createFixture();
    const customResume = { mode: 'generated', initialTemplate: '{command} {sessionId}', resumeTemplate: '{command} {sessionId}' } as const;
    const created = await fixture.manager.create({ name: 'Claude resume reset', agent: 'claude', customResume });
    await panelManager.updatePanel(created.panel.id, { state: { ...created.panel.state, customState: {
      ...created.panel.state.customState, agentSessionId: 'saved-claude-resume', customResumeStarted: true, wasInterrupted: true,
    } } });
    await fixture.manager.update({ sessionId: created.session.id }, { customResume: null });
    const refreshed = panelManager.getPanel(created.panel.id)?.state.customState;
    expect(refreshed?.customResume).toBeNull();
    expect(refreshed?.agentSessionId).toBeUndefined();
    expect(refreshed?.customResumeStarted).toBeUndefined();
    expect(refreshed?.wasInterrupted).toBeUndefined();
  });

  it('starts idle in distinct persistent workspaces with profile context and literal launch arguments', async () => {
    const fixture = createFixture();
    const first = await fixture.manager.create({ name: 'First', launchCommand: 'claude --model "my model"', profile: 'Discuss before delegating.' });
    const second = await fixture.manager.create({ name: 'Second', agent: 'codex' });
    expect(first.cwd).not.toBe(second.cwd);
    expect(first.internalSession.worktreePath).toBe(first.cwd);
    expect(first.panel.state.customState).toMatchObject({ initialCommand: 'claude --model "my model"', orchestrationWorkspace: first.cwd });
    expect(first.panel.state.customState?.initialInput).toBeUndefined();
    expect(second.panel.state.customState?.initialInput).toBeUndefined();
    const instructions = fs.readFileSync(path.join(first.cwd, 'AGENTS.md'), 'utf8');
    expect(instructions).toContain(first.session.id);
    expect(instructions).toContain('Discuss before delegating.');
    expect(instructions).toContain('runpane agent-context');
    fs.writeFileSync(path.join(first.cwd, 'notes.md'), 'Keep these notes');
    await fixture.manager.update({ sessionId: first.session.id }, { name: 'Renamed', archived: true });
    await fixture.manager.update({ sessionId: first.session.id }, { archived: false });
    const reopened = await fixture.manager.getView({ sessionId: first.session.id });
    expect(reopened.cwd).toBe(first.cwd);
    expect(fs.readFileSync(path.join(reopened.cwd, 'notes.md'), 'utf8')).toBe('Keep these notes');
    expect(reopened.session.launchCommand).toBe(first.session.launchCommand);
    expect(reopened.session.profile).toBe(first.session.profile);
  });

  it('repairs historical bootstrap metadata without clearing a live conversation', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Old bootstrap' });
    await panelManager.updatePanel(created.panel.id, { state: { ...created.panel.state, customState: {
      ...created.panel.state.customState,
      initialInput: 'Initialize and begin working', initialInputDeliveryVersion: 1,
      agentSessionId: '22222222-2222-4222-8222-222222222222', hasClaudeSessionId: true,
    } } });
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(true);
    const destroy = vi.spyOn(terminalPanelManager, 'destroyTerminal');
    const reopened = await fixture.manager.getView({ sessionId: created.session.id });
    expect(reopened.panel.state.customState?.initialInput).toBeUndefined();
    expect(reopened.panel.state.customState?.agentSessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(destroy).not.toHaveBeenCalled();
  });

  it('keeps an Agent Farm Session\'s reported ID across refreshes and an unchanged settings save', async () => {
    const fixture = createFixture();
    const launchCommand = 'agent-farm run greenfield/implementer:opus';
    const created = await fixture.manager.create({ name: 'Farm', agent: 'claude', launchCommand });
    await panelManager.updatePanel(created.panel.id, { state: { ...created.panel.state, customState: {
      ...created.panel.state.customState, agentSessionId: 'farm-launch-id', customResumeStarted: true,
    } } });
    for (const initialized of [false, true]) {
      vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(initialized);
      await fixture.manager.update({ sessionId: created.session.id }, { launchCommand, profile: created.session.profile, customResume: null });
      const view = await fixture.manager.getView({ sessionId: created.session.id });
      expect(view.panel.id).toBe(created.panel.id);
      expect(view.panel.state.customState).toMatchObject({ agentSessionId: 'farm-launch-id', customResumeStarted: true });
      expect(view.panel.state.customState?.customResume ?? null).toBeNull();
    }
  });

  it('routes native custom commands to the right agent slot and preserves inactive histories', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Switch commands', agent: 'claude' });
    await panelManager.updatePanel(created.panel.id, { state: { ...created.panel.state, customState: {
      ...created.panel.state.customState, agentSessionId: '22222222-2222-4222-8222-222222222222', hasClaudeSessionId: true,
    } } });
    const changed = await fixture.manager.update({ sessionId: created.session.id }, { launchCommand: 'codex --model test' });
    expect(changed.agent).toBe('codex');
    const codex = await fixture.manager.getView({ sessionId: created.session.id });
    expect(codex.panel.id).toBe(changed.panelIds.codex);
    expect(codex.panel.state.customState?.agentSessionId).toBeUndefined();
    expect(panelManager.getPanel(created.panel.id)?.state.customState?.agentSessionId).toBe('22222222-2222-4222-8222-222222222222');
    const restored = await fixture.manager.setAgent({ sessionId: created.session.id }, 'claude');
    expect(restored.panel.state.customState?.agentSessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(restored.panel.state.customState?.initialCommand).toContain('claude');
  });

  it('stages profile changes while the Session is running', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Profile change', profile: 'Original profile' });
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(true);
    await fixture.manager.update({ sessionId: created.session.id }, { profile: 'New profile' });
    await fixture.manager.getView({ sessionId: created.session.id });
    expect(fs.readFileSync(path.join(created.cwd, 'AGENTS.md'), 'utf8')).toContain('Original profile');
    expect(panelManager.getPanel(created.panel.id)?.state.customState?.orchestrationProfile).toBe('New profile');
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(false);
    await fixture.manager.getView({ sessionId: created.session.id });
    expect(fs.readFileSync(path.join(created.cwd, 'AGENTS.md'), 'utf8')).toContain('New profile');
  });

  it('imports legacy Pane Chat with the existing terminal identity and history, then preserves it on reload', async () => {
    const first = createFixture();
    await first.manager.initialize();
    const imported = await first.manager.get({ sessionId: LEGACY_ORCHESTRATION_SESSION_ID });
    expect(imported.name).toBe('Pane Chat');
    expect(imported.internalSessionId).toBe('__pane_chat_session__');
    expect(imported.panelIds).toEqual({
      claude: '__pane_chat_terminal__',
      codex: '__pane_chat_terminal_codex__',
      cursor: '__pane_chat_terminal_cursor__',
      opencode: '__pane_chat_terminal_opencode__',
      pi: '__pane_chat_terminal_pi__',
    });
    expect(first.paneChatManager.getOrCreate).toHaveBeenCalledTimes(1);

    const view = await first.manager.getView({ sessionId: LEGACY_ORCHESTRATION_SESSION_ID });
    expect(view.internalSession.output).toEqual(['prior conversation line']);
    expect(view.internalSession.jsonMessages).toEqual([{ type: 'assistant', text: 'prior conversation' }]);
    expect(view.panel.id).toBe('__pane_chat_terminal_codex__');

    const firstData = await first.manager.list();
    const secondStore = createStore();
    secondStore.write({ version: 1, sessions: firstData.sessions, selectedSessionId: firstData.selectedSessionId });
    const reloaded = new OrchestrationSessionManager(
      first.configManager,
      first.sessionManager,
      serviceStub<SkillCacheManager>({ ensurePaneChatGuide: vi.fn(async () => '/tmp/issue-653/guide.md'), launchCommand: vi.fn((agent: PaneChatAgent) => agentTerminalCommand(agent)) }),
      serviceStub<PaneChatManager>({ getOrCreate: vi.fn(async () => { throw new Error('legacy migration must run once'); }) }),
      undefined,
      secondStore,
    );
    await reloaded.initialize();
    const persisted = await reloaded.get({ sessionId: LEGACY_ORCHESTRATION_SESSION_ID });
    expect(persisted.internalSessionId).toBe(imported.internalSessionId);
    expect(persisted.panelIds).toEqual(imported.panelIds);
    expect(first.paneChatManager.getOrCreate).toHaveBeenCalledTimes(1);
  });

  it('repairs an unsupported persisted default before legacy Pane Chat migration', async () => {
    const fixture = createFixture('codex', undefined, 'cursor');
    vi.mocked(fixture.paneChatManager.getOrCreate).mockImplementation(async () => {
      const configuredAgent = fixture.configManager.getConfig().defaultOrchestratorAgent;
      if (configuredAgent === 'cursor') throw new Error('unsupported persisted default reached PaneChatManager');
      const session = fixture.sessions.get(PANE_CHAT_SESSION_ID);
      if (!session) throw new Error('Pane Chat fixture session is missing');
      return {
        session,
        panel: createPanel(getPaneChatPanelId('codex'), PANE_CHAT_SESSION_ID, 'Pane Chat'),
        agent: 'codex',
        cwd: '/tmp/issue-653',
        guidePath: '/tmp/issue-653/guide.md',
        started: false,
      };
    });
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await fixture.manager.initialize();
      expect(fixture.configManager.updateConfig).toHaveBeenCalledWith({ defaultOrchestratorAgent: 'claude' });
      expect(fixture.configManager.getConfig().defaultOrchestratorAgent).toBe('claude');

      const imported = await fixture.manager.get({ sessionId: LEGACY_ORCHESTRATION_SESSION_ID });
      expect(imported.agent).toBe('codex');
      expect(imported.internalSessionId).toBe(PANE_CHAT_SESSION_ID);
      expect(fixture.sessions.get(PANE_CHAT_SESSION_ID)?.output).toEqual(['prior conversation line']);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('normalizes persisted unsupported Session agents before opening their panels', async () => {
    const legacy = {
      ...orchestrationRecord(LEGACY_ORCHESTRATION_SESSION_ID, 'Pane Chat'),
      internalSessionId: PANE_CHAT_SESSION_ID,
      panelIds: {
        claude: getPaneChatPanelId('claude'),
        codex: getPaneChatPanelId('codex'),
        cursor: getPaneChatPanelId('cursor'),
        opencode: getPaneChatPanelId('opencode'),
        pi: getPaneChatPanelId('pi'),
      },
    } satisfies OrchestrationSessionRecord;
    const persisted = orchestrationRecord('windows-session', 'Windows Session');
    const fixture = createFixture('claude', {
      version: 1,
      sessions: [legacy, { ...persisted, agent: 'cursor' }],
      selectedSessionId: persisted.id,
    });
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await fixture.manager.initialize();
      const normalized = await fixture.manager.get({ sessionId: persisted.id });
      expect(normalized.agent).toBe('claude');
      expect(normalized.panelIds).toEqual(persisted.panelIds);
      expect(normalized.activity).toEqual(persisted.activity);

      const view = await fixture.manager.getView({ sessionId: persisted.id });
      expect(view.agent).toBe('claude');
      expect(view.panel.id).toBe(persisted.panelIds.claude);
      expect(panelManager.getPanel(persisted.panelIds.cursor)).toBeUndefined();
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('keeps all existing agent histories in one Pane Chat Session across switches and restart', async () => {
    const fixture = createFixture('codex');
    const owner = fixture.sessions.get(PANE_CHAT_SESSION_ID);
    if (!owner) throw new Error('Missing legacy owner');
    owner.name = 'My existing chat';
    const claude = await seedLegacyPanel('claude', 'claude-resume-id');
    const codex = await seedLegacyPanel('codex', 'codex-resume-id');
    await fixture.manager.initialize();
    const listed = await fixture.manager.list();
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ name: 'My existing chat', agent: 'codex',
      panelIds: { claude: claude.id, codex: codex.id } });
    const first = await fixture.manager.getView({ sessionId: LEGACY_ORCHESTRATION_SESSION_ID });
    const switched = await fixture.manager.setAgent({ sessionId: first.session.id }, 'claude');
    expect(switched.panel.id).toBe(claude.id);
    expect(switched.cwd).toBe(first.cwd);
    expect(switched.internalSession.worktreePath).toBe(first.cwd);
    expect(switched.panel.state.customState).toMatchObject({ agentSessionId: 'claude-resume-id' });
    expect(switched.panel.state.customState).not.toHaveProperty('initialInput');
    const reloaded = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
      fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    await reloaded.initialize();
    expect((await reloaded.list()).sessions).toHaveLength(1);
    const restored = await reloaded.setAgent({ sessionId: first.session.id }, 'codex');
    expect(restored.panel.id).toBe(codex.id);
    expect(restored.panel.state.customState).toMatchObject({ agentSessionId: 'codex-resume-id' });
    expect(restored.panel.state.customState).not.toHaveProperty('initialInput');
    expect(databaseService.getPanelBuffers(claude.id)?.scrollback).toBe('claude historical terminal output');
    expect(databaseService.getPanelBuffers(codex.id)?.scrollback).toBe('codex historical terminal output');
  });

  function splitLegacyRecords(): [OrchestrationSessionRecord, OrchestrationSessionRecord] {
    const primary: OrchestrationSessionRecord = {
      ...orchestrationRecord(LEGACY_ORCHESTRATION_SESSION_ID, 'Pane Chat'),
      internalSessionId: PANE_CHAT_SESSION_ID, agent: 'claude', archived: false, isPinned: false,
      panelIds: { claude: getPaneChatPanelId('claude'), codex: 'primary-new-codex', cursor: getPaneChatPanelId('cursor'), opencode: getPaneChatPanelId('opencode'), pi: getPaneChatPanelId('pi') },
    };
    const supplemental: OrchestrationSessionRecord = {
      ...orchestrationRecord(`${LEGACY_ORCHESTRATION_SESSION_ID}-codex`, 'Pane Chat · Codex'),
      internalSessionId: PANE_CHAT_SESSION_ID, agent: 'codex', archived: false, isPinned: false,
      panelIds: { claude: 'supplemental-new-claude', codex: getPaneChatPanelId('codex'), cursor: 'supplemental-new-cursor', opencode: `__orchestration_panel_${LEGACY_ORCHESTRATION_SESSION_ID}-codex_opencode`, pi: `__orchestration_panel_${LEGACY_ORCHESTRATION_SESSION_ID}-codex_pi` },
      revision: 1, goal: '', context: '', nextAction: '', decisions: [], blockers: [], evidence: [], outputs: [],
      report: undefined, reportActivityId: undefined, reportAcceptedAt: undefined,
    };
    return [primary, supplemental];
  }

  it('isolates supplemental OpenCode namespaces without allocating unused panels or conversations', async () => {
    const [primary, supplemental] = splitLegacyRecords();
    supplemental.context = 'Independent supplemental Session';
    const fixture = createFixture('claude', { version: 1, sessions: [primary, supplemental] });
    const legacyPanel = await seedLegacyPanel('claude', 'existing-legacy-conversation');
    const createPanelSpy = vi.spyOn(panelManager, 'createPanel');

    await fixture.manager.initialize();
    const listed = await fixture.manager.list();
    const original = listed.sessions.find(record => record.id === primary.id);
    const independent = listed.sessions.find(record => record.id === supplemental.id);
    expect(original?.panelIds.opencode).toBe('__pane_chat_terminal_opencode__');
    expect(independent?.panelIds.opencode).toBe('__orchestration_panel_legacy-pane-chat-codex_opencode');
    expect(independent?.internalSessionId).not.toBe(PANE_CHAT_SESSION_ID);
    expect(createPanelSpy).not.toHaveBeenCalled();
    for (const record of listed.sessions) {
      expect(panelManager.getPanel(record.panelIds.opencode)).toBeUndefined();
      expect(databaseService.getPanel(record.panelIds.opencode)).toBeNull();
    }
    expect(panelManager.getPanel(legacyPanel.id)?.state.customState?.agentSessionId).toBe('existing-legacy-conversation');

    const created = await fixture.manager.create({ name: 'New scoped Session', agent: 'claude' });
    expect(created.session.panelIds.opencode).toBe(`__orchestration_panel_${created.session.id}_opencode`);
    expect(panelManager.getPanel(created.session.panelIds.opencode)).toBeUndefined();
    expect(created.panel.state.customState?.agentType).toBe('claude');
  });

  it('reunites untouched supplemental imports and redirects their selection without replacing history', async () => {
    const [primary, supplemental] = splitLegacyRecords();
    const fixture = createFixture('claude', { version: 1, sessions: [primary, supplemental], selectedSessionId: supplemental.id });
    await seedLegacyPanel('claude', 'primary-resume');
    const codex = await seedLegacyPanel('codex', 'imported-resume');
    prepareSessionWorkspace(supplemental.id, undefined, supplemental);
    await fixture.manager.initialize();
    const listed = await fixture.manager.list();
    expect(listed.sessions).toHaveLength(1);
    expect(listed.selectedSessionId).toBe(primary.id);
    expect(listed.sessions[0].panelIds.codex).toBe(codex.id);
    const view = await fixture.manager.setAgent({ sessionId: primary.id }, 'codex');
    expect(view.panel.state.customState).toMatchObject({ agentSessionId: 'imported-resume' });
    expect(databaseService.getPanelBuffers(codex.id)?.scrollback).toBe('codex historical terminal output');
  });

  it('recovers an interrupted import ownership move from the persisted target without losing buffers', async () => {
    const [primary, supplemental] = splitLegacyRecords();
    supplemental.revision = 2;
    const fixture = createFixture('claude', { version: 1, sessions: [primary, supplemental] });
    const codex = await seedLegacyPanel('codex', 'recovery-resume');
    const move = vi.spyOn(panelManager, 'movePanel').mockRejectedValueOnce(new Error('Interrupted move'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await fixture.manager.initialize();
    expect(fixture.store.read().sessions.find(session => session.id === supplemental.id)?.activity.at(-1)?.message)
      .toBe('Session could not be restored: Interrupted move');
    const target = fixture.store.read().sessions.find(session => session.id === supplemental.id)?.internalSessionId;
    expect(target).not.toBe(PANE_CHAT_SESSION_ID);
    expect(panelManager.getPanel(codex.id)?.sessionId).toBe(PANE_CHAT_SESSION_ID);
    move.mockRestore();
    const reloaded = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
      fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    await reloaded.initialize();
    expect(panelManager.getPanel(codex.id)?.sessionId).toBe(target);
    expect(panelManager.getPanel(codex.id)?.state.customState).toMatchObject({ agentSessionId: 'recovery-resume' });
    expect(databaseService.getPanelBuffers(codex.id)?.scrollback).toBe('codex historical terminal output');
  });

  it('isolates previously used imports while preserving their files, settings, and histories across restart', async () => {
    const [primary, supplemental] = splitLegacyRecords();
    supplemental.name = 'Independent investigation';
    supplemental.context = 'Keep my context';
    const workspace = sessionWorkspacePath(supplemental.id);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Keep my notes');
    const fixture = createFixture('claude', { version: 1, sessions: [primary, supplemental], selectedSessionId: supplemental.id });
    const claude = await seedLegacyPanel('claude', 'primary-resume');
    const codex = await seedLegacyPanel('codex', 'imported-resume');
    await fixture.manager.initialize();
    const imported = await fixture.manager.getView({ sessionId: supplemental.id });
    const main = await fixture.manager.getView({ sessionId: primary.id });
    expect(imported.internalSession.id).not.toBe(main.internalSession.id);
    expect(imported.internalSession.worktreePath).toBe(workspace);
    expect(main.internalSession.worktreePath).toBe(main.cwd);
    expect(panelManager.getPanel(codex.id)?.sessionId).toBe(imported.internalSession.id);
    expect(panelManager.getPanel(claude.id)?.sessionId).toBe(main.internalSession.id);
    await panelManager.createPanel({ id: 'imported-files', sessionId: imported.internalSession.id, type: 'explorer', title: 'Files' });
    await panelManager.createPanel({ id: 'imported-terminal', sessionId: imported.internalSession.id, type: 'terminal', title: 'Terminal' });
    const reloaded = new OrchestrationSessionManager(fixture.configManager, fixture.sessionManager,
      fixture.skillCacheManager, fixture.paneChatManager, undefined, fixture.store);
    await reloaded.initialize();
    const restored = await reloaded.getView({ sessionId: supplemental.id });
    await reloaded.getView({ sessionId: primary.id });
    expect(restored.internalSession.worktreePath).toBe(workspace);
    expect(restored.session).toMatchObject({ name: supplemental.name, context: supplemental.context, panelIds: supplemental.panelIds });
    expect(fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8')).toBe('Keep my notes');
    expect(panelManager.getPanelsForSession(main.internalSession.id).map(panel => panel.id)).not.toContain('imported-files');
    expect(panelManager.getPanelsForSession(restored.internalSession.id).map(panel => panel.id)).toEqual(expect.arrayContaining(['imported-files', 'imported-terminal', codex.id]));
    expect(databaseService.getPanelBuffers(codex.id)?.scrollback).toBe('codex historical terminal output');
  });

  it('gives each named Session stable hidden terminal identities while switching agent conversations', async () => {
    const fixture = createFixture();
    const first = await fixture.manager.create({ name: 'Release review', agent: 'claude', goal: 'Review the release.' });
    const firstRecord = first.session;
    const claudePanel = panelManager.getPanel(firstRecord.panelIds.claude);
    expect(claudePanel?.sessionId).toBe(firstRecord.internalSessionId);
    expect(claudePanel?.state.customState).toMatchObject({ orchestrationSessionId: firstRecord.id, agentType: 'claude' });

    const second = await fixture.manager.create({ name: 'Incident review', agent: 'codex', goal: 'Review the incident.' });
    expect(second.session.id).not.toBe(firstRecord.id);
    expect(second.session.internalSessionId).not.toBe(firstRecord.internalSessionId);
    expect(second.panel.id).toBe(second.session.panelIds.codex);

    const switched = await fixture.manager.setAgent({ sessionId: firstRecord.id }, 'codex');
    expect(switched.session.id).toBe(firstRecord.id);
    expect(switched.panel.id).toBe(firstRecord.panelIds.codex);
    expect(switched.panel.state.customState).toMatchObject({ orchestrationSessionId: firstRecord.id, agentType: 'codex' });
    expect(switched.session.internalSessionId).toBe(firstRecord.internalSessionId);
    expect(fixture.sessions.has(firstRecord.internalSessionId)).toBe(true);
    expect(panelManager.getPanel(firstRecord.panelIds.claude)).toBeDefined();
  });

  it.each(['windows', 'wsl'] as const)('rolls back %s metadata when hidden owner provisioning fails before publication', async runtime => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(wslUtils, 'validateWSLAvailable').mockResolvedValue(null);
    const input: OrchestrationSessionCreateInput = { name: 'Recoverable Session', runtime };
    if (runtime === 'wsl') input.wslDistribution = 'Ubuntu';
    const fixture = createFixture();
    await fixture.manager.initialize();
    const changedEvents: Array<{ sessionId: string; kind: string }> = [];
    fixture.manager.on('changed', event => changedEvents.push(event));
    vi.mocked(fixture.sessionManager.createSessionWithId).mockImplementationOnce(() => {
      throw new Error('hidden owner provisioning failed');
    });

    await expect(fixture.manager.create(input)).rejects.toThrow('hidden owner provisioning failed');
    const afterFailure = await fixture.manager.list();
    expect(afterFailure.sessions.some(session => session.name === 'Recoverable Session')).toBe(false);
    expect(afterFailure.selectedSessionId).toBe(LEGACY_ORCHESTRATION_SESSION_ID);
    expect(changedEvents).toEqual([]);

    const retried = await fixture.manager.create(input);
    expect(retried.session.name).toBe('Recoverable Session');
  });

  it('retains durable metadata when later provisioning fails with a published owner', async () => {
    const fixture = createFixture();
    await fixture.manager.initialize();
    const changedEvents: Array<{ sessionId: string; kind: string }> = [];
    fixture.manager.on('changed', event => changedEvents.push(event));
    vi.mocked(fixture.skillCacheManager.ensurePaneChatGuide)
      .mockRejectedValueOnce(new Error('guide publication failed'));

    await expect(fixture.manager.create({ name: 'Published Session' })).rejects.toThrow('Reopen it from the Sessions list');
    const persisted = await fixture.manager.get({ name: 'Published Session' });
    expect(changedEvents).toEqual([{ sessionId: persisted.id, kind: 'created' }]);
    expect(fixture.sessions.has(persisted.internalSessionId)).toBe(true);
    expect(panelManager.getPanel(persisted.panelIds[persisted.agent])).toBeDefined();
    const resumed = await fixture.manager.getView({ sessionId: persisted.id });
    expect(resumed.internalSession.id).toBe(persisted.internalSessionId);
  });

  it('does not commit an agent change when its panel cannot be provisioned', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Agent Retry', agent: 'claude' });
    const changedEvents: string[] = [];
    fixture.manager.on('changed', event => changedEvents.push(event.kind));
    vi.spyOn(panelManager, 'createPanel').mockRejectedValueOnce(new Error('panel unavailable'));

    await expect(fixture.manager.update(
      { sessionId: created.session.id },
      { agent: 'codex', expectedRevision: created.session.revision },
    )).rejects.toThrow('panel unavailable');

    const afterFailure = await fixture.manager.get({ sessionId: created.session.id });
    expect(afterFailure.agent).toBe('claude');
    expect(afterFailure.revision).toBe(created.session.revision);
    expect(changedEvents).toEqual([]);

    const retried = await fixture.manager.update(
      { sessionId: created.session.id },
      { agent: 'codex', expectedRevision: created.session.revision },
    );
    expect(retried.agent).toBe('codex');
    expect(retried.revision).toBe(created.session.revision + 1);
  });

  it('recreates missing named Session owners once on startup without touching the shared legacy owner', async () => {
    const legacy = {
      ...orchestrationRecord(LEGACY_ORCHESTRATION_SESSION_ID, 'Pane Chat'),
      internalSessionId: PANE_CHAT_SESSION_ID,
      panelIds: {
        claude: getPaneChatPanelId('claude'),
        codex: getPaneChatPanelId('codex'),
        cursor: getPaneChatPanelId('cursor'),
        opencode: getPaneChatPanelId('opencode'),
        pi: getPaneChatPanelId('pi'),
      },
    } satisfies OrchestrationSessionRecord;
    const orphan = orchestrationRecord('orphan-session', 'Recovered Session');
    const fixture = createFixture('codex', {
      version: 1,
      sessions: [legacy, orphan],
      selectedSessionId: orphan.id,
    });

    await fixture.manager.initialize();
    expect(fixture.paneChatManager.getOrCreate).not.toHaveBeenCalled();
    const recovered = await fixture.manager.getView({ sessionId: orphan.id });
    expect(recovered.internalSession.id).toBe(orphan.internalSessionId);
    expect(fixture.sessions.has(PANE_CHAT_SESSION_ID)).toBe(true);
    expect(fixture.sessionManager.createSessionWithId).toHaveBeenCalledTimes(1);

    const reloaded = new OrchestrationSessionManager(
      fixture.configManager,
      fixture.sessionManager,
      fixture.skillCacheManager,
      serviceStub<PaneChatManager>({ getOrCreate: vi.fn(async () => { throw new Error('restart should use persisted legacy state'); }) }),
      undefined,
      fixture.store,
    );
    await reloaded.initialize();
    const afterReload = await reloaded.list();
    expect(afterReload.sessions.filter(session => session.id === orphan.id)).toHaveLength(1);
    expect(afterReload.sessions.filter(session => session.id === LEGACY_ORCHESTRATION_SESSION_ID)).toHaveLength(1);
    expect(afterReload.selectedSessionId).toBe(orphan.id);
    expect(fixture.sessionManager.createSessionWithId).toHaveBeenCalledTimes(1);
  });

  it("shows a remote member with its machine, as its machine reports it or unreachable when it doesn't answer", async () => {
    const fixture = createFixture();
    const named = await fixture.manager.create({ name: 'Cross-machine', agent: 'claude' });
    const machine = { id: 'tailnet-devbox', label: 'parsa-devbox' };
    await fixture.manager.associateRemote({ sessionId: named.session.id }, { paneId: 'win-pane', name: 'Windows build', machine });
    await fixture.manager.associateRemote({ sessionId: named.session.id }, { paneId: 'wsl-pane', name: 'WSL build', machine });
    fixture.manager.setRemoteMachines({
      forwardsReports: () => true,
      readPane: async (_machineId, paneId) => (paneId === 'win-pane'
        ? { paneId, name: 'Windows build', archived: false, missing: false, panels: [{ panelId: 'tab', title: 'Codex', type: 'terminal', state: 'blocked', initialized: true }] }
        : 'unreachable'),
    });

    const overview = await fixture.manager.overview({ sessionId: named.session.id });

    expect(overview.panes).toMatchObject([
      { paneId: 'win-pane', machine: { label: 'parsa-devbox', state: 'online' }, panels: [{ state: 'blocked' }] },
      { paneId: 'wsl-pane', name: 'WSL build', machine: { label: 'parsa-devbox', state: 'unreachable' }, panels: [] },
    ]);
    expect(overview.status).toBe('blocked');
  });

  it('reports an archived member Pane as archived when the database stores the flag as 1', async () => {
    const fixture = createFixture();
    const pane = paneFixture(fixture, 'archived-member');
    const named = await fixture.manager.create({ name: 'Archived member', agent: 'claude' });
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: pane.id });
    // SQLite returns the archived column as 1; a Session built from a database row can carry it.
    const stored = { ...pane };
    Reflect.set(stored, 'archived', 1);
    fixture.sessions.set(pane.id, stored);

    const overview = await fixture.manager.overview({ sessionId: named.session.id });

    expect(overview.panes[0]).toMatchObject({ paneId: pane.id, archived: true });
  });

  it('includes an associated OpenCode terminal while allowing native Session orchestration', async () => {
    const fixture = createFixture();
    const pane = paneFixture(fixture, 'opencode-worker-pane');
    const worker = createPanel('opencode-worker-panel', pane.id, 'OpenCode worker');
    worker.state.customState = { agentType: 'opencode', isInitialized: true };
    await seedPanel(worker);
    await seedPanel(createPanel('claude-worker-panel', pane.id, 'Claude worker'));
    const named = await fixture.manager.create({ name: 'OpenCode workers', agent: 'claude' });
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: pane.id });

    const overview = await fixture.manager.overview({ sessionId: named.session.id });

    expect(overview.session.agent).toBe('claude');
    expect(overview.panes).toHaveLength(1);
    expect(overview.panes[0].panels).toEqual(expect.arrayContaining([
      expect.objectContaining({ panelId: worker.id, initialized: true, agentType: 'opencode' }),
      expect.objectContaining({ panelId: 'claude-worker-panel', agentType: 'claude' }),
    ]));
    expect((await fixture.manager.update({ sessionId: named.session.id }, { launchCommand: 'opencode --auto' })).agent).toBe('opencode');
  });

  it('lists every tab of a whole-Pane link with its type, Explorer and Diff last, and only the named tabs of a tab link', async () => {
    const fixture = createFixture();
    const whole = paneFixture(fixture, 'all-tabs-pane', { name: 'All tabs' });
    await panelManager.createPanel({ id: 'all-tabs-explorer', sessionId: whole.id, type: 'explorer', title: 'Explorer' });
    await seedPanel(createPanel('all-tabs-agent', whole.id, 'Claude Code'));
    await panelManager.createPanel({ id: 'all-tabs-diff', sessionId: whole.id, type: 'diff', title: 'Diff' });
    await panelManager.createPanel({ id: 'all-tabs-page', sessionId: whole.id, type: 'browser', title: 'localhost:5173' });
    await panelManager.createPanel({ id: 'all-tabs-file', sessionId: whole.id, type: 'editor', title: 'README.md' });
    const scoped = paneFixture(fixture, 'named-tabs-pane', { name: 'Named tabs' });
    await seedPanel(createPanel('named-tabs-agent', scoped.id, 'Codex'));
    await panelManager.createPanel({ id: 'named-tabs-page', sessionId: scoped.id, type: 'browser', title: 'Docs' });
    const named = await fixture.manager.create({ name: 'Every tab' });
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: whole.id });
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: scoped.id, panelIds: ['named-tabs-agent'] });
    liveStates.set('all-tabs-agent', 'working');
    liveStates.set('named-tabs-agent', 'idle');

    const overview = await fixture.manager.overview({ sessionId: named.session.id });

    expect(overview.panes[0].panels.map(panel => [panel.panelId, panel.type])).toEqual([
      ['all-tabs-agent', 'terminal'],
      ['all-tabs-page', 'browser'],
      ['all-tabs-file', 'editor'],
      ['all-tabs-explorer', 'explorer'],
      ['all-tabs-diff', 'diff'],
    ]);
    expect(overview.panes[1].panels).toEqual([expect.objectContaining({ panelId: 'named-tabs-agent', type: 'terminal', state: 'idle' })]);
    // Tabs without an agent leave the Session's status to its agents.
    expect(overview.status).toBe('working');
    // An idle agent keeps the Session idle even with pages and editors present.
    liveStates.set('all-tabs-agent', 'idle');
    expect((await fixture.manager.overview({ sessionId: named.session.id })).status).toBe('idle');
  });

  it('counts only the agent tabs of Panes that exist and are not archived for the Session row\'s activity', async () => {
    const fixture = createFixture();
    const whole = paneFixture(fixture, 'activity-whole', { name: 'Whole' });
    await seedPanel(createPanel('activity-whole-agent', whole.id, 'Claude Code'));
    await panelManager.createPanel({ id: 'activity-whole-chat', sessionId: whole.id, type: 'chat', title: 'Codex', initialState: { customState: { agent: 'codex', launch: { kind: 'agent' }, cwd: '/tmp', status: 'idle' } }, activate: false });
    await panelManager.createPanel({ id: 'activity-whole-page', sessionId: whole.id, type: 'browser', title: 'localhost:5173' });
    const scoped = paneFixture(fixture, 'activity-scoped', { name: 'Scoped' });
    await seedPanel(createPanel('activity-scoped-agent', scoped.id, 'Codex'));
    await seedPanel(createPanel('activity-scoped-other', scoped.id, 'Shell'));
    const shelved = paneFixture(fixture, 'activity-shelved', { name: 'Shelved' });
    await seedPanel(createPanel('activity-shelved-agent', shelved.id, 'Claude Code'));
    const named = await fixture.manager.create({ name: 'Activity members' });
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: whole.id });
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: scoped.id, panelIds: ['activity-scoped-agent'] });
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: shelved.id });
    databaseService.getDb().prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(shelved.id);

    const members = fixture.manager.activityMembers().find(member => member.sessionId === named.session.id);

    // The orchestrator's tabs that were created; a Session keeps an id for every agent it could run.
    expect(members?.orchestratorPanelIds).toEqual([named.panel.id]);
    expect(members?.panes).toEqual([
      { paneId: whole.id, panelIds: ['activity-whole-agent', 'activity-whole-chat'] },
      { paneId: scoped.id, panelIds: ['activity-scoped-agent'] },
    ]);

    // Archiving the Session drops it, and re-reads the members at once rather than on the 2 s refresh.
    const invalidate = vi.spyOn(fixture.manager.liveActivity, 'invalidateMembers');
    await fixture.manager.update({ sessionId: named.session.id }, { archived: true, report: { summary: 'Shipped', status: 'reported', evidence: [createLink('PR')], reportedAt: '2026-11-15T12:00:00.000Z', provenance: 'test' } });
    expect(invalidate).toHaveBeenCalled();
    expect(fixture.manager.activityMembers().find(member => member.sessionId === named.session.id)).toBeUndefined();
    invalidate.mockRestore();
  });

  it('enforces exclusive Pane ownership, validates tab membership, and permits reassignment after detach', async () => {
    const fixture = createFixture();
    const pane = paneFixture(fixture, 'pane-1', { name: 'Feature Pane' });
    await seedPanel(createPanel('pane-1-tab-a', pane.id, 'Terminal A'));
    await seedPanel(createPanel('pane-1-tab-b', pane.id, 'Terminal B'));
    const foreignPane = paneFixture(fixture, 'pane-2', { name: 'Other Pane' });
    await seedPanel(createPanel('pane-2-tab', foreignPane.id));
    const hiddenPane = paneFixture(fixture, 'hidden-pane', { isHidden: true });
    const archivedPane = paneFixture(fixture, 'archived-pane', { archived: true });
    const first = await fixture.manager.create({ name: 'Owner A' });
    const second = await fixture.manager.create({ name: 'Owner B' });

    const attached = await fixture.manager.associate({ sessionId: first.session.id }, {
      paneId: pane.id,
      panelIds: ['pane-1-tab-a', 'pane-1-tab-a', 'pane-1-tab-b'],
    });
    expect(attached.associations[0]?.panelIds).toEqual(['pane-1-tab-a', 'pane-1-tab-b']);

    await expect(fixture.manager.associate({ sessionId: second.session.id }, { paneId: pane.id })).rejects.toThrow('already associated');
    await expect(fixture.manager.associate({ sessionId: second.session.id }, { paneId: pane.id, panelIds: ['pane-2-tab'] })).rejects.toThrow('does not belong');
    await expect(fixture.manager.associate({ sessionId: second.session.id }, { paneId: 'missing-pane' })).rejects.toThrow('missing or hidden');
    await expect(fixture.manager.associate({ sessionId: second.session.id }, { paneId: hiddenPane.id })).rejects.toThrow('missing or hidden');
    await expect(fixture.manager.associate({ sessionId: second.session.id }, { paneId: archivedPane.id })).rejects.toThrow('archived');

    const detached = await fixture.manager.detach({ sessionId: first.session.id }, pane.id);
    expect(detached.associations).toEqual([]);
    expect(detached.activity.at(-1)).toMatchObject({ kind: 'detached', message: 'Detached Pane “Feature Pane”.' });
    const reassigned = await fixture.manager.associate({ sessionId: second.session.id }, { paneId: pane.id });
    expect(reassigned.associations).toEqual([expect.objectContaining({ paneId: pane.id, panelIds: [] })]);
  });

  it('names the Panes each associate and detach changes, and reports live membership for Session watch', async () => {
    const fixture = createFixture();
    const pane = paneFixture(fixture, 'watch-pane', { name: 'Watched Pane' });
    const otherPane = paneFixture(fixture, 'watch-pane-2', { name: 'Second Pane' });
    await seedPanel(createPanel('watch-pane-tab', pane.id));
    const named = await fixture.manager.create({ name: 'Watched' });
    const changes: Array<{ kind: string; paneIds?: string[]; sessionName?: string }> = [];
    fixture.manager.on('changed', event => changes.push(event));

    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: pane.id });
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: pane.id, panelIds: ['watch-pane-tab'] });
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: otherPane.id });
    const membership = fixture.manager.workspaceMembership(named.session.id);
    expect(membership?.panes).toEqual(new Map([[pane.id, ['watch-pane-tab']], [otherPane.id, []]]));
    expect(membership?.ownPaneIds).toEqual(new Set([named.session.internalSessionId]));
    expect(membership?.ownPanelIds).toEqual(new Set(Object.values(named.session.panelIds)));

    fixture.sessions.set(pane.id, { ...pane, archived: true });
    expect(fixture.manager.workspaceMembership(named.session.id)?.panes).toEqual(new Map([[otherPane.id, []]]));
    fixture.sessions.delete(otherPane.id);
    expect(fixture.manager.workspaceMembership(named.session.id)?.panes.size).toBe(0);

    await fixture.manager.detach({ sessionId: named.session.id });
    expect(changes).toEqual([
      { sessionId: named.session.id, kind: 'associated', sessionName: 'Watched', paneIds: [pane.id] },
      // Re-associating a member changes its panel scope but is not a new join.
      { sessionId: named.session.id, kind: 'associated', sessionName: 'Watched', paneIds: [] },
      { sessionId: named.session.id, kind: 'associated', sessionName: 'Watched', paneIds: [otherPane.id] },
      { sessionId: named.session.id, kind: 'detached', sessionName: 'Watched', paneIds: [pane.id, otherPane.id] },
    ]);
    expect(fixture.manager.workspaceMembership(named.session.id)?.panes.size).toBe(0);
    expect(fixture.manager.workspaceMembership('missing')).toBeUndefined();
  });

  it('finds the Session a Pane belongs to for Session-scoped locks', async () => {
    const fixture = createFixture();
    const pane = paneFixture(fixture, 'pane-1', { name: 'Feature Pane' });
    paneFixture(fixture, 'pane-2', { name: 'Loose Pane' });
    const named = await fixture.manager.create({ name: 'Lock Owner' });
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: pane.id });

    await expect(fixture.manager.sessionIdForPane(pane.id)).resolves.toBe(named.session.id);
    await expect(fixture.manager.sessionIdForPane(named.internalSession.id, named.panel.id)).resolves.toBe(named.session.id);
    await expect(fixture.manager.sessionIdForPane('pane-2')).resolves.toBeUndefined();
  });

  it('separates live activity from completion and marks evidence-backed reports stale after later activity', async () => {
    const fixture = createFixture();
    const named = await fixture.manager.create({ name: 'Verification', goal: 'Verify the implementation.' });
    const pane = paneFixture(fixture, 'verification-pane', { name: 'Verification Pane' });
    const panePanel = createPanel('verification-pane-terminal', pane.id);
    await seedPanel(panePanel);
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: pane.id, panelIds: [panePanel.id] });
    const report: NonNullable<OrchestrationSessionRecord['report']> = {
      summary: 'Checks passed',
      status: 'reported',
      evidence: [createLink('Vitest report')],
      reportedAt: '2026-09-16T12:00:00.000Z',
      provenance: 'agent',
    };
    await fixture.manager.update({ sessionId: named.session.id }, { report, source: 'agent' });
    let overview = await fixture.manager.overview({ sessionId: named.session.id });
    expect(overview.report?.freshness).toBe('current');
    expect(overview.status).toBe('unknown');

    liveStates.set(panePanel.id, 'working');
    await fixture.manager.notifyLiveActivity(panePanel.id, 'working');
    overview = await fixture.manager.overview({ sessionId: named.session.id });
    expect(overview.status).toBe('working');
    expect(overview.report?.freshness).toBe('stale');
    expect(overview.session.activity.some(activity => activity.kind === 'working' && activity.panelId === panePanel.id)).toBe(true);

    liveStates.set(panePanel.id, 'idle');
    await fixture.manager.notifyLiveActivity(panePanel.id, 'idle');
    overview = await fixture.manager.overview({ sessionId: named.session.id });
    expect(overview.status).toBe('idle');
    expect(overview.report?.freshness).toBe('stale');
    expect(overview.session.report?.summary).toBe('Checks passed');

    const changedEvents: Array<{ sessionId: string; kind: string }> = [];
    fixture.manager.on('overview-updated', event => changedEvents.push(event));
    await fixture.manager.notifyLiveActivity(panePanel.id, 'idle');
    expect(changedEvents).toEqual([{ panelId: panePanel.id, sessionId: named.session.id, state: 'idle' }]);
  });

  it('records a worker report as Session activity and shows the newest one under its Pane in the overview', async () => {
    // Association and report can be recorded in the same millisecond.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-27T18:00:00.000Z') });
    const fixture = createFixture();
    const named = await fixture.manager.create({ name: 'Reports' });
    const other = await fixture.manager.create({ name: 'Unrelated' });
    const pane = paneFixture(fixture, 'report-pane', { name: 'Report Pane' });
    const worker = createPanel('report-pane-claude', pane.id);
    const reviewer = createPanel('report-pane-reviewer', pane.id);
    await seedPanel(worker);
    await seedPanel(reviewer);
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: pane.id });
    const older = { state: 'blocked' as const, question: 'Keep the old API?', reportedAt: '2026-09-27T17:00:00.000Z' };
    const newer = { state: 'ready' as const, pr: 747, head: 'fc5dce9', summary: 'Tests pass.', reportedAt: '2026-09-27T18:00:00.000Z' };
    await panelManager.updatePanel(reviewer.id, { state: { ...reviewer.state, customState: { ...reviewer.state.customState, agentReport: older } } });
    await panelManager.updatePanel(worker.id, { state: { ...worker.state, customState: { ...worker.state.customState, agentReport: newer } } });
    const changed: Array<{ sessionId: string; kind: string }> = [];
    fixture.manager.on('changed', event => changed.push(event));

    vi.setSystemTime(new Date('2026-09-27T18:00:01.000Z'));
    await expect(fixture.manager.recordAgentReport(worker.id, newer)).resolves.toEqual([named.session.id]);

    expect(changed).toEqual([{ sessionId: named.session.id, kind: 'report' }]);
    const overview = await fixture.manager.overview({ sessionId: named.session.id });
    expect(overview.activity[0]).toMatchObject({
      kind: 'report',
      source: 'agent',
      paneId: pane.id,
      panelId: worker.id,
      message: 'Worker reported ready: PR #747 at fc5dce9.',
    });
    expect(overview.panes[0].report).toEqual({ ...newer, panelId: worker.id });
    const untouched = await fixture.manager.overview({ sessionId: other.session.id });
    expect(untouched.activity.some(activity => activity.kind === 'report')).toBe(false);
    await expect(fixture.manager.recordAgentReport('missing-panel', newer)).resolves.toEqual([]);
  });

  it('J-2: gives each panel its own latest report, with data only for a complete JSON object summary', async () => {
    const fixture = createFixture();
    const named = await fixture.manager.create({ name: 'Panel reports' });
    const pane = paneFixture(fixture, 'panel-report-pane', { name: 'Panel Report Pane' });
    const planner = createPanel('panel-report-planner', pane.id, 'Planner');
    const plain = createPanel('panel-report-plain', pane.id, 'Plain');
    const list = createPanel('panel-report-list', pane.id, 'List');
    const truncated = createPanel('panel-report-truncated', pane.id, 'Truncated');
    const silent = createPanel('panel-report-silent', pane.id, 'Silent');
    for (const panel of [planner, plain, list, truncated, silent]) await seedPanel(panel);
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: pane.id });
    const status = { profile: 'planner', state: 'running', checks: { pass: ['S-1'] }, pr: null };
    const reports = {
      [planner.id]: { state: 'ready' as const, pr: 412, head: '3f9c2ab', summary: JSON.stringify(status), summaryPath: '/tmp/status.json', reportedAt: '2026-10-17T16:00:00.000Z' },
      [plain.id]: { state: 'blocked' as const, question: 'Which filename?', summary: 'Waiting on a filename.', reportedAt: '2026-10-17T16:01:00.000Z' },
      [list.id]: { state: 'done' as const, summary: '["a","b"]', reportedAt: '2026-10-17T16:02:00.000Z' },
      [truncated.id]: { state: 'ready' as const, summary: '{"long":"…\n[summary truncated]', summaryTruncated: true as const, reportedAt: '2026-10-17T16:03:00.000Z' },
    };
    for (const panel of [planner, plain, list, truncated]) {
      await panelManager.updatePanel(panel.id, { state: { ...panel.state, customState: { ...panel.state.customState, agentReport: reports[panel.id] } } });
    }
    liveStates.set(silent.id, 'working');
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(panelId => panelId === silent.id ? {
      initialized: true,
      scrollbackBuffer: '',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'active',
      lastActivityTime: '2026-10-17T16:05:00.000Z',
      currentCommand: '',
    } : null);

    const overview = await fixture.manager.overview({ sessionId: named.session.id });
    const panels = new Map(overview.panes[0].panels.map(panel => [panel.panelId, panel]));

    expect(panels.get(planner.id)?.report).toEqual({ ...reports[planner.id], data: status });
    expect(panels.get(plain.id)?.report).toEqual(reports[plain.id]);
    expect(panels.get(list.id)?.report).toEqual(reports[list.id]);
    expect(panels.get(truncated.id)?.report).toEqual(reports[truncated.id]);
    expect(panels.get(silent.id)).toMatchObject({ state: 'working', lastActivityAt: '2026-10-17T16:05:00.000Z' });
    expect(panels.get(silent.id)).not.toHaveProperty('report');
    // The per-Pane report keeps its shape: the newest report, its panel, and no data.
    expect(overview.panes[0].report).toEqual({ ...reports[truncated.id], panelId: truncated.id });
  });

  it('F-1, F-2: a deeply nested summary leaves the overview readable, and __proto__ keys survive in data', async () => {
    const fixture = createFixture();
    const named = await fixture.manager.create({ name: 'Hostile reports' });
    const pane = paneFixture(fixture, 'hostile-report-pane', { name: 'Hostile Report Pane' });
    const nested = createPanel('hostile-report-nested', pane.id, 'Nested');
    const proto = createPanel('hostile-report-proto', pane.id, 'Proto');
    await seedPanel(nested);
    await seedPanel(proto);
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: pane.id });
    const nestedReport = normalizeAgentReport({ state: 'ready', summary: `{"x":${'['.repeat(2000)}0${']'.repeat(2000)}}` }, '2026-10-17T16:00:00.000Z');
    const protoSummary = '{"__proto__":{"state":"changed","__proto__":{"deep":true}},"ok":true}';
    const protoReport = normalizeAgentReport({ state: 'ready', summary: protoSummary }, '2026-10-17T16:01:00.000Z');
    expect(nestedReport.summaryTruncated).toBeUndefined();
    await panelManager.updatePanel(nested.id, { state: { ...nested.state, customState: { ...nested.state.customState, agentReport: nestedReport } } });
    await panelManager.updatePanel(proto.id, { state: { ...proto.state, customState: { ...proto.state.customState, agentReport: protoReport } } });

    const overview = await fixture.manager.overview({ sessionId: named.session.id });
    const panels = new Map(overview.panes[0].panels.map(panel => [panel.panelId, panel]));

    expect(panels.get(nested.id)?.report).toEqual(nestedReport);
    const data = panels.get(proto.id)?.report?.data;
    expect(data && Object.hasOwn(data, '__proto__')).toBe(true);
    expect(JSON.stringify(data)).toBe(protoSummary);
    // The daemon serializes the overview through the JSON transport; the result survives it unchanged.
    expect(serializeJsonTransport(overview, boundary.json)).toEqual(JSON.parse(JSON.stringify(overview)));
    expect(JSON.stringify(serializeJsonTransport(overview, boundary.json))).toBe(JSON.stringify(overview));
  });

  it('reports a Session as paused in every response once its chat is paused', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Paused work' });
    const mark = { at: '2026-11-04T22:50:20.984Z', by: 'manual' as const };
    const chat = fixture.sessions.get(created.session.internalSessionId);
    if (!chat) throw new Error('The Session has no chat Pane');
    chat.paused = mark;

    const find = (result: { sessions: OrchestrationSessionRecord[] }) => result.sessions.find(session => session.id === created.session.id);
    expect(find(await fixture.manager.list())?.paused).toEqual(mark);
    expect(find(await fixture.manager.select({ sessionId: created.session.id }))?.paused).toEqual(mark);
    expect(find(await fixture.manager.reorder([created.session.id]))?.paused).toEqual(mark);
    expect((await fixture.manager.update({ sessionId: created.session.id }, { goal: 'Still paused' })).paused).toEqual(mark);

    chat.paused = undefined;
    expect(find(await fixture.manager.select({ sessionId: created.session.id }))?.paused).toBeUndefined();
  });

  it('reports when a Session was last opened: selecting it views its chat Pane', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Opened work' });
    const find = (result: { sessions: OrchestrationSessionRecord[] }) => result.sessions.find(session => session.id === created.session.id);
    expect(find(await fixture.manager.list())?.openedAt).toBeUndefined();

    // The host stores the view as SQLite's UTC CURRENT_TIMESTAMP.
    expect(find(await fixture.manager.select({ sessionId: created.session.id }))?.openedAt).toBe('2026-11-25T09:30:00.000Z');
    expect(find(await fixture.manager.list())?.openedAt).toBe('2026-11-25T09:30:00.000Z');
  });

  it('supports exact-name selectors and rejects lost updates with an optimistic revision guard', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Context handoff', context: 'Initial context' });
    const updated = await fixture.manager.update({ name: 'Context handoff' }, { context: 'Updated context' });
    expect(updated.context).toBe('Updated context');
    expect(updated.revision).toBe(created.session.revision + 1);
    const staleInput: OrchestrationSessionUpdateInput = { goal: 'Lost update', expectedRevision: created.session.revision };
    await expect(fixture.manager.update({ sessionId: created.session.id }, staleInput)).rejects.toThrow('changed; expected revision');
    const selected = await fixture.manager.select({ sessionId: 'Context handoff' });
    expect(selected.selectedSessionId).toBe(created.session.id);
    const fetched = await fixture.manager.get({ name: 'Context handoff' });
    expect(fetched.context).toBe('Updated context');
    const createInput: OrchestrationSessionCreateInput = { name: 'Another context' };
    await fixture.manager.create(createInput);
    await expect(fixture.manager.create({ name: 'context handoff' })).rejects.toThrow('already exists');
  });

  it('normalizes names for create and rename uniqueness while preserving the existing record', async () => {
    const fixture = createFixture();
    const first = await fixture.manager.create({ name: 'Alpha', context: 'Keep this context' });

    await expect(fixture.manager.create({ name: ' Alpha ' })).rejects.toThrow('already exists');
    await expect(fixture.manager.create({ name: 'alpha' })).rejects.toThrow('already exists');

    const second = await fixture.manager.create({ name: 'Beta' });
    await expect(fixture.manager.update({ sessionId: second.session.id }, { name: ' alpha ' })).rejects.toThrow('already exists');
    await expect(fixture.manager.update({ sessionId: first.session.id }, { name: '   ' })).rejects.toThrow('Session name is required');

    const preserved = await fixture.manager.get({ sessionId: first.session.id });
    expect(preserved).toMatchObject({ name: 'Alpha', context: 'Keep this context', revision: first.session.revision });
  });

  it('archives and restores a Session durably without changing its owner, history, or associations', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({
      name: 'Archive me',
      goal: 'Keep the archive metadata.',
      context: 'Preserve this context.',
      decisions: ['Keep the conversation.'],
    });
    const pane = paneFixture(fixture, 'archive-pane', { name: 'Archive worktree' });
    const panePanel = await seedPanel(createPanel('archive-pane-terminal', pane.id, 'Archive terminal'));
    const associated = await fixture.manager.associate(
      { sessionId: created.session.id },
      { paneId: pane.id, panelIds: [panePanel.id] },
    );
    await fixture.manager.select({ sessionId: created.session.id });
    const pinned = await fixture.manager.update({ sessionId: created.session.id }, { isPinned: true });
    expect(pinned.isPinned).toBe(true);
    const before = await fixture.manager.get({ sessionId: created.session.id });
    const ownerId = before.internalSessionId;
    const orchestrationPanelId = before.panelIds[before.agent];
    const guideCallsBeforeArchive = vi.mocked(fixture.skillCacheManager.ensurePaneChatGuide).mock.calls.length;

    const archived = await fixture.manager.update(
      { sessionId: created.session.id },
      { archived: true, expectedRevision: before.revision },
    );
    expect(archived).toMatchObject({
      id: before.id,
      archived: true,
      goal: before.goal,
      context: before.context,
      decisions: before.decisions,
      isPinned: true,
      associations: [expect.objectContaining({ paneId: pane.id, panelIds: [panePanel.id] })],
    });
    expect((await fixture.manager.list()).selectedSessionId).not.toBe(created.session.id);
    expect(fixture.sessions.has(ownerId)).toBe(true);
    expect(panelManager.getPanel(orchestrationPanelId)).toBeDefined();
    expect(fixture.sessions.has(pane.id)).toBe(true);
    expect(panelManager.getPanel(panePanel.id)).toBeDefined();
    expect(vi.mocked(fixture.skillCacheManager.ensurePaneChatGuide).mock.calls.length).toBe(guideCallsBeforeArchive);
    await expect(fixture.manager.getView({ sessionId: created.session.id })).rejects.toThrow('restore it before opening');

    const reloaded = new OrchestrationSessionManager(
      fixture.configManager,
      fixture.sessionManager,
      fixture.skillCacheManager,
      fixture.paneChatManager,
      undefined,
      fixture.store,
    );
    await reloaded.initialize();
    const afterReload = await reloaded.list();
    expect(afterReload.sessions.find(session => session.id === created.session.id)).toMatchObject({
      archived: true,
      id: before.id,
      associations: associated.associations,
      context: before.context,
      isPinned: true,
    });
    expect(afterReload.selectedSessionId).not.toBe(created.session.id);

    const selectedBeforeRestore = afterReload.selectedSessionId;
    const restored = await reloaded.update({ sessionId: created.session.id }, { archived: false });
    expect(restored).toMatchObject({ id: before.id, archived: false, isPinned: true, associations: associated.associations });
    expect((await reloaded.list()).selectedSessionId).toBe(selectedBeforeRestore);
    expect((await reloaded.getView({ sessionId: created.session.id })).session.archived).toBe(false);
  });

  it('does not unarchive an archived legacy Session during startup migration', async () => {
    await seedLegacyPanel('claude', 'archived-legacy-claude-history');
    const legacy = {
      ...orchestrationRecord(LEGACY_ORCHESTRATION_SESSION_ID, 'Pane Chat'),
      archived: true,
      agent: 'codex',
      internalSessionId: PANE_CHAT_SESSION_ID,
      panelIds: {
        claude: getPaneChatPanelId('claude'),
        codex: getPaneChatPanelId('codex'),
        cursor: getPaneChatPanelId('cursor'),
        opencode: getPaneChatPanelId('opencode'),
        pi: getPaneChatPanelId('pi'),
      },
    } satisfies OrchestrationSessionRecord;
    const fixture = createFixture('codex', {
      version: 1,
      sessions: [legacy],
      selectedSessionId: legacy.id,
    });

    await fixture.manager.initialize();
    const listed = await fixture.manager.list();
    expect(listed.sessions.find(session => session.id === legacy.id)?.archived).toBe(true);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.selectedSessionId).toBeUndefined();
    expect(fixture.paneChatManager.getOrCreate).not.toHaveBeenCalled();
  });
});

describe('OrchestrationSessionManager Session order', () => {
  const start = Date.parse('2026-10-11T10:00:00.000Z');

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Creates Sessions one second apart, so creation order is unambiguous. */
  async function createInOrder(fixture: ReturnType<typeof createFixture>, names: string[]): Promise<Record<string, string>> {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ids: Record<string, string> = {};
    for (const [index, name] of names.entries()) {
      vi.setSystemTime(start + (index + 1) * 1000);
      ids[name] = (await fixture.manager.create({ name })).session.id;
    }
    return ids;
  }

  async function namesInOrder(fixture: ReturnType<typeof createFixture>, filter: (session: OrchestrationSessionRecord) => boolean = session => session.archived !== true): Promise<string[]> {
    const listed = await fixture.manager.list();
    return listed.sessions.filter(filter).filter(session => session.id !== LEGACY_ORCHESTRATION_SESSION_ID).map(session => session.name);
  }

  it('lists Sessions newest first when no order was saved', async () => {
    const fixture = createFixture();
    await createInOrder(fixture, ['A', 'B', 'C', 'D']);

    expect(await namesInOrder(fixture)).toEqual(['D', 'C', 'B', 'A']);
  });

  it('lists and selects in the saved order, and adds a new Session at the top', async () => {
    const fixture = createFixture();
    const ids = await createInOrder(fixture, ['A', 'B', 'C', 'D']);

    await fixture.manager.reorder([ids.A, ids.D, ids.B, ids.C]);

    expect(await namesInOrder(fixture)).toEqual(['A', 'D', 'B', 'C']);
    const selected = await fixture.manager.select({ sessionId: ids.B });
    expect(selected.sessions.map(session => session.name).filter(name => name !== 'Pane Chat')).toEqual(['A', 'D', 'B', 'C']);
    vi.setSystemTime(start + 60_000);
    await fixture.manager.create({ name: 'E' });
    expect(await namesInOrder(fixture)).toEqual(['E', 'A', 'D', 'B', 'C']);
  });

  it('changes no Session revision, timestamp or activity, and tells clients the order changed', async () => {
    const fixture = createFixture();
    const ids = await createInOrder(fixture, ['A', 'B', 'C']);
    const before = await fixture.manager.list();
    const changes: unknown[] = [];
    fixture.manager.on('changed', change => changes.push(change));

    await fixture.manager.reorder([ids.C, ids.A]);

    const after = await fixture.manager.list();
    const fields = (session: OrchestrationSessionRecord) => [session.id, session.revision, session.updatedAt, session.activity.length];
    expect(after.sessions.map(fields).sort()).toEqual(before.sessions.map(fields).sort());
    expect(changes).toEqual([{ sessionId: ids.C, kind: 'reordered' }]);
  });

  it('moves only the listed Sessions, among the places they already hold', async () => {
    const fixture = createFixture();
    const ids = await createInOrder(fixture, ['A', 'B', 'C', 'D', 'E']);

    // A list that shows only B and D (such as Pinned) swaps them; A, C and E stay where they are.
    await fixture.manager.reorder([ids.B, ids.D]);

    expect(await namesInOrder(fixture)).toEqual(['E', 'B', 'C', 'D', 'A']);
  });

  it('ignores unknown and repeated ids', async () => {
    const fixture = createFixture();
    const ids = await createInOrder(fixture, ['A', 'B', 'C']);

    await fixture.manager.reorder(['missing-session', ids.C, ids.C, ids.A]);

    expect(await namesInOrder(fixture)).toEqual(['C', 'B', 'A']);
  });

  it('returns a restored Session to the place it had before it was archived', async () => {
    const fixture = createFixture();
    const ids = await createInOrder(fixture, ['A', 'B', 'C', 'D']);
    await fixture.manager.reorder([ids.A, ids.D, ids.B, ids.C]);

    await fixture.manager.update({ sessionId: ids.B }, { archived: true });
    // A client that sees only the active Sessions reorders them while B is archived.
    await fixture.manager.reorder([ids.C, ids.A, ids.D]);
    await fixture.manager.update({ sessionId: ids.B }, { archived: false });

    expect(await namesInOrder(fixture)).toEqual(['C', 'A', 'B', 'D']);
  });

  it('selects the next Session in the saved order when the selected one is archived', async () => {
    const fixture = createFixture();
    const ids = await createInOrder(fixture, ['A', 'B', 'C']);
    await fixture.manager.reorder([ids.C, ids.B, ids.A, LEGACY_ORCHESTRATION_SESSION_ID]);
    await fixture.manager.select({ sessionId: ids.C });

    await fixture.manager.update({ sessionId: ids.C }, { archived: true });

    expect((await fixture.manager.list()).selectedSessionId).toBe(ids.B);
  });

  it('loads a store written before ordering, and one whose order names deleted Sessions', async () => {
    const first = { ...orchestrationRecord('session-first', 'First'), createdAt: '2026-10-01T00:00:00.000Z' };
    const second = { ...orchestrationRecord('session-second', 'Second'), createdAt: '2026-10-02T00:00:00.000Z' };
    const unordered = createFixture('codex', { version: 1, sessions: [second, first] });
    expect(await namesInOrder(unordered)).toEqual(['Second', 'First']);

    const stale = createFixture('codex', { version: 1, order: ['session-gone', 'session-first', 'session-second'], sessions: [second, first] });
    expect(await namesInOrder(stale)).toEqual(['First', 'Second']);
    expect(stale.store.read().order).toEqual(['session-first', 'session-second']);
  });
});

function partialRuntime(value: Partial<PaneRuntime>): PaneRuntime {
  // SAFETY: The test reads only the event sink from the runtime.
  return value as PaneRuntime;
}
