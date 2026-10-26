import { describe, expect, it } from 'vitest';
import { cronFromSchedule, describeSchedule, scheduleFromCron } from '../../../../shared/utils/loopSchedule';

describe('scheduleFromCron', () => {
  it('opens each picker shape in its mode', () => {
    expect(scheduleFromCron('15 * * * *')).toMatchObject({ repeat: 'hourly', minute: 15 });
    expect(scheduleFromCron('0 3 * * *')).toMatchObject({ repeat: 'daily', hour: 3, minute: 0 });
    expect(scheduleFromCron('30 9 * * 1-5')).toMatchObject({ repeat: 'weekdays', hour: 9, minute: 30 });
    expect(scheduleFromCron('0 9 * * 1,3,5')).toMatchObject({ repeat: 'weekly', hour: 9, weekdays: [1, 3, 5] });
    expect(scheduleFromCron('0 9 * * 7,6')).toMatchObject({ repeat: 'weekly', weekdays: [0, 6] });
    expect(scheduleFromCron('0 16 15 * *')).toMatchObject({ repeat: 'monthly', hour: 16, dayOfMonth: 15 });
  });

  it('opens anything else in Custom cron, unchanged', () => {
    for (const cron of ['0 */6 * * *', '0 9 1 * 1', '0 9 * 1 *', '0 9 * * MON', '0 24 * * *', '0 9 * * 0-2', 'nonsense']) {
      expect(scheduleFromCron(cron)).toMatchObject({ repeat: 'custom', cron });
    }
  });
});

describe('cronFromSchedule', () => {
  const base = { minute: 5, hour: 9, weekdays: [1, 3, 5], dayOfMonth: 28, cron: ' 0 */6 * * * ' };

  it('writes the cron for each mode', () => {
    expect(cronFromSchedule({ ...base, repeat: 'hourly' })).toBe('5 * * * *');
    expect(cronFromSchedule({ ...base, repeat: 'daily' })).toBe('5 9 * * *');
    expect(cronFromSchedule({ ...base, repeat: 'weekdays' })).toBe('5 9 * * 1-5');
    expect(cronFromSchedule({ ...base, repeat: 'weekly' })).toBe('5 9 * * 1,3,5');
    expect(cronFromSchedule({ ...base, repeat: 'monthly' })).toBe('5 9 28 * *');
    expect(cronFromSchedule({ ...base, repeat: 'custom' })).toBe('0 */6 * * *');
  });
});

describe('describeSchedule', () => {
  const base = { minute: 0, hour: 9, weekdays: [1], dayOfMonth: 26, cron: '' };

  it('reads like Google Calendar', () => {
    expect(describeSchedule({ ...base, repeat: 'weekly', weekdays: [1, 3, 5] })).toBe('Weekly on Mon, Wed, Fri at 9:00 AM');
    expect(describeSchedule({ ...base, repeat: 'weekly', weekdays: [0, 6] })).toBe('Weekly on Sat, Sun at 9:00 AM');
    expect(describeSchedule({ ...base, repeat: 'weekly' })).toBe('Weekly on Monday at 9:00 AM');
    expect(describeSchedule({ ...base, repeat: 'monthly', hour: 16, minute: 30 })).toBe('Monthly on day 26 at 4:30 PM');
    expect(describeSchedule({ ...base, repeat: 'weekdays' })).toBe('Every weekday (Monday to Friday) at 9:00 AM');
    expect(describeSchedule({ ...base, repeat: 'daily', hour: 0, minute: 5 })).toBe('Daily at 12:05 AM');
    expect(describeSchedule({ ...base, repeat: 'hourly', minute: 15 })).toBe('Hourly at 15 minutes past the hour');
    expect(describeSchedule({ ...base, repeat: 'hourly' })).toBe('Hourly, on the hour');
    expect(describeSchedule({ ...base, repeat: 'custom', cron: '0 */6 * * *' })).toBeNull();
  });
});
