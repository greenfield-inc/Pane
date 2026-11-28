import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { profileSyncRecordSchema, type ProfileSyncRecord } from '../../../../shared/types/profileSync';

/** What this computer last knew of another computer's records, so an offline one can show what it's waiting for. */
export interface ProfileSyncPeerMemory {
  name: string;
  machine?: string;
  plugins: Record<string, ProfileSyncRecord>;
  seenAt: number;
}

/** `<PANE_DIR>/agent-farm/sync.json` (T-63 PR 6). */
export interface ProfileSyncFileData {
  version: 1;
  plugins: Record<string, ProfileSyncRecord>;
  /** Other computers, by the desktop's key for them; only a desktop that syncs writes these. */
  computers: Record<string, ProfileSyncPeerMemory>;
}

const fileSchema = boundary.object({
  version: boundary.literal(1),
  plugins: boundary.record(profileSyncRecordSchema),
  computers: boundary.optional(boundary.record(boundary.object({
    name: boundary.string,
    machine: boundary.optional(boundary.string),
    plugins: boundary.record(profileSyncRecordSchema),
    seenAt: boundary.number,
  }))),
});

function profileSyncFile(configRoot: string): string {
  return path.join(configRoot, 'sync.json');
}

/** This computer's sync records; empty when there are none yet or the file can't be read. */
export async function readProfileSync(configRoot: string): Promise<ProfileSyncFileData> {
  const text = await fs.readFile(profileSyncFile(configRoot), 'utf8').catch(() => undefined);
  let parsed: unknown;
  try { parsed = text === undefined ? undefined : JSON.parse(text); }
  catch { parsed = undefined; }
  const data = decodeOptionalBoundary(parsed, fileSchema);
  return { version: 1, plugins: data?.plugins ?? {}, computers: data?.computers ?? {} };
}

export async function writeProfileSync(configRoot: string, data: ProfileSyncFileData): Promise<void> {
  const file = profileSyncFile(configRoot);
  await fs.mkdir(configRoot, { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(temporary, file);
}

/**
 * Pane plugins (greenfield, dcouple) whose newest save here is your edited copy, synced from
 * another computer or saved here: Pane updates keep them, as they keep a plugin edited here (A-3).
 */
export async function syncedPluginEdits(configRoot: string): Promise<Set<string>> {
  const { plugins } = await readProfileSync(configRoot);
  return new Set(Object.entries(plugins).filter(([, record]) => record.state === 'saved').map(([name]) => name));
}

/**
 * After Restore Pane's version: the plugin is Pane's again, not an edited copy, so its record stops
 * saying it is yours. The next sync records the restore as a new save, which reaches the other computers.
 */
export async function forgetSyncedEdit(configRoot: string, plugin: string): Promise<void> {
  const data = await readProfileSync(configRoot);
  const record = data.plugins[plugin];
  if (record?.state !== 'saved') return;
  data.plugins[plugin] = { ...record, state: 'pane', hash: '' };
  await writeProfileSync(configRoot, data);
}
