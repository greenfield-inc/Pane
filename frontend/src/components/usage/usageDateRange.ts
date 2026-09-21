import { MAX_USAGE_DAY_BUCKETS } from '../../../../shared/types/usage';

export interface UsageDateRange {
  start: string;
  end: string;
}

export function localDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function usageDateBounds(range: UsageDateRange) {
  const start = new Date(`${range.start}T00:00:00`);
  const end = new Date(`${range.end}T00:00:00`);
  end.setDate(end.getDate() + 1);
  const dayBoundariesMs: number[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    if (dayBoundariesMs.length > MAX_USAGE_DAY_BUCKETS) throw new Error('Choose a shorter calendar range.');
    dayBoundariesMs.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return { fromMs: start.getTime(), toMs: end.getTime() - 1, dayBoundariesMs };
}

export function presetCalendarRange(days: number): UsageDateRange {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { start: localDateString(start), end: localDateString(end) };
}

