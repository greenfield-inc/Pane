import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import type { ConfigManager } from './configManager';
import type { PaneChatManager } from './paneChatManager';
import type { SessionManager } from './sessionManager';
import type { SkillCacheManager } from './skillCacheManager';
import type { Session } from '../types/session';
import type { ToolPanel } from '../../../shared/types/panels';
import type { AgentState } from '../../../shared/types/agentStatus';
import { databaseService } from './database';
import { panelManager } from './panelManager';
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
import { terminalPanelManager } from './terminalPanelManager';
import { sessionWorkspacePath, prepareSessionWorkspace } from './sessionWorkspace';
import { OrchestrationSessionManager } from './orchestrationSessionManager';

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
    launchCommand: vi.fn((agent: 'claude' | 'codex' | 'cursor') => RUNPANE_CONTRACT.agentTemplates[agent].command),
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
  vi.restoreAllMocks();
  liveStates.clear();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('OrchestrationSessionManager', () => {
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
      serviceStub<SkillCacheManager>({ ensurePaneChatGuide: vi.fn(async () => '/tmp/issue-653/guide.md'), launchCommand: vi.fn((agent: 'claude' | 'codex' | 'cursor') => RUNPANE_CONTRACT.agentTemplates[agent].command) }),
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
      panelIds: { claude: getPaneChatPanelId('claude'), codex: 'primary-new-codex', cursor: getPaneChatPanelId('cursor') },
    };
    const supplemental: OrchestrationSessionRecord = {
      ...orchestrationRecord(`${LEGACY_ORCHESTRATION_SESSION_ID}-codex`, 'Pane Chat · Codex'),
      internalSessionId: PANE_CHAT_SESSION_ID, agent: 'codex', archived: false, isPinned: false,
      panelIds: { claude: 'supplemental-new-claude', codex: getPaneChatPanelId('codex'), cursor: 'supplemental-new-cursor' },
      revision: 1, goal: '', context: '', nextAction: '', decisions: [], blockers: [], evidence: [], outputs: [],
      report: undefined, reportActivityId: undefined, reportAcceptedAt: undefined,
    };
    return [primary, supplemental];
  }

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
    await expect(fixture.manager.initialize()).rejects.toThrow('Interrupted move');
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

  it('rolls back metadata when hidden owner provisioning fails before publication', async () => {
    const fixture = createFixture();
    await fixture.manager.initialize();
    const changedEvents: Array<{ sessionId: string; kind: string }> = [];
    fixture.manager.on('changed', event => changedEvents.push(event));
    vi.mocked(fixture.sessionManager.createSessionWithId).mockImplementationOnce(() => {
      throw new Error('hidden owner provisioning failed');
    });

    await expect(fixture.manager.create({ name: 'Recoverable Session' })).rejects.toThrow('hidden owner provisioning failed');
    const afterFailure = await fixture.manager.list();
    expect(afterFailure.sessions.some(session => session.name === 'Recoverable Session')).toBe(false);
    expect(afterFailure.selectedSessionId).toBe(LEGACY_ORCHESTRATION_SESSION_ID);
    expect(changedEvents).toEqual([]);

    const retried = await fixture.manager.create({ name: 'Recoverable Session' });
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
    expect(detached.activity.at(-1)?.kind).toBe('detached');
    const reassigned = await fixture.manager.associate({ sessionId: second.session.id }, { paneId: pane.id });
    expect(reassigned.associations).toEqual([expect.objectContaining({ paneId: pane.id, panelIds: [] })]);
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
