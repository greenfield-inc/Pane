import { describe, expect, it } from 'vitest';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { newestFullRecord, withNewerSummary } from './sessionRecords';

function record(revision: number, overrides: Partial<OrchestrationSessionRecord> = {}): OrchestrationSessionRecord {
  return {
    id: 'session-1', name: 'Release', agent: 'claude', internalSessionId: 'internal-1',
    panelIds: { claude: 'panel-claude', codex: 'panel-codex', cursor: 'panel-cursor', opencode: 'panel-opencode', pi: 'panel-pi' },
    goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [],
    activity: [{ id: 'a1', kind: 'updated', message: 'Updated the goal.', at: '2026-11-26T10:00:00.000Z', source: 'user' }],
    profile: 'Answer in French.',
    revision, createdAt: '2026-11-26T09:00:00.000Z', updatedAt: '2026-11-26T10:00:00.000Z',
    ...overrides,
  };
}

describe('withNewerSummary (T-127)', () => {
  it('takes the summary\'s fields and keeps the open record\'s profile and activity log', () => {
    const open = record(3);
    const { activity: _activity, profile: _profile, ...summary } = record(4, { name: 'Release 2', goal: 'Ship it' });

    const folded = withNewerSummary(open, summary);

    expect(folded).toMatchObject({ name: 'Release 2', goal: 'Ship it', revision: 4, profile: 'Answer in French.' });
    expect(folded.activity).toEqual(open.activity);
  });

  it('takes a full record whole, so a changed profile shows', () => {
    const folded = withNewerSummary(record(3), record(4, { profile: 'Answer in German.', activity: [] }));

    expect(folded.profile).toBe('Answer in German.');
    expect(folded.activity).toEqual([]);
  });
});

describe('newestFullRecord (T-127)', () => {
  it('picks the overview\'s record once it is newer than the open view\'s', () => {
    expect(newestFullRecord(record(3), record(5, { profile: 'Newer.' })).profile).toBe('Newer.');
    expect(newestFullRecord(record(5, { profile: 'Open.' }), record(3)).profile).toBe('Open.');
    expect(newestFullRecord(record(5, { profile: 'Open.' }), undefined).profile).toBe('Open.');
  });
});
