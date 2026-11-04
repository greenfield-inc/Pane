/** Auto-pause pauses Panes nobody has used for this many hours, by default. */
export const DEFAULT_AUTO_PAUSE_HOURS = 48;
/** The threshold Settings accepts: whole hours from 1 to 720 (30 days). */
export const MIN_AUTO_PAUSE_HOURS = 1;
export const MAX_AUTO_PAUSE_HOURS = 720;

export function isValidAutoPauseHours(hours: number): boolean {
  return Number.isInteger(hours) && hours >= MIN_AUTO_PAUSE_HOURS && hours <= MAX_AUTO_PAUSE_HOURS;
}
