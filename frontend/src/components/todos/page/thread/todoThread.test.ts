import { describe, expect, it } from 'vitest';
import type { TodoActivity } from '../../../../../../shared/types/todos';
import { buildTodoThread, commentAttachments, eventPhrase, imageAttachLabel, isImageFile, type TodoThreadApproval, type TodoThreadInput, type TodoThreadItem } from '../../../../../../shared/todoThread';

let nextId = 1;
let clock = 1_000;

function row(fields: Partial<TodoActivity> & Pick<TodoActivity, 'kind' | 'authorKind' | 'authorName'>): TodoActivity {
  const id = fields.id ?? nextId++;
  clock += 1_000;
  return { id, todoNumber: 12, body: fields.body ?? `row ${id}`, createdAt: fields.createdAt ?? clock, ...fields };
}

const event = (body: string, extra: Partial<TodoActivity> = {}) => row({ kind: 'event', authorKind: 'pane', authorName: 'Pane', body, ...extra });
const agent = (tab: string, name: string, body: string, extra: Partial<TodoActivity> = {}) => row({ kind: 'message', authorKind: 'agent', authorName: name, authorTab: tab, body, ...extra });
const person = (body: string, extra: Partial<TodoActivity> = {}) => row({ kind: 'message', authorKind: 'person', authorName: 'you', body, ...extra });

function input(activity: TodoActivity[], extra: Partial<TodoThreadInput> = {}): TodoThreadInput {
  return { activity, midTurnTabs: new Set(), approvals: [], ...extra };
}

function outline(items: readonly TodoThreadItem[]): string[] {
  return items.map((item) => {
    if (item.kind === 'run') return `run:${item.run.authorName}:${item.run.steps.length}`;
    if (item.kind === 'fold') return `fold:${item.fold.events.length}`;
    if (item.kind === 'approval') return `approval:${item.approval.id}`;
    if (item.kind === 'comment') return `comment:${item.comment.activity.authorKind}`;
    return item.attachedImage ? `image:${item.attachedImage}` : 'event';
  });
}

describe('buildTodoThread: events', () => {
  it('keeps one event as a line and folds two or more in a row', () => {
    const items = buildTodoThread(input([event('Created by you'), agent('p1', 'planner', 'Hi'), event('Started by the orchestrator'), event('Sub-to-do T-13 added: Bundle fonts'), event('Queued: devbox is busy')]));
    expect(outline(items)).toEqual(['event', 'run:planner:1', 'fold:3']);
    const fold = items[2];
    expect(fold.kind === 'fold' && fold.fold.summary).toBe('started by the orchestrator, sub-to-do T-13 added…');
  });

  it('names both events without an ellipsis when only two fold', () => {
    const items = buildTodoThread(input([event('Sub-to-do T-13 done: plan approved'), event('planner attached mockup: Receipt mock-up')]));
    expect(items[0].kind === 'fold' && items[0].fold.summary).toBe('sub-to-do T-13 done, planner attached mockup');
  });

  it('never folds an event tied to a waiting approval: the approval card shows in its place', () => {
    const started = event('Started by you');
    const asked = event('Asked you: Which currencies at launch?');
    const rows = [started, asked, event('Queued: devbox is busy')];
    const approval: TodoThreadApproval = { id: 'q11', qn: 'Q-11', question: 'Which currencies at launch?', state: 'waiting', createdAt: asked.createdAt };
    expect(outline(buildTodoThread(input(rows, { approvals: [approval] })))).toEqual(['event', 'approval:q11', 'event']);
    // Once answered, the event folds like any other and the card stays, by time.
    const answered = buildTodoThread(input(rows, { approvals: [{ ...approval, state: 'answered', answer: 'EUR and USD' }] }));
    expect(outline(answered)).toEqual(['fold:2', 'approval:q11', 'event']);
  });
});

describe('buildTodoThread: agent runs', () => {
  it('groups one tab’s messages and its own events into one card until another author speaks', () => {
    const rows = [
      agent('p1', 'planner', 'Reading the code.'),
      event('planner attached plan: Plan', { authorKind: 'agent', authorName: 'planner' }),
      agent('p1', 'planner', 'Plan written: three packages.\n\nMore detail.', { chatRef: { panelId: 'p1', messageId: 'm2' } }),
      agent('i1', 'implementer', 'Starting.'),
      agent('p1', 'planner', 'One more thing.'),
    ];
    const items = buildTodoThread(input(rows));
    expect(outline(items)).toEqual(['run:planner:3', 'run:implementer:1', 'run:planner:1']);
    const first = items[0].kind === 'run' ? items[0].run : null;
    expect(first).toMatchObject({ authorTab: 'p1', initial: 'P', state: 'finished', summary: 'Plan written: three packages.', chatRef: { panelId: 'p1', messageId: 'm2' }, replyTarget: rows[2].id });
  });

  it('keeps a run open across Pane’s events, which stay lines', () => {
    const items = buildTodoThread(input([agent('p1', 'planner', 'A'), event('Queued: busy'), agent('p1', 'planner', 'B')]));
    expect(outline(items)).toEqual(['run:planner:2', 'event']);
  });

  it('ends a run when the person comments between, and the next message starts a new card', () => {
    const items = buildTodoThread(input([agent('o1', 'orchestrator', 'Planning'), person('Keep the fonts in the repo', { deliveredAt: 5, toName: 'orchestrator' }), agent('o1', 'orchestrator', 'Noted')]));
    expect(outline(items)).toEqual(['run:orchestrator:1', 'comment:person', 'run:orchestrator:1']);
    const comment = items[1].kind === 'comment' ? items[1].comment : null;
    expect(comment?.delivery).toEqual({ delivered: true, toName: 'orchestrator' });
  });

  it('lets a message without a tab stand as its own card rather than join a run', () => {
    const items = buildTodoThread(input([agent('p1', 'planner', 'A'), row({ kind: 'message', authorKind: 'agent', authorName: 'planner', body: 'B' }), agent('p1', 'planner', 'C')]));
    expect(outline(items)).toEqual(['run:planner:1', 'run:planner:1', 'run:planner:1']);
  });

  it('reads Working only on the tab’s latest run while it is mid-turn', () => {
    const items = buildTodoThread(input([agent('i1', 'implementer', 'A'), person('hi'), agent('i1', 'implementer', 'B')], { midTurnTabs: new Set(['i1']) }));
    const states = items.flatMap((item) => (item.kind === 'run' ? [item.run.state] : []));
    expect(states).toEqual(['finished', 'working']);
  });

  it('reads who started a run from an event that records it', () => {
    const items = buildTodoThread(input([event('Assigned to implementer by orchestrator', { authorKind: 'agent', authorName: 'orchestrator' }), agent('i1', 'implementer', 'On it')]));
    const run = items.find((item) => item.kind === 'run');
    expect(run?.kind === 'run' && run.run.startedBy).toBe('orchestrator');
  });

  it('takes the first line of the latest message, without Markdown marks, as the summary', () => {
    const items = buildTodoThread(input([agent('p1', 'planner', 'Old'), agent('p1', 'planner', '\n## **Done**: plan attached\nrest')]));
    expect(items[0].kind === 'run' && items[0].run.summary).toBe('Done: plan attached');
  });
});

describe('buildTodoThread: approvals', () => {
  it('places an approval asked inside a run after that run’s card, and the run reads Waiting on you', () => {
    const a = agent('p1', 'planner', 'Need a call on currencies');
    const b = agent('p1', 'planner', 'Waiting for the answer');
    const approval: TodoThreadApproval = { id: 'q11', qn: 'Q-11', question: 'Currencies?', state: 'waiting', askerTab: 'p1', createdAt: a.createdAt + 500 };
    const items = buildTodoThread(input([a, b, event('Queued: busy')], { approvals: [approval], midTurnTabs: new Set(['p1']) }));
    expect(outline(items)).toEqual(['run:planner:2', 'approval:q11', 'event']);
    expect(items[0].kind === 'run' && items[0].run).toMatchObject({ state: 'waiting', waitingApprovalId: 'q11' });
  });

  it('puts an approval before everything asked later and after everything earlier', () => {
    const first = event('Created by you');
    const approval: TodoThreadApproval = { id: 'q1', question: 'Go?', state: 'answered', answer: 'Yes', createdAt: first.createdAt + 1 };
    const items = buildTodoThread(input([first, person('hello')], { approvals: [approval] }));
    expect(outline(items)).toEqual(['event', 'approval:q1', 'comment:person']);
  });
});

describe('buildTodoThread: replies', () => {
  it('nests the person’s reply and the agent’s threaded answer under the run card', () => {
    const plan = agent('p1', 'planner', 'Plan written');
    const reply = person('Use EUR only', { replyTo: plan.id, toTab: 'p1', toName: 'planner' });
    const answer = agent('p1', 'planner', 'Done: EUR only', { replyTo: reply.id });
    const later = agent('p1', 'planner', 'Next step');
    const items = buildTodoThread(input([plan, reply, answer, later]));
    expect(outline(items)).toEqual(['run:planner:2']);
    const run = items[0].kind === 'run' ? items[0].run : null;
    expect(run?.replies.map((entry) => entry.activity.id)).toEqual([reply.id, answer.id]);
    expect(run?.replies[0].delivery).toEqual({ delivered: false, toName: 'planner' });
    expect(run?.replies[1].delivery).toBeUndefined();
  });

  it('nests replies on a comment, and a reply to a reply, under that comment', () => {
    const comment = person('Looks good');
    const answer = agent('o1', 'orchestrator', 'Noted', { replyTo: comment.id });
    const again = person('Thanks', { replyTo: answer.id });
    const items = buildTodoThread(input([comment, answer, again]));
    expect(outline(items)).toEqual(['comment:person']);
    expect(items[0].kind === 'comment' && items[0].comment.replies.map((entry) => entry.activity.id)).toEqual([answer.id, again.id]);
  });

  it('shows a reply whose card fell outside the newest rows as its own card', () => {
    const items = buildTodoThread(input([person('Orphan', { replyTo: 99_999 })]));
    expect(outline(items)).toEqual(['comment:person']);
  });

  it('keeps the requester’s messages as comment cards without a delivery line', () => {
    const items = buildTodoThread(input([row({ kind: 'message', authorKind: 'requester', authorName: 'Billing orchestrator', body: 'EUR first' })]));
    expect(items[0].kind === 'comment' && items[0].comment.delivery).toBeUndefined();
  });
});

describe('buildTodoThread: a long thread', () => {
  it('keeps 500 rows (mixed events, 40 runs, 60 comments) under 150 top-level items', () => {
    const rows: TodoActivity[] = [];
    let comments = 0;
    for (let segment = 0; segment < 40; segment += 1) {
      const tab = `tab-${segment % 3}`;
      const name = ['planner', 'implementer', 'qa'][segment % 3];
      rows.push(event('Pane reminded the orchestrator'), event('Queued: devbox is busy'), event('Load came down: resumed'));
      for (let message = 0; message < 6; message += 1) rows.push(agent(tab, name, `Step ${message}`));
      rows.push(event(`${name} attached findings: QA findings`, { authorKind: 'agent', authorName: name }));
      rows.push(event(`${name} attached plan: Plan ${segment}`, { authorKind: 'agent', authorName: name }));
      const here = segment % 2 === 0 ? 1 : 2;
      for (let index = 0; index < here; index += 1) {
        rows.push(person(`Comment ${comments}`));
        comments += 1;
      }
    }
    expect(rows).toHaveLength(500);
    expect(comments).toBe(60);
    const started = performance.now();
    const items = buildTodoThread(input(rows, { midTurnTabs: new Set(['tab-0']) }));
    const took = performance.now() - started;
    expect(items.filter((item) => item.kind === 'run')).toHaveLength(40);
    expect(items.filter((item) => item.kind === 'comment')).toHaveLength(60);
    expect(items.length).toBeLessThan(150);
    expect(took).toBeLessThan(100);
  });
});

describe('eventPhrase', () => {
  it('shortens an event to its first clause, lower-cased unless it starts with a ref', () => {
    expect(eventPhrase('Started by the orchestrator')).toBe('started by the orchestrator');
    expect(eventPhrase('T-13 done: fonts')).toBe('T-13 done');
    expect(eventPhrase('Pane attached pr: PR #7')).toBe('Pane attached pr');
    expect(eventPhrase('A very long event line that keeps going well past the width a fold label can hold')).toMatch(/…$/u);
  });
});

describe('buildTodoThread: attached images', () => {
  it('never folds an image attach event, and keeps an agent’s out of its run so it shows while the run is closed', () => {
    const items = buildTodoThread(input([
      event('Created by you'),
      agent('p1', 'planner', 'Taking a screenshot'),
      event('planner attached image: shot.png', { authorKind: 'agent', authorName: 'planner' }),
      event('planner attached plan: Plan', { authorKind: 'agent', authorName: 'planner' }),
      agent('p1', 'planner', 'Done'),
      event('Queued: busy'),
      event('You attached image: mock.png', { authorKind: 'person', authorName: 'you' }),
      event('Load came down: resumed'),
    ]));
    expect(outline(items)).toEqual(['event', 'run:planner:3', 'image:shot.png', 'event', 'image:mock.png', 'event']);
  });

  it('folds an image attach event a comment names, since the comment shows the image', () => {
    const items = buildTodoThread(input([
      event('You attached image: paste-1.png', { authorKind: 'person', authorName: 'you' }),
      event('Queued: busy'),
      person('Look at this\n\nAttached paste-1.png: /Users/me/.pane/images/paste-1.png'),
    ]));
    expect(outline(items)).toEqual(['fold:2', 'comment:person']);
  });
});

describe('commentAttachments', () => {
  it('splits the composer’s trailing Attached lines into images and files, keeping the words', () => {
    const body = 'Look at these\n\nAttached shot.png: /tmp/a/shot.png\n\nAttached notes.txt: /tmp/a/notes.txt\n\nAttached logo.SVG: C:\\work\\logo.SVG';
    expect(commentAttachments(body)).toEqual({
      text: 'Look at these',
      images: [{ name: 'shot.png', path: '/tmp/a/shot.png' }, { name: 'logo.SVG', path: 'C:\\work\\logo.SVG' }],
      files: [{ name: 'notes.txt', path: '/tmp/a/notes.txt' }],
    });
  });

  it('leaves an Attached line in the middle of the words, or one without a full path, as text', () => {
    const body = 'Attached a.png: /x/a.png\n\nthen more words\n\nAttached b.png: relative/b.png';
    expect(commentAttachments(body)).toEqual({ text: body, images: [], files: [] });
  });

  it('reads a body that is only attachments as no words', () => {
    expect(commentAttachments('Attached a.gif: /x/a.gif')).toEqual({ text: '', images: [{ name: 'a.gif', path: '/x/a.gif' }], files: [] });
  });
});

describe('image helpers', () => {
  it('knows image files by extension, as Pane attaches them', () => {
    expect(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg'].every(isImageFile)).toBe(true);
    expect(['a.pdf', 'b.html', 'png', 'c.png.txt'].some(isImageFile)).toBe(false);
  });

  it('reads the label from an image attach event only', () => {
    expect(imageAttachLabel('planner attached image: shot.png')).toBe('shot.png');
    expect(imageAttachLabel('You attached image: Receipt mock (opened beside you)')).toBe('Receipt mock');
    expect(imageAttachLabel('planner attached plan: Plan')).toBeUndefined();
  });
});
