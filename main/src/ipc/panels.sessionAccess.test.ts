import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { ToolPanel } from '../../../shared/types/panels';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { databaseService } from '../services/database';
import { OrchestrationSessionStore } from '../services/orchestrationSessionStore';
import { sessionWorkspacePath } from '../services/sessionWorkspace';
import { getAppDirectory } from '../utils/appDirectory';
import { registerPanelHandlers } from './panels';
import { panelManager } from '../services/panelManager';
import { readProfilesSwitchFrom } from '../services/agentFarm/profilesFeature';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: The fixture provides every member used by the panel creation handler.
  return value as Contract;
}

afterEach(() => vi.restoreAllMocks());

describe('desktop worker Session access', () => {
  it.each(['{broken-json', '{"version":1,"sessions":[{}]}', null])('opens an unassociated terminal when Session storage is invalid or unreadable: %s', async contents => {
    const paneId = `unassociated-${contents?.length ?? 'unreadable'}`;
    databaseService.createSession({ id: paneId, name: paneId, initial_prompt: '', worktree_name: paneId, worktree_path: '/tmp/worker', project_id: null, tool_type: 'none' });
    const registry = new PaneCommandRegistry();
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({}), registry);
    const storePath = path.join(getAppDirectory(), 'orchestration-sessions.json');
    const previous = fs.existsSync(storePath) ? fs.readFileSync(storePath) : undefined;
    if (contents === null) {
      fs.rmSync(storePath, { force: true });
      fs.mkdirSync(storePath);
    } else fs.writeFileSync(storePath, contents);
    try {
      const result = await registry.invoke('panels:create', [{ sessionId: paneId, type: 'terminal' }]);
      expect(result).toMatchObject({ success: true, data: { sessionId: paneId, type: 'terminal' } });
      // SAFETY: Successful panels:create returns a ToolPanel.
      const panel = (result as { data: ToolPanel }).data;
      expect(panel.state.customState).not.toHaveProperty('sessionFolder');
      if (contents === null) expect(fs.statSync(storePath).isDirectory()).toBe(true);
      else expect(fs.readFileSync(storePath, 'utf8')).toBe(contents);
      await expect(registry.invoke('panels:list', [paneId])).resolves.toMatchObject({ success: true, data: [expect.objectContaining({ id: panel.id })] });
    } finally {
      fs.rmSync(storePath, { recursive: true, force: true });
      if (previous) fs.writeFileSync(storePath, previous);
    }
  });

  it('grants Session access only to tabs created after association, including plain shells', async () => {
    const paneId = 'desktop-worker';
    databaseService.createSession({ id: paneId, name: paneId, initial_prompt: '', worktree_name: paneId, worktree_path: '/tmp/worker', project_id: null, tool_type: 'none' });
    const registry = new PaneCommandRegistry();
    // SAFETY: Creating a panel does not read AppServices or Electron methods besides handle.
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({}), registry);
    const create = async (command?: string) => {
      const result = await registry.invoke('panels:create', [{ sessionId: paneId, type: 'terminal', initialState: { customState: { initialCommand: command } } }]);
      expect(result).toMatchObject({ success: true });
      // SAFETY: Successful panels:create returns a ToolPanel.
      return (result as { data: ToolPanel }).data;
    };
    const old = await create('claude --dangerously-skip-permissions');
    const folder = sessionWorkspacePath('desktop-session');
    fs.mkdirSync(folder, { recursive: true });
    const store = new OrchestrationSessionStore(path.join(getAppDirectory(), 'orchestration-sessions.json'));
    store.write({ ...store.read(), sessions: [{
      id: 'desktop-session', name: 'Desktop Session', agent: 'claude', internalSessionId: 'orchestrator',
      panelIds: { claude: 'c', codex: 'x', cursor: 'u' }, goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], activity: [], revision: 0,
      createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z',
      associations: [{ paneId, panelIds: [], attachedAt: '2026-10-18T00:00:00Z' }],
    }] });
    try {
      const claude = await create('claude --dangerously-skip-permissions');
      const shell = await create();
      const custom = await create('agent-farm claude');
      expect(old.state.customState).not.toHaveProperty('sessionFolder');
      expect(claude.state.customState).toMatchObject({ sessionFolder: folder });
      expect(shell.state.customState).toMatchObject({ sessionFolder: folder });
      expect(custom.state.customState).toMatchObject({ sessionFolder: folder, initialCommand: 'agent-farm claude' });
      const command = claude.state.customState?.initialCommand;
      expect(command).toBe(process.platform === 'win32' ? 'claude --dangerously-skip-permissions' : `claude --dangerously-skip-permissions --settings '${JSON.stringify({ permissions: { additionalDirectories: [folder], deny: [`Edit(/${folder}/**)`] } })}'`);
    } finally {
      store.write({ ...store.read(), sessions: [] });
    }
  });

  // T-110 (D-2, D-4): a tab gets its Session's snapshot when it opens, and keeps it after a Reload.
  it('pins the Session\'s Agent Farm snapshot on tabs opened in its Panes, only with Profiles on', async () => {
    const paneId = 'snapshot-worker';
    databaseService.createSession({ id: paneId, name: paneId, initial_prompt: '', worktree_name: paneId, worktree_path: '/tmp/worker', project_id: null, tool_type: 'none' });
    const registry = new PaneCommandRegistry();
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({}), registry);
    const create = async (type: 'terminal' | 'chat'): Promise<ToolPanel> => {
      // Chat tabs open through chat-tab:create, which creates the panel this way.
      if (type === 'chat') return panelManager.createPanel({ sessionId: paneId, type, initialState: { customState: { agent: 'claude', launch: { kind: 'agent' }, cwd: '/tmp/worker', status: 'starting' } } });
      const result = await registry.invoke('panels:create', [{ sessionId: paneId, type }]);
      expect(result).toMatchObject({ success: true });
      // SAFETY: Successful panels:create returns a ToolPanel.
      return (result as { data: ToolPanel }).data;
    };
    const folder = sessionWorkspacePath('snapshot-session');
    fs.mkdirSync(folder, { recursive: true });
    const store = new OrchestrationSessionStore(path.join(getAppDirectory(), 'orchestration-sessions.json'));
    const write = (snapshot: string) => store.write({ ...store.read(), sessions: [{
      id: 'snapshot-session', name: 'Snapshot Session', agent: 'claude', internalSessionId: 'snapshot-orchestrator',
      panelIds: { claude: 'c', codex: 'x', cursor: 'u' }, goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], activity: [], revision: 0,
      createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z', agentFarmSnapshot: snapshot,
      associations: [{ paneId, panelIds: [], attachedAt: '2026-11-26T00:00:00Z' }],
    }] });
    write('.agent-farm/snapshots/d1');
    try {
      const off = await create('terminal');
      expect(off.state.customState).not.toHaveProperty('agentFarmSnapshot');
      readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: true }));
      const terminal = await create('terminal');
      const chat = await create('chat');
      const first = path.join(folder, '.agent-farm', 'snapshots', 'd1');
      expect(terminal.state.customState).toMatchObject({ agentFarmSnapshot: first });
      expect(chat.state.customState).toMatchObject({ agentFarmSnapshot: first });
      // After a Reload, tabs opened from then on get the new snapshot; the open ones keep theirs.
      write('.agent-farm/snapshots/d2');
      const later = await create('terminal');
      expect(later.state.customState).toMatchObject({ agentFarmSnapshot: path.join(folder, '.agent-farm', 'snapshots', 'd2') });
      await expect(registry.invoke('panels:list', [paneId])).resolves.toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ id: terminal.id, state: expect.objectContaining({ customState: expect.objectContaining({ agentFarmSnapshot: first }) }) })]) });
    } finally {
      readProfilesSwitchFrom(() => undefined);
      store.write({ ...store.read(), sessions: [] });
    }
  });
});
