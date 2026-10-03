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
  hostTerminalEnvironment,
  hostTerminalTypedInput,
  type HostTerminalOpenRequest,
  type HostTerminalRef,
  type HostTerminalState,
} from '../../../shared/types/hostTerminal';

const HOST_TERMINAL_TITLE = 'Terminal';
/** Ctrl-E then Ctrl-U: replace a half-typed or earlier prefilled line instead of appending to it. */
const CLEAR_PROMPT_LINE = '\x05\x15';

type HostTerminalPanels = Pick<typeof panelManager, 'getPanel' | 'createPanel' | 'updatePanel' | 'setActivePanel'>;
type HostTerminalShells = Pick<typeof terminalPanelManager, 'isTerminalInitialized' | 'initializeTerminal' | 'writeToTerminal'>;

/**
 * The one plain shell on this host. It needs no repository: a hidden detached
 * session owns it (like Pane Chat), so it never shows up as a project or Pane,
 * and reopening it returns the same running shell.
 */
export class HostTerminalManager {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly panels: HostTerminalPanels = panelManager,
    private readonly shells: HostTerminalShells = terminalPanelManager,
  ) {}

  async open(request: HostTerminalOpenRequest = {}): Promise<HostTerminalState<Session>> {
    // Checked before anything changes, so a bad request leaves the terminal as it was.
    const environment = request.env === undefined ? undefined : Object.fromEntries(hostTerminalEnvironment(request.env));
    return withLock('host-terminal', async () => {
      const session = this.ensureSession();
      const panel = await this.ensurePanel(session.id);
      await this.panels.setActivePanel(session.id, panel.id);
      const input = request.input === undefined ? '' : hostTerminalTypedInput(request.input);
      const cwd = os.homedir();
      const running = this.shells.isTerminalInitialized(panel.id);

      // A running shell keeps its environment; the stored one applies the next time it starts.
      await this.updateLaunchState(panel, environment, running ? '' : input);
      if (running) {
        if (input) this.shells.writeToTerminal(panel.id, `${CLEAR_PROMPT_LINE}${input}`);
      } else {
        await this.shells.initializeTerminal(this.panels.getPanel(panel.id) ?? panel, cwd);
      }

      return {
        session,
        panel: this.panels.getPanel(panel.id) ?? panel,
        cwd,
        started: this.shells.isTerminalInitialized(panel.id),
      };
    });
  }

  /** Read-only: null until the terminal was first opened on this host. */
  get(): HostTerminalRef | null {
    if (!this.sessionManager.getSession(HOST_TERMINAL_SESSION_ID) || !this.panels.getPanel(HOST_TERMINAL_PANEL_ID)) {
      return null;
    }
    return {
      sessionId: HOST_TERMINAL_SESSION_ID,
      panelId: HOST_TERMINAL_PANEL_ID,
      started: this.shells.isTerminalInitialized(HOST_TERMINAL_PANEL_ID),
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
    const existing = this.panels.getPanel(HOST_TERMINAL_PANEL_ID);
    if (existing) return existing;

    const initialState: TerminalPanelState = { isCliPanel: false };
    return this.panels.createPanel({
      id: HOST_TERMINAL_PANEL_ID,
      sessionId,
      type: 'terminal',
      title: HOST_TERMINAL_TITLE,
      initialState,
      metadata: { permanent: true },
    });
  }

  /**
   * Store the environment the shell starts with, and text a starting shell
   * types once it is up (never pressing Enter).
   */
  private async updateLaunchState(
    panel: ToolPanel,
    environment: TerminalPanelState['environmentVars'],
    input: string,
  ): Promise<void> {
    if (environment === undefined && !input) return;
    // SAFETY: The host terminal panel is created with a TerminalPanelState.
    const current = panel.state.customState as TerminalPanelState | undefined;
    const customState: TerminalPanelState = { ...current };
    if (environment !== undefined) customState.environmentVars = environment;
    if (input) {
      customState.initialInput = input;
      customState.initialInputSubmitStrategy = 'none';
      customState.initialInputSentAt = undefined;
      customState.initialInputError = undefined;
    }
    await this.panels.updatePanel(panel.id, { state: { ...panel.state, customState } });
  }
}
