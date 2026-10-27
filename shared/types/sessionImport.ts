/**
 * "Bring your sessions into Pane": the tools Pane reads, the sessions it finds,
 * and the result of bringing them in. Pane's main process scans and places;
 * the renderer only shows the card.
 */

export const SESSION_IMPORT_SOURCES = ['claude', 'codex', 'conductor', 'superset', 'herdr', 'emdash', 'orca', 't3code'] as const;
export type SessionImportSource = typeof SESSION_IMPORT_SOURCES[number];

/** Agents Pane can resume by their own session id. */
export const RESUMABLE_IMPORT_AGENTS = ['claude', 'codex', 'cursor', 'opencode'] as const;
export type ResumableImportAgent = typeof RESUMABLE_IMPORT_AGENTS[number];

export function isResumableImportAgent(agent: string): agent is ResumableImportAgent {
  return RESUMABLE_IMPORT_AGENTS.some(known => known === agent);
}

/** Preference set once the Home card was dismissed or used to finish an import. */
export const SESSION_IMPORT_HOME_RETIRED_PREFERENCE = 'session_import_home_retired';

export type ImportRunning = 'yes' | 'no' | 'unknown';

/** One session as the card shows it. */
export interface ImportSession {
  /** Stable key: `<agent>:<agent session id>`. */
  key: string;
  source: SessionImportSource;
  agent: string;
  sessionId: string;
  title?: string;
  branch?: string;
  folder?: string;
  /** Git checkout root, when the folder is inside one. */
  checkout?: string;
  /** Main repository root the checkout belongs to. */
  repoRoot?: string;
  repoName?: string;
  lastActiveMs: number;
  running: ImportRunning;
  alreadyInPane: boolean;
  /** Why it can't be brought in; the card shows "Can't bring in: <reason>". */
  unavailable?: string;
  preselected: boolean;
}

export interface ImportSourceSummary {
  source: SessionImportSource;
  status: 'ok' | 'unreadable';
  /** "Couldn't read Emdash 1.4" detail: the version or shape Pane didn't recognise. */
  version?: string;
  reason?: string;
  /** Store paths Pane looked at, for the "What Pane reads" disclosure. */
  storePaths: string[];
}

export interface SessionImportScan {
  scannedAt: number;
  sources: ImportSourceSummary[];
  sessions: ImportSession[];
}

/** `still starting`: the agent is up but slow; its tab stays open for the person to check. */
export type ImportSessionOutcome = 'continued' | 'not continued' | 'waiting for trust' | 'still starting' | 'skipped running';

export interface ImportSessionResult {
  key: string;
  source: SessionImportSource;
  agent: string;
  title?: string;
  outcome: ImportSessionOutcome;
  paneId?: string;
  paneName?: string;
  panelId?: string;
  /** What happened and the next step, for anything not continued. */
  reason?: string;
}

export interface SessionImportRunResult {
  results: ImportSessionResult[];
  panesCreated: number;
  /** Sessions that became tabs in Panes that already existed. */
  tabsInExistingPanes: number;
  /** Why the migrate-to-pane record couldn't be updated, when it couldn't. */
  recordError?: string;
}

export interface SessionImportProgress {
  running: boolean;
  /** Done count per source while a run is going. */
  done: Partial<Record<SessionImportSource, number>>;
  total: Partial<Record<SessionImportSource, number>>;
}
