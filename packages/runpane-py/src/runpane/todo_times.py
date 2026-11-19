"""`runpane todos snooze --until <time>`: the npm CLI's todoTimes.ts, read and printed the same, byte for byte.

A small reader for a fixed set of forms, no natural-language parser. A time without an offset is read in this
machine's zone, and the instant is fixed here, before it is sent, so the host never reinterprets it.
"""
from __future__ import annotations

import os
import re
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import List, NamedTuple, Optional

from .notify import RunpaneError

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python 3.8: times are read in the system's own zone.
    ZoneInfo = None  # type: ignore[assignment,misc]

MINUTE = 60 * 1000
HOUR = 60 * MINUTE
DAY = 24 * HOUR
# The longest a snooze can run (a year); TODO_SNOOZE_MAX_MS in shared/types/todos.ts.
SNOOZE_MAX_MS = 366 * DAY
MORNING_HOUR = 9

DURATION_PATTERN = re.compile(r"(?:in )?([0-9]{1,9}) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)")
ISO_PATTERN = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?:(?:t| )([0-9]{1,2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]+)?)? ?(z|[+-][0-9]{2}(?::?[0-9]{2})?)?)?")
DAY_PATTERN = re.compile(r"([a-z]+)(?: (?:at )?([0-9]{1,2})(?::([0-9]{2}))? ?(am|pm)?)?")
OFFSET_PATTERN = re.compile(r"([+-])([0-9]{2}):?([0-9]{2})?")

# Sunday first, as the npm CLI counts.
WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
WEEKDAY_ALIASES = {
    **{name: index for index, name in enumerate(WEEKDAYS)},
    **{name[:3]: index for index, name in enumerate(WEEKDAYS)},
    "tues": 2,
    "thur": 4,
    "thurs": 4,
}
# The short names English (and so the npm CLI's Intl) gives North American zones; others read GMT+5:30.
NORTH_AMERICAN_ABBREVIATIONS = {"PST", "PDT", "MST", "MDT", "CST", "CDT", "EST", "EDT", "AKST", "AKDT", "HST", "HDT", "AST", "ADT"}
NORTH_AMERICAN_PREFIXES = ("America/", "US/", "Canada/", "Pacific/Honolulu", "Atlantic/Bermuda")
NOT_NORTH_AMERICAN = {"America/Havana", "Cuba"}

SNOOZE_TIME_FORMS = (
    "an ISO 8601 time (2026-11-18T09:00, 2026-11-18 09:00-08:00 or 2026-11-18T17:00Z), "
    'a date alone (2026-11-18, meaning 9:00 AM that day), a duration (45m, 2h, 3d, or "in 2h"), '
    'or tomorrow or a weekday name (monday), meaning the next one, at 9:00 AM or at a time after it ("tomorrow 14:30", "fri 10am")'
)


class WallTime(NamedTuple):
    """A calendar date and wall-clock time, with no zone."""

    year: int
    month: int
    day: int
    hour: int
    minute: int
    second: int


def _zone_info(zone: str) -> Optional[tzinfo]:
    """The zone's rules; None means read it in the system's own zone (Python 3.8, or no tz database)."""
    if zone == "UTC":
        return timezone.utc
    if ZoneInfo is None or zone == LOCAL_TIME:
        return None
    try:
        return ZoneInfo(zone)
    except Exception:  # noqa: BLE001 - an unknown key, or no tz database (Windows without tzdata)
        return None


def _known_zone(name: str) -> bool:
    if not name or name.startswith("/") or ".." in name:
        return False
    if ZoneInfo is None:
        return re.fullmatch(r"[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+)*", name) is not None
    return _zone_info(name) is not None


# Not a zone name: read times in the system's own local time (Windows has no /etc/localtime, and may
# have no tz database). The host shows such a snooze in its own zone.
LOCAL_TIME = "localtime"


def cli_time_zone() -> str:
    """The zone this CLI reads times in: $TZ, else the machine's, else the system's local time."""
    candidates: List[str] = []
    tz = (os.environ.get("TZ") or "").strip()
    candidates.append(tz[1:] if tz.startswith(":") else tz)
    try:
        link = os.readlink("/etc/localtime")
        if "zoneinfo/" in link:
            candidates.append(link.split("zoneinfo/", 1)[1])
    except OSError:
        pass
    try:
        with open("/etc/timezone", encoding="utf-8") as handle:
            candidates.append(handle.read().strip())
    except OSError:
        pass
    for candidate in candidates:
        if _known_zone(candidate):
            return candidate
    return LOCAL_TIME


def read_snooze_time(text: str, now: int, zone: str) -> int:
    """`--until` text as an instant (ms since epoch), or a RunpaneError saying what runpane reads."""
    normalized = re.sub(r"\s+", " ", text.strip()).lower()
    at = _read_forms(normalized, now, zone)
    if at is None:
        raise _snooze_error(
            "todo_snooze_time",
            f'--until "{text}" is not a time runpane reads. It reads {SNOOZE_TIME_FORMS}.',
            'Pass one of those forms, such as --until tomorrow or --until "2026-11-18 09:00".',
        )
    if at <= now:
        raise _snooze_error(
            "todo_snooze_past",
            f'--until "{text}" is {format_snooze_time(at, zone)}, which has already passed.',
            "Pass a time in the future, such as --until 2h or --until tomorrow.",
        )
    if at - now > SNOOZE_MAX_MS:
        raise _snooze_error(
            "todo_snooze_time",
            f'--until "{text}" is more than a year away; a snooze can last at most a year.',
            "Pick a time within a year.",
        )
    return at


def _snooze_error(code: str, message: str, next_step: str) -> RunpaneError:
    return RunpaneError(code, f"{message} Nothing was changed.", next_step)


def _read_forms(text: str, now: int, zone: str) -> Optional[int]:
    duration = DURATION_PATTERN.fullmatch(text)
    if duration:
        unit_text = duration.group(2)
        unit = MINUTE if unit_text.startswith("m") else HOUR if unit_text.startswith("h") else DAY
        return now + int(duration.group(1)) * unit
    iso = ISO_PATTERN.fullmatch(text)
    if iso:
        return _read_iso(iso, zone)
    day = DAY_PATTERN.fullmatch(text)
    if day:
        return _read_day(day, now, zone)
    return None


def _read_iso(match: "re.Match[str]", zone: str) -> Optional[int]:
    year, month, day, hour, minute, second, offset = match.groups()
    wall = WallTime(
        int(year),
        int(month),
        int(day),
        MORNING_HOUR if hour is None else int(hour),
        0 if minute is None else int(minute),
        0 if second is None else int(second),
    )
    if not _valid_wall(wall):
        return None
    if offset is None:
        return _wall_to_instant(wall, zone)
    offset_ms = _read_offset(offset)
    if offset_ms is None:
        return None
    return _wall_utc(wall) - offset_ms


def _read_offset(text: str) -> Optional[int]:
    """"z", "+08", "+0800" or "-08:00" as ms east of UTC; at most 14 hours."""
    if text == "z":
        return 0
    match = OFFSET_PATTERN.fullmatch(text)
    if not match:
        return None
    hours = int(match.group(2))
    minutes = 0 if match.group(3) is None else int(match.group(3))
    if minutes > 59 or hours * 60 + minutes > 14 * 60:
        return None
    return (-1 if match.group(1) == "-" else 1) * (hours * HOUR + minutes * MINUTE)


def _read_day(match: "re.Match[str]", now: int, zone: str) -> Optional[int]:
    """tomorrow or a weekday, at 9:00 AM or the time after it. A weekday is the next one, never today."""
    word, hour_text, minute_text, meridiem = match.groups()
    weekday = WEEKDAY_ALIASES.get(word)
    if word != "tomorrow" and weekday is None:
        return None
    hour = MORNING_HOUR
    minute = 0
    if hour_text is not None:
        # "tomorrow 9" is ambiguous; a time is HH:MM, or an hour with am or pm.
        if minute_text is None and meridiem is None:
            return None
        hour = int(hour_text)
        minute = 0 if minute_text is None else int(minute_text)
        if meridiem is not None:
            if hour < 1 or hour > 12:
                return None
            hour = (hour % 12) + (12 if meridiem == "pm" else 0)
        if hour > 23 or minute > 59:
            return None
    today = _instant_to_wall(now, zone)
    today_date = date(today.year, today.month, today.day)
    today_index = (today_date.weekday() + 1) % 7
    ahead = 1 if weekday is None else ((weekday - today_index + 7) % 7) or 7
    target = today_date + timedelta(days=ahead)
    return _wall_to_instant(WallTime(target.year, target.month, target.day, hour, minute, 0), zone)


def _valid_wall(wall: WallTime) -> bool:
    try:
        date(wall.year, wall.month, wall.day)
    except ValueError:
        return False
    return wall.hour <= 23 and wall.minute <= 59 and wall.second <= 59


def _wall_utc(wall: WallTime) -> int:
    moment = datetime(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second, tzinfo=timezone.utc)
    return int(moment.timestamp()) * 1000


def _wall_to_instant(wall: WallTime, zone: str) -> int:
    """A wall-clock time in `zone` as an instant. Twice-happening times are the first; missing ones move forward."""
    local = _wall_utc(wall)
    first = local - _offset_at(local, zone)
    second = local - _offset_at(first, zone)
    exact = [candidate for candidate in (first, second) if candidate + _offset_at(candidate, zone) == local]
    return min(exact) if exact else max(first, second)


def _aware(at: int, zone: str) -> datetime:
    whole_second = at - (at % 1000)
    info = _zone_info(zone)
    if info is None:
        return datetime.fromtimestamp(whole_second // 1000).astimezone()
    return datetime.fromtimestamp(whole_second // 1000, tz=info)


def _offset_at(at: int, zone: str) -> int:
    """How far `zone` is ahead of UTC at `at`, in ms."""
    offset = _aware(at, zone).utcoffset()
    return 0 if offset is None else int(offset.total_seconds()) * 1000


def _instant_to_wall(at: int, zone: str) -> WallTime:
    moment = _aware(at, zone)
    return WallTime(moment.year, moment.month, moment.day, moment.hour, moment.minute, moment.second)


def format_snooze_time(at: int, zone: str) -> str:
    """"Wed 18 Nov 2026, 9:00 AM PST", in `zone`."""
    wall = _instant_to_wall(at, zone)
    weekday = WEEKDAY_SHORT[(date(wall.year, wall.month, wall.day).weekday() + 1) % 7]
    hour12 = 12 if wall.hour % 12 == 0 else wall.hour % 12
    meridiem = "AM" if wall.hour < 12 else "PM"
    return f"{weekday} {wall.day} {MONTH_SHORT[wall.month - 1]} {wall.year}, {hour12}:{wall.minute:02d} {meridiem} {_zone_abbreviation(at, zone)}"


def _zone_abbreviation(at: int, zone: str) -> str:
    """"PST" where English has a short name for the zone, else "GMT+5:30", as the npm CLI's Intl prints it."""
    moment = _aware(at, zone)
    name = moment.tzname() or ""
    offset_ms = _offset_at(at, zone)
    if zone in ("UTC", "Etc/UTC", "Etc/Universal", "Universal", "Zulu", "Etc/Zulu"):
        return "UTC"
    if name in NORTH_AMERICAN_ABBREVIATIONS and zone.startswith(NORTH_AMERICAN_PREFIXES) and zone not in NOT_NORTH_AMERICAN:
        return name
    if offset_ms == 0:
        return "GMT"
    sign = "-" if offset_ms < 0 else "+"
    minutes = abs(offset_ms) // MINUTE
    hours, rest = divmod(minutes, 60)
    return f"GMT{sign}{hours}:{rest:02d}" if rest else f"GMT{sign}{hours}"


def format_until(at: int, now: int) -> str:
    """"in 45m", "in 17h" or "in 3d"; "due now" once it has come."""
    if at <= now:
        return "due now"
    minutes = max(1, (at - now + MINUTE // 2) // MINUTE)
    if minutes < 60:
        return f"in {minutes}m"
    hours = (minutes + 30) // 60
    if hours < 48:
        return f"in {hours}h"
    return f"in {(hours + 12) // 24}d"
