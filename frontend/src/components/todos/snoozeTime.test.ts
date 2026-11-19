import { describe, expect, it } from 'vitest';
import type { TodoSnooze } from '../../../../shared/types/todos';
import {
  fromDatetimeLocal, nextMonday, presetWhen, setByText, snoozeFull, snoozePresets, snoozeReason, snoozeWhen, toDatetimeLocal,
  tomorrowMorning, wakesIn, zoneNote,
} from './snoozeTime';

const LA = 'America/Los_Angeles';
const LONDON = 'Europe/London';

describe('presets (calendar arithmetic in the viewer\'s zone)', () => {
  // Tue 17 Nov 2026, 3:11:30 PM PST.
  const now = Date.parse('2026-11-17T15:11:30-08:00');

  it('In an hour, Tomorrow morning and Next Monday, each with the time it resolves to', () => {
    const presets = snoozePresets(now, LA);
    expect(presets.map(preset => preset.id)).toEqual(['hour', 'tomorrow', 'monday']);
    expect(presets[0].at).toBe(Date.parse('2026-11-17T16:12:00-08:00'));
    expect(presets[0].when).toBe('Today 4:12 PM');
    expect(presets[1].at).toBe(Date.parse('2026-11-18T09:00:00-08:00'));
    expect(presets[1].when).toBe('Wed 18 Nov, 9:00 AM');
    expect(presets[2].at).toBe(Date.parse('2026-11-23T09:00:00-08:00'));
    expect(presets[2].when).toBe('Mon 23 Nov, 9:00 AM');
  });

  it('Tomorrow morning stays 9:00 AM local across the autumn change (PDT to PST)', () => {
    // Sat 31 Oct 2026, 3 PM PDT; clocks go back at 2 AM on Sun 1 Nov.
    const before = Date.parse('2026-10-31T15:00:00-07:00');
    expect(tomorrowMorning(before, LA)).toBe(Date.parse('2026-11-01T09:00:00-08:00'));
    expect(nextMonday(before, LA)).toBe(Date.parse('2026-11-02T09:00:00-08:00'));
  });

  it('Tomorrow morning stays 9:00 AM local across the spring change (PST to PDT)', () => {
    const before = Date.parse('2026-03-07T20:00:00-08:00');
    expect(tomorrowMorning(before, LA)).toBe(Date.parse('2026-03-08T09:00:00-07:00'));
  });

  it('Next Monday is the coming Monday, never today', () => {
    const monday = Date.parse('2026-11-23T08:00:00-08:00');
    expect(nextMonday(monday, LA)).toBe(Date.parse('2026-11-30T09:00:00-08:00'));
    const sunday = Date.parse('2026-11-22T23:30:00-08:00');
    expect(nextMonday(sunday, LA)).toBe(Date.parse('2026-11-23T09:00:00-08:00'));
  });

  it('works in the viewer\'s zone, not UTC', () => {
    // 11 PM in London is already tomorrow in UTC+1 zones; tomorrow is still the next London day.
    const late = Date.parse('2026-11-17T23:00:00Z');
    expect(tomorrowMorning(late, LONDON)).toBe(Date.parse('2026-11-18T09:00:00Z'));
  });
});

describe('how a wake time reads', () => {
  const now = Date.parse('2026-11-17T15:12:00-08:00');
  const wed = Date.parse('2026-11-18T09:00:00-08:00');

  it('the list: a weekday within the coming week, a date beyond it', () => {
    expect(snoozeWhen(wed, now, LA)).toBe('Wed 9:00 AM');
    expect(snoozeWhen(Date.parse('2026-11-25T09:00:00-08:00'), now, LA)).toBe('Wed 25 Nov, 9:00 AM');
  });

  it('a preset: Today for today', () => {
    expect(presetWhen(Date.parse('2026-11-17T16:12:00-08:00'), now, LA)).toBe('Today 4:12 PM');
  });

  it('the banner: in full, with the zone', () => {
    expect(snoozeFull(wed, LA)).toBe('Wednesday 18 November, 9:00 AM PST');
  });

  it('wakes in: its two largest units', () => {
    expect(wakesIn(wed, now)).toBe('17h 48m');
    expect(wakesIn(Date.parse('2026-11-20T10:00:00-08:00'), now)).toBe('2d 18h');
    expect(wakesIn(now + 45 * 60_000, now)).toBe('45m');
  });

  it('the date and time picker round-trips through the viewer\'s zone', () => {
    expect(toDatetimeLocal(Date.parse('2026-11-20T10:00:00-08:00'), LA)).toBe('2026-11-20T10:00');
    expect(fromDatetimeLocal('2026-11-20T10:00', LA)).toBe(Date.parse('2026-11-20T10:00:00-08:00'));
    expect(fromDatetimeLocal('2026-03-08T09:00', LA)).toBe(Date.parse('2026-03-08T09:00:00-07:00'));
    expect(fromDatetimeLocal('not a time', LA)).toBeNull();
  });
});

describe('a snoozed row\'s words', () => {
  const snooze: TodoSnooze = {
    until: Date.parse('2026-11-18T09:00:00-08:00'), zone: LA, note: '\ncheck Sentry and the PDF download rate\nthen post', action: 'agents', by: 'orchestrator', from: 'in_progress', reminderCardId: null,
  };
  const now = Date.parse('2026-11-17T15:12:00-08:00');

  it('until the time, then the note\'s first line; machine offline when it is', () => {
    expect(snoozeReason(snooze, now, LA)).toBe('until Wed 9:00 AM · check Sentry and the PDF download rate');
    expect(snoozeReason({ ...snooze, note: '' }, now, LA, true)).toBe('until Wed 9:00 AM · machine offline');
  });

  it('who set it', () => {
    expect(setByText('you')).toBe('set by you');
    expect(setByText('orchestrator')).toBe('set by the orchestrator');
    expect(setByText('planner')).toBe('set by planner');
  });

  it('names the zone it was set in only when that differs from the viewer\'s', () => {
    expect(zoneNote(snooze, LA)).toBeNull();
    expect(zoneNote({ ...snooze, zone: LONDON }, LA)).toBe('5:00 PM in Europe/London, where it was set');
  });
});
