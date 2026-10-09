/** Bounded metadata only; archive contents and database rows are never loaded. */
export interface FilePreviewListing {
  columns: string[];
  rows: string[][];
  notice: string;
}
