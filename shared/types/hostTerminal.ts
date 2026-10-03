import type { ToolPanel } from './panels';
import type { HostTerminalEnvVar } from './remoteDaemon';

/** Hidden detached session that owns a host's terminal; never a project or sidebar Pane. */
export const HOST_TERMINAL_SESSION_ID = '__host_terminal__';
export const HOST_TERMINAL_PANEL_ID = '__host_terminal_panel__';
/** Session workspace name, so its folder is `<pane dir>/sessions/host-terminal`. */
export const HOST_TERMINAL_WORKSPACE = 'host-terminal';

export interface HostTerminalOpenRequest {
  /** Typed at the prompt without pressing Enter; line breaks are removed. */
  input?: string;
  /** Environment the shell starts with (the saved host's `hostTerminalEnv`); a running shell keeps its own. */
  env?: HostTerminalEnvVar[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_VARS = 32;

/** The variables as the shell gets them; rejects names a shell could not export. */
export function hostTerminalEnvironment(env: readonly HostTerminalEnvVar[]): Map<string, string> {
  if (env.length > MAX_ENV_VARS) throw new Error(`A host terminal takes at most ${MAX_ENV_VARS} environment variables`);
  const variables = new Map<string, string>();
  for (const { name, value } of env) {
    if (!ENV_NAME.test(name)) throw new Error(`"${name}" is not an environment variable name`);
    variables.set(name, value);
  }
  return variables;
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
