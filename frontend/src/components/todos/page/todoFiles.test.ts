import { describe, expect, it } from 'vitest';
import type { TodoAttachment, TodoAttachmentGroup, TodoAttachmentKind } from '../../../../../shared/types/todos';
import { fileOrigin, groupTodoFiles, todoFileRows } from './todoFiles';

let nextId = 1;
function attachment(kind: TodoAttachmentKind, label: string, extra: Partial<TodoAttachment> = {}): TodoAttachment {
  const id = nextId++;
  return { id, todoNumber: 12, kind, target: `/tmp/r/${label.replace(/\s+/g, '-')}.md`, label, addedBy: 'planner', source: 'attached', addedAt: id, ...extra };
}

describe('todoFileRows', () => {
  it('lists the to-do’s own files, its sub-to-dos’ and its parent’s, leaving out detached ones', () => {
    const own = attachment('plan', 'Plan');
    const gone = attachment('doc', 'Gone', { removedAt: 5 });
    const sub = attachment('pr', 'PR #8', { todoNumber: 14 });
    const parent = attachment('decision', 'Decisions', { todoNumber: 10 });
    const groups: TodoAttachmentGroup[] = [
      { attachments: [own, gone] },
      { from: { number: 14, relation: 'sub' }, attachments: [sub] },
      { from: { number: 10, relation: 'parent' }, attachments: [parent] },
    ];
    expect(todoFileRows(groups).map((row) => [row.attachment.label, row.from?.number])).toEqual([
      ['Plan', undefined], ['PR #8', 14], ['Decisions', 10],
    ]);
  });
});

describe('groupTodoFiles', () => {
  const plan = attachment('plan', 'Cover sheet');
  const mockup = attachment('mockup', 'Receipt mock-up', { note: 'the empty state' });
  const design = attachment('design', 'Colours');
  const pr = attachment('pr', 'PR #7', { target: 'https://github.com/acme/billing/pull/7' });
  const findings = attachment('findings', 'QA findings');
  const image = attachment('image', 'Screenshot', { target: '/tmp/r/shot.png' });
  const link = attachment('link', 'Stripe docs', { target: 'https://stripe.com/docs' });
  const doc2 = attachment('doc', 'Notes later', { addedAt: 100 });
  const doc1 = attachment('doc', 'Notes', { addedAt: 50 });
  const rows = todoFileRows([{ attachments: [link, image, findings, pr, design, mockup, plan, doc2, doc1] }]);

  it('groups by kind in the split’s tab order, each in the order attached, with counts; empty groups hidden', () => {
    const groups = groupTodoFiles(rows, '');
    expect(groups.map((group) => [group.label, group.rows.length])).toEqual([
      ['Plan', 1], ['Mock-ups', 1], ['Designs', 1], ['PRs', 1], ['Findings', 1], ['Docs', 2], ['Images', 1], ['Links', 1],
    ]);
    expect(groups.find((group) => group.label === 'Docs')?.rows.map((row) => row.attachment.label)).toEqual(['Notes', 'Notes later']);
  });

  it('search matches label, path and note, ignoring case', () => {
    expect(groupTodoFiles(rows, 'RECEIPT').flatMap((group) => group.rows.map((row) => row.attachment.label))).toEqual(['Receipt mock-up']);
    expect(groupTodoFiles(rows, 'stripe.com').flatMap((group) => group.rows.map((row) => row.attachment.label))).toEqual(['Stripe docs']);
    expect(groupTodoFiles(rows, 'empty state').flatMap((group) => group.rows.map((row) => row.attachment.label))).toEqual(['Receipt mock-up']);
    expect(groupTodoFiles(rows, '  shot.png ').map((group) => group.label)).toEqual(['Images']);
    expect(groupTodoFiles(rows, 'nothing like it')).toEqual([]);
  });

  it('keeps status and checklist files after the links', () => {
    const extra = todoFileRows([{ attachments: [attachment('checklist', 'Checks'), attachment('status', 'Status page'), attachment('link', 'A link')] }]);
    expect(groupTodoFiles(extra, '').map((group) => group.label)).toEqual(['Links', 'Status', 'Checklists']);
  });
});

describe('fileOrigin', () => {
  it('names where a file came from', () => {
    expect(fileOrigin({ attachment: attachment('doc', 'a', { addedBy: 'you' }) })).toBe('you');
    expect(fileOrigin({ attachment: attachment('doc', 'b', { addedBy: 'planner' }) })).toBe('planner');
    expect(fileOrigin({ attachment: attachment('pr', 'c', { addedBy: 'Pane', source: 'pr' }) })).toBe('Pane · its PR');
    expect(fileOrigin({ attachment: attachment('plan', 'd', { addedBy: 'Pane', source: 'approval' }) })).toBe('from an approval');
    expect(fileOrigin({ attachment: attachment('mockup', 'e', { addedBy: 'Pane', source: 'opened' }) })).toBe('opened beside you');
  });

  it('adds the to-do an inherited file comes from', () => {
    expect(fileOrigin({ attachment: attachment('pr', 'f', { addedBy: 'implementer' }), from: { number: 14, relation: 'sub' } })).toBe('implementer · from T-14');
    expect(fileOrigin({ attachment: attachment('plan', 'g'), from: { number: 10, relation: 'parent' } })).toBe('planner · from T-10 (parent)');
  });
});
