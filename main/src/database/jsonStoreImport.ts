import type Database from 'better-sqlite3-multiple-ciphers';
import { copyFileSync, existsSync, readFileSync } from 'fs';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';

/**
 * Moves a JSON store into sessions.db once. The shared step every such move uses (D-160):
 *
 * 1. If its marker exists, nothing happens.
 * 2. The source file is copied aside before anything changes. The source itself is never touched.
 * 3. The rows and the marker go in one transaction, so an interrupted run leaves neither and the
 *    next start runs it again.
 * 4. Any failure leaves the source as it was and returns a PaneError for the UI to show.
 */

export const IMPORT_MARKERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS json_store_imports (
    source TEXT PRIMARY KEY,
    imported_at INTEGER NOT NULL,
    item_count INTEGER NOT NULL,
    backup_path TEXT
  )`;

const markerRowSchema = boundary.object({
  source: boundary.string,
  imported_at: boundary.number,
  item_count: boundary.number,
  backup_path: boundary.nullable(boundary.string),
});

export interface JsonStoreImportMarker {
  source: string;
  importedAt: number;
  itemCount: number;
  backupPath: string | null;
}

export interface JsonStoreImportRequest {
  /** The store's name in the marker table, also what the error calls it. */
  source: string;
  filePath: string;
  /** Inside one transaction: writes the parsed file's rows and returns how many it wrote. */
  apply: (parsed: JsonValue) => number;
  now?: () => number;
  /** Test hook: runs inside the transaction, after the rows and before the marker. */
  insideTransaction?: () => void;
}

export type JsonStoreImportOutcome =
  /** Ran earlier: nothing changed. */
  | { status: 'already'; marker: JsonStoreImportMarker }
  /** The rows moved on this start (a missing file moves none). */
  | { status: 'imported'; marker: JsonStoreImportMarker }
  /** Nothing changed and nothing was lost; the next start tries again. */
  | { status: 'failed'; error: PaneError };

export function readImportMarker(db: Database.Database, source: string): JsonStoreImportMarker | undefined {
  const row = decodeOptionalBoundary(db.prepare('SELECT source, imported_at, item_count, backup_path FROM json_store_imports WHERE source = ?').get(source), markerRowSchema);
  return row && { source: row.source, importedAt: row.imported_at, itemCount: row.item_count, backupPath: row.backup_path };
}

export function importJsonStoreOnce(db: Database.Database, request: JsonStoreImportRequest): JsonStoreImportOutcome {
  const { source, filePath, apply, insideTransaction } = request;
  const now = request.now ?? Date.now;
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  try {
    db.prepare(IMPORT_MARKERS_TABLE_SQL).run();
    const existing = readImportMarker(db, source);
    if (existing) return { status: 'already', marker: existing };
    const at = now();
    const present = existsSync(filePath);
    const parsed: JsonValue = present ? decodeBoundary(JSON.parse(readFileSync(filePath, 'utf8')), boundary.json) : null;
    let backupPath: string | null = null;
    if (present) {
      // Named once per store: a retry after a failure must not stack up copies, and the first
      // copy is the one taken before anything changed.
      backupPath = `${filePath}.before-import`;
      if (!existsSync(backupPath)) copyFileSync(filePath, backupPath);
    }
    const marker = db.transaction((): JsonStoreImportMarker => {
      const itemCount = present ? apply(parsed) : 0;
      insideTransaction?.();
      db.prepare('INSERT INTO json_store_imports (source, imported_at, item_count, backup_path) VALUES (?, ?, ?, ?)').run(source, at, itemCount, backupPath);
      return { source, importedAt: at, itemCount, backupPath };
    })();
    return { status: 'imported', marker };
  } catch (error) {
    return {
      status: 'failed',
      error: new PaneError(
        'ERR_JSON_STORE_IMPORT',
        `Pane couldn't import your saved ${source} from ${fileName}: ${reasonOf(error)}. Nothing was deleted; it retries on the next start.`,
        `Restart Pane to retry. If it keeps failing, fix or move ${filePath}.`,
      ),
    };
  }
}
