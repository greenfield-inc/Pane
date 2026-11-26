import fs from 'fs/promises';
import path from 'path';
import { insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch, type RankedSearchResult } from '../../../shared/searchRanking';
import type { ChatTabFile } from '../../../shared/types/chatTab';
import type { CommandRunner } from '../utils/commandRunner';
import type { PathResolver } from '../utils/pathResolver';

/** A folder to search. `storedPath` is where its commands run (a Linux path in WSL). */
export interface SearchFolder {
  storedPath: string;
  pathResolver: PathResolver;
  commandRunner: CommandRunner;
  /** Not a worktree (a Session's folder): walked without git, so nothing hidden is listed. */
  walk?: boolean;
}

interface Entry { path: string; lower: string; nameStart: number; isDirectory: boolean }
interface Listing { entries: Promise<Entry[]>; loading: boolean; drop?: ReturnType<typeof setTimeout> }

/** A list is kept this long after the last search. */
const KEEP_MS = 30_000;
const WALK_LIMIT = 20_000;
const LIST_BYTES = 256 * 1024 * 1024;
/** Work done between two yields to the main process's other work. */
const SLICE_MS = 8;
/** Candidates ranked beyond the limit, for those that turn out to be gone or outside the folder. */
const SPARE = 40;
/** Names no reference could hold: a double quote, a line break or a control character. */
// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const UNWRITABLE = /["\x00-\x1f\x7f-\x9f\u2028\u2029\ufffd]/;

/**
 * Finds files and folders by name under one folder: what git lists there (gitignored files left out),
 * or a bounded walk outside git. Results are names that exist inside the folder; links out of it are
 * left out. One list per folder is shared, refreshed by an empty query (a menu opening).
 */
export class FileSearch {
  private readonly lists = new Map<string, Listing>();
  /** The newest search of each folder and kind: an older one still ranking gives way, so overlapping searches never queue on the main process. */
  private readonly newest = new Map<string, number>();
  private searches = 0;

  /**
   * `fuzzy: false` leaves out names that only hold the query's letters in order (a search box, unlike a menu).
   * `fresh` lists the folder again for this search, as an empty query does.
   */
  async search(folder: SearchFolder, query: string, limit: number, options: { fuzzy?: boolean; fresh?: boolean } = {}): Promise<ChatTabFile[]> {
    const wanted = normalizeSearchQuery(query).replaceAll('\\', '/');
    const root = folder.pathResolver.toFileSystem(folder.storedPath);
    const kind = `${options.fuzzy === false ? 'exact' : 'fuzzy'}\0${root}`;
    const id = ++this.searches;
    this.newest.set(kind, id);
    const stale = () => this.newest.get(kind) !== id;
    try {
      const entries = await this.entries(root, folder, !wanted || options.fresh === true);
      if (stale()) return [];
      const candidates = wanted ? await ranked(entries, wanted, limit + SPARE, options.fuzzy !== false, stale) : topLevel(entries, limit + SPARE);
      return candidates && !stale() ? await inside(root, candidates, limit) : [];
    } finally {
      if (!stale()) this.newest.delete(kind);
    }
  }

  private entries(root: string, folder: SearchFolder, refresh: boolean): Promise<Entry[]> {
    const key = `${folder.walk ? 'walk' : 'git'}\0${root}`;
    let listing = this.lists.get(key);
    if (!listing || (refresh && !listing.loading)) {
      clearTimeout(listing?.drop);
      listing = { entries: list(root, folder), loading: true };
      this.lists.set(key, listing);
    }
    const current = listing;
    clearTimeout(current.drop);
    const forget = () => {
      clearTimeout(current.drop);
      if (this.lists.get(key) === current) this.lists.delete(key);
    };
    current.drop = setTimeout(forget, KEEP_MS);
    current.drop.unref?.();
    current.entries.then(() => { current.loading = false; }, forget);
    return current.entries;
  }
}

/** A query that points outside the folder: an absolute or home path, or one that climbs with `..`. */
export function leavesFolder(query: string): boolean {
  const text = query.trim().replaceAll('\\', '/');
  return text.startsWith('/') || text.startsWith('~') || /^[a-z]:/i.test(text) || text.split('/').includes('..');
}

async function list(root: string, folder: SearchFolder): Promise<Entry[]> {
  if (folder.walk) return walk(root);
  let output: string;
  try {
    ({ stdout: output } = await folder.commandRunner.execFile('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], folder.storedPath, { silent: true, maxBuffer: LIST_BYTES }));
  } catch (error) {
    // git's own answer for a folder that is no repository; any other failure is reported.
    if (error instanceof Error && /not a git repository/i.test(`${error.message} ${'stderr' in error ? String(error.stderr) : ''}`)) return walk(root);
    throw error;
  }
  const pause = slices();
  const files = new Map<string, Entry>();
  const folders = new Set<string>();
  for (let at = 0; at < output.length;) {
    const end = output.indexOf('\0', at);
    const file = output.slice(at, end < 0 ? output.length : end);
    at = end < 0 ? output.length : end + 1;
    // A trailing slash is an untracked repository of its own, such as a nested worktree.
    if (!listable(file) || file.endsWith('/')) continue;
    files.set(file, entry(file, false));
    for (let slash = file.lastIndexOf('/'); slash > 0; slash = file.lastIndexOf('/', slash - 1)) {
      const parent = file.slice(0, slash);
      if (folders.has(parent)) break;
      folders.add(parent);
    }
    if (pause.due()) await pause.yield();
  }
  return [...[...folders].map(name => entry(name, true)), ...files.values()];
}

/** A folder outside git: no hidden names, no links, and at most WALK_LIMIT entries, nearest first. */
async function walk(root: string): Promise<Entry[]> {
  const found: Entry[] = [];
  const queue = [''];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    const names = await fs.readdir(path.join(root, parent), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (parent === '') throw error;
      return [];
    });
    for (const name of names) {
      if (name.name.startsWith('.') || !(name.isFile() || name.isDirectory())) continue;
      const file = parent ? `${parent}/${name.name}` : name.name;
      if (!listable(file)) continue;
      found.push(entry(file, name.isDirectory()));
      if (found.length >= WALK_LIMIT) return found;
      if (name.isDirectory()) queue.push(file);
    }
  }
  return found;
}

function listable(file: string): boolean {
  return file !== '' && !UNWRITABLE.test(file) && !path.posix.isAbsolute(file) && !file.split('/').some(part => part === '..' || part === '.git');
}

function entry(file: string, isDirectory: boolean): Entry {
  return { path: file, lower: file.toLowerCase(), nameStart: file.lastIndexOf('/') + 1, isDirectory };
}

/** Top-level folders, then top-level files, each A to Z. */
function topLevel(entries: readonly Entry[], limit: number): Entry[] {
  return entries.filter(item => item.nameStart === 0)
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.lower.localeCompare(b.lower))
    .slice(0, limit);
}

/** Best match first: the name, then the whole path, then letters in order. Undefined once `stale`. */
async function ranked(entries: readonly Entry[], query: string, limit: number, fuzzy: boolean, stale: () => boolean): Promise<Entry[] | undefined> {
  const wanted = query.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!wanted) return topLevel(entries, limit);
  const best: RankedSearchResult<Entry>[] = [];
  const pause = slices();
  for (const item of entries) {
    const score = scoreEntry(item, wanted, fuzzy);
    const worst = best.length === limit ? best[limit - 1] : undefined;
    if (score !== null && (!worst || score <= worst.score)) insertRankedSearchResult(best, { item, score, tieBreaker: item.lower }, limit);
    if (pause.due()) {
      await pause.yield();
      if (stale()) return undefined;
    }
  }
  return best.map(result => result.item);
}

function scoreEntry(item: Entry, query: string, fuzzy: boolean): number | null {
  const name = item.nameStart ? item.lower.slice(item.nameStart) : item.lower;
  const exact = scoreQueryMatch({ value: name, query, exactBase: 0, prefixBase: 100, boundaryBase: 300, includesBase: 500, boundaryMarkers: ['-', '_', '.', ' '] })
    ?? scoreQueryMatch({ value: item.lower, query, exactBase: 0, prefixBase: 900, boundaryBase: 1200, includesBase: 5000, boundaryMarkers: ['/'] });
  if (exact !== null || !fuzzy) return exact;
  return scoreQueryMatch({ value: name, query, exactBase: 0, fuzzyBase: 20_000 })
    ?? scoreQueryMatch({ value: item.lower, query, exactBase: 0, fuzzyBase: 40_000 });
}

/** The files of `paths` a reference can name that exist inside `root`. */
export function existingFiles(root: string, paths: readonly string[], limit: number): Promise<ChatTabFile[]> {
  return inside(root, paths.filter(listable).slice(0, limit + SPARE).map(file => entry(file, false)), limit);
}

/** The candidates that exist and, links followed, are inside the folder. */
async function inside(root: string, candidates: readonly Entry[], limit: number): Promise<ChatTabFile[]> {
  const realRoot = await fs.realpath(root);
  const checked = await Promise.all(candidates.map(async (item): Promise<ChatTabFile | undefined> => {
    try {
      const real = await fs.realpath(path.join(root, ...item.path.split('/')));
      if (!contains(realRoot, real)) return undefined;
      const isDirectory = (await fs.stat(real)).isDirectory();
      // A listed file that is a folder of its own is a nested repository; a link to a folder is a folder.
      if (isDirectory && !item.isDirectory && !(await fs.lstat(path.join(root, ...item.path.split('/')))).isSymbolicLink()) return undefined;
      return { path: item.path, isDirectory };
    } catch { return undefined; }
  }));
  return checked.filter(file => file !== undefined).slice(0, limit);
}

/** Both paths already resolved. */
export function contains(folder: string, target: string): boolean {
  const relative = path.relative(folder, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Splits long work so it never holds the main process. */
function slices() {
  let started = performance.now();
  let count = 0;
  return {
    due: () => (count += 1) % 256 === 0 && performance.now() - started > SLICE_MS,
    yield: async () => {
      await new Promise<void>(resolve => { setImmediate(resolve); });
      started = performance.now();
    },
  };
}

/** Shared by chat tabs and the phone's Files tab, so a folder is listed once. */
export const fileSearch = new FileSearch();
