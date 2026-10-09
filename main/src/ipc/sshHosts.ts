import os from 'os';
import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import type { SessionManager } from '../services/sessionManager';
import { panelManager } from '../services/panelManager';
import { listSshConfigHosts } from '../services/sshConfigHosts';
import { withLock } from '../utils/mutex';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { SSH_HOSTS_SESSION_ID, type SshHostList, type SshHostOpenResult } from '../../../shared/types/sshHosts';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

function sshHostOf(panel: ToolPanel): string | undefined {
  // SAFETY: Terminal panels store TerminalPanelState as their custom state.
  return panel.type === 'terminal' ? (panel.state.customState as TerminalPanelState | undefined)?.sshHost : undefined;
}

/**
 * The SSH view's Session: hidden and project-free like Pane Chat's, created on
 * the first click. Its shells start in the home folder, which Pane marks
 * external so it never removes or commits to it.
 */
function ensureSshSession(sessionManager: SessionManager): void {
  if (sessionManager.getSession(SSH_HOSTS_SESSION_ID)) return;
  sessionManager.createSessionWithId(
    SSH_HOSTS_SESSION_ID, 'SSH', os.homedir(), '', 'ssh', 'ignore', undefined, false, undefined, 'none',
    undefined, undefined, false, { detached: true, hidden: true, worktreeOwnership: 'external' },
  );
  sessionManager.updateSession(SSH_HOSTS_SESSION_ID, { status: 'stopped' });
}

/** Aliases with an open tab, in tab order, whether or not the config still lists them. */
function openSshHosts(): string[] {
  const aliases = panelManager.getPanelsForSession(SSH_HOSTS_SESSION_ID).map(sshHostOf);
  return [...new Set(aliases.filter((alias): alias is string => alias !== undefined))];
}

async function openSshHost(sessionManager: SessionManager, alias: string, newTab: boolean): Promise<SshHostOpenResult> {
  const hosts = await listSshConfigHosts();
  return withLock('ssh-hosts-session', async () => {
    // An open tab stays reachable after its host leaves the config.
    const existing = newTab ? undefined : panelManager.getPanelsForSession(SSH_HOSTS_SESSION_ID).find(panel => sshHostOf(panel) === alias);
    // Only an alias the config lists right now is ever typed into a shell.
    if (!existing && !hosts.includes(alias)) throw new Error('That host is no longer in your SSH config');
    ensureSshSession(sessionManager);
    const panel = existing ?? await panelManager.createPanel({
      sessionId: SSH_HOSTS_SESSION_ID,
      type: 'terminal',
      title: alias,
      initialState: { customState: { initialCommand: `ssh ${alias}`, sshHost: alias } satisfies TerminalPanelState },
      announceActivation: false,
    });
    await panelManager.rememberActivePanel(SSH_HOSTS_SESSION_ID, panel.id);
    return { sessionId: SSH_HOSTS_SESSION_ID, panelId: panel.id };
  });
}

export function registerSshHostHandlers(
  ipcMain: IpcMain,
  { sessionManager }: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('ssh-hosts:list', async () => {
    try {
      const data: SshHostList = { hosts: await listSshConfigHosts(), openHosts: openSshHosts() };
      return { success: true, data };
    } catch (error) {
      console.error('[SSH hosts] Failed to list hosts:', error instanceof Error ? error.message : error);
      return { success: false, error: 'Failed to read your SSH config' };
    }
  });

  commandRegistry.register('ssh-hosts:open', async (alias: PaneCommandValue, newTab: PaneCommandValue) => {
    try {
      const data = await openSshHost(
        sessionManager,
        decodeBoundary(alias, boundary.string),
        decodeBoundary(newTab, boundary.optional(boundary.boolean)) === true,
      );
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open the host' };
    }
  });

  commandRegistry.bindChannels(ipcMain, ['ssh-hosts:list', 'ssh-hosts:open']);
}
