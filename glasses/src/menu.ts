// Finds a terminal menu the glasses can answer with a picker. Only a certain match counts: a
// numbered block near the bottom of the screen with exactly one cursor mark, under a prompt whose
// top is on screen. No rule names an agent.
import { isRule } from './terminal';

export interface Menu {
  /** Each choice's first row, "1. Yes", without the cursor mark. */
  choices: string[];
  /** Up to 4 rows just above the choices, across separators: the question and what it would do. */
  question: string[];
  /** Every row of the prompt, from its top to the last choice's description, cursor mark removed: the same text is the same menu. */
  identity: string;
}

const MIN_CHOICES = 2;
const MAX_CHOICES = 9;
/** Hint and status rows a menu may have below it. */
const MAX_BELOW = 4;
/** Description rows the last choice may have; more means output below a stale menu. */
const MAX_DESCRIPTION = 3;
const MAX_QUESTION = 4;

/** An optional cursor mark, then a number ("1." or "1)"), then the label. */
const CHOICE = /^(\s*)(?:([❯>›])\s*)?(\d[.)])\s+(\S.*?)\s*$/u;
const CURSOR_START = /^\s*[❯>›]/u;
/** Dashed separators some menus draw, which `isRule` leaves to the output. */
const DASHED = /^[╌╍┄┅┈┉]{3,}$/u;

interface ChoiceRow {
  index: number;
  /** Where the number sits. */
  column: number;
  marker: string;
  label: string;
  cursor: boolean;
}

function choiceRow(row: string, index: number): ChoiceRow | null {
  const match = CHOICE.exec(row);
  if (!match) return null;
  const [, indent = '', cursor, marker = '', label = ''] = match;
  return { index, column: row.indexOf(marker, indent.length), marker, label: `${marker} ${label}`, cursor: cursor !== undefined };
}

const blank = (row: string) => !row.trim();
const separator = (row: string) => isRule(row) || DASHED.test(row.replace(/\s/g, ''));
const indentOf = (row: string) => row.length - row.trimStart().length;

/** The menu at the bottom of `rows` (the whole screen, input box included), or null when not certain. */
export function findMenu(rows: readonly string[]): Menu | null {
  let last = -1;
  for (let index = rows.length - 1; index >= 0 && last < 0; index -= 1) if (choiceRow(rows[index] ?? '', index)) last = index;
  const lowest = last < 0 ? null : choiceRow(rows[last] ?? '', last);
  if (!lowest) return null;
  // Under a choice, rows indented past its number are its description.
  const continues = (row: string) => !blank(row) && indentOf(row) > lowest.column && !CURSOR_START.test(row) && !choiceRow(row, 0);

  let below = 0;
  let described = true;
  let description = 0;
  let end = last;
  for (const [offset, row] of rows.slice(last + 1).entries()) {
    if (blank(row)) continue;
    if (described && continues(row)) {
      description += 1;
      end = last + 1 + offset;
      if (description > MAX_DESCRIPTION) return null;
      continue;
    }
    described = false;
    if (CURSOR_START.test(row)) return null;
    below += 1;
  }
  if (below > MAX_BELOW) return null;

  const block: ChoiceRow[] = [lowest];
  for (let index = last - 1; index >= 0; index -= 1) {
    const row = rows[index] ?? '';
    const choice = choiceRow(row, index);
    if (choice?.column === lowest.column) block.unshift(choice);
    else if (!choice && (blank(row) || separator(row) || continues(row))) continue;
    else break;
  }
  const choices = block.length;
  if (choices < MIN_CHOICES || choices > MAX_CHOICES) return null;
  if (!block.every((choice, position) => choice.marker === `${position + 1}.` || choice.marker === `${position + 1})`)) return null;
  if (block.filter((choice) => choice.cursor).length !== 1) return null;

  // The prompt starts below a solid rule, or below two blank rows; the screen's edge counts as one
  // blank row. Blank rows between dashed separators belong to the command they frame. Reaching the
  // edge otherwise means rows that could change what is asked are out of sight.
  const first = block[0]?.index ?? last;
  let top = first;
  let blanks = 0;
  let framed = false;
  for (let index = first - 1; ; index -= 1) {
    const row = index < 0 ? '' : (rows[index] ?? '');
    if (index >= 0 && isRule(row)) break;
    if (blank(row)) {
      if (!framed && (blanks += 1) >= 2 && top < first) break;
      if (index < 0) return null;
      continue;
    }
    blanks = 0;
    if (separator(row)) framed = !framed;
    top = index;
  }
  const asked = rows.slice(top, first).filter((row) => !blank(row) && !separator(row)).map((row) => row.trim());
  // Without a question there is nothing to tell this menu from another with the same choices.
  if (!asked.length) return null;
  const question = asked.slice(-MAX_QUESTION);
  const shown = rows.slice(first, end + 1).map((row) => (choiceRow(row, 0) ? row.replace(/^(\s*)[❯>›]/u, '$1 ') : row).trimEnd());
  return { choices: block.map((choice) => choice.label), question, identity: [...asked, ...shown].join('\n') };
}
