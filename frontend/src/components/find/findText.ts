/**
 * Text matching shared by Pane's find adapters. Matching ignores case and
 * never joins text across a block boundary, like Chrome's find in page.
 */

/** One run of rendered text (a DOM text node, a log line, a cell). */
export interface TextSegment {
  text: string;
  /** True when a block boundary separates this segment from the previous one. */
  breakBefore: boolean;
}

export interface TextPosition {
  segment: number;
  offset: number;
}

export interface TextMatch {
  start: TextPosition;
  /** Exclusive end. */
  end: TextPosition;
}

/**
 * Lower-case one character at a time so offsets in the folded string stay
 * aligned with the original (some characters change length when lowered).
 */
export function foldCase(text: string): string {
  let folded = '';
  for (const char of text) {
    const lower = char.toLocaleLowerCase();
    folded += lower.length === char.length ? lower : char;
  }
  return folded;
}

/** Where `query` occurs in `text` (case-insensitive, non-overlapping). */
export function findOffsets(text: string, query: string): number[] {
  if (!query) return [];
  const haystack = foldCase(text);
  const needle = foldCase(query);
  const offsets: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    offsets.push(index);
    from = index + needle.length;
  }
  return offsets;
}

export function countOccurrences(text: string, query: string): number {
  return findOffsets(text, query).length;
}

function locate(starts: number[], position: number): number {
  // Last segment whose start is <= position.
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= position) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function findInSegments(segments: readonly TextSegment[], query: string): TextMatch[] {
  if (!query || segments.length === 0) return [];
  const starts: number[] = [];
  let joined = '';
  segments.forEach((segment, index) => {
    // A newline cannot be typed into the single-line find input, so a match
    // can never cross it.
    if (index > 0 && segment.breakBefore) joined += '\n';
    starts.push(joined.length);
    joined += segment.text;
  });

  return findOffsets(joined, query).map((offset) => {
    const endOffset = offset + query.length;
    const startSegment = locate(starts, offset);
    // The end is exclusive, so place it in the segment holding its last character.
    const endSegment = locate(starts, endOffset - 1);
    return {
      start: { segment: startSegment, offset: offset - starts[startSegment] },
      end: { segment: endSegment, offset: endOffset - starts[endSegment] },
    };
  });
}

/** Move a 1-based match index, wrapping at both ends. 0 means no match. */
export function stepMatchIndex(current: number, total: number, direction: 'next' | 'prev'): number {
  if (total <= 0) return 0;
  if (direction === 'next') return current >= total ? 1 : current + 1;
  return current <= 1 ? total : current - 1;
}
