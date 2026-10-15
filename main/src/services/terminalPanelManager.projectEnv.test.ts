import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPaneRuntimeForTests, setPaneRuntime, type PtyHandleLike, type PtyHostRuntime } from '../core/runtime';
import type { PtyHostSpawnOpts } from '../ptyHost/types';
import type { ToolPanel } from '../../../shared/types/panels';
import { ConfigManager } from './configManager';
import { databaseService } from './database';
import { panelManager as panelManagerMock } from '../test/setup';
import { inProcessEmulatorHost } from '../test/inProcessEmulatorHost';
import { TerminalPanelManager } from './terminalPanelManager';
import { ProjectEnvService } from './projectEnvVars';
import { FakeKeychain } from '../test/fakeKeychain';

class FakePtyHandle implements PtyHandleLike {
  readonly pid = 4242;
  private readonly listeners = new Set<(data: string) => void>();
  onData(listener: (data: string) => void) {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  emit(data: string): void {
    for (const listener of this.listeners) listener(data);
  }
  onExit() { return { dispose: () => undefined }; }
  async write(): Promise<void> {}
  async resize(): Promise<void> {}
  async kill(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
}

class FakePtyHost implements PtyHostRuntime {
  readonly handles = new Map<string, FakePtyHandle>();
  readonly spawnOptions: PtyHostSpawnOpts[] = [];

  async spawn(opts: PtyHostSpawnOpts): Promise<{ ptyId: string; pid: number }> {
    this.spawnOptions.push(opts);
    const ptyId = `pty-${this.handles.size + 1}`;
    this.handles.set(ptyId, new FakePtyHandle());
    return { ptyId, pid: 4242 };
  }

  async write(): Promise<void> {}
  async resize(): Promise<void> {}
  async kill(): Promise<void> {}
  async ack(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  getHandle(ptyId: string): PtyHandleLike | undefined { return this.handles.get(ptyId); }
}

describe('terminal panels and project environment variables', () => {
  let tempDir: string;
  let ptyHost: FakePtyHost;
  let managers: TerminalPanelManager[];
  let curaId: number;
  let lastManager: TerminalPanelManager | undefined;
  let keychain: FakeKeychain;
  let projectEnv: ProjectEnvService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-terminal-project-env-'));
    ptyHost = new FakePtyHost();
    managers = [];
    keychain = new FakeKeychain();
    projectEnv = new ProjectEnvService(databaseService, () => keychain, 'Pane');
    const configManager = new ConfigManager();
    vi.spyOn(configManager, 'getUsePtyHost').mockReturnValue(true);
    setPaneRuntime({
      eventSink: {
        send: () => {},
      },
      getConfigManager: () => configManager,
      getPtyHostRuntime: () => ptyHost,
      getWebviewContextMap: () => new Map(),
    });
    panelManagerMock.updatePanel.mockResolvedValue(undefined);

    const suffix = path.basename(tempDir);
    const cura = databaseService.createProject(`cura-${suffix}`, path.join(tempDir, 'cura'));
    const other = databaseService.createProject(`other-${suffix}`, path.join(tempDir, 'other'));
    curaId = cura.id;
    for (const [id, projectId] of [[`cura-pane-${suffix}`, cura.id], [`other-pane-${suffix}`, other.id]] as const) {
      databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: path.join(tempDir, id), project_id: projectId, tool_type: 'none' });
    }
    await projectEnv.save(cura.id, [
      { key: 'UIVERIFY_API_KEY', source: 'keychain', secret: 'sk-test-secret' },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);
  });

  afterEach(async () => {
    for (const manager of managers) {
      for (const panelId of manager.getActiveTerminals()) await manager.destroyTerminal(panelId);
    }
    panelManagerMock.updatePanel.mockReset();
    panelManagerMock.getPanel.mockReset();
    resetPaneRuntimeForTests();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function panelIn(pane: 'cura' | 'other', id: string, customState: ToolPanel['state']['customState'] = {}): ToolPanel {
    return {
      id: `${id}-${path.basename(tempDir)}`,
      sessionId: `${pane}-pane-${path.basename(tempDir)}`,
      type: 'terminal',
      title: 'Terminal',
      state: { isActive: false, hasBeenViewed: true, customState },
      metadata: { createdAt: '2026-10-13T00:00:00.000Z', lastActiveAt: '2026-10-13T00:00:00.000Z', position: 0 },
    };
  }

  async function start(panel: ToolPanel, wslContext?: { enabled: boolean; distribution: string; linuxPath: string }): Promise<PtyHostSpawnOpts> {
    const manager = new TerminalPanelManager(inProcessEmulatorHost, undefined, projectEnv);
    managers.push(manager);
    lastManager = manager;
    panelManagerMock.getPanel.mockReturnValue(panel);
    databaseService.createPanel({ id: panel.id, sessionId: panel.sessionId, type: 'terminal', title: panel.title, state: panel.state });
    await manager.initializeTerminal(panel, tempDir, wslContext);
    const spawned = ptyHost.spawnOptions.at(-1);
    if (!spawned) throw new Error('no PTY was spawned');
    return spawned;
  }

  it('sets the project\'s variables in its terminal and agent panels', async () => {
    const terminal = await start(panelIn('cura', 'terminal'));
    const agent = await start(panelIn('cura', 'agent', { agentType: 'claude', initialCommand: 'claude' }));

    for (const spawned of [terminal, agent]) {
      expect(spawned.env.UIVERIFY_API_KEY).toBe('sk-test-secret');
      expect(spawned.env.NODE_ENV).toBe('development');
    }
  });

  it('does not give another project\'s Pane the variables', async () => {
    const spawned = await start(panelIn('other', 'terminal'));

    expect(spawned.env.UIVERIFY_API_KEY).toBeUndefined();
    expect(spawned.env.NODE_ENV).toBe(process.env.NODE_ENV);
  });

  it('keeps Pane\'s own variables when a stored project variable collides with one', async () => {
    databaseService.replaceProjectEnvVars(curaId, [{ key: 'PANE_PANEL_ID', source: 'plain', value: 'spoofed' }]);
    const panel = panelIn('cura', 'terminal');

    const spawned = await start(panel);

    expect(spawned.env.PANE_PANEL_ID).toBe(panel.id);
  });

  it('opens the terminal without a variable whose keychain item cannot be read, and says so in the pane', async () => {
    keychain.fail('Pane', `${curaId}:UIVERIFY_API_KEY`, 'User interaction is not allowed.');

    const panel = panelIn('cura', 'terminal');
    const spawned = await start(panel);

    expect(spawned.env.UIVERIFY_API_KEY).toBeUndefined();
    expect(spawned.env.NODE_ENV).toBe('development');
    // Shown after the shell's first prompt, once the panel's viewer is listening.
    Array.from(ptyHost.handles.values()).at(-1)?.emit('$ ');
    await vi.waitFor(() => expect(lastManager?.getTerminalSnapshot(panel.id)?.scrollbackBuffer).toContain('UIVERIFY_API_KEY'));
    const shown = lastManager?.getTerminalSnapshot(panel.id)?.scrollbackBuffer ?? '';
    expect(shown).toContain('User interaction is not allowed');
    expect(shown).not.toContain('sk-test-secret');
  });

  it('forwards the project\'s variables into a WSL shell', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const spawned = await start(panelIn('cura', 'terminal'), { enabled: true, distribution: 'Ubuntu', linuxPath: '/home/u/cura' });

    expect(spawned.env.UIVERIFY_API_KEY).toBe('sk-test-secret');
    expect(spawned.env.WSLENV?.split(':')).toEqual(expect.arrayContaining(['UIVERIFY_API_KEY', 'NODE_ENV']));
  });
});
