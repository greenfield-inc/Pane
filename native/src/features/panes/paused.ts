import type { TerminalPausedMark } from '@shared/types/panels';

/** "Paused 2 days ago", worded like the desktop's paused banner (frontend/src/utils/pause.ts). */
export function pausedLabel(mark: TerminalPausedMark, now: number): string {
  const at = Date.parse(mark.at);
  if (Number.isNaN(at)) return 'Paused';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const ago = (count: number, unit: string) => `Paused ${count} ${unit}${count > 1 ? 's' : ''} ago`;
  if (days > 0) return ago(days, 'day');
  if (hours > 0) return ago(hours, 'hour');
  if (minutes > 0) return ago(minutes, 'minute');
  return 'Paused just now';
}
