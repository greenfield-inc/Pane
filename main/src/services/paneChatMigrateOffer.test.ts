import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { getPaneChatPanelId, PANE_CHAT_SESSION_ID, type PaneChatAgent } from '../../../shared/types/paneChat';
import type { TerminalPanelState } from '../../../shared/types/panels';
import { LEGACY_ORCHESTRATION_SESSION_ID } from '../../../shared/types/orchestrationSession';
import type { Session } from '../types/session';
import { getAppDirectory } from '../utils/appDirectory';
import type { ConfigManager } from './configManager';
import { databaseService } from './database';
import { OrchestrationSessionManager } from './orchestrationSessionManager';
import { OrchestrationSessionStore } from './orchestrationSessionStore';
import { PaneChatManager } from './paneChatManager';
import { MIGRATE_OFFER_PREFERENCE } from './paneChatMigrateOffer';
import { panelManager } from './panelManager';
import type { SessionManager } from './sessionManager';
import type { SkillCacheManager } from './skillCacheManager';

const SKILLS_ROOT = path.join(getAppDirectory(), 'skills', 'pane-chat', 'skills');

function serviceStub<Service>(value: Partial<Service>): Service {
  // SAFETY: The fixture exposes exactly the service methods these managers
  // reach; an unexpected method call fails at its own site.
  return value as Service;
}

function session(id: string, name: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name,
    worktreePath: path.join(getAppDirectory(), id),
    prompt: '',
    status: 'stopped',
    createdAt: new Date('2026-10-16T12:00:00.000Z'),
    lastActivity: new Date('2026-10-16T12:00:00.000Z'),
    output: [],
    jsonMessages: [],
    permissionMode: 'ignore',
    toolType: 'none',
    archived: false,
    isHidden: false,
    ...overrides,
  };
}

function storeSession(value: Session): void {
  databaseService.createSession({
    id: value.id,
    name: value.name,
    initial_prompt: value.prompt,
    worktree_name: value.id,
    worktree_path: value.worktreePath,
    project_id: null,
    permission_mode: value.permissionMode,
    tool_type: value.toolType,
    is_hidden: value.isHidden,
  });
}

function fixture(agent: PaneChatAgent = 'claude') {
  const sessions = new Map<string, Session>();
  const sessionManager = serviceStub<SessionManager>({
    emit: vi.fn(),
    getSession: vi.fn((id: string) => sessions.get(id)),
    createSessionWithId: vi.fn((id: string, name: string, worktreePath: string): Session => {
      const created = session(id, name, { worktreePath, isHidden: true });
      sessions.set(id, created);
      if (!databaseService.getSession(id)) storeSession(created);
      return created;
    }),
    updateSession: vi.fn((id: string, update: Partial<Session>) => {
      const existing = sessions.get(id);
      if (existing) Object.assign(existing, update);
    }),
    getProjectContext: vi.fn(() => null),
  });
  const config = { defaultOrchestratorAgent: agent };
  const configManager = serviceStub<ConfigManager>({
    on: vi.fn(),
    getConfig: vi.fn(() => config),
    updateConfig: vi.fn(async updates => Object.assign(config, updates)),
  });
  const skillCacheManager = serviceStub<SkillCacheManager>({
    paneChatSkillsRoot: SKILLS_ROOT,
    ensurePaneChatGuide: vi.fn(async () => path.join(getAppDirectory(), 'guide.md')),
    launchCommand: vi.fn((name: PaneChatAgent) => RUNPANE_CONTRACT.agentTemplates[name].command),
  });
  const paneChat = new PaneChatManager(configManager, sessionManager, skillCacheManager);
  return { paneChat, configManager, sessionManager, skillCacheManager };
}

function customState(agent: PaneChatAgent): TerminalPanelState | undefined {
  // SAFETY: Pane Chat panels persist TerminalPanelState as their custom state.
  return panelManager.getPanel(getPaneChatPanelId(agent))?.state.customState as TerminalPanelState | undefined;
}

/** What the terminal launch does when it passes the first prompt to the agent. */
async function launchWithFirstPrompt(agent: PaneChatAgent): Promise<void> {
  const panel = panelManager.getPanel(getPaneChatPanelId(agent));
  if (!panel) throw new Error(`No ${agent} Pane Chat panel`);
  const state: TerminalPanelState = { ...customState(agent), initialInputSentAt: '2026-10-16T12:01:00.000Z' };
  if (agent === 'claude') state.hasClaudeSessionId = true;
  await panelManager.updatePanel(panel.id, { state: { ...panel.state, customState: state } });
}

beforeEach(async () => {
  const db = databaseService.getDb();
  db.prepare('DELETE FROM user_preferences WHERE key = ?').run(MIGRATE_OFFER_PREFERENCE);
  // Pane Chat panels are permanent; return each to a terminal that never launched.
  for (const agent of ['claude', 'codex', 'cursor'] as const) {
    const panel = panelManager.getPanel(getPaneChatPanelId(agent));
    if (panel) await panelManager.updatePanel(panel.id, { state: { ...panel.state, customState: {} } });
  }
  db.prepare('DELETE FROM sessions WHERE id != ?').run(PANE_CHAT_SESSION_ID);
  db.prepare('DELETE FROM projects').run();
});

describe('Pane Chat first-run migrate offer', () => {
  it('asks once, naming the agents and the skill, when Pane has no Panes and no repositories', async () => {
    const { paneChat } = fixture();
    const state = await paneChat.getOrCreate();

    const offer = customState(state.agent)?.initialInput ?? '';
    expect(offer).toContain('Pane sent this once');
    expect(offer).toContain(path.join(SKILLS_ROOT, 'migrate-to-pane', 'SKILL.md'));
    for (const tool of ['Claude Code', 'Codex', 'OpenCode', 'Cursor', 'Conductor']) expect(offer).toContain(tool);
    expect(offer).toContain('migrate to Pane');
  });

  it('still asks when the only repository is the sample one the onboarding dialog cloned', async () => {
    databaseService.createProject('Pane', path.join(getAppDirectory(), 'projects', 'Pane'));
    const { paneChat } = fixture();
    await paneChat.getOrCreate();
    expect(customState('claude')?.initialInput).toContain('Pane sent this once');
  });

  it('sends nothing when Pane already has a repository of the user', async () => {
    databaseService.createProject('app', path.join(getAppDirectory(), 'elsewhere', 'app'));
    const { paneChat } = fixture();
    await paneChat.getOrCreate();
    expect(customState('claude')?.initialInput).toBeUndefined();
  });

  it('sends nothing when Pane already has a Pane', async () => {
    storeSession(session('feature-pane', 'feature'));
    const { paneChat } = fixture();
    await paneChat.getOrCreate();
    expect(customState('claude')?.initialInput).toBeUndefined();
  });

  it('never sends it twice: not after a restart, and not to another Pane Chat agent', async () => {
    const first = fixture('codex');
    await first.paneChat.getOrCreate();
    expect(customState('codex')?.initialInput).toContain('Pane sent this once');
    await launchWithFirstPrompt('codex');

    // A restart rebuilds the launch state of the not-yet-running terminal.
    const restarted = fixture('codex');
    await restarted.paneChat.getOrCreate();
    expect(customState('codex')?.initialInput).toBeUndefined();
    expect(databaseService.getUserPreference(MIGRATE_OFFER_PREFERENCE)).toBe('true');

    await restarted.paneChat.setAgent('claude');
    expect(customState('claude')?.initialInput).toBeUndefined();
  });

  it('keeps offering until a launch actually sends it', async () => {
    const first = fixture();
    await first.paneChat.getOrCreate();
    const restarted = fixture();
    await restarted.paneChat.getOrCreate();
    expect(customState('claude')?.initialInput).toContain('Pane sent this once');
    expect(databaseService.getUserPreference(MIGRATE_OFFER_PREFERENCE)).toBeNull();
  });

  it('reaches the built-in Pane Chat Session that the Session manager opens', async () => {
    const { paneChat, configManager, sessionManager, skillCacheManager } = fixture();
    const directory = getAppDirectory();
    const store = new OrchestrationSessionStore(path.join(directory, `sessions-${Date.now()}.json`));
    const manager = new OrchestrationSessionManager(configManager, sessionManager, skillCacheManager, paneChat, undefined, store);
    await manager.initialize();

    const view = await manager.getView({ sessionId: LEGACY_ORCHESTRATION_SESSION_ID });

    expect(view.internalSession.id).toBe(PANE_CHAT_SESSION_ID);
    // SAFETY: Session panels persist TerminalPanelState as their custom state.
    const state = view.panel.state.customState as TerminalPanelState;
    expect(state.initialInput).toContain('Pane sent this once');
    expect(state.initialInputMode).toBe('argument');
  });
});
