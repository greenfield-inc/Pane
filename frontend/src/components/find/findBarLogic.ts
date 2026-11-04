import type { FindBarState } from './findController';

export const NO_TEXT_MESSAGE = 'No text to search in this tab';

export type FindBarKeyAction = 'next' | 'prev' | 'close' | null;

/** Enter and Shift+Enter move between matches; Esc closes. */
export function findBarKeyAction(event: { key: string; shiftKey: boolean; isComposing: boolean }): FindBarKeyAction {
  if (event.isComposing) return null;
  if (event.key === 'Enter') return event.shiftKey ? 'prev' : 'next';
  if (event.key === 'Escape') return 'close';
  return null;
}

/**
 * Keys on the bar's buttons: Esc closes from any control. Enter and Space keep
 * their ordinary button behaviour.
 */
export function findBarControlKeyAction(event: { key: string; isComposing: boolean }): 'close' | null {
  return !event.isComposing && event.key === 'Escape' ? 'close' : null;
}

/** "3 of 12", "0 of 0", or nothing before a query is typed. */
export function findCountLabel(bar: Pick<FindBarState, 'query' | 'result' | 'noText'>): string {
  if (bar.noText || !bar.query) return '';
  return `${bar.result.current} of ${bar.result.total}`;
}
