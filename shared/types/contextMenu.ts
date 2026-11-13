import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';

/**
 * One row of a native context menu the renderer asks main to show. Main
 * answers with the chosen item's id. Main performs two kinds itself: `paste`,
 * because only a native paste reaches the focused element's paste handler, and
 * `look-up` (macOS), which shows the dictionary for the focused selection and
 * labels itself with `text`.
 */
export type ContextMenuEntry =
  | { type: 'item'; id: string; label: string; enabled: boolean; accelerator?: string }
  | { type: 'paste'; id: string; label: string; enabled: boolean; accelerator?: string }
  | { type: 'look-up'; id: string; text: string }
  | { type: 'separator' };

const itemFields = {
  id: boundary.nonEmptyString,
  label: boundary.nonEmptyString,
  enabled: boundary.boolean,
  accelerator: boundary.optional(boundary.string),
};

export const contextMenuEntriesSchema: BoundarySchema<ContextMenuEntry[]> = boundary.array(boundary.union(
  boundary.object({ type: boundary.literal('item'), ...itemFields }),
  boundary.object({ type: boundary.literal('paste'), ...itemFields }),
  boundary.object({ type: boundary.literal('look-up'), id: boundary.nonEmptyString, text: boundary.nonEmptyString }),
  boundary.object({ type: boundary.literal('separator') }),
));
