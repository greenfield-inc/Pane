import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { takeRestoreNote, writeRestoreNote } from './restoreNote';

describe('restore note', () => {
  let directory: string;
  const writtenAt = Date.parse('2026-10-26T14:00:00Z');

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-restore-note-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('returns a fresh note once, then nothing', () => {
    const navigation = { hostId: null, memory: { view: 'sessions' as const, projectId: 1, paneId: 'dark-mode', orchestrationSessionId: null } };
    writeRestoreNote(directory, { source: 'toast', fromVersion: '2.4.202', toVersion: '2.4.203', navigation }, writtenAt);
    expect(takeRestoreNote(directory, writtenAt + 30_000)).toEqual({
      source: 'toast', fromVersion: '2.4.202', toVersion: '2.4.203', writtenAt,
      navigation: { hostId: null, memory: { view: 'sessions', projectId: 1, paneId: 'dark-mode', orchestrationSessionId: null } },
    });
    expect(takeRestoreNote(directory, writtenAt + 31_000)).toBeNull();
  });

  it('ignores and removes a note older than 1 hour', () => {
    writeRestoreNote(directory, { source: 'tonight', fromVersion: '2.4.202', toVersion: '2.4.203', navigation: null }, writtenAt);
    expect(takeRestoreNote(directory, writtenAt + 60 * 60_000 + 1)).toBeNull();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('returns nothing when there is no note', () => {
    expect(takeRestoreNote(directory, writtenAt)).toBeNull();
  });

  it('removes an unreadable note without restoring', () => {
    fs.writeFileSync(path.join(directory, 'restart-to-update.json'), '{not json');
    expect(takeRestoreNote(directory, writtenAt)).toBeNull();
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
