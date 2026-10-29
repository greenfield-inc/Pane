// Finds a terminal menu the glasses can answer with a picker. Only a certain match counts: a
// numbered or bulleted block near the bottom of the screen with exactly one cursor mark. No rule
// names an agent.
import { isRule } from './terminal';

export interface Menu {
  /** Each choice's first row, "1. Yes", without the cursor mark. */
  choices: string[];
  /** The choice the cursor is on. */
  cursor: number;
  /** Up to 4 rows just above the choices: the question. */
  question: string[];
}

const MIN_CHOICES = 2;
const MAX_CHOICES = 9;
/** Hint and status rows a menu may have below it. */
const MAX_BELOW = 4;
const MAX_QUESTION = 4;

/** An optional cursor mark, then a number ("1." or "1)") or a bullet, then the label. */
const CHOICE = /^(\s*)(?:([❯>›])\s*)?(\d[.)]|[-*•])\s+(\S.*?)\s*$/u;
const CURSOR_START = /^\s*[❯>›]/u;
/** Dashed separators some menus draw, which `isRule` leaves to the output. */
const DASHED = /^[╌╍┄┅┈┉]{3,}$/u;

interface ChoiceRow {
  index: number;
  /** Where the number or bullet sits. */
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
  for (const row of rows.slice(last + 1)) {
    if (blank(row)) continue;
    if (described && continues(row)) continue;
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
  const numbered = block.every((choice, position) => choice.marker === `${position + 1}.` || choice.marker === `${position + 1})`);
  const bulleted = block.every((choice) => choice.marker === lowest.marker && !/\d/.test(choice.marker));
  if (!numbered && !bulleted) return null;
  const cursors = block.filter((choice) => choice.cursor);
  if (cursors.length !== 1 || !cursors[0]) return null;

  const question: string[] = [];
  let blanks = 0;
  for (let index = (block[0]?.index ?? 0) - 1; index >= 0 && question.length < MAX_QUESTION; index -= 1) {
    const row = rows[index] ?? '';
    if (blank(row)) {
      blanks += 1;
      if (blanks >= 2 && question.length) break;
      continue;
    }
    if (separator(row)) break;
    blanks = 0;
    question.unshift(row.trim());
  }
  return { choices: block.map((choice) => choice.label), cursor: block.indexOf(cursors[0]), question };
}
