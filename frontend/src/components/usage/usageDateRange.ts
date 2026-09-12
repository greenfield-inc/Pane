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
  return { fromMs: start.getTime(), toMs: end.getTime() - 1 };
}

