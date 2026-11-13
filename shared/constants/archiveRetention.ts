/**
 * Days Pane keeps an archived Session's folder, and the scratch folder of an
 * archived Pane on the main checkout or an adopted worktree, before deleting
 * them. The `archiveRetentionDays` setting overrides it.
 */
export const ARCHIVE_RETENTION_DAYS = 14;
export const MIN_ARCHIVE_RETENTION_DAYS = 1;
export const MAX_ARCHIVE_RETENTION_DAYS = 365;

export function isValidArchiveRetentionDays(days: number): boolean {
  return Number.isInteger(days) && days >= MIN_ARCHIVE_RETENTION_DAYS && days <= MAX_ARCHIVE_RETENTION_DAYS;
}

/** Whole days typed into the setting, or null when out of range. */
export function parseArchiveRetentionDays(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const days = Number(trimmed);
  return isValidArchiveRetentionDays(days) ? days : null;
}
