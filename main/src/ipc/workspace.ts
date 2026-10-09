import type { AppConfig } from '../types/config';
import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { PaneWorkspaceHostController, WorkspaceHostStatus } from '../daemon/workspaceHost';
import { describeMachine, execOnMachine, readMachineFile, writeMachineFile } from '../services/workspaceMachine';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { hashWorkspacePassword } from '../daemon/workspacePassword';
import { discoverTailnetMachines, probeWorkspace, readTailscaleStatus, type WorkspaceProbe } from '../services/tailnetMachines';
import {
  WORKSPACE_PASSWORD_MIN_LENGTH,
  type WorkspaceAccessSummary,
  type TailnetMachineList,
  type WorkspaceAccessUpdate,
  type WorkspaceMachineDescription,
} from '../../../shared/types/workspaceAccess';

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
const setAccessRequestSchema = boundary.object({
  visibility: boundary.optional(boundary.enumeration('off', 'owner', 'tailnet')),
  password: boundary.optional(boundary.nullable(boundary.string)),
});

interface WorkspaceCommandConfig {
  getConfig(): Pick<AppConfig, 'preferredShell' | 'workspaces'>;
  updateConfigWith(update: (current: Pick<AppConfig, 'workspaces'>) => Pick<AppConfig, 'workspaces'>): Promise<object>;
}

interface WorkspaceStatusResult extends WorkspaceHostStatus {
  enabled: boolean;
}

/**
 * `runpane:machine:*` act on this whole machine for `runpane workspace`; the HTTP transport
 * serves them only through the Tailscale workspace listener. `runpane:workspaces:*` manage that
 * listener; the ones that change who may connect answer only this machine, never a remote client.
 */
export function registerWorkspaceCommands(
  registry: PaneCommandRegistry,
  host: PaneWorkspaceHostController,
  configManager: WorkspaceCommandConfig,
  paneVersion: string,
  discovery: { readStatus: () => Promise<string | null>; probe: WorkspaceProbe } = { readStatus: readTailscaleStatus, probe: probeWorkspace },
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
    refuseRemoteCaller();
    const { enabled } = decodeBoundary(request, setEnabledRequestSchema);
    await configManager.updateConfigWith(current => ({ workspaces: { ...current.workspaces, enabled } }));
    await host.sync();
    return status();
  });

  registry.register('runpane:workspaces:access', (): WorkspaceAccessSummary => host.getAccess());
  registry.register('runpane:workspaces:set-access', async (request: PaneCommandValue): Promise<WorkspaceAccessSummary> => {
    refuseRemoteCaller();
    const update: WorkspaceAccessUpdate = decodeBoundary(request, setAccessRequestSchema);
    if (update.password !== undefined && update.password !== null && update.password.length < WORKSPACE_PASSWORD_MIN_LENGTH) {
      throw new Error(`Use a password of at least ${WORKSPACE_PASSWORD_MIN_LENGTH} characters.`);
    }
    await configManager.updateConfigWith(current => {
      const workspaces = { ...current.workspaces };
      if (update.visibility === 'off') workspaces.enabled = false;
      else if (update.visibility) Object.assign(workspaces, { enabled: true, visibility: update.visibility });
      if (update.password === null) delete workspaces.password;
      else if (update.password !== undefined) workspaces.password = hashWorkspacePassword(update.password);
      return { workspaces };
    });
    await host.sync();
    return host.getAccess();
  });
  const describe = (): WorkspaceMachineDescription => {
    const access = host.getAccess();
    return {
      machineName: access.machineName ?? '',
      visibility: access.visibility === 'tailnet' ? 'tailnet' : 'owner',
      passwordProtected: access.passwordProtected,
      paneVersion,
    };
  };
  // Describe answers clients admitted by visibility and password checks.
  registry.register('runpane:workspaces:describe', describe);
  // A phone cannot read `tailscale status`; it asks a computer on its own login.
  // The HTTP transport restricts discovery to the signed owner identity before invoking this.
  registry.register('runpane:workspaces:machines', (): Promise<TailnetMachineList> => {
    const url = host.getAccess().url;
    return discoverTailnetMachines({ ...discovery, self: url ? { url, description: describe() } : undefined });
  });
}

function refuseRemoteCaller(): void {
  if (isRemotePaneCommand()) {
    throw new Error('Who may connect to this machine can be changed only on the machine itself.');
  }
}
