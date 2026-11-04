import fs from 'node:fs';
import path from 'node:path';
import type { RestartToUpdateSource, RestoredNavigation } from '../../../../shared/types/updater';
import { decodeHostNavigationMemory } from '../../../../shared/types/hostNavigation';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

const NOTE_FILE = 'restart-to-update.json';
/** A restart that has not relaunched within this long is not the launch the note was written for. */
const NOTE_LIFETIME_MS = 60 * 60_000;

export interface RestoreNote {
  source: RestartToUpdateSource;
  fromVersion: string;
  toVersion: string;
  /** Where the user was at restart; a write during the next launch cannot overwrite it here. */
  navigation: RestoredNavigation | null;
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
      navigation: boundary.optional(boundary.nullable(boundary.object({
        hostId: boundary.nullable(boundary.string),
        memory: boundary.json,
      }))),
      writtenAt: boundary.number,
    }));
    if (now - note.writtenAt > NOTE_LIFETIME_MS) return null;
    const memory = note.navigation ? decodeHostNavigationMemory(note.navigation.memory) : null;
    return { ...note, navigation: note.navigation && memory ? { hostId: note.navigation.hostId, memory } : null };
  } catch (error) {
    console.warn('[RestartToUpdate] Ignored an unreadable restore note:', error);
    return null;
  }
}

export function discardRestoreNote(directory: string): void {
  fs.rmSync(path.join(directory, NOTE_FILE), { force: true });
}
