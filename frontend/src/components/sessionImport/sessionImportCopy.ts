import type {
  ImportSession,
  SessionImportProgress,
  SessionImportRunResult,
  SessionImportScan,
  SessionImportSource,
} from '../../../../shared/types/sessionImport';
import { SESSION_IMPORT_SOURCES } from '../../../../shared/types/sessionImport';
import { capture, type AnalyticsProperties } from '../../services/posthog';

export const SOURCE_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  conductor: 'Conductor workspaces',
  superset: 'Superset workspaces',
  herdr: 'Herdr workspaces',
  emdash: 'Emdash tasks',
  orca: 'Orca worktrees',
  t3code: 'T3 Code threads',
} as const satisfies Record<SessionImportSource, string>;

export const TOOL_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  conductor: 'Conductor',
  superset: 'Superset',
  herdr: 'Herdr',
  emdash: 'Emdash',
  orca: 'Orca',
  t3code: 'T3 Code',
} as const satisfies Record<SessionImportSource, string>;

/** Agent tools count sessions and repos; workspace tools count worktrees. */
const AGENT_TOOLS: ReadonlySet<SessionImportSource> = new Set(['claude', 'codex']);

export function isSelectable(session: ImportSession): boolean {
  return !session.alreadyInPane && session.running === 'no' && !session.unavailable;
}

export function isRunningElsewhere(session: ImportSession): boolean {
  return !session.alreadyInPane && session.running !== 'no';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The sources the card lists, in Pane's order: any with sessions, plus any it couldn't read. */
export function listedSources(scan: SessionImportScan): SessionImportSource[] {
  return SESSION_IMPORT_SOURCES.filter(source =>
    scan.sessions.some(session => session.source === source)
    || scan.sources.some(summary => summary.source === source && summary.status === 'unreadable'));
}

export function rowMeta(
  source: SessionImportSource,
  scan: SessionImportScan,
  selected: ReadonlySet<string>,
  progress?: SessionImportProgress,
): string {
  const summary = scan.sources.find(candidate => candidate.source === source);
  if (summary?.status === 'unreadable') {
    // Readers report a store shape or an app version; only a version reads well in the row.
    const version = summary.version && /^v?\d+(\.\d+)+$/u.test(summary.version) ? ` ${summary.version}` : '';
    return `Couldn't read ${TOOL_NAMES[source]}${version}`;
  }
  if (progress?.running && progress.total[source]) return `${progress.done[source] ?? 0} of ${progress.total[source]}`;
  const sessions = scan.sessions.filter(session => session.source === source);
  const chosen = sessions.filter(session => selected.has(session.key));
  if (chosen.length > 0) {
    if (!AGENT_TOOLS.has(source)) return plural(new Set(chosen.map(session => session.checkout)).size, 'worktree');
    return `${plural(chosen.length, 'session')} · ${plural(new Set(chosen.map(session => session.repoRoot)).size, 'repo')}`;
  }
  const selectable = sessions.filter(isSelectable).length;
  if (selectable > 0) return `${selectable} older ${selectable === 1 ? 'session' : 'sessions'}`;
  if (sessions.some(isRunningElsewhere)) return `${sessions.filter(isRunningElsewhere).length} running`;
  return `${sessions.filter(session => session.alreadyInPane).length} already in Pane`;
}

/** "Running in Conductor", "Already in Pane", "Can't bring in: …", or nothing. */
export function sessionStatus(session: ImportSession): string | undefined {
  if (session.alreadyInPane) return 'Already in Pane';
  if (session.running !== 'no') return `Running in ${TOOL_NAMES[session.source]}`;
  if (session.unavailable) return `Can't bring in: ${session.unavailable}`;
  return undefined;
}

export function resultHeadline(result: SessionImportRunResult): string {
  const brought = result.results.filter(entry => entry.outcome !== 'not continued' && entry.outcome !== 'skipped running').length;
  const existing = result.tabsInExistingPanes > 0 ? ` and ${plural(result.tabsInExistingPanes, 'tab')} in existing Panes` : '';
  return `Brought in ${plural(brought, 'session')} as ${plural(result.panesCreated, 'Pane')}${existing}.`;
}

export const EMPTY_STATE = 'No sessions found from Claude Code, Codex, Conductor, Superset, Herdr, Emdash, Orca or T3 Code on this computer.';

export type SessionImportSurface = 'home' | 'settings';

/** Sessions found per source, for analytics. */
function foundCounts(scan: SessionImportScan) {
  return Object.fromEntries(SESSION_IMPORT_SOURCES
    .map(source => [source, scan.sessions.filter(session => session.source === source).length] as const)
    .filter(([, count]) => count > 0));
}

/** The one analytics event for this feature: counts only, never a path, title or id. */
export function captureSessionImport(
  step: 'shown' | 'dismissed' | 'started' | 'finished',
  surface: SessionImportSurface,
  scan: SessionImportScan,
  extra: { selected?: number; result?: SessionImportRunResult } = {},
): void {
  const properties: AnalyticsProperties = { step, surface, found: foundCounts(scan) };
  if (extra.selected !== undefined) properties.selected = extra.selected;
  const { result } = extra;
  if (result) {
    const outcome = (name: string) => result.results.filter(entry => entry.outcome === name).length;
    properties.panes_created = result.panesCreated;
    properties.tabs_added = outcome('continued') + outcome('waiting for trust') + outcome('still starting');
    properties.continued = outcome('continued');
    properties.not_continued = outcome('not continued');
    properties.waiting_trust = outcome('waiting for trust');
    properties.running_skipped = scan.sessions.filter(isRunningElsewhere).length;
  }
  capture('session_import', properties);
}
