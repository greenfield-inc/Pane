import { RunpaneError } from './errors';

/**
 * `runpane todos snooze --until <time>`: a small reader for a fixed set of forms, no natural-language
 * parser. A time without an offset is read in this machine's zone, and the instant is fixed here, before
 * it is sent, so the host never reinterprets it. runpane-py's todo_times.py reads and prints the same,
 * byte for byte (scripts/test-runpane-todo-times.js).
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The longest a snooze can run (a year); TODO_SNOOZE_MAX_MS in shared/types/todos.ts. */
const SNOOZE_MAX_MS = 366 * DAY;
const MORNING_HOUR = 9;

const DURATION_PATTERN = /^(?:in )?([0-9]{1,9}) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/;
const ISO_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:(?:t| )([0-9]{1,2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]+)?)? ?(z|[+-][0-9]{2}(?::?[0-9]{2})?)?)?$/;
const DAY_PATTERN = /^([a-z]+)(?: (?:at )?([0-9]{1,2})(?::([0-9]{2}))? ?(am|pm)?)?$/;
const OFFSET_PATTERN = /^([+-])([0-9]{2}):?([0-9]{2})?$/;

/** Sunday first, as Date#getUTCDay counts. */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_ALIASES = new Map<string, number>([
  ...WEEKDAYS.map((name, index): [string, number] => [name, index]),
  ...WEEKDAYS.map((name, index): [string, number] => [name.slice(0, 3), index]),
  ['tues', 2], ['thur', 4], ['thurs', 4],
]);

const SNOOZE_TIME_FORMS = 'an ISO 8601 time (2026-11-18T09:00, 2026-11-18 09:00-08:00 or 2026-11-18T17:00Z), '
  + 'a date alone (2026-11-18, meaning 9:00 AM that day), a duration (45m, 2h, 3d, or "in 2h"), '
  + 'or tomorrow or a weekday name (monday), meaning the next one, at 9:00 AM or at a time after it ("tomorrow 14:30", "fri 10am")';

/** A calendar date and wall-clock time, with no zone. */
interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The zone this CLI reads times in: the machine's (TZ overrides it, as everywhere in Node). */
export function cliTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** `--until` text as an instant (ms since epoch), or a RunpaneError saying what runpane reads. */
export function readSnoozeTime(text: string, now: number, zone: string): number {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  const at = readForms(normalized, now, zone);
  if (at === null) {
    throw snoozeError('todo_snooze_time', `--until "${text}" is not a time runpane reads. It reads ${SNOOZE_TIME_FORMS}.`,
      'Pass one of those forms, such as --until tomorrow or --until "2026-11-18 09:00".');
  }
  if (at <= now) {
    throw snoozeError('todo_snooze_past', `--until "${text}" is ${formatSnoozeTime(at, zone)}, which has already passed.`,
      'Pass a time in the future, such as --until 2h or --until tomorrow.');
  }
  if (at - now > SNOOZE_MAX_MS) {
    throw snoozeError('todo_snooze_time', `--until "${text}" is more than a year away; a snooze can last at most a year.`,
      'Pick a time within a year.');
  }
  return at;
}

function snoozeError(code: string, message: string, next: string): RunpaneError {
  return new RunpaneError(code, `${message} Nothing was changed.`, next);
}

function readForms(text: string, now: number, zone: string): number | null {
  const duration = DURATION_PATTERN.exec(text);
  if (duration) {
    const unit = duration[2].startsWith('m') ? MINUTE : duration[2].startsWith('h') ? HOUR : DAY;
    return now + Number(duration[1]) * unit;
  }
  const iso = ISO_PATTERN.exec(text);
  if (iso) return readIso(iso, zone);
  const day = DAY_PATTERN.exec(text);
  if (day) return readDay(day, now, zone);
  return null;
}

function readIso(match: RegExpExecArray, zone: string): number | null {
  const [, year, month, day, hour, minute, second, offset] = match;
  const wall: WallTime = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: hour === undefined ? MORNING_HOUR : Number(hour),
    minute: minute === undefined ? 0 : Number(minute),
    second: second === undefined ? 0 : Number(second),
  };
  if (!validWall(wall)) return null;
  if (offset === undefined) return wallToInstant(wall, zone);
  const offsetMs = readOffset(offset);
  if (offsetMs === null) return null;
  return wallUtc(wall) - offsetMs;
}

/** "z", "+08", "+0800" or "-08:00" as ms east of UTC; at most 14 hours. */
function readOffset(text: string): number | null {
  if (text === 'z') return 0;
  const match = OFFSET_PATTERN.exec(text);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  if (minutes > 59 || hours * 60 + minutes > 14 * 60) return null;
  return (match[1] === '-' ? -1 : 1) * (hours * HOUR + minutes * MINUTE);
}

/** tomorrow or a weekday, at 9:00 AM or the time after it. A weekday is the next one, never today. */
function readDay(match: RegExpExecArray, now: number, zone: string): number | null {
  const [, word, hourText, minuteText, meridiem] = match;
  const weekday = WEEKDAY_ALIASES.get(word);
  if (word !== 'tomorrow' && weekday === undefined) return null;
  let hour = MORNING_HOUR;
  let minute = 0;
  if (hourText !== undefined) {
    // "tomorrow 9" is ambiguous; a time is HH:MM, or an hour with am or pm.
    if (minuteText === undefined && meridiem === undefined) return null;
    hour = Number(hourText);
    minute = minuteText === undefined ? 0 : Number(minuteText);
    if (meridiem !== undefined) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
    }
    if (hour > 23 || minute > 59) return null;
  }
  const today = instantToWall(now, zone);
  const todayIndex = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  const ahead = weekday === undefined ? 1 : ((weekday - todayIndex + 7) % 7) || 7;
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
  return wallToInstant({
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute, second: 0,
  }, zone);
}

function validWall(wall: WallTime): boolean {
  if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.hour > 23 || wall.minute > 59 || wall.second > 59) return false;
  const daysInMonth = new Date(Date.UTC(wall.year, wall.month, 0)).getUTCDate();
  return wall.day <= daysInMonth;
}

function wallUtc(wall: WallTime): number {
  const date = new Date(0);
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  date.setUTCHours(wall.hour, wall.minute, wall.second, 0);
  return date.getTime();
}

/**
 * A wall-clock time in `zone` as an instant. A time that happens twice (clocks going back) is the first;
 * one that doesn't exist (clocks going forward) moves forward by the jump, so 2:30 AM reads as 3:30 AM.
 */
function wallToInstant(wall: WallTime, zone: string): number {
  const local = wallUtc(wall);
  const first = local - offsetAt(local, zone);
  const second = local - offsetAt(first, zone);
  const exact = [first, second].filter((candidate) => candidate + offsetAt(candidate, zone) === local);
  return exact.length > 0 ? Math.min(...exact) : Math.max(first, second);
}

/** How far `zone` is ahead of UTC at `at`, in ms. */
function offsetAt(at: number, zone: string): number {
  const wholeSecond = at - (((at % 1000) + 1000) % 1000);
  return wallUtc(instantToWall(wholeSecond, zone)) - wholeSecond;
}

function instantToWall(at: number, zone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second') };
}

/** "Wed 18 Nov 2026, 9:00 AM PST", in `zone`. */
export function formatSnoozeTime(at: number, zone: string): string {
  const wall = instantToWall(at, zone);
  const weekday = WEEKDAY_SHORT[new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()];
  const hour12 = wall.hour % 12 === 0 ? 12 : wall.hour % 12;
  const minute = String(wall.minute).padStart(2, '0');
  const meridiem = wall.hour < 12 ? 'AM' : 'PM';
  return `${weekday} ${wall.day} ${MONTH_SHORT[wall.month - 1]} ${wall.year}, ${hour12}:${minute} ${meridiem} ${zoneAbbreviation(at, zone)}`;
}

/** "PST" where English has a short name for the zone, else "GMT+5:30". */
function zoneAbbreviation(at: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(at);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? zone;
}

/** "in 45m", "in 17h" or "in 3d"; "due now" once it has come. */
export function formatUntil(at: number, now: number): string {
  if (at <= now) return 'due now';
  const minutes = Math.max(1, Math.floor((at - now + MINUTE / 2) / MINUTE));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor((minutes + 30) / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor((hours + 12) / 24)}d`;
}
