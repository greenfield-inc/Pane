import { claudeProjectDirName } from '../agentTranscript/claude';
import type { SessionMovePathEntry } from '../../../../shared/types/sessionMove';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { quoteShellWord } from '../agents/shellWord';

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
  const encoded = new Map(map.entries.map(entry => [claudeProjectDirName(entry.from), claudeProjectDirName(entry.to)]));
  const encodedFroms = [...encoded.keys()].sort((a, b) => b.length - a.length);
  const encodedPattern = new RegExp(`(?<![A-Za-z0-9._-])(${encodedFroms.map(escape).join('|')})(?![A-Za-z0-9])`, 'g');
  return rewritten.replace(encodedPattern, (match: string) => encoded.get(match) ?? match);
}

/**
 * Rewrites every source path in a JSON value (tab state, a Session record, a card), one string at a
 * time: never the serialised text, where a target path with `\\` or `"` (every Windows path, and
 * legal in macOS and Linux names) would come out as broken or different JSON.
 */
export function rewriteJson(map: PathMap, value: JsonValue): JsonValue {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Branches on the kind of a JsonValue its caller already holds typed; nothing here is parsed.
  if (typeof value === 'string') return rewriteText(map, value);
  if (Array.isArray(value)) return value.map(item => rewriteJson(map, item));
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- As above: a JsonValue object, walked key by key.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteJson(map, item)]));
  return value;
}

/** A layout as Pane saves it (JSON text), with this machine's paths; text that isn't JSON is rewritten as text. */
export function rewriteJsonText(map: PathMap, text: string): string {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rewriteText(map, text);
  }
  return JSON.stringify(rewriteJson(map, parsed));
}

/** One `--snapshot <folder>` in a launch command (T-110): its span, and the folder as the shell reads it. */
export interface SnapshotArgument { start: number; end: number; folder: string; equals: boolean }

/**
 * Every `--snapshot` in a POSIX launch command, with its folder read as one shell word: bare,
 * single-quoted (with `'\''` for an apostrophe), double-quoted, or after `--snapshot=`. The one
 * reader for this flag in a move (review F-6).
 */
export function snapshotArguments(command: string): SnapshotArgument[] {
  const found: SnapshotArgument[] = [];
  const flag = /(?:^|\s)(--snapshot)(=|\s+)/g;
  for (let match = flag.exec(command); match; match = flag.exec(command)) {
    const start = match.index + match[0].length - match[1].length - match[2].length;
    const word = readShellWord(command, match.index + match[0].length);
    if (!word) continue;
    found.push({ start, end: word.end, folder: word.value, equals: match[2] === '=' });
    flag.lastIndex = word.end;
  }
  return found;
}

/** The POSIX shell word starting at `from`, or undefined when there is none or a quote isn't closed. */
function readShellWord(text: string, from: number): { value: string; end: number } | undefined {
  let value = '';
  let index = from;
  while (index < text.length && !/\s/.test(text[index])) {
    const character = text[index];
    if (character === "'") {
      const close = text.indexOf("'", index + 1);
      if (close < 0) return undefined;
      value += text.slice(index + 1, close);
      index = close + 1;
    } else if (character === '"') {
      let close = index + 1;
      let quoted = '';
      while (close < text.length && text[close] !== '"') {
        if (text[close] === '\\' && close + 1 < text.length) { quoted += text[close + 1]; close += 2; } else { quoted += text[close]; close += 1; }
      }
      if (close >= text.length) return undefined;
      value += quoted;
      index = close + 1;
    } else if (character === '\\' && index + 1 < text.length) {
      value += text[index + 1];
      index += 2;
    } else {
      value += character;
      index += 1;
    }
  }
  return index > from ? { value, end: index } : undefined;
}

/**
 * A stored launch command with this machine's paths (rewriteText), and its `--snapshot` folder moved
 * as one word, quoted when the new path needs it: a restore replays the command with `--resume`, and
 * Agent Farm reads that flag before its own record (T-110 review F-11). Moves run between macOS and
 * Linux, so the quoting is POSIX.
 */
export function rewriteLaunchCommand(map: PathMap, command: string): string {
  const moved: string[] = [];
  let held = '';
  let at = 0;
  for (const argument of snapshotArguments(command)) {
    const target = mapPath(map, argument.folder);
    if (target === null) continue;
    held += `${command.slice(at, argument.start)}\uE000${moved.length}\uE001`;
    moved.push(`--snapshot${argument.equals ? '=' : ' '}${/^[\w./:@%+=,-]+$/.test(target) ? target : quoteShellWord(target, undefined)}`);
    at = argument.end;
  }
  held += command.slice(at);
  return rewriteText(map, held).replace(/\uE000(\d+)\uE001/g, (_match: string, index: string) => moved[Number(index)] ?? '');
}
