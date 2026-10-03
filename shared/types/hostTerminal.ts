import type { ToolPanel } from './panels';

/** Hidden detached session that owns a host's terminal; never a project or sidebar Pane. */
export const HOST_TERMINAL_SESSION_ID = '__host_terminal__';
export const HOST_TERMINAL_PANEL_ID = '__host_terminal_panel__';
/** Session workspace name, so its folder is `<pane dir>/sessions/host-terminal`. */
export const HOST_TERMINAL_WORKSPACE = 'host-terminal';

export interface HostTerminalOpenRequest {
  /** Typed at the prompt without pressing Enter; line breaks are removed. */
  input?: string;
}

export interface HostTerminalState<TSession = unknown> {
  session: TSession;
  panel: ToolPanel;
  /** Where the shell starts: the host's home folder. */
  cwd: string;
  started: boolean;
}

export interface HostTerminalRef {
  sessionId: string;
  panelId: string;
  started: boolean;
}

/** The text `input` puts at the prompt: no line breaks, so nothing is submitted. */
export function hostTerminalTypedInput(input: string): string {
  return input.replace(/[\r\n]/g, '');
}
