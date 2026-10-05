/** Aggregate line/file counts for a git diff payload. */
export interface GitDiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

/** Git patch payload shared by the main process and renderer. */
export interface GitDiffResult {
  diff: string;
  stats: GitDiffStats;
  changedFiles: string[];
  beforeHash?: string;
  afterHash?: string;
}
