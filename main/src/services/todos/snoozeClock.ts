/**
 * Calendar arithmetic for snoozing (round 9, T-17). A snooze is stored as an instant; these show it
 * in a zone (the host's when `zone` is absent) and work out wall times there, so "9:00 AM" stays
 * 9:00 AM across a daylight-saving change. No timers: callers compare instants with the wall clock.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface WallTime {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string | undefined): Intl.DateTimeFormat {
  const key = zone ?? '';
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

interface ZonedParts extends WallTime {
  second: number;
  /** Sun, Mon … */
  weekday: string;
}

function zonedParts(at: number, zone: string | undefined): ZonedParts {
  const parts = new Map(partsFormatter(zone).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.get(type) ?? 0);
  return { year: number('year'), month: number('month'), day: number('day'), hour: number('hour') % 24, minute: number('minute'), second: number('second'), weekday: parts.get('weekday') ?? '' };
}

/** The zone's offset from UTC at `at`, in ms (Los Angeles in November: -8 h). */
function zoneOffsetMs(at: number, zone: string | undefined): number {
  const parts = zonedParts(at, zone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a wall time in `zone` names. A time skipped by a clock change resolves to the hour after. */
export function zonedInstant(wall: WallTime, zone: string | undefined): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let at = asUtc - zoneOffsetMs(asUtc, zone);
  // Once more with the offset at the answer: right on either side of a change.
  at = asUtc - zoneOffsetMs(at, zone);
  return at;
}

/** ISO 8601 with the zone's offset: 2026-11-18T09:00:00-08:00. */
export function isoInZone(at: number, zone: string): string {
  const parts = zonedParts(at, zone);
  const offset = Math.round(zoneOffsetMs(at, zone) / MINUTE);
  const pad = (value: number) => String(value).padStart(2, '0');
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const WEEKEND = new Set(['Sat', 'Sun']);

/** 9:00 AM tomorrow in `zone`, or the Monday after when tomorrow is a Saturday or Sunday (the reminder card's Snooze to the next morning). */
export function nextMorning(now: number, zone: string | undefined): number {
  const today = zonedParts(now, zone);
  // Noon today, then whole days on: never lands on the wrong date across a clock change.
  const noon = Date.UTC(today.year, today.month - 1, today.day, 12);
  for (let ahead = 1; ahead <= 3; ahead += 1) {
    const day = new Date(noon + ahead * DAY);
    const weekday = day.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    if (WEEKEND.has(weekday)) continue;
    return zonedInstant({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: 9, minute: 0 }, zone);
  }
  return zonedInstant({ year: today.year, month: today.month, day: today.day + 1, hour: 9, minute: 0 }, zone);
}

/** "45m", "3h", "1h 20m", "2d 3h": how long, in its two largest units. */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

function clockOf(at: number, zone: string | undefined): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
}

/** "9:00 AM" in `zone`. */
export function clockText(at: number, zone?: string): string {
  return clockOf(at, zone);
}

/**
 * When a snooze ends, as the list reads it: "Wed 9:00 AM" within the coming week, "Wed 25 Nov,
 * 9:00 AM" beyond it (or always, with `full`).
 */
export function snoozeWhen(at: number, now: number, zone?: string, options: { full?: boolean } = {}): string {
  const parts = zonedParts(at, zone);
  const month = new Date(at).toLocaleDateString('en-US', { month: 'short', timeZone: zone });
  const clock = clockOf(at, zone);
  if (!options.full && at - now < 6 * DAY && at - now > -DAY) return `${parts.weekday} ${clock}`;
  return `${parts.weekday} ${parts.day} ${month}, ${clock}`;
}

/** A real IANA zone ("Europe/London"), as Intl knows them. */
export function isKnownZone(zone: string): boolean {
  if (!zone.trim()) return false;
  try {
    return Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}
