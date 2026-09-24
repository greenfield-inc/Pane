import type Database from 'better-sqlite3-multiple-ciphers';
import { constants, copyFileSync, existsSync, statSync } from 'fs';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PANEL_BUFFER_KEYS, splitPanelBufferState, type PanelBufferStore } from './panelBuffers';

/**
 * One-time repair that moves terminal bytes out of `tool_panels.state`.
 *
 * Before this schema version, every PTY output chunk without a newline was
 * appended to `customState.lastActiveCommand` and, on newline, pushed into
 * `customState.commandHistory`. Full-screen agents never emit a newline in the
 * alternate screen, so a single panel reached a 428 MB state blob and the
 * whole-blob JSON.parse / JSON.stringify on every panel update exhausted the
 * V8 heap. The repair drops those two dead keys, moves `scrollbackBuffer`,
 * `serializedBuffer` and `alternateScreenBuffer` into `panel_buffers` under
 * the byte cap, and vacuums.
 *
 * Idempotent via `PRAGMA user_version`; a backup copy of the database file is
 * written before the first real run.
 */
export const PANEL_BUFFER_SCHEMA_VERSION = 1;

const DEAD_KEYS = ['lastActiveCommand', 'commandHistory'] as const;
const MOVED_PATHS = [...PANEL_BUFFER_KEYS, ...DEAD_KEYS].map((key) => `$.customState.${key}`);

/**
 * Rows whose state is a JSON object carrying any of the five keys. The
 * substr test runs first so rows that cannot match are never JSON-parsed.
 */
const CANDIDATE_PREDICATE = `
  substr(state, 1, 1) = '{'
  AND json_valid(state)
  AND (${MOVED_PATHS.map((path) => `json_type(state, '${path}') IS NOT NULL`).join(' OR ')})
`;

export interface PanelBufferMigrationResult {
  /** False when the schema version was already current or nothing needed moving. */
  migrated: boolean;
  panelsRepaired: number;
  panelsWithBuffers: number;
  backupPath: string | null;
  fileBytesBefore: number | null;
  fileBytesAfter: number | null;
  durationMs: number;
}

interface CandidateIdRow {
  id: string;
}

/** Single-path json_extract returns native TEXT; an array scrollback comes back as JSON text. */
interface CandidateBufferRow {
  scrollback: string | null;
  scrollbackType: string | null;
  serialized: string | null;
  alternate: string | null;
}

const legacyScrollbackSchema = boundary.array(boundary.string);

/**
 * Older builds wrote `state` as a JSON string wrapping the object. Unwrap so
 * the per-key merge in `updatePanel` and the migration predicate see an
 * object. The migration runs this over every row once; `updatePanel` keeps
 * it as a per-row guard in case the migration never completed.
 */
export function unwrapStringWrappedPanelState(db: Database.Database, panelId?: string): void {
  db.prepare(
    `UPDATE tool_panels
     SET state = json_extract(state, '$')
     WHERE ${panelId === undefined ? '1 = 1' : 'id = ?'}
       AND substr(state, 1, 1) = '"' AND json_valid(state)
       AND json_valid(json_extract(state, '$')) AND json_type(json_extract(state, '$')) = 'object'`,
  ).run(...(panelId === undefined ? [] : [panelId]));
}

function fileSize(dbPath: string): number | null {
  try {
    return existsSync(dbPath) ? statSync(dbPath).size : null;
  } catch {
    return null;
  }
}

function readUserVersion(db: Database.Database): number {
  return decodeBoundary(db.pragma('user_version', { simple: true }), boundary.number);
}

function writeBackup(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const backupPath = `${dbPath}.pre-panel-buffers-${Date.now()}.bak`;
  // APFS clones the file instantly; other filesystems fall back to a plain copy.
  copyFileSync(dbPath, backupPath, constants.COPYFILE_FICLONE);
  return backupPath;
}

export function migratePanelBuffers(
  db: Database.Database,
  dbPath: string,
  store: PanelBufferStore,
): PanelBufferMigrationResult {
  const startedAt = Date.now();
  const skipped: PanelBufferMigrationResult = {
    migrated: false,
    panelsRepaired: 0,
    panelsWithBuffers: 0,
    backupPath: null,
    fileBytesBefore: null,
    fileBytesAfter: null,
    durationMs: 0,
  };

  if (readUserVersion(db) >= PANEL_BUFFER_SCHEMA_VERSION) return skipped;

  unwrapStringWrappedPanelState(db);

  // One scan over the big blobs; everything after this addresses rows by id.
  // SAFETY: This fixed SQLite query projection matches the declared row type at this database boundary.
  const candidates = (db
    .prepare(`SELECT id FROM tool_panels WHERE ${CANDIDATE_PREDICATE}`)
    .all() as CandidateIdRow[]).map((row) => row.id);

  if (candidates.length === 0) {
    db.pragma(`user_version = ${PANEL_BUFFER_SCHEMA_VERSION}`);
    return { ...skipped, durationMs: Date.now() - startedAt };
  }

  // WAL mode: fold pending commits into the main file so the size and the
  // file-level backup copy are complete.
  db.pragma('wal_checkpoint(TRUNCATE)');
  const fileBytesBefore = fileSize(dbPath);
  const backupPath = writeBackup(dbPath);
  console.log(
    `[PanelBuffers] Migrating ${candidates.length} panel states (database ${fileBytesBefore ?? 'unknown'} bytes, ` +
    `backup ${backupPath ?? 'skipped'})`,
  );

  let panelsWithBuffers = 0;
  let panelsRepaired = 0;
  const candidateIdsJson = JSON.stringify(candidates);
  const migrate = db.transaction(() => {
    // Only the three buffer values ever reach the JS heap, never the state
    // blob they are extracted from.
    const readBuffers = db.prepare(
      `SELECT json_extract(state, '$.customState.scrollbackBuffer') AS scrollback,
              json_type(state, '$.customState.scrollbackBuffer') AS scrollbackType,
              json_extract(state, '$.customState.serializedBuffer') AS serialized,
              json_extract(state, '$.customState.alternateScreenBuffer') AS alternate
       FROM tool_panels WHERE id = ?`,
    );
    for (const id of candidates) {
      // SAFETY: This fixed SQLite query projection matches the declared row type at this database boundary.
      const row = readBuffers.get(id) as CandidateBufferRow | undefined;
      if (!row || (row.scrollback === null && row.serialized === null && row.alternate === null)) continue;
      const scrollbackBuffer = row.scrollbackType === 'array' && row.scrollback !== null
        ? decodeBoundary(JSON.parse(row.scrollback), legacyScrollbackSchema)
        : row.scrollback ?? undefined;
      // Same normalization as a live write: legacy array scrollback joins, strings pass through.
      const { patch } = splitPanelBufferState({
        isActive: false,
        customState: {
          scrollbackBuffer,
          serializedBuffer: row.serialized ?? undefined,
          alternateScreenBuffer: row.alternate ?? undefined,
        },
      });
      if (patch) store.apply(id, patch);
      panelsWithBuffers += 1;
    }

    panelsRepaired = db
      .prepare(
        `UPDATE tool_panels
         SET state = json_remove(state, ${MOVED_PATHS.map((path) => `'${path}'`).join(', ')}),
             updated_at = CURRENT_TIMESTAMP
         WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .run(candidateIdsJson).changes;

    db.pragma(`user_version = ${PANEL_BUFFER_SCHEMA_VERSION}`);
  });
  migrate();

  db.exec('VACUUM');
  // VACUUM's rewrite lands in the WAL; checkpoint so the main file shrinks now.
  db.pragma('wal_checkpoint(TRUNCATE)');

  return {
    migrated: true,
    panelsRepaired,
    panelsWithBuffers,
    backupPath,
    fileBytesBefore,
    fileBytesAfter: fileSize(dbPath),
    durationMs: Date.now() - startedAt,
  };
}
