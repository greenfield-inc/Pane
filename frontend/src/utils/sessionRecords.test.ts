import { describe, expect, it } from 'vitest';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { newestFullRecord, SessionSettingsForm, settingsSave, withNewerSummary } from './sessionRecords';

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

describe('Session settings after another client changed the profile (T-127 review F-1)', () => {
  it('prefill the overview\'s profile when the folded summary reached the same revision', () => {
    const { activity: _activity, profile: _profile, ...summary } = record(5);
    const open = withNewerSummary(record(4, { profile: 'Old profile.' }), summary);
    const overview = record(5, { profile: 'New profile.' });

    expect(newestFullRecord(open, overview).profile).toBe('New profile.');
  });

  it('save with the revision of the record they prefilled from, so a stale prefill is refused rather than saved over a newer profile', () => {
    const prefill = record(4, { profile: 'Old profile.' });

    expect(settingsSave(prefill, { launchCommand: 'claude --verbose', profile: 'Old profile.' }))
      .toEqual({ launchCommand: 'claude --verbose', profile: 'Old profile.', expectedRevision: 4 });
  });

  it('send the revision the profile was read at when the overview has not caught up, so the host refuses the stale save', () => {
    const { activity: _activity, profile: _profile, ...summary } = record(5);
    const folded = withNewerSummary(record(4, { profile: 'Old profile.' }), summary);
    const prefill = newestFullRecord(folded, record(4, { profile: 'Old profile.' }));

    expect(prefill.revision).toBe(5);
    expect(settingsSave(prefill, { profile: 'Old profile.' }).expectedRevision).toBe(4);
  });

  it('send the record\'s own revision once a full record replaced the folded one', () => {
    const { activity: _activity, profile: _profile, ...summary } = record(5);
    const folded = withNewerSummary(record(4), summary);

    expect(settingsSave(withNewerSummary(folded, record(6)), {}).expectedRevision).toBe(6);
  });
});

describe('SessionSettingsForm (T-127 review F-3)', () => {
  // The phone set the profile to "New" at revision 5; the list summary landed first, the overview later.
  function openedBeforeTheOverview() {
    const { activity: _activity, profile: _profile, ...summary } = record(5);
    const view = withNewerSummary(record(4, { profile: 'Old' }), summary);
    return { view, form: new SessionSettingsForm(newestFullRecord(view, record(4, { profile: 'Old' }))) };
  }

  it('checks a save against the record the form was filled from, even after the overview lands while it is open', () => {
    const { view, form } = openedBeforeTheOverview();
    const landed = newestFullRecord(view, record(5, { profile: 'New' }));

    expect(landed.profile).toBe('New');
    expect(form.values.profile).toBe('Old');
    expect(form.saveInput(form.values).expectedRevision).toBe(4);
  });

  it('refills from the current record after the host refuses a stale save, so saving again cannot write the old profile', () => {
    const { form } = openedBeforeTheOverview();
    const refused = 'Session Release changed; expected revision 4, found 5';

    const next = form.afterFailure(refused, record(5, { profile: 'New' }));

    expect(next.form.values.profile).toBe('New');
    expect(next.form.saveInput(next.form.values).expectedRevision).toBe(5);
    expect(next.message).toBe('These settings changed on another device. The form now shows the current ones: check them and save again.');
  });

  it('keeps what the person typed when a save fails for another reason', () => {
    const { form } = openedBeforeTheOverview();

    const next = form.afterFailure('The host did not answer.', record(5, { profile: 'New' }));

    expect(next.form).toBe(form);
    expect(next.message).toBe('The host did not answer.');
  });
});
