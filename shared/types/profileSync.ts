import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';

/**
 * Profile sync across computers (T-63 PR 6). Each computer's `<PANE_DIR>/agent-farm/sync.json`
 * holds one record per plugin: its last save, where and when it happened, and whether it was a
 * deletion. The desktop reads every computer's records over the machine connection and sends the
 * newest save of each plugin to any computer that is behind. The newest save wins; equal times go
 * to the computer with the lower id. Nothing is merged.
 */

/**
 * What a save left: `saved` is the plugin's files (yours, or a Pane plugin you edited), `pane` is
 * Pane's own version of greenfield or dcouple with only your photos on it, `deleted` is a deletion.
 */
export type ProfileSyncRecordState = 'saved' | 'pane' | 'deleted';

export interface ProfileSyncRecord {
  state: ProfileSyncRecordState;
  /** The plugin's sync hash (its files, ignoring pack checksums, and its photos); empty for a deletion. */
  hash: string;
  /** Epoch ms of the save, on the computer where it happened. */
  savedAt: number;
  /** The id of the computer where it happened (its Pane install id). */
  machine: string;
}

/** A computer's records, as `profile-sync:state` returns them. */
export interface ProfileSyncState {
  /** This computer's Pane install id. */
  machine: string;
  /** The name the sidebar gives it. */
  name: string;
  plugins: Record<string, ProfileSyncRecord>;
}

/** The calls the desktop makes on each computer (its own included) to sync profiles. Owner's machines only. */
export const PROFILE_SYNC_CHANNELS = {
  /** The computer's records. Takes `{ from }`, the caller's install id, so it can tell a returning computer. */
  state: 'profile-sync:state',
  /** Packs a plugin's newest save for reading: `{ plugin }` → `ProfileSyncExport`. */
  export: 'profile-sync:export',
  /** One chunk of an exported pack: `{ transferId, offset }` → `ProfileSyncChunk`. */
  read: 'profile-sync:read',
  /** One chunk of a pack arriving (Session move's checked write). */
  write: 'profile-sync:write',
  /** Installs an arrived pack, or applies a deletion: `ProfileSyncApplyRequest` → `ProfileSyncApplyResult`. */
  apply: 'profile-sync:apply',
} as const;

/** The event a computer raises when one of its profiles changed, so the desktop syncs again. */
export const PROFILE_SYNC_CHANGED_EVENT = 'profiles:changed';

/** The code a computer answers `profile-sync:*` with while its Profiles switch is off (D-474). */
export const PROFILE_SYNC_OFF_CODE = 'ERR_PROFILES_OFF';

/** A checked file of a transfer: its size and SHA-256 before compression. */
export interface ProfileSyncFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ProfileSyncExport {
  record: ProfileSyncRecord;
  /** Absent for a deletion, which carries no files. */
  transferId?: string;
  pack?: ProfileSyncFile;
}

export interface ProfileSyncChunk {
  /** Base64 of the compressed bytes from `offset`. */
  content: string;
  /** On the final chunk: the pack's size and SHA-256 before compression. */
  last?: { bytes: number; sha256: string };
}

export interface ProfileSyncApplyRequest {
  plugin: string;
  record: ProfileSyncRecord;
  /** The transfer the pack arrived in; absent for a deletion. */
  transferId?: string;
  pack?: ProfileSyncFile;
  /** Sync now: install it again even when the records already agree, if the files here differ. */
  force?: boolean;
}

export interface ProfileSyncApplyResult {
  applied: boolean;
  /** The computer's record for the plugin afterwards. */
  record?: ProfileSyncRecord;
}

/** How one of your other computers stands, for the Profiles tab's footer and Sync sheet. */
/** `off`: Profiles is switched off on that computer, so it doesn't sync. */
export type ProfileSyncComputerState = 'up-to-date' | 'offline' | 'outdated' | 'failed' | 'off';

export interface ProfileSyncComputer {
  /** The desktop's key for it: a saved machine's id, as the sidebar and machine marks use. */
  key: string;
  /** Its Pane install id; empty until it was first reached. */
  id: string;
  name: string;
  state: ProfileSyncComputerState;
  /** The plugins it gets when it reconnects (offline), or that didn't reach it (failed). */
  waiting: string[];
  /** Why it failed, or that its Pane is too old, in a sentence. */
  error?: string;
}

export interface ProfileSyncStatus {
  computers: ProfileSyncComputer[];
  running: boolean;
  /** Epoch ms the last sync ended; absent before the first. */
  lastSyncAt?: number;
}

export const profileSyncRecordSchema: BoundarySchema<ProfileSyncRecord> = boundary.object({
  state: boundary.enumeration('saved', 'pane', 'deleted'),
  hash: boundary.string,
  savedAt: boundary.refine(boundary.number, value => Number.isFinite(value) && value >= 0, 'expected a time in ms'),
  machine: boundary.string,
});

export const profileSyncStateSchema: BoundarySchema<ProfileSyncState> = boundary.object({
  machine: boundary.string,
  name: boundary.string,
  plugins: boundary.record(profileSyncRecordSchema),
});

const fileSchema: BoundarySchema<ProfileSyncFile> = boundary.object({ path: boundary.nonEmptyString, bytes: boundary.number, sha256: boundary.string });

export const profileSyncExportSchema: BoundarySchema<ProfileSyncExport> = boundary.object({
  record: profileSyncRecordSchema,
  transferId: boundary.optional(boundary.string),
  pack: boundary.optional(fileSchema),
});

export const profileSyncChunkSchema: BoundarySchema<ProfileSyncChunk> = boundary.object({
  content: boundary.string,
  last: boundary.optional(boundary.object({ bytes: boundary.number, sha256: boundary.string })),
});

export const profileSyncApplyRequestSchema: BoundarySchema<ProfileSyncApplyRequest> = boundary.object({
  plugin: boundary.nonEmptyString,
  record: profileSyncRecordSchema,
  transferId: boundary.optional(boundary.string),
  pack: boundary.optional(fileSchema),
  force: boundary.optional(boundary.boolean),
});

export const profileSyncApplyResultSchema: BoundarySchema<ProfileSyncApplyResult> = boundary.object({
  applied: boundary.boolean,
  record: boundary.optional(profileSyncRecordSchema),
});

export const profileSyncStatusSchema: BoundarySchema<ProfileSyncStatus> = boundary.object({
  computers: boundary.array(boundary.object({
    key: boundary.string,
    id: boundary.string,
    name: boundary.string,
    state: boundary.enumeration('up-to-date', 'offline', 'outdated', 'failed', 'off'),
    waiting: boundary.array(boundary.string),
    error: boundary.optional(boundary.string),
  })),
  running: boundary.boolean,
  lastSyncAt: boundary.optional(boundary.number),
});

/**
 * Whether `candidate` is a newer save than `current`: the later time wins, and equal times go to
 * the computer with the lower id, so every computer picks the same one whatever order it reads them in.
 */
export function isNewerSave(candidate: ProfileSyncRecord, current: ProfileSyncRecord | undefined): boolean {
  if (!current) return true;
  if (candidate.savedAt !== current.savedAt) return candidate.savedAt > current.savedAt;
  return candidate.machine < current.machine;
}

/** Two records are the same save when they happened at the same time on the same computer. */
export function sameSave(a: ProfileSyncRecord | undefined, b: ProfileSyncRecord | undefined): boolean {
  return !!a && !!b && a.savedAt === b.savedAt && a.machine === b.machine && a.state === b.state;
}
