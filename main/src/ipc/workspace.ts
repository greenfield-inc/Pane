import type { ConfigManager } from '../services/configManager';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { PaneWorkspaceHostController, WorkspaceHostStatus } from '../daemon/workspaceHost';
import { describeMachine, execOnMachine, readMachineFile, writeMachineFile } from '../services/workspaceMachine';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const readRequestSchema = boundary.object({ path: boundary.nonEmptyString });
const writeRequestSchema = boundary.object({
  path: boundary.nonEmptyString,
  content: boundary.string,
  encoding: boundary.optional(boundary.enumeration('utf8', 'base64')),
});
const execRequestSchema = boundary.object({
  command: boundary.nonEmptyString,
  cwd: boundary.optional(boundary.nonEmptyString),
  timeoutMs: boundary.optional(boundary.number),
});
const setEnabledRequestSchema = boundary.object({ enabled: boundary.boolean });

interface WorkspaceStatusResult extends WorkspaceHostStatus {
  enabled: boolean;
}

/**
 * `runpane:machine:*` act on this whole machine for `runpane workspace`; the HTTP transport
 * serves them only to the owner's Tailscale identity. `runpane:workspaces:*` manage that host.
 */
export function registerWorkspaceCommands(
  registry: PaneCommandRegistry,
  host: PaneWorkspaceHostController,
  configManager: Pick<ConfigManager, 'getConfig' | 'updateConfigWith'>,
): void {
  const preferredShell = () => configManager.getConfig().preferredShell;
  const status = (): WorkspaceStatusResult => ({ enabled: host.isEnabled(), ...host.getStatus() });

  registry.register('runpane:machine:info', () => describeMachine(preferredShell()));
  registry.register('runpane:machine:read', (request: PaneCommandValue) =>
    readMachineFile(decodeBoundary(request, readRequestSchema)));
  registry.register('runpane:machine:write', (request: PaneCommandValue) =>
    writeMachineFile(decodeBoundary(request, writeRequestSchema)));
  registry.register('runpane:machine:exec', (request: PaneCommandValue) =>
    execOnMachine(decodeBoundary(request, execRequestSchema), preferredShell()));

  registry.register('runpane:workspaces:status', () => status());
  registry.register('runpane:workspaces:set-enabled', async (request: PaneCommandValue) => {
    const { enabled } = decodeBoundary(request, setEnabledRequestSchema);
    await configManager.updateConfigWith(current => ({ workspaces: { ...current.workspaces, enabled } }));
    await host.sync();
    return status();
  });
}
