import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import type { ReaderContext, SourceReadResult } from './types';
import type { SessionImportSource } from '../../../../../shared/types/sessionImport';
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../../shared/validation/boundaryDecoder';

/** The per-user app data folder Electron apps use for `name` on this OS. */
export function appDataDir(context: ReaderContext, name: string): string {
  if (context.platform === 'darwin') return path.join(context.home, 'Library', 'Application Support', name);
  if (context.platform === 'win32') return path.join(context.env.APPDATA || path.join(context.home, 'AppData', 'Roaming'), name);
  return path.join(context.env.XDG_CONFIG_HOME || path.join(context.home, '.config'), name);
}

/** The person's own Claude Code folder. */
export function claudeConfigDir(context: Pick<ReaderContext, 'env' | 'home'>): string {
  return context.env.CLAUDE_CONFIG_DIR || path.join(context.home, '.claude');
}

/** The person's own Codex folder. */
export function codexHome(context: Pick<ReaderContext, 'env' | 'home'>): string {
  return context.env.CODEX_HOME || path.join(context.home, '.codex');
}

export function exists(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

export function mtimeMs(target: string): number | undefined {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return undefined;
  }
}

/** JSON from a file, or undefined when it is missing or not JSON. */
export function readJson(file: string): JsonValue | undefined {
  try {
    return decodeOptionalBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), boundary.json);
  } catch {
    return undefined;
  }
}

/** Complete lines in the first `maxBytes` of a file, so metadata reads stay bounded. */
export function readHeadLines(file: string, maxBytes = 64 * 1024): string[] {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(handle, buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const lines = text.split('\n');
    if (read === maxBytes) lines.pop();
    return lines.filter(line => line.trim() !== '');
  } finally {
    fs.closeSync(handle);
  }
}

/** Complete lines in the last `maxBytes` of a file. */
export function readTailLines(file: string, maxBytes = 64 * 1024): string[] {
  const handle = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const read = fs.readSync(handle, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(line => line.trim() !== '');
  } finally {
    fs.closeSync(handle);
  }
}

export function parseJsonLine(line: string): JsonObject | undefined {
  try {
    return decodeOptionalBoundary(JSON.parse(line), boundary.jsonObject);
  } catch {
    return undefined;
  }
}

export function isRecord(value: JsonValue | undefined): value is JsonObject {
  return decodeOptionalBoundary(value, boundary.jsonObject) !== undefined;
}

export function stringField(record: JsonObject | undefined, key: string): string | undefined {
  return decodeOptionalBoundary(record?.[key], boundary.nonEmptyString);
}

export type SqliteDatabase = InstanceType<typeof Database>;

/**
 * Read a SQLite store from a temporary copy of the database and its -wal and
 * -shm files, so Pane never locks or writes the other tool's live file.
 */
export function withSqliteCopy<T>(context: ReaderContext, dbPath: string, read: (db: SqliteDatabase) => T): T {
  const copyDir = fs.mkdtempSync(path.join(context.tempDir, 'store-'));
  try {
    const copy = path.join(copyDir, path.basename(dbPath));
    fs.copyFileSync(dbPath, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (exists(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, copy + suffix);
    }
    const db = new Database(copy, { fileMustExist: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
}

export function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  // SAFETY: pragma table_info rows always carry a string `name`.
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>;
  return new Set(rows.map(row => row.name));
}

/** Whether `table` exists with every column in `columns`. */
export function hasColumns(db: SqliteDatabase, table: string, columns: readonly string[]): boolean {
  const present = tableColumns(db, table);
  return columns.every(column => present.has(column));
}

export function absent(source: SessionImportSource, storePaths: string[] = []): SourceReadResult {
  return { source, status: 'absent', storePaths, sessions: [] };
}

export function unreadable(source: SessionImportSource, reason: string, storePaths: string[], version?: string): SourceReadResult {
  return { source, status: 'unreadable', reason, version, storePaths, sessions: [] };
}

/** Milliseconds from an ISO string, epoch seconds, or epoch milliseconds. */
export function toMs(value: JsonValue | undefined): number | undefined {
  const numeric = decodeOptionalBoundary(value, boundary.number);
  if (numeric !== undefined) return Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : undefined;
  const text = decodeOptionalBoundary(value, boundary.nonEmptyString);
  if (text === undefined) return undefined;
  if (Number.isFinite(Number(text))) return toMs(Number(text));
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

