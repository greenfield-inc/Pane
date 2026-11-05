import type { IpcMain } from 'electron';
import { PaneError, paneErrorText, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneSecretStorage, PaneSecretSummary } from '../../../shared/types/paneSecrets';
import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { paneSecretStore, secretNotFound, validatePaneSecretAddress, type PaneSecretStore } from '../services/paneSecrets';

interface PaneSecretListResult { ok: true; secrets: PaneSecretSummary[]; storage: PaneSecretStorage }
interface PaneSecretSetResult { ok: true; replaced: boolean; secret: PaneSecretSummary }
interface PaneSecretDeleteResult { ok: true; deleted: { project: string; name: string } }
/** Only `runpane secrets exec` reads this; it is never an MCP tool or printed. */
interface PaneSecretResolveResult { ok: true; values: Record<string, string> }

const listSchema = boundary.object({ project: boundary.optional(boundary.string) });
const addressSchema = boundary.object({ project: boundary.string, name: boundary.string });
const setSchema = boundary.object({ project: boundary.string, name: boundary.string, value: boundary.string });
const resolveSchema = boundary.object({ project: boundary.string, names: boundary.optional(boundary.array(boundary.string)) });

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

/** Secret values never cross the network through these channels; other hosts get them only through shared-key sync. */
function refuseRemote(): void {
  if (isRemotePaneCommand()) {
    throw new PaneError(
      'SECRET_LOCAL_ONLY',
      'Pane secrets are managed only on the machine itself, so their values never cross the network. Nothing was changed.',
      'Run `runpane secrets …` on that machine, or `runpane workspace <machine> exec -- runpane secrets …` from your own devices.',
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
): void {
  registerSettingsChannels(ipcMain, secrets);

  commandRegistry.register('runpane:secrets:list', (request: PaneCommandValue): PaneSecretListResult => {
    refuseRemote();
    const { project } = decode(request ?? {}, listSchema);
    return { ok: true, secrets: secrets().list(project), storage: secrets().storage() };
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
    const wanted = names ?? store.list(project).map(secret => secret.name);
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
function registerSettingsChannels(ipcMain: Pick<IpcMain, 'handle'>, secrets: () => PaneSecretStore): void {
  ipcMain.handle('pane-secrets:list', () => respond(() => ({ secrets: secrets().list(), storage: secrets().storage() })));
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
