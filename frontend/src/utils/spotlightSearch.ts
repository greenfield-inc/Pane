/**
 * Search: turns the renderer's Panes, Sessions, projects and commands plus a
 * query into what the launcher shows (a Top hit, then capped groups, or one
 * filtered list). Ranking is match tier first, then recency within the tier.
 */
import { matchSorterWithRankInfo, rankings, type KeyOption, type RankedItem } from 'match-sorter';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import type { HotkeyDefinition } from '../stores/hotkeyStore';
import type { Project } from '../types/project';
import type { Session } from '../types/session';

export type SearchFilter = 'all' | 'panes' | 'sessions' | 'projects' | 'commands';

export const SEARCH_FILTERS: ReadonlyArray<{ id: SearchFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'panes', label: 'Panes' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'projects', label: 'Projects' },
  { id: 'commands', label: 'Commands' },
];

interface SearchItemBase {
  key: string;
  title: string;
  detail: string;
  /** Milliseconds since epoch of the latest activity, 0 when unknown. */
  recency: number;
  /** Extra text that finds the item but is not its title. */
  terms: string[];
}

export type SearchItem =
  | SearchItemBase & { kind: 'pane'; pane: Session; current: boolean; viewedAt: number; prUrl?: string }
  | SearchItemBase & { kind: 'session'; session: OrchestrationSessionRecord }
  | SearchItemBase & { kind: 'project'; project: Project }
  | SearchItemBase & { kind: 'command'; command: HotkeyDefinition; disabledReason: string | null };

export interface SearchSources {
  panes: Session[];
  sessions: OrchestrationSessionRecord[];
  projects: Project[];
  /** Commands that show in the palette (`getAll({ paletteOnly: true })`). */
  commands: HotkeyDefinition[];
  activePaneId: string | null;
  selectedSessionId?: string;
}

export interface SearchSection {
  id: 'top' | 'recent' | 'suggested' | Exclude<SearchFilter, 'all'>;
  label: string;
  items: SearchItem[];
  /** Matches left out of a capped group; choosing "N more" opens `filter`. */
  more: number;
  /** The filter that lists this group whole. */
  filter?: Exclude<SearchFilter, 'all'>;
}

export interface SearchResults {
  /** A leading `>` selects Commands whatever chip is chosen. */
  filter: SearchFilter;
  sections: SearchSection[];
}

const GROUP_LIMIT = 3;
const RECENT_LIMIT = 5;
const SUGGESTED_COMMAND_IDS = ['new-session', 'new-orchestration-session', 'open-settings'];
// The launcher lists real Panes, so the mod+1-9 commands would only repeat them.
// Their shortcuts still work, and the Help dialog still lists them.
const HIDDEN_COMMAND = /^(open-command-palette|switch-session-\d)$/;

const KIND_OF_FILTER = {
  panes: 'pane',
  sessions: 'session',
  projects: 'project',
  commands: 'command',
} as const satisfies Record<Exclude<SearchFilter, 'all'>, SearchItem['kind']>;

const time = (iso: string | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? '';

export function buildSearchItems(sources: SearchSources): SearchItem[] {
  const panes = sources.panes.filter(pane => !pane.archived && !pane.isHidden);
  const projectById = new Map(sources.projects.map(project => [project.id, project]));
  const paneCountByProject = new Map<number, number>();
  for (const pane of panes) {
    if (pane.projectId != null) paneCountByProject.set(pane.projectId, (paneCountByProject.get(pane.projectId) ?? 0) + 1);
  }

  const items: SearchItem[] = [];
  for (const pane of panes) {
    const project = pane.projectId != null ? projectById.get(pane.projectId) : undefined;
    const { prNumber, prTitle, prUrl } = pane.gitStatus ?? {};
    const pr = prNumber ? `#${prNumber}${prTitle ? ` ${prTitle}` : ''}` : '';
    const viewedAt = time(pane.lastViewedAt);
    items.push({
      kind: 'pane',
      key: `pane:${pane.id}`,
      title: pane.name,
      // The PR number shows as the row's metadata, so the detail carries only its title.
      detail: [project?.name, prTitle].filter(Boolean).join(' · '),
      recency: Math.max(viewedAt, time(pane.lastActivity)),
      terms: [basename(pane.worktreePath), project?.name ?? '', pr],
      pane,
      current: pane.id === sources.activePaneId,
      viewedAt,
      prUrl,
    });
  }
  for (const session of sources.sessions) {
    if (session.archived) continue;
    const current = session.id === sources.selectedSessionId;
    items.push({
      kind: 'session',
      key: `session:${session.id}`,
      title: session.name,
      detail: [current && 'Current', plural(session.associations.length, 'Pane')].filter(Boolean).join(' · '),
      recency: time(session.updatedAt),
      terms: [],
      session,
    });
  }
  for (const project of sources.projects) {
    items.push({
      kind: 'project',
      key: `project:${project.id}`,
      title: project.name,
      detail: plural(paneCountByProject.get(project.id) ?? 0, 'Pane'),
      recency: 0,
      terms: [],
      project,
    });
  }
  for (const command of sources.commands) {
    if (HIDDEN_COMMAND.test(command.id)) continue;
    const disabled = !!command.enabled && !command.enabled();
    items.push({
      kind: 'command',
      key: `command:${command.id}`,
      title: command.label,
      detail: '',
      recency: 0,
      terms: [],
      command,
      disabledReason: disabled ? command.disabledReason?.() ?? 'Command unavailable' : null,
    });
  }
  return items;
}

// Detail text finds an item, but a title match of the same strength wins.
const MATCH_KEYS: ReadonlyArray<KeyOption<SearchItem>> = [
  'title',
  { key: (item: SearchItem) => item.terms.filter(Boolean), maxRanking: rankings.CONTAINS },
];

const isDisabled = (item: SearchItem) => item.kind === 'command' && item.disabledReason !== null;

function compareRanked(a: RankedItem<SearchItem>, b: RankedItem<SearchItem>): number {
  const disabled = Number(isDisabled(a.item)) - Number(isDisabled(b.item));
  if (disabled) return disabled;
  const tier = Math.floor(b.rank) - Math.floor(a.rank);
  if (tier) return tier;
  if (a.keyIndex !== b.keyIndex) return a.keyIndex - b.keyIndex;
  // Fuzzy matches carry how tightly the letters sit together; tighter wins.
  if (a.rank !== b.rank) return b.rank - a.rank;
  return b.item.recency - a.item.recency || a.item.title.localeCompare(b.item.title);
}

function rank(items: SearchItem[], query: string): SearchItem[] {
  return matchSorterWithRankInfo(items, query, {
    keys: MATCH_KEYS,
    sorter: ranked => ranked.sort(compareRanked),
  }).map(ranked => ranked.item);
}

function byRecency(items: SearchItem[]): SearchItem[] {
  return [...items].sort((a, b) =>
    Number(isDisabled(a)) - Number(isDisabled(b)) || b.recency - a.recency);
}

function filterLabel(filter: Exclude<SearchFilter, 'all'>): string {
  return SEARCH_FILTERS.find(entry => entry.id === filter)?.label ?? filter;
}

export function searchItems(items: SearchItem[], options: { query: string; filter: SearchFilter }): SearchResults {
  const commandsOnly = options.query.trimStart().startsWith('>');
  const filter = commandsOnly ? 'commands' : options.filter;
  const query = (commandsOnly ? options.query.trimStart().slice(1) : options.query).trim();

  if (filter !== 'all') {
    const kind = KIND_OF_FILTER[filter];
    const ofKind = items.filter(item => item.kind === kind);
    const listed = query ? rank(ofKind, query) : byRecency(ofKind);
    return { filter, sections: listed.length ? [{ id: filter, label: filterLabel(filter), items: listed, more: 0 }] : [] };
  }

  if (!query) return { filter, sections: emptyQuerySections(items) };

  const ranked = rank(items, query);
  if (ranked.length === 0) return { filter, sections: [] };
  const [topHit, ...rest] = ranked;
  const sections: SearchSection[] = [{ id: 'top', label: 'Top hit', items: [topHit], more: 0 }];
  for (const group of ['panes', 'sessions', 'projects', 'commands'] as const) {
    const matches = rest.filter(item => item.kind === KIND_OF_FILTER[group]);
    if (matches.length === 0) continue;
    sections.push({
      id: group,
      filter: group,
      label: filterLabel(group),
      items: matches.slice(0, GROUP_LIMIT),
      more: Math.max(0, matches.length - GROUP_LIMIT),
    });
  }
  return { filter, sections };
}

function emptyQuerySections(items: SearchItem[]): SearchSection[] {
  // Panes by when they were last viewed, mixed with Sessions by their last
  // update. The previous Pane always leads, so ⌘⇧P then ↵ returns to it.
  const recent = items
    .flatMap((item): Array<{ item: SearchItem; at: number }> => {
      if (item.kind === 'pane') return item.viewedAt && !item.current ? [{ item, at: item.viewedAt }] : [];
      if (item.kind === 'session') return [{ item, at: item.recency }];
      return [];
    })
    .sort((a, b) => b.at - a.at)
    .map(entry => entry.item);
  const previousPane = recent.findIndex(item => item.kind === 'pane');
  if (previousPane > 0) recent.unshift(...recent.splice(previousPane, 1));
  recent.splice(RECENT_LIMIT);
  const suggested = SUGGESTED_COMMAND_IDS.flatMap(id =>
    items.filter(item => item.kind === 'command' && item.command.id === id));
  return [
    { id: 'recent' as const, label: 'Recent', items: recent, more: 0 },
    { id: 'suggested' as const, label: 'Suggested', items: suggested, more: 0 },
  ].filter(section => section.items.length > 0);
}

/**
 * The parts of `text` the query matched, for marking: the first exact run, or
 * else each query letter in order (initials and fuzzy matches).
 */
export function matchedRanges(text: string, query: string): Array<[number, number]> {
  const needle = query.trim().replace(/^>\s*/, '').toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at >= 0) return [[at, at + needle.length]];
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (const char of needle) {
    if (char === ' ') continue;
    const index = haystack.indexOf(char, from);
    if (index < 0) return [];
    const last = ranges[ranges.length - 1];
    if (last && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
    from = index + 1;
  }
  return ranges;
}
