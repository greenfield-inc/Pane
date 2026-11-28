import fs from 'fs/promises';
import path from 'path';
import { PaneError } from '../../../../shared/paneError';
import type { ProfileRecovery } from '../../../../shared/types/profileEditor';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';

/**
 * The Profiles tab's one-time notice for an edited bundled plugin that Pane saved aside and replaced
 * (T-63 #1740 review F-3). Each recovery folder under `<config root>/recovered/` holds a
 * `recovery.json` note saying which plugin it is; dismissing the notice marks that note, so it
 * shows once per recovery and stays dismissed across restarts.
 */
const NOTE_FILE = 'recovery.json';

interface RecoveryNote {
  plugin: string;
  version: string;
  reason: string;
  dismissed?: boolean;
}

const noteSchema: BoundarySchema<RecoveryNote> = boundary.object({
  plugin: boundary.string,
  version: boundary.string,
  reason: boundary.string,
  dismissed: boundary.optional(boundary.boolean),
});

function recoveredRoot(configRoot: string): string {
  return path.join(configRoot, 'recovered');
}

async function readNote(folder: string): Promise<RecoveryNote | undefined> {
  const text = await fs.readFile(path.join(folder, NOTE_FILE), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try { return decodeOptionalBoundary(JSON.parse(text), noteSchema); }
  catch { return undefined; }
}

/** Records which plugin a recovery folder holds, for the tab's notice. */
export async function writeRecoveryNote(folder: string, note: { plugin: string; version: string; reason: string }): Promise<void> {
  await fs.writeFile(path.join(folder, NOTE_FILE), `${JSON.stringify(note, null, 2)}\n`);
}

/** Recoveries whose notice hasn't been dismissed, oldest first. A folder without a readable note is skipped. */
export async function pendingRecoveries(configRoot: string): Promise<ProfileRecovery[]> {
  const root = recoveredRoot(configRoot);
  const names: string[] = await fs.readdir(root).catch(() => []);
  const pending: ProfileRecovery[] = [];
  for (const id of names.sort()) {
    const folder = path.join(root, id);
    const note = await readNote(folder);
    if (note && !note.dismissed) pending.push({ id, plugin: note.plugin, folder });
  }
  return pending;
}

/** The folder of one recovery, by its id (the folder's name); throws when there is no such recovery. */
export async function recoveryFolder(configRoot: string, id: string): Promise<string> {
  const folder = path.join(recoveredRoot(configRoot), id);
  const inside = id !== '' && !id.includes('/') && !id.includes('\\') && id !== '.' && id !== '..';
  if (!inside || !(await readNote(folder))) {
    throw new PaneError('PROFILE_RECOVERY_MISSING', `Pane has no saved copy called ${id}.`, 'Open Profiles again to see what it saved.');
  }
  return folder;
}

/** Stops the notice for one recovery from showing again; the saved files stay. */
export async function dismissRecovery(configRoot: string, id: string): Promise<void> {
  const folder = await recoveryFolder(configRoot, id);
  const note = await readNote(folder);
  if (!note || note.dismissed) return;
  const file = path.join(folder, NOTE_FILE);
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify({ ...note, dismissed: true }, null, 2)}\n`);
  await fs.rename(`${file}.tmp`, file);
}
