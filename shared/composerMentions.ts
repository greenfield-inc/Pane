/*
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code, commit 2808e878d), packages/shared/src/composerTrigger.ts and apps/web/src/providerSkillSearch.ts.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch, type RankedSearchResult } from './searchRanking';
import type { ChatTabCommand, ChatTabMentions } from './types/chatTab';

/**
 * The chat composer's @, $ and / rules, shared by desktop, the web app, the phone and the host:
 * when the menu opens, what it lists, what a pick writes, and which words are references.
 */
export type ComposerTriggerKind = 'file' | 'skill' | 'command';

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  /** The word after its sign. */
  query: string;
  rangeStart: number;
  /** The caret. */
  rangeEnd: number;
}

type Range = readonly [start: number, end: number];

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r';
}

/** A second slash or backslash makes the whole word a path, even when the caret precedes it. */
function isPathWord(text: string, wordStart: number, cursor: number): boolean {
  let wordEnd = cursor;
  while (wordEnd < text.length && !isWhitespace(text[wordEnd] ?? '')) wordEnd += 1;
  return /[/\\]/.test(text.slice(wordStart + 1, wordEnd));
}

/** `$5`, `€9.99` and `$10k` are money, not skills, with the punctuation prose puts after one (`$10k.`, `$5)`). */
function isCurrencyAmount(query: string): boolean {
  return /^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$/.test(query);
}

/**
 * Where `text` is Markdown code: fenced blocks (an unclosed one runs to the end) and backtick spans.
 * With `unclosed`, a backtick span still being typed runs to the end too.
 */
function codeRanges(text: string, unclosed = false): Range[] {
  const ranges: Range[] = [];
  let paragraphStart = 0;
  let fence: { marker: string; start: number } | undefined;
  const closeParagraph = (end: number, last: boolean) => {
    const runs = [...text.slice(paragraphStart, end).matchAll(/`+/g)].map(run => ({ start: paragraphStart + run.index, length: run[0].length }));
    for (let index = 0; index < runs.length; index += 1) {
      const close = runs.findIndex((run, other) => other > index && run.length === runs[index].length);
      if (close > 0) { ranges.push([runs[index].start, runs[close].start + runs[close].length]); index = close; }
      else if (last && unclosed) { ranges.push([runs[index].start, text.length]); return; }
    }
  };
  for (let lineStart = 0; lineStart <= text.length;) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
        ranges.push([fence.start, lineEnd]);
        fence = undefined;
        paragraphStart = lineEnd + 1;
      }
    } else if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      closeParagraph(lineStart, false);
      fence = { marker: marker[1], start: lineStart };
    } else if (!line.trim()) {
      closeParagraph(lineStart, false);
      paragraphStart = lineEnd + 1;
    }
    if (newline < 0) break;
    lineStart = lineEnd + 1;
  }
  if (fence) ranges.push([fence.start, text.length]);
  else closeParagraph(text.length, true);
  return ranges;
}

function within(ranges: readonly Range[], index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** The trigger the caret is in: a word that starts with @, a currency sign or / (the / rule), outside code. */
export function detectComposerTrigger(text: string, cursor: number): ComposerTrigger | null {
  const rangeEnd = Math.max(0, Math.min(text.length, Math.floor(cursor)));
  let rangeStart = rangeEnd;
  while (rangeStart > 0 && !isWhitespace(text[rangeStart - 1] ?? '')) rangeStart -= 1;
  const token = text.slice(rangeStart, rangeEnd);
  const found = (kind: ComposerTriggerKind, query: string): ComposerTrigger | null =>
    within(codeRanges(text), rangeStart) || within(codeRanges(text.slice(0, rangeEnd), true), rangeStart) ? null : { kind, query, rangeStart, rangeEnd };
  if (token.startsWith('/')) {
    if (isPathWord(text, rangeStart, rangeEnd)) return null;
    // Mid-message, / needs a letter next and no dot, so paths, dates and fractions open nothing.
    if (rangeStart > 0 && !/^\/\p{L}[^.]*$/u.test(token)) return null;
    return found('command', token.slice(1));
  }
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    const query = token.slice(skillPrefix[0].length);
    return isCurrencyAmount(query) ? null : found('skill', query);
  }
  return token.startsWith('@') ? found('file', token.slice(1).replace(/^"/, '')) : null;
}

export function isSameTrigger(a: ComposerTrigger | null, b: ComposerTrigger | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.rangeStart === b.rangeStart;
}

/** A mid-message / lists skills whose name it begins, and Enter still sends until a row is chosen. */
export function isMidMessageSlash(trigger: ComposerTrigger): boolean {
  return trigger.kind === 'command' && trigger.rangeStart > 0;
}

/** A skill's name. Some agents list skills as `$name`, and the name keeps that form on the wire. */
export function skillName(command: Pick<ChatTabCommand, 'name'>): string {
  return command.name.replace(/^\$/, '');
}

export function skillNames(commands: readonly ChatTabCommand[]): Set<string> {
  return new Set(commands.flatMap(command => command.skill ? [skillName(command)] : []));
}

/** Best name match first, then description matches; a name listed twice shows once. Everything, by name, for an empty query. */
function rankCommands<Command extends ChatTabCommand>(commands: readonly Command[], query: string): Command[] {
  const unique = new Map<string, Command>();
  for (const command of commands) {
    const key = skillName(command).toLowerCase();
    if (!unique.has(key)) unique.set(key, command);
  }
  const normalized = normalizeSearchQuery(query);
  const ranked: RankedSearchResult<Command>[] = [];
  for (const [name, item] of unique) {
    const score = normalized ? scoreCommand(name, item.description ?? '', normalized) : 0;
    if (score !== null) insertRankedSearchResult(ranked, { item, score, tieBreaker: name }, Number.POSITIVE_INFINITY);
  }
  return ranked.map(entry => entry.item);
}

function scoreCommand(name: string, description: string, query: string): number | null {
  const scores = [
    scoreQueryMatch({ value: name, query, exactBase: 0, prefixBase: 2, boundaryBase: 4, includesBase: 6, fuzzyBase: 100, boundaryMarkers: ['-', '_', '/', ':'] }),
    scoreQueryMatch({ value: description.toLowerCase(), query, exactBase: 20, prefixBase: 22, boundaryBase: 24, includesBase: 26 }),
  ].filter(score => score !== null);
  return scores.length ? Math.min(...scores) : null;
}

/**
 * The commands and skills a $ or / trigger lists, or undefined when it opens no menu. `mentions` is what
 * the host says the tab can mention; without it (an older host) only a first-word / opens.
 */
export function commandRows<Command extends ChatTabCommand>(trigger: ComposerTrigger, commands: readonly Command[], mentions: ChatTabMentions | undefined): Command[] | undefined {
  const skills = commands.filter(command => command.skill);
  if (trigger.kind === 'skill') return mentions?.skills ? rankCommands(skills, trigger.query) : undefined;
  if (trigger.kind !== 'command') return undefined;
  let rows: Command[];
  if (isMidMessageSlash(trigger)) {
    if (!mentions?.skills) return undefined;
    const query = trigger.query.toLowerCase();
    rows = rankCommands(skills.filter(command => skillName(command).toLowerCase().startsWith(query)), query);
  } else rows = rankCommands(commands, trigger.query);
  return rows.length ? rows : undefined;
}

/** What picking a row writes: a skill is always `$name`, from either sign. */
export function commandText(command: ChatTabCommand): string {
  return command.skill ? `$${skillName(command)}` : `/${command.name}`;
}

/** How a row names itself under the trigger that lists it. */
export function commandLabel(trigger: ComposerTrigger, command: ChatTabCommand): string {
  return `${trigger.kind === 'skill' ? '$' : '/'}${command.skill ? skillName(command) : command.name}`;
}

/** `@path`, quoted when a space would end it or its last character reads as punctuation. Folders end with /. */
export function fileReference(file: { path: string; isDirectory: boolean }): string {
  const path = file.isDirectory ? `${file.path.replace(/\/+$/, '')}/` : file.path;
  return /\s|[.,;:)?]$/.test(path) ? `@"${path}"` : `@${path}`;
}

export interface ComposerPick { text: string; cursor: number; mark: ComposerMark }

/** Puts `reference` in place of the trigger's word, followed by one space (an existing one is reused). */
export function applyPick(text: string, trigger: ComposerTrigger, reference: string): ComposerPick {
  const before = text.slice(0, trigger.rangeStart);
  const after = text.slice(trigger.rangeEnd);
  const end = before.length + reference.length;
  return { text: `${before}${reference}${/^\s/.test(after) ? '' : ' '}${after}`, cursor: end + 1, mark: { start: before.length, end } };
}

/** A highlighted stretch of the message box. */
export interface ComposerMark { start: number; end: number }

/** Moves marks with an edit. Editing inside a mark, or typing onto its end, removes it. */
export function moveMarks(marks: readonly ComposerMark[], previous: string, next: string): ComposerMark[] {
  if (previous === next || !marks.length) return [...marks];
  const limit = Math.min(previous.length, next.length);
  let start = 0;
  while (start < limit && previous[start] === next[start]) start += 1;
  let tail = 0;
  while (tail < limit - start && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  const end = previous.length - tail;
  const added = next.slice(start, next.length - tail);
  const delta = next.length - previous.length;
  return marks.flatMap(mark => {
    if (mark.end < start || (mark.end === start && !/^\S/.test(added || next.slice(start, start + 1)))) return [mark];
    if (mark.start > end || (mark.start === end && !/\S$/.test(added || next.slice(0, start)))) return [{ start: mark.start + delta, end: mark.end + delta }];
    return [];
  });
}

export type MessageReference = ComposerMark & (
  | { kind: 'file' | 'folder'; path: string }
  | { kind: 'skill'; name: string }
);

/** The `$name` words that name one of `names`, outside code. */
export function skillReferences(text: string, names: ReadonlySet<string>): Array<ComposerMark & { kind: 'skill'; name: string }> {
  if (!names.size || !text.includes('$')) return [];
  const code = codeRanges(text);
  return [...text.matchAll(/(^|\s)\$([a-zA-Z0-9][a-zA-Z0-9:._-]*)(?=[,;:)?]*(?:\s|$))/g)].flatMap(match => {
    const start = match.index + match[1].length;
    const name = names.has(match[2]) ? match[2] : match[2].replace(/[.:]+$/, '');
    return !names.has(name) || within(code, start) ? [] : [{ kind: 'skill' as const, start, end: start + 1 + name.length, name }];
  });
}

/** The references of a sent message: `@` words with a slash, a file extension or quotes, and the tab's skills. */
export function messageReferences(text: string, names: ReadonlySet<string>): MessageReference[] {
  const references: MessageReference[] = skillReferences(text, names);
  if (text.includes('@')) {
    const code = codeRanges(text);
    for (const match of text.matchAll(/(^|\s)@(?:"([^"\r\n]+)"(?=[.,;:)?]*(?:\s|$))|([^\s"]+))/g)) {
      const start = match.index + match[1].length;
      const path = match[2] ?? match[3].replace(/[.,;:)?]+$/, '');
      if (within(code, start) || (match[2] === undefined && !/\/|\.[\p{L}\p{N}_]+$/u.test(path))) continue;
      const end = start + path.length + (match[2] === undefined ? 1 : 3);
      const folder = path.endsWith('/');
      references.push({ kind: folder ? 'folder' : 'file', start, end, path });
    }
  }
  return references.sort((a, b) => a.start - b.start);
}

/** `text` cut at its references, in order. */
export function referenceSegments(text: string, names: ReadonlySet<string>): Array<{ text: string; start: number; reference?: MessageReference }> {
  const segments: Array<{ text: string; start: number; reference?: MessageReference }> = [];
  let at = 0;
  for (const reference of messageReferences(text, names)) {
    if (reference.start > at) segments.push({ text: text.slice(at, reference.start), start: at });
    segments.push({ text: text.slice(reference.start, reference.end), start: reference.start, reference });
    at = reference.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), start: at });
  return segments;
}

/** `text` split where `query` matches, for the menu's bold letters: the whole query when it is there, else its letters in order. */
export function matchedParts(text: string, query: string): Array<{ text: string; matched: boolean }> {
  const wanted = query.trim().toLowerCase().split('/').filter(Boolean).at(-1) ?? '';
  const lower = text.toLowerCase();
  const bold = new Set<number>();
  // Lower-casing a few letters changes their length, and offsets with it: those names are not marked.
  if (wanted && lower.length === text.length) {
    const at = lower.indexOf(wanted);
    if (at >= 0) for (let index = at; index < at + wanted.length; index += 1) bold.add(index);
    else {
      let next = 0;
      for (let index = 0; index < lower.length && next < wanted.length; index += 1) if (lower[index] === wanted[next]) { bold.add(index); next += 1; }
      if (next < wanted.length) bold.clear();
    }
  }
  const parts: Array<{ text: string; matched: boolean }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const matched = bold.has(index);
    const last = parts.at(-1);
    if (last && last.matched === matched) last.text += text[index];
    else parts.push({ text: text[index], matched });
  }
  return parts;
}

/** The empty message box's text. Unchanged for Autopilot and a host too old for @. */
export function composerPlaceholder(mentions: ChatTabMentions | undefined, options: { session?: boolean; phone?: boolean } = {}): string {
  const plain = options.session ? 'Ask the Session anything' : 'Ask anything';
  if (!mentions?.files) return plain;
  const other = mentions.skills ? ['$', 'skills'] : ['/', 'commands'];
  if (options.phone) return `${options.session ? 'Ask the Session' : plain}, @ files, ${other[0]} ${other[1]}`;
  return `${plain}, @ for files, ${other[0]} for ${other[1]}`;
}

export const COMPOSER_MENU_TEXT = {
  searchingFiles: 'Searching files…',
  noFiles: 'No matching files or folders.',
  filesFailed: 'Pane couldn\'t list this folder\'s files.',
  loadingSkills: 'Loading skills…',
  noSkills: 'No skills found.',
  midMessageHint: 'Tab or ↓ picks · Enter sends',
  fileGone: 'That file is no longer in this chat\'s folder.',
} as const;

/** The wait after the last key before a file search. */
export const FILE_SEARCH_DELAY_MS = 120;
/** Skills the phone lists before you type. */
export const PHONE_SKILL_LIMIT = 20;
