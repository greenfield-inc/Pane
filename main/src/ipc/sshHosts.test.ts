import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { setPaneRuntime, type PaneRuntime } from '../core/runtime';
import { databaseService } from '../services/database';
import { panelManager } from '../services/panelManager';
import type { SessionManager } from '../services/sessionManager';
import { SSH_HOSTS_SESSION_ID } from '../../../shared/types/sshHosts';
import type { TerminalPanelState } from '../../../shared/types/panels';
import type { AppServices } from './types';
import { registerSshHostHandlers } from './sshHosts';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member read by the tested code.
  return value as Contract;
}

/** The Session store calls the SSH handlers make, backed by the real database. */
const sessionManager = partial<SessionManager>({
  getSession: (id: string) => databaseService.getSession(id) ? partial({ id }) : undefined,
  createSessionWithId: (id: string, name: string, worktreePath: string) => {
    databaseService.createSession({
      id, name, initial_prompt: '', worktree_name: name, worktree_path: worktreePath,
      project_id: null, tool_type: 'none', is_hidden: true, worktree_ownership: 'external',
    });
    return partial({ id });
  },
  updateSession: () => undefined,
});

let home: string;
let registry: PaneCommandRegistry;

async function writeConfig(text: string): Promise<void> {
  await fs.writeFile(path.join(home, '.ssh', 'config'), text);
}

async function open(alias: string, newTab = false): Promise<{ success: boolean; data?: { panelId: string }; error?: string }> {
  const args: PaneCommandValue[] = [alias, newTab];
  // SAFETY: ssh-hosts:open answers with an IPCResponse whose data is SshHostOpenResult.
  return await registry.invoke('ssh-hosts:open', args) as { success: boolean; data?: { panelId: string }; error?: string };
}

function sshTabs(): Array<{ title: string; command?: string }> {
  return panelManager.getPanelsForSession(SSH_HOSTS_SESSION_ID).map(panel => ({
    title: panel.title,
    // SAFETY: SSH view tabs are terminal panels whose custom state is TerminalPanelState.
    command: (panel.state.customState as TerminalPanelState).initialCommand,
  }));
}

describe('ssh-hosts:open', () => {
  beforeEach(async () => {
    setPaneRuntime(partial<PaneRuntime>({ eventSink: { send: vi.fn() } }));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-ssh-open-'));
    await fs.mkdir(path.join(home, '.ssh'));
    vi.spyOn(os, 'userInfo').mockReturnValue(partial({ homedir: home }));
    registry = new PaneCommandRegistry();
    registerSshHostHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({ sessionManager }), registry);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const panel of panelManager.getPanelsForSession(SSH_HOSTS_SESSION_ID)) await panelManager.deletePanel(panel.id);
    await fs.rm(home, { recursive: true, force: true });
  });

  it('reuses one tab for repeated clicks on the same host', async () => {
    await writeConfig('Host mini\n');

    const first = await open('mini');
    const second = await open('mini');

    expect(first.success && second.success).toBe(true);
    expect(second.data?.panelId).toBe(first.data?.panelId);
    expect(sshTabs()).toEqual([{ title: 'mini', command: 'ssh mini' }]);
  });

  it('opens another tab on the same host when asked for a new one', async () => {
    await writeConfig('Host mini\n');

    const first = await open('mini');
    const second = await open('mini', true);

    expect(second.data?.panelId).not.toBe(first.data?.panelId);
    expect(sshTabs()).toEqual([{ title: 'mini', command: 'ssh mini' }, { title: 'mini', command: 'ssh mini' }]);
  });

  it('keeps an open tab reachable after its host leaves the config, and connects nowhere new', async () => {
    await writeConfig('Host mini\n');
    const opened = await open('mini');
    await writeConfig('Host *\n');

    await expect(open('mini')).resolves.toEqual({ success: true, data: { sessionId: SSH_HOSTS_SESSION_ID, panelId: opened.data?.panelId } });
    await expect(open('mini', true)).resolves.toEqual({ success: false, error: 'That host is no longer in your SSH config' });
    expect(sshTabs()).toEqual([{ title: 'mini', command: 'ssh mini' }]);
  });

  it('never types an alias the config does not list as a plain host', async () => {
    await writeConfig('Host -V @prod\n');

    for (const alias of ['-V', '@prod', 'mini; rm -rf ~']) {
      await expect(open(alias)).resolves.toEqual({ success: false, error: 'That host is no longer in your SSH config' });
    }
    expect(sshTabs()).toEqual([]);
  });
});
