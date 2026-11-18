import type { TodoSnooze } from '../../../../shared/types/todos';

/**
 * Snooze times as the renderer shows and picks them (round 9, T-17). A snooze is an instant; every
 * surface shows it in the viewer's zone, and the presets are calendar arithmetic in that zone, so
 * "Tomorrow morning" is 9:00 AM local even across a daylight-saving change. Pure: tests pass a zone.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The viewer's IANA zone, as `todos:act` snooze sends it. */
export function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface WallTime {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

interface ZonedParts extends WallTime {
  second: number;
  /** 0 Sunday … 6 Saturday. */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function zonedParts(at: number, zone: string): ZonedParts {
  const parts = new Map(partsFormatter(zone).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.get(type) ?? 0);
  return {
    year: number('year'), month: number('month'), day: number('day'), hour: number('hour') % 24, minute: number('minute'), second: number('second'),
    weekday: Math.max(0, WEEKDAYS.indexOf(parts.get('weekday') ?? '')),
  };
}

function zoneOffsetMs(at: number, zone: string): number {
  const parts = zonedParts(at, zone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000;
}

/** The instant a wall time in `zone` names; a time a clock change skips resolves to the hour after. */
function zonedInstant(wall: WallTime, zone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = asUtc - zoneOffsetMs(asUtc, zone);
  return asUtc - zoneOffsetMs(first, zone);
}

/** 9:00 AM `days` calendar days after today in `zone`. */
function morningAfter(now: number, zone: string, days: number): number {
  const today = zonedParts(now, zone);
  // Noon UTC on the zone's date, then whole days: never the wrong date across a clock change.
  const day = new Date(Date.UTC(today.year, today.month - 1, today.day, 12) + days * DAY);
  return zonedInstant({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: 9, minute: 0 }, zone);
}

/** An hour from now, on the next whole minute. */
export function inAnHour(now: number): number {
  return Math.ceil((now + HOUR) / MINUTE) * MINUTE;
}

export function tomorrowMorning(now: number, zone: string): number {
  return morningAfter(now, zone, 1);
}

/** 9:00 AM on the coming Monday, never today. */
export function nextMonday(now: number, zone: string): number {
  const weekday = zonedParts(now, zone).weekday;
  return morningAfter(now, zone, ((8 - weekday) % 7) || 7);
}

export type SnoozePresetId = 'hour' | 'tomorrow' | 'monday';

export interface SnoozePreset {
  id: SnoozePresetId;
  label: string;
  at: number;
  /** What it resolves to: "Today 4:12 PM", "Wed 18 Nov, 9:00 AM". */
  when: string;
}

export function snoozePresets(now: number, zone: string): SnoozePreset[] {
  const make = (id: SnoozePresetId, label: string, at: number): SnoozePreset => ({ id, label, at, when: presetWhen(at, now, zone) });
  return [
    make('hour', 'In an hour', inAnHour(now)),
    make('tomorrow', 'Tomorrow morning', tomorrowMorning(now, zone)),
    make('monday', 'Next Monday', nextMonday(now, zone)),
  ];
}

function clockOf(at: number, zone: string): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
}

function shortDate(at: number, zone: string): string {
  const parts = zonedParts(at, zone);
  const month = new Date(at).toLocaleDateString('en-US', { month: 'short', timeZone: zone });
  return `${WEEKDAYS[parts.weekday]} ${parts.day} ${month}, ${clockOf(at, zone)}`;
}

/** The list's and chip's form: "Wed 9:00 AM" within the coming week, "Wed 25 Nov, 9:00 AM" beyond it. */
export function snoozeWhen(at: number, now: number, zone: string): string {
  if (at - now < 6 * DAY && at - now > -DAY) return `${WEEKDAYS[zonedParts(at, zone).weekday]} ${clockOf(at, zone)}`;
  return shortDate(at, zone);
}

/** A preset's time: "Today 4:12 PM", else "Wed 18 Nov, 9:00 AM". */
export function presetWhen(at: number, now: number, zone: string): string {
  const day = zonedParts(at, zone);
  const today = zonedParts(now, zone);
  if (day.year === today.year && day.month === today.month && day.day === today.day) return `Today ${clockOf(at, zone)}`;
  return shortDate(at, zone);
}

/** The zone's short name at that instant: "PST". */
export function zoneAbbrev(at: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(at)).find(part => part.type === 'timeZoneName')?.value ?? zone;
}

/** The banner's form: "Wednesday 18 November, 9:00 AM PST". */
export function snoozeFull(at: number, zone: string): string {
  const date = new Date(at);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: zone });
  const month = date.toLocaleDateString('en-US', { month: 'long', timeZone: zone });
  return `${weekday} ${zonedParts(at, zone).day} ${month}, ${clockOf(at, zone)} ${zoneAbbrev(at, zone)}`;
}

/** "17h 48m", "2d 18h", "45m": how long until it wakes, in its two largest units. */
export function wakesIn(at: number, now: number): string {
  const minutes = Math.max(1, Math.round((at - now) / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** The time column's form: "17h", "3d", "45m" (its largest unit). */
export function wakesInShort(at: number, now: number): string {
  return wakesIn(at, now).split(' ')[0];
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `<input type="datetime-local">`'s value for an instant in `zone`: "2026-11-20T10:00". */
export function toDatetimeLocal(at: number, zone: string): string {
  const parts = zonedParts(at, zone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** The instant a datetime-local value names in `zone`, or null when it isn't one. */
export function fromDatetimeLocal(value: string, zone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return zonedInstant({ year, month, day, hour, minute }, zone);
}

/** A note's first line with words on it. */
export function firstLine(note: string): string {
  return note.split('\n').map(line => line.trim()).find(Boolean) ?? '';
}

/** A snoozed row's reason: "until Wed 9:00 AM · check Sentry", "· machine offline" while its machine is. */
export function snoozeReason(snooze: TodoSnooze, now: number, zone: string, offline = false): string {
  return [`until ${snoozeWhen(snooze.until, now, zone)}`, firstLine(snooze.note), offline ? 'machine offline' : ''].filter(Boolean).join(' · ');
}

/** "set by you", "set by the orchestrator", "set by planner". */
export function setByText(by: string): string {
  if (by === 'you') return 'set by you';
  if (by === 'orchestrator') return 'set by the orchestrator';
  return `set by ${by}`;
}

/** "9:00 AM in Europe/London, where it was set", when that zone isn't the viewer's. */
export function zoneNote(snooze: TodoSnooze, zone: string): string | null {
  if (!snooze.zone || snooze.zone === zone) return null;
  try {
    return `${clockOf(snooze.until, snooze.zone)} in ${snooze.zone}, where it was set`;
  } catch {
    return null;
  }
}
