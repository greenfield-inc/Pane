/** Auto-pause pauses Panes nobody has used for this many hours, by default. */
export const DEFAULT_AUTO_PAUSE_HOURS = 48;
/** The threshold Settings accepts: whole hours from 1 to 720 (30 days). */
export const MIN_AUTO_PAUSE_HOURS = 1;
export const MAX_AUTO_PAUSE_HOURS = 720;

export function isValidAutoPauseHours(hours: number): boolean {
  return Number.isInteger(hours) && hours >= MIN_AUTO_PAUSE_HOURS && hours <= MAX_AUTO_PAUSE_HOURS;
}

/** Hours typed into the auto-pause field, or null when Settings refuses them. */
export function parseAutoPauseHours(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const hours = Number(trimmed);
  return isValidAutoPauseHours(hours) ? hours : null;
}

/**
 * Auto-pause stops a chat tab's agent after this many idle minutes, by default (D-42). Chat tabs get their
 * own, shorter threshold: their agents hold memory while idle, and a restart replays the conversation.
 */
export const DEFAULT_CHAT_RELEASE_MINUTES = 30;
/** The chat threshold Settings accepts: whole minutes from 5 to 1440 (a day). */
export const MIN_CHAT_RELEASE_MINUTES = 5;
export const MAX_CHAT_RELEASE_MINUTES = 1440;

export function isValidChatReleaseMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= MIN_CHAT_RELEASE_MINUTES && minutes <= MAX_CHAT_RELEASE_MINUTES;
}

/** Minutes typed into the chat threshold field, or null when Settings refuses them. */
export function parseChatReleaseMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return isValidChatReleaseMinutes(minutes) ? minutes : null;
}
