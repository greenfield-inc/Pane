import type { SessionMovePathEntry } from '../../../../shared/types/sessionMove';

/**
 * Turns any source path into the target's: each worktree, each repository, the Pane folder, and
 * the source home as the catch-all. Built on the target from the manifest and its own answers.
 * The longest prefix wins and only whole path segments match, so /Users/tyler never rewrites
 * /Users/tylerbrown.
 */
export interface PathMap {
  /** Longest `from` first. */
  entries: SessionMovePathEntry[];
}

function trimSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

export function buildPathMap({ sourceHome, targetHome, entries }: { sourceHome: string; targetHome: string; entries: readonly SessionMovePathEntry[] }): PathMap {
  const byFrom = new Map<string, string>();
  for (const entry of [...entries, { from: sourceHome, to: targetHome }]) {
    const from = trimSlash(entry.from);
    if (!byFrom.has(from)) byFrom.set(from, trimSlash(entry.to));
  }
  return {
    entries: [...byFrom].map(([from, to]) => ({ from, to })).sort((a, b) => b.from.length - a.from.length),
  };
}

/** The target's path for `value`, or null when no entry covers it. */
export function mapPath(map: PathMap, value: string): string | null {
  for (const { from, to } of map.entries) {
    if (value === from) return to;
    if (value.startsWith(`${from}/`)) return to + value.slice(from.length);
  }
  return null;
}

/** The folder name Claude Code files a working directory's conversations under. */
export function claudeProjectFolder(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites every source path in a text file (Session folder files, launch commands), including
 * file:// links and Claude's encoded project folder names. A path nested in a longer one
 * (/Volumes/x/Users/…) or a longer name that only starts like an entry is left alone.
 */
export function rewriteText(map: PathMap, text: string): string {
  if (map.entries.length === 0) return text;
  const plain = new Map(map.entries.map(entry => [entry.from, entry.to]));
  const plainPattern = new RegExp(
    `(?:(?<=file://)|(?<![A-Za-z0-9._~/-]))(${map.entries.map(entry => escape(entry.from)).join('|')})(?![A-Za-z0-9._-])`,
    'g',
  );
  const rewritten = text.replace(plainPattern, (match: string) => plain.get(match) ?? match);
  const encoded = new Map(map.entries.map(entry => [claudeProjectFolder(entry.from), claudeProjectFolder(entry.to)]));
  const encodedFroms = [...encoded.keys()].sort((a, b) => b.length - a.length);
  const encodedPattern = new RegExp(`(?<![A-Za-z0-9._-])(${encodedFroms.map(escape).join('|')})(?![A-Za-z0-9])`, 'g');
  return rewritten.replace(encodedPattern, (match: string) => encoded.get(match) ?? match);
}
