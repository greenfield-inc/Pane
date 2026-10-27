import fs from 'node:fs';
import path from 'node:path';
import type { RestartToUpdateSource } from '../../../../shared/types/updater';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

const NOTE_FILE = 'restart-to-update.json';
/** A restart that has not relaunched within this long is not the launch the note was written for. */
const NOTE_LIFETIME_MS = 60 * 60_000;

export interface RestoreNote {
  source: RestartToUpdateSource;
  fromVersion: string;
  toVersion: string;
  writtenAt: number;
}

/** Records that Pane is restarting to update, so the next launch restores everything. */
export function writeRestoreNote(directory: string, note: Omit<RestoreNote, 'writtenAt'>, now = Date.now()): void {
  fs.writeFileSync(path.join(directory, NOTE_FILE), JSON.stringify({ ...note, writtenAt: now }));
}

/** Reads and removes the note. Returns null when there is none, or it is stale or unreadable. */
export function takeRestoreNote(directory: string, now = Date.now()): RestoreNote | null {
  const notePath = path.join(directory, NOTE_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(notePath, 'utf8');
  } catch {
    return null;
  }
  fs.rmSync(notePath, { force: true });
  try {
    const note = decodeBoundary(JSON.parse(raw), boundary.object({
      source: boundary.enumeration('toast', 'pill', 'tonight', 'runpane'),
      fromVersion: boundary.string,
      toVersion: boundary.string,
      writtenAt: boundary.number,
    }));
    return now - note.writtenAt <= NOTE_LIFETIME_MS ? note : null;
  } catch (error) {
    console.warn('[RestartToUpdate] Ignored an unreadable restore note:', error);
    return null;
  }
}

export function discardRestoreNote(directory: string): void {
  fs.rmSync(path.join(directory, NOTE_FILE), { force: true });
}
