/**
 * Tailnet port for workspaces; the remote daemon keeps 443. `PANE_WORKSPACES_PORT` moves it for
 * development, so a test host never takes over the 8443 handler of the Pane in daily use, and a
 * fleet of test hosts on that port find each other instead of the Panes in daily use.
 */
export const WORKSPACE_HTTPS_PORT = readWorkspacePort(process.env.PANE_WORKSPACES_PORT);

export function readWorkspacePort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8443;
}
