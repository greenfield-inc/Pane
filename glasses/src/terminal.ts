// Turns a terminal's rows into what the glasses show: the agent's input box and status rows at the
// bottom are trimmed, so the narrow display shows output instead of chrome. No rule names an agent.

const BOX_DRAWING = /[─━═╭╮╰╯│┃┌┐└┘├┤┬┴┼]/gu;
/** A rule this close above the lowest one is the input box's top border. */
const BOX_SPAN = 6;
/** The input box sits in the last rows of the screen; a rule higher up is output. */
const CHROME_DEPTH = 10;
/** At most this many unchanging bottom rows count as a footer. */
const MAX_FOOTER = 4;

/** A row that is mostly box-drawing characters: a border or separator, drawn as one short line. */
export function isRule(row: string): boolean {
  const ink = row.replace(/\s/g, '');
  return ink.length >= 3 && (ink.match(BOX_DRAWING)?.length ?? 0) >= 0.8 * ink.length;
}

function withoutTrailingBlanks(rows: readonly string[]): string[] {
  let end = rows.length;
  while (end > 0 && !rows[end - 1]?.trim()) end -= 1;
  return rows.slice(0, end);
}

/** Bottom rows that read the same in every earlier read while a row above them changed. */
function staticFooter(rows: readonly string[], earlier: readonly (readonly string[])[]): number {
  if (earlier.length < 2) return 0;
  const reads = earlier.map(withoutTrailingBlanks);
  const same = (count: number) => reads.every((read) => read.length >= count && read.at(-count) === rows.at(-count));
  let footer = 0;
  while (footer < MAX_FOOTER && footer < rows.length - 1 && same(footer + 1)) footer += 1;
  if (!footer) return 0;
  const above = rows.slice(0, -footer).join('\n');
  return reads.some((read) => read.slice(0, -footer).join('\n') !== above) ? footer : 0;
}

/**
 * The rows above the input box. The box starts at the lowest wide rule near the bottom, or at a
 * second rule just above it (its top border). Without a rule, a footer that stays the same across
 * `earlier` reads while the rows above change is trimmed. Plain output comes back unchanged.
 */
export function trimChrome(screen: readonly string[], earlier: readonly (readonly string[])[] = []): string[] {
  const rows = withoutTrailingBlanks(screen);
  const width = Math.max(0, ...rows.map((row) => row.trimEnd().length));
  const wide = (index: number) => {
    const row = rows[index] ?? '';
    return isRule(row) && row.trim().length >= 0.6 * width;
  };
  let cut = -1;
  for (let index = rows.length - 1; index >= Math.max(0, rows.length - CHROME_DEPTH); index -= 1) {
    if (wide(index)) {
      cut = index;
      break;
    }
  }
  if (cut >= 0) {
    for (let index = cut - 1; index >= Math.max(0, cut - BOX_SPAN); index -= 1) {
      if (wide(index)) {
        cut = index;
        break;
      }
    }
  } else {
    cut = rows.length - staticFooter(rows, earlier);
  }
  const kept = withoutTrailingBlanks(rows.slice(0, cut));
  return kept.length ? kept : rows;
}
