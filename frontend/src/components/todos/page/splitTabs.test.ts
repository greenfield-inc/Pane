import { describe, expect, it } from 'vitest';
import type { TodoAttachment, TodoAttachmentGroup, TodoAttachmentKind } from '../../../../../shared/types/todos';
import {
  NARROW_TODO_AREA_PX,
  attachmentTabs,
  initialSplit,
  splitItemKey,
  startsHidden,
  todoSplitReducer,
  type TodoSplitState,
} from './splitTabs';

let nextId = 1;
function attachment(kind: TodoAttachmentKind, addedAt: number, todoNumber = 12, label: string = kind): TodoAttachment {
  const id = nextId++;
  return { id, todoNumber, kind, target: `/tmp/${label}-${id}.html`, label, addedBy: 'planner', source: 'attached', addedAt };
}

function own(...attachments: TodoAttachment[]): TodoAttachmentGroup {
  return { attachments };
}

function labels(state: TodoSplitState): string[] {
  return state.items.map((item) => (item.kind === 'attachment' ? item.attachment.label : item.label));
}

describe('attachmentTabs', () => {
  it('orders tabs plan, design and mock-ups, PRs, findings, decisions, docs, images, links; each in attach order', () => {
    const groups = [own(
      attachment('link', 1, 12, 'link'),
      attachment('decision', 2, 12, 'decisions'),
      attachment('pr', 3, 12, 'pr'),
      attachment('mockup', 4, 12, 'mock-up 2'),
      attachment('design', 3.5, 12, 'design'),
      attachment('findings', 5, 12, 'findings'),
      attachment('image', 6, 12, 'image'),
      attachment('doc', 7, 12, 'doc'),
      attachment('plan', 8, 12, 'plan'),
      attachment('mockup', 1, 12, 'mock-up 1'),
    )];
    expect(attachmentTabs(groups).map((item) => (item.kind === 'attachment' ? item.attachment.label : ''))).toEqual([
      'plan', 'mock-up 1', 'design', 'mock-up 2', 'pr', 'findings', 'decisions', 'doc', 'image', 'link',
    ]);
  });

  it('a sub-to-do shows its parent’s attachments, marked from the parent; a sub-to-do’s own are not a parent’s tabs', () => {
    const parentPlan = attachment('plan', 1, 12, 'parent plan');
    const groups: TodoAttachmentGroup[] = [
      own(attachment('pr', 5, 14, 'my pr')),
      { from: { number: 12, relation: 'parent' }, attachments: [parentPlan] },
      { from: { number: 15, relation: 'sub' }, attachments: [attachment('doc', 2, 15, 'sub doc')] },
    ];
    const tabs = attachmentTabs(groups);
    expect(tabs.map((item) => (item.kind === 'attachment' ? [item.attachment.label, item.from] : []))).toEqual([
      ['parent plan', 12],
      ['my pr', undefined],
    ]);
  });

  it('leaves out detached attachments', () => {
    const gone = { ...attachment('plan', 1), removedAt: 2 };
    expect(attachmentTabs([own(gone)])).toEqual([]);
  });
});

describe('initialSplit', () => {
  it('selects the plan when there is one', () => {
    const state = initialSplit([own(attachment('pr', 1, 12, 'pr'), attachment('plan', 2, 12, 'plan'))], false);
    expect(labels(state)[state.active]).toBe('plan');
    expect(state.hidden).toBe(false);
  });

  it('otherwise selects the first attachment in tab order', () => {
    const state = initialSplit([own(attachment('doc', 1, 12, 'doc'), attachment('findings', 2, 12, 'findings'))], false);
    expect(labels(state)[state.active]).toBe('findings');
  });

  it('has no tabs with no attachments', () => {
    const state = initialSplit([own()], false);
    expect(state.items).toEqual([]);
  });

  it('starts hidden when asked', () => {
    expect(initialSplit([own(attachment('plan', 1))], true).hidden).toBe(true);
  });
});

describe('todoSplitReducer', () => {
  const plan = attachment('plan', 1, 12, 'plan');
  const pr = attachment('pr', 2, 12, 'pr');
  const findings = attachment('findings', 3, 12, 'findings');
  const base = initialSplit([own(plan, pr, findings)], false);

  it('activates a tab, and steps with ←/→ wrapping round', () => {
    const second = todoSplitReducer(base, { type: 'activate', index: 1 });
    expect(second.active).toBe(1);
    expect(todoSplitReducer(base, { type: 'step', delta: -1 }).active).toBe(2);
    expect(todoSplitReducer({ ...base, active: 2 }, { type: 'step', delta: 1 }).active).toBe(0);
    expect(todoSplitReducer(base, { type: 'activate', index: 9 })).toBe(base);
  });

  it('opening an attachment shows its tab and shows a hidden split', () => {
    const hidden = todoSplitReducer(base, { type: 'set-hidden', hidden: true });
    expect(hidden.hidden).toBe(true);
    const opened = todoSplitReducer(hidden, { type: 'open', item: { kind: 'attachment', attachment: findings } });
    expect(opened.hidden).toBe(false);
    expect(labels(opened)[opened.active]).toBe('findings');
    expect(opened.items).toHaveLength(3);
  });

  it('opening a description image adds its own tab at the end, which ✕ closes', () => {
    const opened = todoSplitReducer(base, { type: 'open', item: { kind: 'image', src: 'https://example.test/a.png', label: 'a.png' } });
    expect(opened.items.map(splitItemKey).at(-1)).toBe('image:https://example.test/a.png');
    expect(opened.active).toBe(3);
    const closed = todoSplitReducer(opened, { type: 'close', index: 3 });
    expect(closed.items).toHaveLength(3);
    expect(closed.active).toBe(2);
    // Attachment tabs don't close: they leave by Detach.
    expect(todoSplitReducer(base, { type: 'close', index: 0 })).toBe(base);
  });

  it('keeps the tab shown when attachments change, and keeps images', () => {
    const onPr = todoSplitReducer(base, { type: 'activate', index: 1 });
    const withImage = todoSplitReducer(onPr, { type: 'open', item: { kind: 'image', src: 'x.png', label: 'x' } });
    const shownPr = todoSplitReducer(withImage, { type: 'activate', index: 1 });
    const newer = attachment('plan', 9, 12, 'plan 2');
    const synced = todoSplitReducer(shownPr, { type: 'sync', groups: [own(plan, pr, findings, newer)] });
    expect(labels(synced)).toEqual(['plan', 'plan 2', 'pr', 'findings', 'x']);
    expect(labels(synced)[synced.active]).toBe('pr');
  });

  it('when the shown attachment is detached, shows the default tab', () => {
    const onPr = todoSplitReducer(base, { type: 'activate', index: 1 });
    const synced = todoSplitReducer(onPr, { type: 'sync', groups: [own(plan, findings)] });
    expect(labels(synced)[synced.active]).toBe('plan');
  });

  it('+ Attach: the new attachment’s tab is selected, and the split shows, once it arrives', () => {
    const hidden = todoSplitReducer(base, { type: 'set-hidden', hidden: true });
    const waiting = todoSplitReducer(hidden, { type: 'reveal', target: '/tmp/new.md' });
    const added = { ...attachment('doc', 10, 12, 'new'), target: '/tmp/new.md' };
    const synced = todoSplitReducer(waiting, { type: 'sync', groups: [own(plan, pr, findings, added)] });
    expect(labels(synced)[synced.active]).toBe('new');
    expect(synced.hidden).toBe(false);
    expect(synced.reveal).toBeNull();
  });

  it('+ Attach that arrived before the reveal selects it at once', () => {
    const added = { ...attachment('doc', 11, 12, 'early'), target: '/tmp/early.md' };
    const synced = todoSplitReducer(todoSplitReducer(base, { type: 'set-hidden', hidden: true }), { type: 'sync', groups: [own(plan, pr, findings, added)] });
    const revealed = todoSplitReducer(synced, { type: 'reveal', target: '/tmp/early.md' });
    expect(labels(revealed)[revealed.active]).toBe('early');
    expect(revealed.hidden).toBe(false);
    expect(revealed.reveal).toBeNull();
  });

  it('attaching to a to-do with no attachments opens the split on it', () => {
    const empty = initialSplit([own()], false);
    const waiting = todoSplitReducer(empty, { type: 'reveal', target: 'https://example.test' });
    const link = { ...attachment('link', 1, 12, 'link'), target: 'https://example.test' };
    const synced = todoSplitReducer(waiting, { type: 'sync', groups: [own(link)] });
    expect(synced.items).toHaveLength(1);
    expect(synced.active).toBe(0);
    expect(synced.hidden).toBe(false);
  });

  it('toggles hidden', () => {
    expect(todoSplitReducer(base, { type: 'toggle-hidden' }).hidden).toBe(true);
    expect(todoSplitReducer(todoSplitReducer(base, { type: 'toggle-hidden' }), { type: 'toggle-hidden' }).hidden).toBe(false);
  });
});

describe('startsHidden (the narrow rule)', () => {
  it('opens hidden under a 1,000 px to-do area whatever was remembered', () => {
    expect(startsHidden(false, NARROW_TODO_AREA_PX - 1)).toBe(true);
    expect(startsHidden(false, 900)).toBe(true);
  });

  it('keeps the remembered choice in a wide area', () => {
    expect(startsHidden(false, NARROW_TODO_AREA_PX)).toBe(false);
    expect(startsHidden(true, 1400)).toBe(true);
  });
});
