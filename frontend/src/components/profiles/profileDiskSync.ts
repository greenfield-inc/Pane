/**
 * Keeping the Profiles tab in step with the disk (T-63 PR 5). A profile's files can change outside
 * the tab: an agent edits one, `runpane profiles` saves (PR 7), or sync brings another computer's
 * save (PR 6). The tab reads them again every few seconds and reconciles here.
 */

/** What the tab holds for one file. */
export interface FileCopy {
  /** The content as last read from disk (or saved by the tab). */
  saved?: string;
  /** Your unsaved edit. */
  draft?: string;
  /**
   * The file changed on disk while you had unsaved edits: the new content, or null when it was
   * removed. The tab asks whether to reload it or keep yours; Save writes yours (the last save wins).
   */
  onDisk?: string | null;
}

/** The file's copy after reading `disk` (null: the file is gone). */
export function reconcileFromDisk(copy: FileCopy, disk: string | null): FileCopy {
  const { saved, draft } = copy;
  if (disk === null) return draft === undefined ? {} : { saved, draft, onDisk: null };
  if (draft === undefined) return { saved: disk };
  if (draft === disk) return { saved: disk };
  if (disk === saved) return { saved, draft };
  return { saved, draft, onDisk: disk };
}
