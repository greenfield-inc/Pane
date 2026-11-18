import type { IpcMain } from 'electron';
import { PaneError, paneErrorText, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  paneSecretProjectProblem,
  teammateSecretRefusal,
  type PaneSecretReferenceSummary,
  type PaneSecretsOverview,
  type PaneSecretStorage,
  type PaneSecretSummary,
  type SecretLeaseSummary,
} from '../../../shared/types/paneSecrets';
import { isRemotePaneCommand, teammatePaneCaller, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { getRuntimeConfigManager } from '../core/runtime';
import { onePassword } from '../services/onePassword';
import { localHostLabel, paneSecretStore, secretLeaseStore, secretNotFound, validatePaneSecretAddress, type PaneSecretStore } from '../services/paneSecrets';
import type { SecretLeaseStore } from '../services/secretLeases';
import { secretLeaseService } from '../services/secretLeaseRuntime';
import {
  hostLeaseRefusal,
  leaseEndSchema,
  leasePushSchema,
  leaseRefused,
  LOCAL_LEASE_MACHINE,
  type HostLeaseList,
  type SecretLeaseService,
} from '../services/secretLeaseService';

interface PaneSecretListResult {
  ok: true;
  secrets: PaneSecretSummary[];
  storage: PaneSecretStorage;
  /** Secrets whose values live in 1Password; older runpane versions drop these fields. */
  references: PaneSecretReferenceSummary[];
  leases: SecretLeaseSummary[];
}
interface PaneSecretSetResult { ok: true; replaced: boolean; secret: PaneSecretSummary }
interface PaneSecretDeleteResult { ok: true; deleted: { project: string; name: string } }
/** Only `runpane secrets exec` reads this; it is never an MCP tool or printed. */
interface PaneSecretResolveResult { ok: true; values: Record<string, string> }

const listSchema = boundary.object({ project: boundary.optional(boundary.string) });
const addressSchema = boundary.object({ project: boundary.string, name: boundary.string });
const setSchema = boundary.object({ project: boundary.string, name: boundary.string, value: boundary.string });
const resolveSchema = boundary.object({ project: boundary.string, names: boundary.optional(boundary.array(boundary.string)) });
const leaseIdSchema = boundary.object({ leaseId: boundary.nonEmptyString });
const trustedSchema = boundary.object({ clientId: boundary.nonEmptyString });
const startLeaseSchema = boundary.object({
  project: boundary.string,
  names: boundary.array(boundary.string),
  machines: boundary.array(boundary.string),
});

function invalidRequest(): PaneError {
  // Never echo the request: a set request carries the value.
  return new PaneError('SECRET_INVALID', 'The secrets request is malformed. Nothing was changed.', 'Update runpane to match this Pane, then try again.');
}

function decode<Value>(value: PaneCommandValue, schema: Parameters<typeof decodeBoundary<Value>>[1]): Value {
  try {
    return decodeBoundary(value, schema);
  } catch {
    throw invalidRequest();
  }
}

/** These channels answer only this machine's own callers; other hosts get values through shared-key sync. */
function refuseRemote(): void {
  if (isRemotePaneCommand()) {
    throw new PaneError(
      'SECRET_LOCAL_ONLY',
      'Pane refused a secrets request from another machine: secrets answer only commands running on this machine. Nothing was changed.',
      'From one of your own devices, run `runpane workspace <machine> exec -- runpane secrets …`, or run `runpane secrets …` on that machine.',
    );
  }
}

/**
 * `runpane secrets` and Settings → Secrets. Values go in through `set` and out only
 * through `resolve`, which `runpane secrets exec` uses to start its child process.
 */
export function registerPaneSecretHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  commandRegistry: PaneCommandRegistry,
  secrets: () => PaneSecretStore = paneSecretStore,
  leases: () => SecretLeaseStore = secretLeaseStore,
  service: () => SecretLeaseService | null = secretLeaseService,
): void {
  registerSettingsChannels(ipcMain, secrets, service);
  registerLeaseHostCommands(commandRegistry, leases);

  commandRegistry.register('runpane:secrets:list', async (request: PaneCommandValue): Promise<PaneSecretListResult> => {
    refuseRemote();
    const { project } = decode(request ?? {}, listSchema);
    await leases().ready();
    return {
      ok: true,
      secrets: secrets().list(project),
      storage: secrets().storage(),
      references: secrets().listReferences(project),
      leases: leases().list().filter(lease => project === undefined || lease.project === project),
    };
  });

  // Ending only removes access, so agents may; on the desktop it ends the lease on every machine too.
  commandRegistry.register('runpane:secrets:lease:end', async (request: PaneCommandValue) => {
    refuseRemote();
    const { leaseId } = decode(request, leaseIdSchema);
    const desktop = service();
    const ended = desktop ? await desktop.end(leaseId) : await leases().end(leaseId);
    return { ok: true, ended };
  });

  commandRegistry.register('runpane:secrets:set', async (request: PaneCommandValue): Promise<PaneSecretSetResult> => {
    refuseRemote();
    const { project, name, value } = decode(request, setSchema);
    const { replaced, secret } = await secrets().set(project, name, value);
    return { ok: true, replaced, secret };
  });

  commandRegistry.register('runpane:secrets:delete', async (request: PaneCommandValue): Promise<PaneSecretDeleteResult> => {
    refuseRemote();
    const { project, name } = decode(request, addressSchema);
    await secrets().delete(project, name);
    return { ok: true, deleted: { project, name } };
  });

  commandRegistry.register('runpane:secrets:resolve', async (request: PaneCommandValue): Promise<PaneSecretResolveResult> => {
    refuseRemote();
    const { project, names } = decode(request, resolveSchema);
    const store = secrets();
    await leases().ready();
    // Without --only: every typed secret, and each 1Password one that has a live lease here.
    const wanted = names ?? [
      ...store.list(project).map(secret => secret.name),
      ...store.listReferences(project).map(reference => reference.name).filter(name => leases().has(project, name)),
    ];
    for (const name of wanted) {
      validatePaneSecretAddress(project, name);
      if (!store.has(project, name)) throw secretNotFound(project, name);
    }
    const values: Record<string, string> = {};
    for (const name of wanted) values[name] = await store.read(project, name);
    return { ok: true, values };
  });
}

type IpcResponse<Data> = { success: true; data: Data } | { success: false; error: string };

async function respond<Data>(work: () => Promise<Data> | Data): Promise<IpcResponse<Data>> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    // Messages from the store never contain a value; the request is never logged.
    return { success: false, error: error instanceof PaneError ? paneErrorText(error) : `Pane could not change its secrets: ${reasonOf(error)}.` };
  }
}

/**
 * Settings → Secrets. Renderer-only channels, so the desktop always manages its own
 * store (which syncs to the other hosts), even while it shows another machine.
 */
function registerSettingsChannels(ipcMain: Pick<IpcMain, 'handle'>, secrets: () => PaneSecretStore, service: () => SecretLeaseService | null): void {
  const desktop = (): SecretLeaseService => {
    const found = service();
    if (!found) throw new PaneError('SECRET_LEASE_NEEDS_DESKTOP', 'Leases start from Pane on a computer. Nothing was changed.', 'Open Pane on your Mac or PC.');
    return found;
  };
  ipcMain.handle('pane-secrets:list', () => respond(async (): Promise<PaneSecretsOverview> => {
    const { leases, machines } = (await service()?.overview()) ?? { leases: [], machines: [] };
    const config = getRuntimeConfigManager().getConfig();
    return {
      secrets: secrets().list(),
      references: secrets().listReferences(),
      storage: secrets().storage(),
      leases,
      machines,
      leaseLengths: config.secretLeaseLengths ?? {},
      moveVault: config.onePasswordMoveVault ?? null,
    };
  }));
  ipcMain.handle('pane-secrets:set-reference', (_event, project: PaneCommandValue, name: PaneCommandValue, reference: PaneCommandValue) => respond(async () => {
    const request = decode({ project, name, reference }, boundary.object({ project: boundary.string, name: boundary.string, reference: boundary.string }));
    return (await secrets().setReference(request.project, request.name, request.reference.trim())).replacedTyped;
  }));
  ipcMain.handle('pane-secrets:start-lease', (_event, request: PaneCommandValue) => respond(async () => {
    const { project, names, machines } = decode(request, startLeaseSchema);
    return desktop().start({ project, names, machines: machines.filter(id => id !== LOCAL_LEASE_MACHINE), requestedBy: 'Settings' });
  }));
  ipcMain.handle('pane-secrets:end-lease', (_event, leaseId: PaneCommandValue) => respond(async () => {
    const { id } = decode({ id: leaseId }, leaseEndSchema);
    return desktop().end(id);
  }));
  ipcMain.handle('pane-secrets:end-all-leases', () => respond(() => desktop().endAll()));
  ipcMain.handle('pane-secrets:set-lease-length', (_event, project: PaneCommandValue, lengthMs: PaneCommandValue) => respond(async () => {
    const request = decode({ project, lengthMs }, boundary.object({ project: boundary.string, lengthMs: boundary.number }));
    const problem = paneSecretProjectProblem(request.project);
    if (problem) throw new PaneError('SECRET_INVALID', `${problem} Nothing was changed.`, 'Pick a project from the list.');
    await desktop().setLength(request.project, request.lengthMs);
    return true;
  }));
  ipcMain.handle('pane-secrets:set-move-vault', (_event, vault: PaneCommandValue) => respond(async () => {
    const request = decode({ vault }, boundary.object({ vault: boundary.nonEmptyString }));
    await getRuntimeConfigManager().updateConfigWith(() => ({ onePasswordMoveVault: request.vault }));
    return true;
  }));
  ipcMain.handle('pane-secrets:list-vaults', () => respond(() => onePassword().vaults()));
  ipcMain.handle('pane-secrets:move-to-1password', (_event, project: PaneCommandValue, name: PaneCommandValue) => respond(async () => {
    const request = decode({ project, name }, addressSchema);
    return moveToOnePassword(secrets(), request.project, request.name);
  }));
  ipcMain.handle('pane-secrets:set', (_event, project: PaneCommandValue, name: PaneCommandValue, value: PaneCommandValue) => respond(async () => {
    const request = decode({ project, name, value }, setSchema);
    return (await secrets().set(request.project, request.name, request.value)).replaced;
  }));
  ipcMain.handle('pane-secrets:delete', (_event, project: PaneCommandValue, name: PaneCommandValue) => respond(async () => {
    const request = decode({ project, name }, addressSchema);
    await secrets().delete(request.project, request.name);
    return true;
  }));
}

/**
 * Move to 1Password: writes the typed value into a new item in the picked vault (one prompt), then
 * points the name at it, which deletes the typed copy here and, through sync, on every host.
 */
async function moveToOnePassword(store: PaneSecretStore, project: string, name: string): Promise<{ reference: string }> {
  const vault = getRuntimeConfigManager().getConfig().onePasswordMoveVault;
  if (!vault) {
    throw new PaneError('SECRET_NO_VAULT', 'Pick a 1Password vault for moved secrets first. Nothing was moved.', 'In Settings → Secrets, choose the vault under "1Password vault for moved secrets".');
  }
  if (store.referenceOf(project, name)) {
    throw new PaneError('SECRET_IS_REFERENCE', `${project}/${name} already comes from 1Password. Nothing was moved.`, 'Nothing to do.');
  }
  const value = await store.read(project, name);
  const reference = await onePassword().createItem(vault, `${project}/${name} (Pane)`, value);
  await store.setReference(project, name, reference);
  return { reference };
}

/**
 * Commands a desktop sends a machine it holds a connection to: take a lease (values and time
 * remaining), end one, or list them (names and times, never values). The HTTP server lets only the
 * owner's paired devices call them, as for key sharing; a teammate is refused here too.
 */
function registerLeaseHostCommands(commandRegistry: PaneCommandRegistry, leases: () => SecretLeaseStore): void {
  const trust = (trusted: PaneCommandValue, action: string) => {
    decode(trusted, trustedSchema);
    const teammate = teammatePaneCaller();
    if (teammate) throw teammateSecretRefusal(teammate, action);
  };
  commandRegistry.register('secrets:lease:push', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    trust(trusted, 'push a lease');
    const refusal = hostLeaseRefusal(getRuntimeConfigManager().getConfig());
    if (refusal) throw leaseRefused(localHostLabel(), refusal);
    const push = decode(input, leasePushSchema);
    const lease = await leases().grant(push);
    return { ok: true, lease };
  });
  commandRegistry.register('secrets:lease:end', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    trust(trusted, 'end a lease');
    const { id } = decode(input, leaseEndSchema);
    return { ok: true, ended: await leases().end(id) };
  });
  commandRegistry.register('secrets:lease:list', async (_input: PaneCommandValue, trusted: PaneCommandValue): Promise<HostLeaseList> => {
    trust(trusted, 'list leases');
    await leases().ready();
    return { leases: leases().list(), memoryOnly: leases().memoryOnly(), refusal: hostLeaseRefusal(getRuntimeConfigManager().getConfig()) };
  });
}
