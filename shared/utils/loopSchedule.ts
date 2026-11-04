/**
 * A loop's cron as the form's picker shows it, and the one sentence every
 * surface (the form, the Loops page, `runpane loops`) uses for a schedule.
 */

/** How often a loop repeats, as the form's picker shows it. */
export type LoopRepeat = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

/**
 * The picker's state. Every field is kept while the repeat changes, so
 * switching from Weekly to Daily and back keeps the chosen days.
 */
export interface LoopSchedule {
  repeat: LoopRepeat;
  minute: number;
  hour: number;
  /** Cron day-of-week numbers, 0 for Sunday. Never empty. */
  weekdays: number[];
  dayOfMonth: number;
  /** The text a Custom cron saves. */
  cron: string;
}

const DEFAULTS = { minute: 0, hour: 9, weekdays: [1], dayOfMonth: 1 };

function numberIn(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/** Cron day-of-week list such as `1,3,5`; 7 is Sunday too. */
function weekdayList(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const day = numberIn(part, 0, 7);
    if (day === null) return null;
    days.add(day % 7);
  }
  return [...days].sort((a, b) => a - b);
}

/** Opens a saved cron in the picker mode it matches, or in Custom cron. */
export function scheduleFromCron(cron: string): LoopSchedule {
  const custom: LoopSchedule = { ...DEFAULTS, repeat: 'custom', cron };
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return custom;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  const minute = numberIn(minuteField, 0, 59);
  if (minute === null || monthField !== '*') return custom;
  if (hourField === '*') {
    return dayField === '*' && weekdayField === '*' ? { ...custom, repeat: 'hourly', minute } : custom;
  }
  const hour = numberIn(hourField, 0, 23);
  if (hour === null) return custom;
  const at = { ...custom, minute, hour };
  if (dayField !== '*') {
    const dayOfMonth = numberIn(dayField, 1, 31);
    return dayOfMonth !== null && weekdayField === '*' ? { ...at, repeat: 'monthly', dayOfMonth } : custom;
  }
  if (weekdayField === '*') return { ...at, repeat: 'daily' };
  if (weekdayField === '1-5') return { ...at, repeat: 'weekdays' };
  const weekdays = weekdayList(weekdayField);
  return weekdays ? { ...at, repeat: 'weekly', weekdays } : custom;
}

/** The cron the form saves for this schedule. */
export function cronFromSchedule(schedule: LoopSchedule): string {
  const { minute, hour } = schedule;
  switch (schedule.repeat) {
    case 'hourly': return `${minute} * * * *`;
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': return `${minute} ${hour} * * ${schedule.weekdays.join(',')}`;
    case 'monthly': return `${minute} ${hour} ${schedule.dayOfMonth} * *`;
    case 'custom': return schedule.cron.trim();
  }
}

/** Monday first, the way the picker lists them; `day` is the cron number. */
export const WEEKDAYS = [
  { day: 1, short: 'Mon', name: 'Monday' },
  { day: 2, short: 'Tue', name: 'Tuesday' },
  { day: 3, short: 'Wed', name: 'Wednesday' },
  { day: 4, short: 'Thu', name: 'Thursday' },
  { day: 5, short: 'Fri', name: 'Friday' },
  { day: 6, short: 'Sat', name: 'Saturday' },
  { day: 0, short: 'Sun', name: 'Sunday' },
] as const;

/** `Monday`, or `Mon, Wed, Fri` for several days, in picker order. */
function weekdayNames(weekdays: number[]): string {
  const chosen = WEEKDAYS.filter(({ day }) => weekdays.includes(day));
  return chosen.length === 1 ? chosen[0].name : chosen.map(({ short }) => short).join(', ');
}

/** A Repeat option's name, worded like Google Calendar's Repeat field. */
export function repeatLabel(repeat: LoopRepeat, schedule: LoopSchedule): string {
  switch (repeat) {
    case 'hourly': return 'Hourly';
    case 'daily': return 'Daily';
    case 'weekdays': return 'Every weekday (Monday to Friday)';
    case 'weekly': return `Weekly on ${weekdayNames(schedule.weekdays)}`;
    case 'monthly': return `Monthly on day ${schedule.dayOfMonth}`;
    case 'custom': return 'Custom cron';
  }
}

/** `9:00 AM`. */
function clockTime(hour: number, minute: number): string {
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** The schedule in words, such as `Weekly on Mon, Wed, Fri at 9:00 AM`. Custom cron has none. */
export function describeSchedule(schedule: LoopSchedule): string | null {
  if (schedule.repeat === 'custom') return null;
  if (schedule.repeat === 'hourly') {
    return schedule.minute === 0 ? 'Hourly, on the hour' : `Hourly at ${schedule.minute} minutes past the hour`;
  }
  return `${repeatLabel(schedule.repeat, schedule)} at ${clockTime(schedule.hour, schedule.minute)}`;
}
