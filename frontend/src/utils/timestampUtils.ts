/**
 * Utility functions for consistent timestamp handling in the frontend
 */

/**
 * Formats a timestamp for display to users
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized time string
 */
/**
 * Formats a timestamp with full date and time for display
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized date and time string
 */
/**
 * Short "time ago" for dense surfaces: `just now`, `5m ago`, `3h ago`, `2d ago`.
 *
 * Returns an empty string for an absent, unparseable or future timestamp, so a
 * caller can render it unconditionally.
 */
export function formatTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Formats the distance between a timestamp and now
 * @param date - The date to compare
 * @returns Human-readable time distance
 */
export function formatDistanceToNow(date: Date | string): string {
  const dateObj = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - dateObj.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  } else if (diffHours > 0) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  } else if (diffMinutes > 0) {
    return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
  } else {
    return 'just now';
  }
}

/**
 * Checks if a timestamp is valid
 * @param timestamp - The timestamp to validate
 * @returns boolean indicating if the timestamp is valid
 */
export function isValidTimestamp(timestamp: string | Date | null | undefined): boolean {
  if (!timestamp) return false;
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return !isNaN(date.getTime());
}

/**
 * Gets the time difference between two timestamps
 * @param start - Start timestamp
 * @param end - End timestamp (defaults to current time)
 * @returns Duration in milliseconds
 */
/**
 * Formats a duration in milliseconds to a human-readable string
 * @param ms - Duration in milliseconds
 * @returns Human-readable duration string
 */
/**
 * Formats a timestamp for sorting/comparison
 * @param timestamp - The timestamp to format
 * @returns ISO string for consistent sorting
 */
