import { describe, expect, it } from 'vitest';
import { agentTempFolderName, classifyPaneDataFile, replacedUpdates } from './reclaimRules';

const DAY = 86_400_000;

describe('replacedUpdates', () => {
  it('removes every update older than the newest completed one, whatever its outcome', () => {
    const replaced = replacedUpdates([
      { id: 'u1', phase: 'complete', updatedAt: Date.parse('2026-10-01') },
      { id: 'u2', phase: 'needs-attention', updatedAt: Date.parse('2026-10-31') },
      { id: 'u3', phase: 'complete', updatedAt: Date.parse('2026-11-10') },
      { id: 'u4', phase: 'failed', updatedAt: Date.parse('2026-11-12') },
      { id: 'u5', phase: 'install', updatedAt: Date.parse('2026-11-15') },
    ]);
    expect(replaced).toEqual(['u1', 'u2']);
  });

  it('keeps everything until one update has completed', () => {
    expect(replacedUpdates([
      { id: 'u1', phase: 'needs-attention', updatedAt: 1 },
      { id: 'u2', phase: 'failed', updatedAt: 2 },
    ])).toEqual([]);
  });
});

describe('agentTempFolderName', () => {
  it('turns every character outside letters and digits into a dash, as Claude Code names its folders', () => {
    expect(agentTempFolderName('/Users/parsas/allGitHubRepos/dcouple/Pane/worktrees/glassly-port'))
      .toBe('-Users-parsas-allGitHubRepos-dcouple-Pane-worktrees-glassly-port');
    expect(agentTempFolderName('/Users/parsas/.pane/sessions/__orchestration_session_dc86a98e__'))
      .toBe('-Users-parsas--pane-sessions---orchestration-session-dc86a98e--');
  });
});

describe('classifyPaneDataFile', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const cleanOpenAt = now - 5 * DAY;

  it('lets a migration backup go once it is 30 days old and the database has opened cleanly since', () => {
    expect(classifyPaneDataFile('sessions.db.pre-panel-buffers-1757600000000.bak', now - 40 * DAY, now, cleanOpenAt)).toBe('migration-backup');
  });

  it('keeps a migration backup with no clean open recorded after it', () => {
    expect(classifyPaneDataFile('sessions.db.pre-panel-buffers-1757600000000.bak', now - 40 * DAY, now, null)).toBe('keep');
    expect(classifyPaneDataFile('sessions.db.pre-panel-buffers-1757600000000.bak', now - 40 * DAY, now, now - 41 * DAY)).toBe('keep');
  });

  it('keeps a migration backup younger than 30 days', () => {
    expect(classifyPaneDataFile('sessions.db.pre-panel-buffers-1757600000000.bak', now - 10 * DAY, now, cleanOpenAt)).toBe('keep');
  });

  it('shows database copies Pane did not write, and leaves the live database files alone', () => {
    expect(classifyPaneDataFile('sessions.db.before-repair', now - 3 * DAY, now, cleanOpenAt)).toBe('foreign');
    expect(classifyPaneDataFile('sessions-copy.db', now - 3 * DAY, now, cleanOpenAt)).toBe('foreign');
    for (const live of ['sessions.db', 'sessions.db-wal', 'sessions.db-shm', 'config.json']) {
      expect(classifyPaneDataFile(live, now - 90 * DAY, now, cleanOpenAt)).toBe('keep');
    }
  });
});
