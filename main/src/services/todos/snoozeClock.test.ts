import { describe, expect, it } from 'vitest';
import { durationText, isKnownZone, isoInZone, nextMorning, snoozeWhen, zonedInstant } from './snoozeClock';

const LA = 'America/Los_Angeles';

describe('snooze clock', () => {
  it('writes an instant as ISO 8601 with the offset of the zone it was set in', () => {
    expect(isoInZone(Date.UTC(2026, 10, 18, 17, 0), LA)).toBe('2026-11-18T09:00:00-08:00');
    expect(isoInZone(Date.UTC(2026, 10, 18, 17, 0), 'Europe/London')).toBe('2026-11-18T17:00:00+00:00');
    expect(isoInZone(Date.UTC(2026, 10, 18, 3, 30), 'Asia/Kolkata')).toBe('2026-11-18T09:00:00+05:30');
    expect(isoInZone(Date.UTC(2026, 6, 1, 16, 0), LA)).toBe('2026-07-01T09:00:00-07:00');
  });

  it('turns a wall time in a zone into its instant, either side of a daylight-saving change', () => {
    expect(zonedInstant({ year: 2026, month: 11, day: 18, hour: 9, minute: 0 }, LA)).toBe(Date.UTC(2026, 10, 18, 17, 0));
    expect(zonedInstant({ year: 2026, month: 10, day: 30, hour: 9, minute: 0 }, LA)).toBe(Date.UTC(2026, 9, 30, 16, 0));
  });

  it('the next morning is 9:00 tomorrow in the zone, or Monday when tomorrow is a weekend day', () => {
    // Monday 16 Nov, 2 PM → Tuesday 9 AM.
    expect(nextMorning(Date.UTC(2026, 10, 16, 22, 0), LA)).toBe(Date.UTC(2026, 10, 17, 17, 0));
    // Monday 11:30 PM in LA is already Tuesday in UTC: still Tuesday 9 AM there.
    expect(nextMorning(Date.UTC(2026, 10, 17, 7, 30), LA)).toBe(Date.UTC(2026, 10, 17, 17, 0));
    // Friday and Saturday → Monday.
    expect(nextMorning(Date.UTC(2026, 10, 20, 20, 0), LA)).toBe(Date.UTC(2026, 10, 23, 17, 0));
    expect(nextMorning(Date.UTC(2026, 10, 21, 20, 0), LA)).toBe(Date.UTC(2026, 10, 23, 17, 0));
    // Saturday 31 Oct (PDT) → Monday 2 Nov 9 AM PST, after the clocks go back.
    expect(nextMorning(Date.UTC(2026, 9, 31, 17, 0), LA)).toBe(Date.UTC(2026, 10, 2, 17, 0));
    // Thursday 29 Oct → Friday 9 AM PDT.
    expect(nextMorning(Date.UTC(2026, 9, 29, 17, 0), LA)).toBe(Date.UTC(2026, 9, 30, 16, 0));
  });

  it('says how long, in the largest two units', () => {
    expect([20_000, 45 * 60_000, 3 * 3_600_000, 80 * 60_000, 14 * 3_600_000, 51 * 3_600_000].map(durationText)).toEqual(['1m', '45m', '3h', '1h 20m', '14h', '2d 3h']);
  });

  it('names a wake time by weekday within the week, and adds the date beyond it', () => {
    const now = Date.UTC(2026, 10, 16, 22, 0);
    expect(snoozeWhen(Date.UTC(2026, 10, 18, 17, 0), now, LA)).toBe('Wed 9:00 AM');
    expect(snoozeWhen(Date.UTC(2026, 10, 25, 17, 0), now, LA)).toBe('Wed 25 Nov, 9:00 AM');
    expect(snoozeWhen(Date.UTC(2026, 10, 18, 17, 0), now, LA, { full: true })).toBe('Wed 18 Nov, 9:00 AM');
  });

  it('knows a real IANA zone from a made-up one', () => {
    expect(isKnownZone(LA)).toBe(true);
    expect(isKnownZone('Mars/Olympus')).toBe(false);
    expect(isKnownZone('')).toBe(false);
  });
});
