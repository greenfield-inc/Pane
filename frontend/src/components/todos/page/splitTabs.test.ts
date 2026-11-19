import { describe, expect, it } from 'vitest';
import type { TodoAttachment, TodoAttachmentGroup, TodoAttachmentKind } from '../../../../../shared/types/todos';
import {
  NARROW_TODO_AREA_PX,
  attachmentTabs,
  initialSplit,
  everyTabClosed,
  splitAttachmentItems,
  splitFileItems,
  splitHasTabs,
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
  return state.items.map((item) => (item.kind === 'attachment' ? item.attachment.label : item.kind === 'overview' ? 'Overview' : item.label));
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
    // An image tab is gone once closed: it isn't remembered as closed.
    expect(closed.closed).toEqual([]);
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

describe('the Session Overview tab (round 8, T-4)', () => {
  const plan = attachment('plan', 1, 12, 'plan');
  const plan2 = attachment('plan', 2, 12, 'plan 2');
  const pr = attachment('pr', 3, 12, 'pr');
  const findings = attachment('findings', 4, 12, 'findings');

  it('sits after the plan tabs', () => {
    expect(labels(initialSplit([own(pr, plan, plan2, findings)], false, 's-12'))).toEqual(['plan', 'plan 2', 'Overview', 'pr', 'findings']);
  });

  it('is first without a plan, but the first attachment stays the default tab', () => {
    const state = initialSplit([own(findings, pr)], false, 's-12');
    expect(labels(state)).toEqual(['Overview', 'pr', 'findings']);
    expect(labels(state)[state.active]).toBe('pr');
  });

  it('is never the default selection when a plan exists', () => {
    const state = initialSplit([own(pr, plan)], false, 's-12');
    expect(labels(state)[state.active]).toBe('plan');
  });

  it('is the one tab, and selected, when nothing is attached', () => {
    const state = initialSplit([own()], false, 's-12');
    expect(labels(state)).toEqual(['Overview']);
    expect(state.active).toBe(0);
  });

  it('is left out without a Session here', () => {
    expect(labels(initialSplit([own(plan)], false, null))).toEqual(['plan']);
    expect(labels(initialSplit([own(plan)], false))).toEqual(['plan']);
  });

  it('has one key per Session, and opening it again shows its tab', () => {
    expect(splitItemKey({ kind: 'overview', sessionId: 's-12' })).toBe('overview:s-12');
    const state = initialSplit([own(plan, pr)], false, 's-12');
    const opened = todoSplitReducer(state, { type: 'open', item: { kind: 'overview', sessionId: 's-12' } });
    expect(opened.items).toHaveLength(3);
    expect(labels(opened)[opened.active]).toBe('Overview');
  });

  it('sync adds it when the Session arrives, drops it when it goes, and keeps it shown across attachment changes', () => {
    const before = initialSplit([own(plan, pr)], false);
    const arrived = todoSplitReducer(before, { type: 'sync', groups: [own(plan, pr)], overview: 's-12' });
    expect(labels(arrived)).toEqual(['plan', 'Overview', 'pr']);
    expect(labels(arrived)[arrived.active]).toBe('plan');
    const onOverview = todoSplitReducer(arrived, { type: 'activate', index: 1 });
    const attached = todoSplitReducer(onOverview, { type: 'sync', groups: [own(plan, pr, findings)], overview: 's-12' });
    expect(labels(attached)[attached.active]).toBe('Overview');
    const gone = todoSplitReducer(attached, { type: 'sync', groups: [own(plan, pr, findings)], overview: null });
    expect(labels(gone)).toEqual(['plan', 'pr', 'findings']);
    expect(labels(gone)[gone.active]).toBe('plan');
  });

  it('closes with ✕ like any tab, and stays closed when the Session syncs again', () => {
    const state = initialSplit([own(plan)], false, 's-12');
    const closed = todoSplitReducer(state, { type: 'close', index: 1 });
    expect(labels(closed)).toEqual(['plan']);
    expect(closed.closed).toEqual(['overview:s-12']);
    expect(labels(todoSplitReducer(closed, { type: 'sync', groups: [own(plan)], overview: 's-12' }))).toEqual(['plan']);
  });

  it('attachment counts leave it out', () => {
    expect(splitAttachmentItems(initialSplit([own(plan, pr)], false, 's-12').items).map((item) => item.kind)).toEqual(['attachment', 'attachment']);
  });
});

describe('closing and reopening tabs (T-25)', () => {
  const plan = attachment('plan', 1, 12, 'plan');
  const pr = attachment('pr', 2, 12, 'pr');
  const findings = attachment('findings', 3, 12, 'findings');
  const subDoc = attachment('doc', 4, 14, 'sub doc');
  const groups: TodoAttachmentGroup[] = [own(plan, pr, findings), { from: { number: 14, relation: 'sub' }, attachments: [subDoc] }];
  const base = initialSplit(groups, false, 's-12');

  it('closes an attachment tab and remembers its key; the next tab is shown', () => {
    const onPr = todoSplitReducer(base, { type: 'activate', index: 2 });
    const closed = todoSplitReducer(onPr, { type: 'close', index: 2 });
    expect(labels(closed)).toEqual(['plan', 'Overview', 'findings']);
    expect(closed.closed).toEqual([`attachment:${pr.id}`]);
    expect(labels(closed)[closed.active]).toBe('findings');
    expect(closed.hidden).toBe(false);
  });

  it('closing a tab before the shown one keeps the shown one', () => {
    const onFindings = todoSplitReducer(base, { type: 'activate', index: 3 });
    const closed = todoSplitReducer(onFindings, { type: 'close', index: 0 });
    expect(labels(closed)[closed.active]).toBe('findings');
  });

  it('closing the last tab shows the one before it', () => {
    const onFindings = todoSplitReducer(base, { type: 'activate', index: 3 });
    const closed = todoSplitReducer(onFindings, { type: 'close', index: 3 });
    expect(labels(closed)[closed.active]).toBe('pr');
  });

  it('closed tabs stay closed across syncs; a tab attached later shows as usual', () => {
    const closed = todoSplitReducer(base, { type: 'close', index: 2 });
    const later = attachment('doc', 9, 12, 'later');
    const synced = todoSplitReducer(closed, { type: 'sync', groups: [own(plan, pr, findings, later)], overview: 's-12' });
    expect(labels(synced)).toEqual(['plan', 'Overview', 'findings', 'later']);
  });

  it('starts with the remembered closed tabs left out', () => {
    const state = initialSplit(groups, false, 's-12', [`attachment:${plan.id}`, 'overview:s-12']);
    expect(labels(state)).toEqual(['pr', 'findings']);
    expect(labels(state)[state.active]).toBe('pr');
  });

  it('closing every tab hides the split', () => {
    let state = base;
    while (state.items.length > 0) state = todoSplitReducer(state, { type: 'close', index: state.active });
    expect(state.hidden).toBe(true);
    expect(state.closed).toHaveLength(4);
    expect(splitHasTabs(state)).toBe(true);
    expect(everyTabClosed(state)).toBe(true);
  });

  it('opens hidden when every tab was closed', () => {
    const state = initialSplit([own(plan)], false, null, [`attachment:${plan.id}`]);
    expect(state.items).toEqual([]);
    expect(state.hidden).toBe(true);
  });

  it('showing the split with every tab closed reopens the default tab and forgets only its mark', () => {
    let state = base;
    while (state.items.length > 0) state = todoSplitReducer(state, { type: 'close', index: state.active });
    const shown = todoSplitReducer(state, { type: 'set-hidden', hidden: false });
    expect(labels(shown)).toEqual(['plan']);
    expect(shown.hidden).toBe(false);
    expect(shown.closed).not.toContain(`attachment:${plan.id}`);
    expect(shown.closed).toHaveLength(3);
    const toggled = todoSplitReducer(state, { type: 'toggle-hidden' });
    expect(labels(toggled)).toEqual(['plan']);
    expect(toggled.hidden).toBe(false);
  });

  it('opening a closed attachment reopens its tab in its place and forgets its mark', () => {
    const closed = todoSplitReducer(todoSplitReducer(base, { type: 'close', index: 2 }), { type: 'set-hidden', hidden: true });
    const opened = todoSplitReducer(closed, { type: 'open', item: { kind: 'attachment', attachment: pr } });
    expect(labels(opened)).toEqual(['plan', 'Overview', 'pr', 'findings']);
    expect(labels(opened)[opened.active]).toBe('pr');
    expect(opened.closed).toEqual([]);
    expect(opened.hidden).toBe(false);
  });

  it('opening the closed Overview reopens it', () => {
    const closed = todoSplitReducer(base, { type: 'close', index: 1 });
    const opened = todoSplitReducer(closed, { type: 'open', item: { kind: 'overview', sessionId: 's-12' } });
    expect(labels(opened)[opened.active]).toBe('Overview');
    expect(opened.closed).toEqual([]);
  });

  it('+ Attach’s reveal reopens a closed tab with that target', () => {
    const closed = todoSplitReducer(base, { type: 'close', index: 3 });
    const revealed = todoSplitReducer(closed, { type: 'reveal', target: findings.target });
    expect(labels(revealed)[revealed.active]).toBe('findings');
    expect(revealed.closed).toEqual([]);
  });

  it('a sub-to-do’s file opens as an extra tab, kept across syncs, and ✕ drops it without remembering it', () => {
    const opened = todoSplitReducer(base, { type: 'open', item: { kind: 'attachment', attachment: subDoc, from: 14 } });
    expect(labels(opened).at(-1)).toBe('sub doc');
    const synced = todoSplitReducer(opened, { type: 'sync', groups, overview: 's-12' });
    expect(labels(synced)[synced.active]).toBe('sub doc');
    const closed = todoSplitReducer(synced, { type: 'close', index: synced.active });
    expect(labels(closed)).toEqual(['plan', 'Overview', 'pr', 'findings']);
    expect(closed.closed).toEqual([]);
    const detached = todoSplitReducer(opened, { type: 'sync', groups: [own(plan, pr, findings)], overview: 's-12' });
    expect(labels(detached)).toEqual(['plan', 'Overview', 'pr', 'findings']);
  });

  it('file tabs count every file, closed or not, and never the Overview', () => {
    const closed = todoSplitReducer(base, { type: 'close', index: 0 });
    expect(splitFileItems(closed).map(splitItemKey)).toEqual([plan, pr, findings].map((a) => `attachment:${a.id}`));
  });
});

describe('the To-do tab where no split is available (T-38, D-448)', () => {
  const plan = attachment('plan', 1, 12, 'cover-sheet.html');
  const doc = attachment('doc', 2, 12, 'p5-p8.html');
  const base = initialSplit([own(plan, doc)], true);

  it('a to-do opens on its To-do tab', () => {
    expect(base.todoShown).toBe(true);
  });

  it('picking or opening a file shows its tab; the To-do tab comes back with show-todo', () => {
    const picked = todoSplitReducer(base, { type: 'activate', index: 1 });
    expect([picked.todoShown, labels(picked)[picked.active]]).toEqual([false, 'p5-p8.html']);
    const opened = todoSplitReducer(base, { type: 'open', item: { kind: 'attachment', attachment: plan } });
    expect([opened.todoShown, labels(opened)[opened.active]]).toEqual([false, 'cover-sheet.html']);
    const back = todoSplitReducer(picked, { type: 'show-todo' });
    expect([back.todoShown, labels(back)[back.active]]).toEqual([true, 'p5-p8.html']);
  });

  it('activating the tab already selected under the To-do tab shows it, and un-hides the split', () => {
    const picked = todoSplitReducer(base, { type: 'activate', index: base.active });
    expect([picked.todoShown, picked.hidden]).toEqual([false, false]);
  });

  it('arrows walk To-do, then each file, wrapping round', () => {
    const steps = [1, 1, 1, -1] as const;
    const seen: string[] = [];
    let state = base;
    for (const delta of steps) {
      state = todoSplitReducer(state, { type: 'step', delta, withTodo: true });
      seen.push(state.todoShown ? 'To-do' : labels(state)[state.active]);
    }
    expect(seen).toEqual(['cover-sheet.html', 'p5-p8.html', 'To-do', 'p5-p8.html']);
  });

  it('closing the last file goes back to the To-do tab', () => {
    const shown = todoSplitReducer(base, { type: 'activate', index: 0 });
    const one = todoSplitReducer(shown, { type: 'close', index: 0 });
    expect(one.todoShown).toBe(false);
    const none = todoSplitReducer(one, { type: 'close', index: 0 });
    expect(none.todoShown).toBe(true);
  });

  it('hiding the split leaves the To-do tab selected for the one-column layout', () => {
    const shown = todoSplitReducer(base, { type: 'activate', index: 1 });
    expect(todoSplitReducer(shown, { type: 'set-hidden', hidden: true }).todoShown).toBe(true);
    expect(todoSplitReducer(shown, { type: 'toggle-hidden' }).todoShown).toBe(true);
    expect(todoSplitReducer(base, { type: 'set-hidden', hidden: false }).todoShown).toBe(false);
  });

  it('an attached file arriving shows its tab', () => {
    const waiting = todoSplitReducer(base, { type: 'reveal', target: '/tmp/new.html' });
    const fresh = { ...attachment('doc', 3, 12, 'new'), target: '/tmp/new.html' };
    const arrived = todoSplitReducer(waiting, { type: 'sync', groups: [own(plan, doc, fresh)] });
    expect([arrived.todoShown, labels(arrived)[arrived.active]]).toEqual([false, 'new']);
  });
});
