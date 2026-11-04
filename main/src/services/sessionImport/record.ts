import fs from 'fs';
import path from 'path';
import type { SessionImportSource } from '../../../../shared/types/sessionImport';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { isRecord, readJson, stringField } from './sources/common';

/**
 * The migrate-to-pane skill's record, `<PANE_DIR>/migrate-to-pane/record.json`.
 * The app writes the same fields so a rerun from either path creates nothing
 * twice; `tool` is the agent and `source` the tool the session came from.
 */
export type MigrationRecordEntry = {
  tool: string;
  id: string;
  folder: string;
  paneId: string | null;
  panelId: string | null;
  forkId: string | null;
  result: 'pending' | 'continued' | 'continued as a fork' | 'not continued';
  at: string;
  source: SessionImportSource;
};

function migrationRecordPath(paneDir: string): string {
  return path.join(paneDir, 'migrate-to-pane', 'record.json');
}

function readEntries(paneDir: string): JsonValue[] {
  const parsed = readJson(migrationRecordPath(paneDir));
  return isRecord(parsed) && Array.isArray(parsed.sessions) ? parsed.sessions : [];
}

/** `<tool>:<id>` of every session the record holds in Pane; a "not continued" one can be tried again. */
export function recordedSessionKeys(paneDir: string): Set<string> {
  const keys = new Set<string>();
  for (const entry of readEntries(paneDir)) {
    if (!isRecord(entry) || entry.result === 'not continued') continue;
    const tool = stringField(entry, 'tool');
    const id = stringField(entry, 'id');
    if (tool && id) keys.add(`${tool}:${id}`);
  }
  return keys;
}

/** Add or replace the entry for one session, keeping every other entry as the skill wrote it. */
export function writeRecordEntry(paneDir: string, entry: MigrationRecordEntry): void {
  const sessions = readEntries(paneDir).filter(existing =>
    !(isRecord(existing) && existing.tool === entry.tool && existing.id === entry.id));
  sessions.push(entry);
  const file = migrationRecordPath(paneDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ sessions }, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
