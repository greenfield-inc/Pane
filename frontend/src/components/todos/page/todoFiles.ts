import type { TodoAttachment, TodoAttachmentGroup, TodoAttachmentKind } from '../../../../../shared/types/todos';

/**
 * The details sidebar's Files tab (T-26): every file and page a to-do has (its own, its sub-to-dos'
 * and its parent's, with what Pane attached on its own: PRs, approval files, pages opened beside
 * you), grouped by kind in the split's tab order, with a search over label, path and note.
 */
export interface TodoFileRow {
  attachment: TodoAttachment;
  /** The to-do an inherited file comes from; absent for the to-do's own. */
  from?: { number: number; relation: 'parent' | 'sub' };
}

export interface TodoFileGroup {
  kind: TodoAttachmentKind;
  label: string;
  rows: TodoFileRow[];
}

/** The groups, in the split's tab order (round 7), each named in the plural. */
const FILE_GROUPS = [
  ['plan', 'Plan'], ['mockup', 'Mock-ups'], ['design', 'Designs'], ['pr', 'PRs'], ['findings', 'Findings'], ['decision', 'Decisions'],
  ['doc', 'Docs'], ['image', 'Images'], ['link', 'Links'], ['status', 'Status'], ['checklist', 'Checklists'],
] as const satisfies ReadonlyArray<readonly [TodoAttachmentKind, string]>;

/** Pane's own attachments name how they came; the rest who attached them. */
const SOURCE_ORIGIN = { pr: 'Pane · its PR', approval: 'from an approval', opened: 'opened beside you' } as const;

/** Every attached file, own first then each inherited group, leaving out detached ones. */
export function todoFileRows(groups: readonly TodoAttachmentGroup[]): TodoFileRow[] {
  return groups.flatMap((group) => group.attachments
    .filter((attachment) => attachment.removedAt === undefined)
    .map((attachment): TodoFileRow => (group.from ? { attachment, from: group.from } : { attachment })));
}

function matches(row: TodoFileRow, query: string): boolean {
  const { label, target, note } = row.attachment;
  return [label, target, note ?? ''].some((text) => text.toLowerCase().includes(query));
}

/** The rows matching `query` (case-insensitive), grouped by kind; each group in the order attached, empty ones left out. */
export function groupTodoFiles(rows: readonly TodoFileRow[], query: string): TodoFileGroup[] {
  const needle = query.trim().toLowerCase();
  const shown = needle ? rows.filter((row) => matches(row, needle)) : rows;
  return FILE_GROUPS.flatMap(([kind, label]) => {
    const inKind = shown.filter((row) => row.attachment.kind === kind)
      .sort((a, b) => a.attachment.addedAt - b.attachment.addedAt || a.attachment.id - b.attachment.id);
    return inKind.length > 0 ? [{ kind, label, rows: inKind }] : [];
  });
}

/** Where a file came from: "you", the agent's name, "Pane · its PR", "from an approval", "opened beside you"; then "from T-14". */
export function fileOrigin(row: TodoFileRow): string {
  const { source, addedBy } = row.attachment;
  const who = source === 'attached' ? addedBy : SOURCE_ORIGIN[source];
  if (!row.from) return who;
  return `${who} · from T-${row.from.number}${row.from.relation === 'parent' ? ' (parent)' : ''}`;
}
