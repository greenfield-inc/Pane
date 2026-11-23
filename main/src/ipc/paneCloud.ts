import path from 'path';
import type { GitHubTokenRecord } from 'pane-cloud-contract';
import type { IpcMain } from 'electron';
import { openExternalUrl } from '../utils/openExternalUrl';
import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { PANE_CLOUD_MACHINE_CHANNEL, paneCloudMachine } from '../../../shared/utils/paneCloudMachine';
import type { MachineConnections } from '../services/machineConnections';
import type { ConfigManager } from '../services/configManager';
import { DEFAULT_PANE_CLOUD_URL, PaneCloudFailure, PaneCloudManager } from '../services/paneCloud';
import { cloneRepoOf } from '../services/paneCloudRepo';
import { getAppDirectory } from '../utils/appDirectory';
import { PaneError } from '../../../shared/paneError';
import { computerRelayId } from '../../../shared/types/remoteComputers';
import { normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { PaneCloudSnapshot } from '../../../shared/types/paneCloud';
import { LEGACY_ORCHESTRATION_SESSION_ID } from '../../../shared/types/orchestrationSession';
import { RELAY_DEVICE_COMMANDS } from '../../../shared/types/relay';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import { CLOUD_SIGN_IN_PROJECT, CLOUD_TOKEN_AGENTS, GITHUB_SIGN_IN_ENV, type PaneCloudSecretChoice } from '../../../shared/types/paneCloudSecrets';
import { describeCloudSecrets, readGithubToken } from '../services/cloudSecrets';
import { localHostLabel, paneSecretStore } from '../services/paneSecrets';

/** How long a newly paired VM may take to answer on its saved connection. */
const CONNECT_DEADLINE_MS = 60_000;

const pairedSchema = boundary.object({ computerId: boundary.nonEmptyString });
const unlinkedSchema = boundary.object({ notReached: boundary.array(boundary.string) });
const sessionListSchema = boundary.object({
  data: boundary.optional(boundary.object({ sessions: boundary.array(boundary.object({ id: boundary.nonEmptyString, archived: boundary.optional(boundary.boolean) })) })),
});
/** How old a read of Pane Cloud `pane-cloud:machine` may answer from. */
const MACHINE_ANSWER_MAX_AGE_MS = 60_000;
/** How long one Session call on a cloud machine may take. */
const SESSION_CALL_MS = 30_000;
const createdSchema = boundary.object({
  success: boundary.boolean,
  error: boundary.optional(boundary.string),
  data: boundary.optional(boundary.object({ session: boundary.object({ id: boundary.nonEmptyString }) })),
});

let manager: PaneCloudManager | null = null;
let knownCloudMachines: string[] = [];

/** The saved computers in the "Pane Cloud" machine (D-90), sorted. */
const machineIdsOf = (snapshot: PaneCloudSnapshot) => (paneCloudMachine(snapshot.sessions)?.members ?? []).map((member) => member.computerId).sort();

/**
 * The saved machines that are the person's cloud VMs, as Pane Cloud lists them: each VM's relay id
 * mapped to the computer this desktop saved for it. Empty while signed out or before Pane Cloud answers.
 */
export function cloudMachineIds(): ReadonlySet<string> {
  return new Set(manager ? machineIdsOf(manager.snapshot()) : []);
}

/**
 * Pane Cloud's channels. They run on this computer even while the window shows another one: the
 * service session, pairing and the saved computers are this desktop's.
 */
export function registerPaneCloudHandlers(ipcMain: Pick<IpcMain, 'handle'>, deps: {
  commands: Pick<PaneCommandRegistry, 'invoke' | 'register'>;
  machines: Pick<MachineConnections, 'machineState' | 'run' | 'invokeOn'>;
  configManager: Pick<ConfigManager, 'getConfig' | 'updateConfigWith'>;
  /** Sends the person's chosen secrets to a newly paired cloud VM (SharedCredentialSync, D-58). */
  sendSecrets: (machineId: string) => Promise<void>;
  /** Called when the saved machines that are the person's cloud VMs change (`cloudMachineIds`). */
  onCloudMachinesChanged?: () => void;
  send: (channel: string, snapshot: PaneCloudSnapshot) => void;
  /** The folder of a project on this computer, for the repo a new cloud Session clones. */
  projectPath?: (projectId: number) => string | null;
  /** The GitHub token a new cloud Session's create request seals, or null (SharedCredentialSync, D-107). */
  githubToken?: () => Promise<GitHubTokenRecord | null>;
}): void {
  manager?.dispose();
  const { commands, machines, configManager } = deps;
  const cloud = new PaneCloudManager({
    serviceUrl: process.env.PANE_CLOUD_URL || DEFAULT_PANE_CLOUD_URL,
    // This computer sends a new cloud Session its secrets (deps.sendSecrets), so the card says they come along.
    sendsSecrets: true,
    githubToken: deps.githubToken,
    tokenFile: path.join(getAppDirectory(), 'pane-cloud', 'session.json'),
    // Pane's own allowlist (http, https, mailto) as well as the manager's web-address check.
    openExternal: (url) => openExternalUrl(url),
    pair: async ({ link, relay }) => {
      const request = { link, relay: { computerId: relay.computerId, fingerprint: relay.fingerprint, domain: relay.domain } };
      return decodeBoundary(await commands.invoke('relay:redeem-vouched', [request]), pairedSchema).computerId;
    },
    computerFor: (relayId) => normalizeRemoteDaemonConfig(configManager.getConfig().remoteDaemon).client.computers.find((computer) => computerRelayId(computer) === relayId)?.id ?? null,
    startSession: async (machineId, input) => {
      await waitUntilOnline(machines, machineId);
      // Before the Session, so its first agent starts signed in.
      await deps.sendSecrets(machineId);
      const { data } = await machines.run(machineId, { type: 'create-session', input });
      const reply = decodeBoundary(data, createdSchema);
      if (!reply.success || !reply.data) {
        throw new PaneError('ERR_CLOUD_SESSION_NOT_CREATED', `The cloud machine did not create the Session: ${reply.error ?? 'it gave no reason'}.`, 'Try New cloud Session again.');
      }
      return reply.data.session.id;
    },
    // Only this computer forgets it: a cloud VM is never linked with the person's other computers, so none is told.
    forget: async (machineId) => {
      await configManager.updateConfigWith((current) => {
        const remote = normalizeRemoteDaemonConfig(current.remoteDaemon);
        const client = { ...remote.client, computers: remote.client.computers.filter((computer) => computer.id !== machineId) };
        if (client.activeProfileId === machineId) Object.assign(client, { activeProfileId: null, mode: 'local' });
        return { remoteDaemon: { ...remote, client } };
      });
    },
    unlink: async (machineId) => ({ notReached: decodeBoundary(await commands.invoke(RELAY_DEVICE_COMMANDS.unlinkComputerEverywhere, [{ computerId: machineId }]), unlinkedSchema).notReached }),
    archiveSessions: async (machineId, archived) => {
      await waitUntilOnline(machines, machineId);
      const listed = decodeBoundary(await machines.invokeOn(machineId, 'orchestration-sessions:list', [], SESSION_CALL_MS), sessionListSchema);
      const targets = (listed.data?.sessions ?? []).filter((session) => session.id !== LEGACY_ORCHESTRATION_SESSION_ID && (session.archived === true) !== archived);
      for (const session of targets) {
        await machines.invokeOn(machineId, 'orchestration-sessions:update', [{ sessionId: session.id }, { archived }], SESSION_CALL_MS);
      }
    },
    onChange: (snapshot) => {
      deps.send('pane-cloud:changed', snapshot);
      const ids = machineIdsOf(snapshot);
      if (ids.join('\n') !== knownCloudMachines.join('\n')) {
        knownCloudMachines = ids;
        deps.onCloudMachinesChanged?.();
      }
    },
  });
  manager = cloud;

  const vmId = (value: PaneCommandValue) => decodeBoundary(value, boundary.nonEmptyString);
  // The "Pane Cloud" machine (D-90): runpane and the pane MCP name a person's cloud Session VMs by it.
  // It answers on this computer only, where the Pane Cloud sign-in and the paired computers are.
  commands.register(PANE_CLOUD_MACHINE_CHANNEL, async () => {
    if (isRemotePaneCommand()) {
      throw new PaneError('ERR_PANE_CLOUD_HERE_ONLY', 'Pane Cloud answers only on the computer signed in to it, so another computer can\'t read its machines.', 'Run this on the computer signed in to Pane Cloud.');
    }
    // runpane and the MCP ask on every machine call: a read under a minute old answers.
    const machine = paneCloudMachine((await cloud.recent(MACHINE_ANSWER_MAX_AGE_MS)).sessions);
    return machine === null ? null : { id: machine.id, name: machine.name, members: machine.members.map((member) => ({ ...member })) };
  });
  ipcMain.handle('pane-cloud:get', () => answer(() => cloud.refresh()));
  ipcMain.handle('pane-cloud:sign-in', () => answer(() => cloud.startSignIn()));
  ipcMain.handle('pane-cloud:sign-out', () => answer(() => cloud.signOut()));
  ipcMain.handle('pane-cloud:stop', (_event, id: PaneCommandValue) => answer(() => cloud.stop(vmId(id))));
  ipcMain.handle('pane-cloud:start', (_event, id: PaneCommandValue) => answer(() => cloud.start(vmId(id))));
  ipcMain.handle('pane-cloud:delete', (_event, id: PaneCommandValue) => answer(() => cloud.remove(vmId(id))));
  ipcMain.handle('pane-cloud:archive', (_event, id: PaneCommandValue) => answer(() => cloud.archive(vmId(id))));
  ipcMain.handle('pane-cloud:restore', (_event, id: PaneCommandValue) => answer(() => cloud.restore(vmId(id))));
  ipcMain.handle('pane-cloud:update-pane', (_event, id: PaneCommandValue) => answer(() => cloud.updatePane(vmId(id))));
  ipcMain.handle('pane-cloud:actions', async (_event, id: PaneCommandValue) => answer(() => cloud.actions(vmId(id))));
  ipcMain.handle('pane-cloud:prepare-create', () => answer(async () => cloud.prepareCreate()));
  ipcMain.handle('pane-cloud:retry-clone', (_event, id: PaneCommandValue) => answer(() => cloud.retryClone(vmId(id))));
  ipcMain.handle('pane-cloud:create', async (_event, input: PaneCommandValue, projectId?: PaneCommandValue) =>
    answer(async () => {
      const folder = projectId === undefined || projectId === null ? null : deps.projectPath?.(decodeBoundary(projectId, boundary.number)) ?? null;
      return cloud.createSession(decodeBoundary(input, boundary.jsonObject), folder ? await cloneRepoOf(folder) : null);
    }));

  // "Choose what to send": this computer's secrets by name only, and the person's choice.
  ipcMain.handle('pane-cloud:secrets', async () => answer(async () => {
    const thisComputer = localHostLabel();
    const store = paneSecretStore();
    const secrets = store.list();
    if (!secrets.some((secret) => secret.project === CLOUD_SIGN_IN_PROJECT && secret.name === GITHUB_SIGN_IN_ENV) && await readGithubToken()) {
      secrets.push({ project: CLOUD_SIGN_IN_PROJECT, name: GITHUB_SIGN_IN_ENV, updatedAt: new Date().toISOString(), machine: thisComputer });
    }
    return describeCloudSecrets(secrets, store.cloudChoice(), thisComputer);
  }));
  // Saved with a time, so it reaches the person's other computers and every cloud VM, and wins there.
  ipcMain.handle('pane-cloud:secrets:choose', async (_event, choice: PaneCommandValue) => answer(async () => {
    await paneSecretStore().setCloudChoice(decodeBoundary(choice, secretChoiceSchema));
  }));
  // A token an agent's CLI made for machines that can't keep its own sign-in (`claude setup-token`), kept as a Pane secret.
  ipcMain.handle('pane-cloud:secrets:token', async (_event, agentId: PaneCommandValue, token: PaneCommandValue) => answer(async () => {
    const agent = CLOUD_TOKEN_AGENTS.find((candidate) => candidate.id === decodeBoundary(agentId, boundary.nonEmptyString));
    if (!agent) throw new PaneError('ERR_CLOUD_TOKEN_AGENT', 'That agent has no sign-in token for cloud Sessions, so nothing was saved.', 'Update Pane, then try again.');
    await paneSecretStore().set(CLOUD_SIGN_IN_PROJECT, agent.env, decodeBoundary(token, boundary.nonEmptyString).trim());
  }));
}

const secretChoiceSchema: BoundarySchema<PaneCloudSecretChoice> = boundary.object({
  excludedSecrets: boundary.array(boundary.nonEmptyString),
  excludedMachines: boundary.array(boundary.nonEmptyString),
});

/** A call's IPC answer: its data, or what failed and the next step. */
async function answer<T>(call: () => Promise<T>) {
  try {
    return { success: true, data: await call() };
  } catch (error) {
    if (error instanceof PaneCloudFailure) return { success: false, error: error.message, details: error.next ?? undefined, code: error.code };
    if (error instanceof PaneError) return { success: false, error: error.message, details: error.next, code: error.code };
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A computer saved a moment ago is connected by MachineConnections on the config change; this waits for it to answer. */
async function waitUntilOnline(machines: Pick<MachineConnections, 'machineState'>, machineId: string): Promise<void> {
  const deadline = Date.now() + CONNECT_DEADLINE_MS;
  while (machines.machineState(machineId)?.status !== 'online') {
    if (Date.now() > deadline) {
      throw new PaneError('ERR_CLOUD_SESSION_UNREACHABLE', 'This computer paired with the cloud machine but could not connect to it.', 'Check this computer is online, then try New cloud Session again.');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
