import fs from 'fs';
import os from 'os';
import { withLock } from '../utils/mutex';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import { sessionWorkspacePath } from './sessionWorkspace';
import type { SessionManager } from './sessionManager';
import type { Session } from '../types/session';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import {
  HOST_TERMINAL_PANEL_ID,
  HOST_TERMINAL_SESSION_ID,
  HOST_TERMINAL_WORKSPACE,
  hostTerminalTypedInput,
  type HostTerminalOpenRequest,
  type HostTerminalRef,
  type HostTerminalState,
} from '../../../shared/types/hostTerminal';

const HOST_TERMINAL_TITLE = 'Terminal';

/**
 * The one plain shell on this host. It needs no repository: a hidden detached
 * session owns it (like Pane Chat), so it never shows up as a project or Pane,
 * and reopening it returns the same running shell.
 */
export class HostTerminalManager {
  constructor(private readonly sessionManager: SessionManager) {}

  async open(request: HostTerminalOpenRequest = {}): Promise<HostTerminalState<Session>> {
    return withLock('host-terminal', async () => {
      const session = this.ensureSession();
      const panel = await this.ensurePanel(session.id);
      await panelManager.setActivePanel(session.id, panel.id);
      const input = request.input === undefined ? '' : hostTerminalTypedInput(request.input);
      const cwd = os.homedir();

      if (terminalPanelManager.isTerminalInitialized(panel.id)) {
        if (input) terminalPanelManager.writeToTerminal(panel.id, input);
      } else {
        if (input) await this.stageInput(panel, input);
        await terminalPanelManager.initializeTerminal(panelManager.getPanel(panel.id) ?? panel, cwd);
      }

      return {
        session,
        panel: panelManager.getPanel(panel.id) ?? panel,
        cwd,
        started: terminalPanelManager.isTerminalInitialized(panel.id),
      };
    });
  }

  /** Read-only: null until the terminal was first opened on this host. */
  get(): HostTerminalRef | null {
    if (!this.sessionManager.getSession(HOST_TERMINAL_SESSION_ID) || !panelManager.getPanel(HOST_TERMINAL_PANEL_ID)) {
      return null;
    }
    return {
      sessionId: HOST_TERMINAL_SESSION_ID,
      panelId: HOST_TERMINAL_PANEL_ID,
      started: terminalPanelManager.isTerminalInitialized(HOST_TERMINAL_PANEL_ID),
    };
  }

  private ensureSession(): Session {
    const existing = this.sessionManager.getSession(HOST_TERMINAL_SESSION_ID);
    if (existing) return existing;

    const workspace = sessionWorkspacePath(HOST_TERMINAL_WORKSPACE);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const session = this.sessionManager.createSessionWithId(
      HOST_TERMINAL_SESSION_ID,
      HOST_TERMINAL_TITLE,
      workspace,
      '',
      'host-terminal',
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
    return this.sessionManager.getSession(session.id) ?? session;
  }

  private async ensurePanel(sessionId: string): Promise<ToolPanel> {
    const existing = panelManager.getPanel(HOST_TERMINAL_PANEL_ID);
    if (existing) return existing;

    const initialState: TerminalPanelState = { isCliPanel: false };
    return panelManager.createPanel({
      id: HOST_TERMINAL_PANEL_ID,
      sessionId,
      type: 'terminal',
      title: HOST_TERMINAL_TITLE,
      initialState,
      metadata: { permanent: true },
    });
  }

  /** The shell types this once it starts, and never presses Enter. */
  private async stageInput(panel: ToolPanel, input: string): Promise<void> {
    // SAFETY: The host terminal panel is created with a TerminalPanelState.
    const current = panel.state.customState as TerminalPanelState | undefined;
    const customState: TerminalPanelState = {
      ...current,
      initialInput: input,
      initialInputSubmitStrategy: 'none',
      initialInputSentAt: undefined,
      initialInputError: undefined,
    };
    await panelManager.updatePanel(panel.id, { state: { ...panel.state, customState } });
  }
}
