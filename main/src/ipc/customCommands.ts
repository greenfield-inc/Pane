import type { IpcMainHandleLike, PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { readOnlyPaneCaller, teammatePaneCaller } from '../daemon/commandRegistry';
import type { AppConfig, CustomCommand } from '../types/config';
import { applyCustomCommandEdit, type CustomCommandEdit, type CustomCommandEditOutcome, type CustomCommandResumePatch } from '../services/customCommandList';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import { PaneError, paneErrorText } from '../../../shared/paneError';
import { getPaneEventSink } from '../core/runtime';
import { CUSTOM_COMMAND_RESUME_MODES, type CustomCommandResume } from '../../../shared/types/customCommandResume';

/** The channels `runpane custom-commands` calls on the machine that owns the list. */
export const CUSTOM_COMMAND_CHANNELS = [
  'runpane:custom-commands:list',
  'runpane:custom-commands:add',
  'runpane:custom-commands:update',
  'runpane:custom-commands:remove',
  'runpane:custom-commands:reorder',
] as const;

/** What `custom-commands list` shows the owner: every entry in order, legacy duplicates included. */
interface CustomCommandListEntry {
  position: number;
  name: string;
  command: string;
  resume: CustomCommandResume | null;
}

interface CustomCommandConfig {
  getConfig(): AppConfig;
  updateConfigWith(update: (current: AppConfig) => Partial<AppConfig>): Promise<AppConfig>;
}

const resumeModeSchema = boundary.enumeration(...CUSTOM_COMMAND_RESUME_MODES);
const resumePatchSchema: BoundarySchema<CustomCommandResumePatch> = boundary.object({
  mode: boundary.optional(resumeModeSchema),
  initialTemplate: boundary.optional(boundary.string),
  resumeTemplate: boundary.optional(boundary.string),
});
const addSchema = boundary.object({ name: boundary.string, command: boundary.string, resume: boundary.optional(resumePatchSchema) });
const updateSchema = boundary.object({
  name: boundary.string,
  newName: boundary.optional(boundary.string),
  command: boundary.optional(boundary.string),
  resume: boundary.optional(boundary.nullable(resumePatchSchema)),
});
const removeSchema = boundary.object({ name: boundary.string });
const reorderSchema = boundary.object({ name: boundary.string, position: boundary.number });
const entrySchema: BoundarySchema<CustomCommand> = boundary.object({
  name: boundary.string,
  command: boundary.string,
  resume: boundary.optional(boundary.nullable(boundary.object({
    mode: resumeModeSchema,
    initialTemplate: boundary.string,
    resumeTemplate: boundary.string,
  }))),
});
const rowSchema = boundary.object({ index: boundary.number, expected: entrySchema, next: boundary.nullable(entrySchema) });

/**
 * Registers the owner-only commands that read and edit this machine's custom commands, and the
 * desktop row editor's guarded save. Every edit runs inside `updateConfigWith`, against the list
 * on disk at that moment, so concurrent edits from the CLI, the desktop and config.json all survive.
 */
export function registerCustomCommandHandlers(
  ipcMain: IpcMainHandleLike,
  configManager: CustomCommandConfig,
  commandRegistry?: PaneCommandRegistry,
): void {
  const edit = async (request: CustomCommandEdit): Promise<CustomCommandEditOutcome> => {
    let outcome: CustomCommandEditOutcome | undefined;
    // The update may run more than once when config.json changes underneath it; the last run is what lands.
    await configManager.updateConfigWith((current) => {
      const result = applyCustomCommandEdit(current.customCommands ?? [], request);
      outcome = result.outcome;
      return result.outcome.changed ? { customCommands: result.list } : {};
    });
    if (!outcome) throw new Error('The custom command edit did not run.');
    // Phones and other clients refetch their command list; the event carries no values.
    if (outcome.changed) getPaneEventSink().send('remote:settings-changed');
    return outcome;
  };

  // The desktop's pencil and × in the "+" menu: they edit the row the menu showed, never another one.
  ipcMain.handle('config:custom-commands:edit-row', async (_event, request: PaneCommandValue) => {
    try {
      const row = decodeBoundary(request, rowSchema);
      return { success: true, data: await edit({ kind: 'row', ...row }) };
    } catch (error) {
      return { success: false, error: error instanceof PaneError ? paneErrorText(error) : error instanceof Error ? error.message : String(error) };
    }
  });

  if (!commandRegistry) return;
  commandRegistry.register('runpane:custom-commands:list', () => {
    refuseNonOwner('read');
    const commands: CustomCommandListEntry[] = (configManager.getConfig().customCommands ?? []).map((entry, index) => ({
      position: index + 1,
      name: entry.name,
      command: entry.command,
      resume: entry.resume ?? null,
    }));
    return { ok: true, commands };
  });
  commandRegistry.register('runpane:custom-commands:add', async (request: PaneCommandValue) => {
    refuseNonOwner('change');
    return { ok: true, ...(await edit({ kind: 'add', ...decodeRequest(request, addSchema) })) };
  });
  commandRegistry.register('runpane:custom-commands:update', async (request: PaneCommandValue) => {
    refuseNonOwner('change');
    return { ok: true, ...(await edit({ kind: 'update', ...decodeRequest(request, updateSchema) })) };
  });
  commandRegistry.register('runpane:custom-commands:remove', async (request: PaneCommandValue) => {
    refuseNonOwner('change');
    return { ok: true, ...(await edit({ kind: 'remove', ...decodeRequest(request, removeSchema) })) };
  });
  commandRegistry.register('runpane:custom-commands:reorder', async (request: PaneCommandValue) => {
    refuseNonOwner('change');
    return { ok: true, ...(await edit({ kind: 'reorder', ...decodeRequest(request, reorderSchema) })) };
  });
}

/** A teammate on the tailnet or a device paired Read only never reads or changes the owner's commands. */
function refuseNonOwner(action: 'read' | 'change'): void {
  const teammate = teammatePaneCaller();
  if (!teammate && !readOnlyPaneCaller()) return;
  throw new PaneError(
    'ERR_CUSTOM_COMMANDS_OWNER_ONLY',
    `Only this computer's owner can ${action} its custom commands${teammate ? `, and ${teammate} is signed in as someone else` : ', and this device is paired Read only'}. Nothing was ${action === 'read' ? 'shown' : 'changed'}.`,
    'Ask the owner to run the command from their own devices.',
  );
}

function decodeRequest<Value>(request: PaneCommandValue, schema: BoundarySchema<Value>): Value {
  try {
    return decodeBoundary(request, schema);
  } catch (error) {
    throw new PaneError(
      'ERR_CUSTOM_COMMAND_INVALID',
      `The custom command request is malformed (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`,
      'Run it through runpane custom-commands, which builds the request.',
    );
  }
}
