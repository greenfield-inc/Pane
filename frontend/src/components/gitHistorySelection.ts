/**
 * Click and shift-click selection for the Details history graph.
 *
 * The graph lists its rows newest first (the uncommitted 'index' row, when present, is on top),
 * so the row further down is the older end of a range.
 */

export interface HistorySelection {
  /** The row a plain click last chose; shift-click ranges extend from it. */
  anchor: string;
  /** The older end, by graph position. Equals newerHash for a single row. */
  olderHash: string;
  /** The newer end, by graph position; 'index' for the uncommitted row. */
  newerHash: string;
}

/**
 * The selection after a click on `hash`. A plain click, a shift-click with no anchor, or one whose
 * anchor has left the graph selects that row alone and makes it the anchor; a shift-click spans from
 * the anchor to it and keeps the anchor.
 */
export function selectHistoryRow(
  hashes: readonly string[],
  previous: HistorySelection | null,
  hash: string,
  extend: boolean,
): HistorySelection {
  const clicked = hashes.indexOf(hash);
  const anchorAt = previous ? hashes.indexOf(previous.anchor) : -1;
  if (!extend || !previous || clicked === -1 || anchorAt === -1 || anchorAt === clicked) {
    return { anchor: hash, olderHash: hash, newerHash: hash };
  }
  return {
    anchor: previous.anchor,
    olderHash: hashes[Math.max(anchorAt, clicked)],
    newerHash: hashes[Math.min(anchorAt, clicked)],
  };
}

/** Whether the row at `index` falls inside the selection, both ends included. */
export function isHistoryRowSelected(hashes: readonly string[], selection: HistorySelection | null, index: number): boolean {
  if (!selection) return false;
  const older = hashes.indexOf(selection.olderHash);
  const newer = hashes.indexOf(selection.newerHash);
  if (older === -1 || newer === -1) return false;
  return index >= newer && index <= older;
}

// A plain click opens the Changes tab, which unmounts the Details history, so each session's
// selection lives here; the next shift-click back in Details extends from the remembered anchor.
const selections = new Map<string, HistorySelection>();

export function recallHistorySelection(sessionId: string): HistorySelection | null {
  return selections.get(sessionId) ?? null;
}

export function rememberHistorySelection(sessionId: string, selection: HistorySelection): void {
  selections.set(sessionId, selection);
}

export function forgetHistorySelections(): void {
  selections.clear();
}
