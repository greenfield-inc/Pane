import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';

/**
 * One row of a native context menu the renderer asks main to show. Main
 * answers with the chosen item's id; `paste` items are performed by main
 * itself, because only a native paste reaches the focused element's paste
 * handler.
 */
export type ContextMenuEntry =
  | { type: 'item'; id: string; label: string; enabled: boolean; accelerator?: string }
  | { type: 'paste'; id: string; label: string; enabled: boolean; accelerator?: string }
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
  boundary.object({ type: boundary.literal('separator') }),
));
