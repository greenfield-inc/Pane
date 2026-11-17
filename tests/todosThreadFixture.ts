import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';
import type { TodoActivity, TodoDetail, TodoListRow, TodoRecord, TodosSnapshot } from '../shared/types/todos';

const MIN = 60_000;

function record(number: number, title: string, extra: Partial<TodoRecord> = {}): TodoRecord {
  const now = Date.now();
  return {
    number, ref: `T-${number}`, sessionId: 'sess-billing', parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'orchestrator', name: 'Billing rewrite orchestrator', sessionId: 'sess-req' }, projectId: 1, agent: 'claude', assignee: null,
    createdBy: 'orchestrator', createdAt: now - 180 * MIN, startedAt: now - 180 * MIN, updatedAt: now, acceptedAt: null, closedAt: null,
    lastProgressAt: now, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null,
    workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null, ...extra,
  };
}

const sub13: TodoListRow = { todo: record(13, 'Bundle the fonts', { parentNumber: 12, state: 'done' }), status: { status: 'done', reason: '' }, machine: 'devbox' };
const sub14: TodoListRow = {
  todo: record(14, 'Attach PDF to the receipt email', { parentNumber: 12, assignee: { panelId: 'impl', paneId: 'pane-impl', name: 'implementer' } }),
  status: { status: 'working', reason: '' }, machine: 'devbox', agentId: 'codex',
};

/** The prototype's T-12 thread: folds, a finished planner run, a comment with a reply, a working implementer run with your reply, events and a waiting approval. */
function prototypeActivity(): TodoActivity[] {
  const now = Date.now();
  let id = 100;
  const rows: TodoActivity[] = [];
  const add = (minutesAgo: number, fields: Partial<TodoActivity> & Pick<TodoActivity, 'kind' | 'authorKind' | 'authorName' | 'body'>) => {
    const row: TodoActivity = { id: id++, todoNumber: 12, createdAt: now - minutesAgo * MIN, ...fields };
    rows.push(row);
    return row;
  };
  add(181, { kind: 'event', authorKind: 'agent', authorName: 'Billing rewrite orchestrator', body: 'Billing rewrite orchestrator created this to-do' });
  add(180, { kind: 'event', authorKind: 'pane', authorName: 'Pane', body: 'Started its own Session and orchestrator' });
  add(179, { kind: 'event', authorKind: 'agent', authorName: 'orchestrator', body: 'orchestrator added sub-to-dos T-13 and T-14' });
  add(178, { kind: 'event', authorKind: 'agent', authorName: 'orchestrator', body: 'Assigned to planner by orchestrator' });
  add(130, { kind: 'message', authorKind: 'agent', authorName: 'planner', authorTab: 'plan', body: 'Reading the billing code and the receipt email template.' });
  add(125, { kind: 'event', authorKind: 'agent', authorName: 'planner', body: 'planner attached plan: Plan' });
  add(124, { kind: 'event', authorKind: 'agent', authorName: 'planner', body: 'planner attached decision: Decisions' });
  add(122, { kind: 'event', authorKind: 'agent', authorName: 'planner', body: 'planner asked the requester “EUR only?”, who passed it to you' });
  add(120, { kind: 'message', authorKind: 'agent', authorName: 'planner', authorTab: 'plan', chatRef: { panelId: 'plan', messageId: 'm1' }, body: 'Plan written: three packages (render, store, email). Attached the plan and decisions.\n\nThree packages, **P1 render**, **P2 store**, **P3 email**. Fonts stay in the repo (D-1). One question is open: currencies at launch.' });
  const comment = add(60, { kind: 'message', authorKind: 'person', authorName: 'you', body: 'Looks good. Keep the fonts in the repo, not a CDN.', toTab: 'orch', toName: 'orchestrator', deliveredAt: now - 59 * MIN });
  add(58, { kind: 'message', authorKind: 'agent', authorName: 'orchestrator', authorTab: 'orch', replyTo: comment.id, body: 'Noted. T-13 bundles them in the repo; the implementer picks them up from there.' });
  add(55, { kind: 'event', authorKind: 'pane', authorName: 'Pane', body: 'Sub-to-do T-13 done: Bundle the fonts' });
  add(52, { kind: 'event', authorKind: 'agent', authorName: 'planner', body: 'planner attached mockup: Receipt mock-up' });
  add(45, { kind: 'event', authorKind: 'agent', authorName: 'orchestrator', body: 'Assigned to implementer by orchestrator' });
  const impl = add(40, { kind: 'message', authorKind: 'agent', authorName: 'implementer', authorTab: 'impl', chatRef: { panelId: 'impl' }, body: 'Rendering works locally; wiring the PDF into the receipt email. Opened PR #7.' });
  add(39, { kind: 'event', authorKind: 'pane', authorName: 'Pane', body: 'Pane attached pr: PR #7 (from the implementer’s Pane)' });
  add(30, { kind: 'message', authorKind: 'person', authorName: 'you', replyTo: impl.id, toTab: 'impl', toName: 'implementer', body: 'Use the bundled fonts only, no system fallback.' });
  add(20, { kind: 'event', authorKind: 'agent', authorName: 'qa', body: 'qa attached findings: QA findings' });
  add(5, { kind: 'event', authorKind: 'pane', authorName: 'Pane', body: 'Asked you: Which currencies must the PDF support at launch?' });
  return rows;
}

/** 500 rows: mixed events, 40 runs (6 messages each), 60 comments. */
function longActivity(): TodoActivity[] {
  const now = Date.now();
  const rows: TodoActivity[] = [];
  let id = 1;
  let at = now - 600 * MIN;
  const add = (fields: Partial<TodoActivity> & Pick<TodoActivity, 'kind' | 'authorKind' | 'authorName' | 'body'>) => {
    at += 60_000;
    rows.push({ id: id++, todoNumber: 12, createdAt: at, ...fields });
  };
  const names = ['planner', 'implementer', 'qa'];
  const tabs = ['plan', 'impl', 'qa'];
  let comments = 0;
  for (let segment = 0; segment < 40; segment += 1) {
    const name = names[segment % 3];
    add({ kind: 'event', authorKind: 'pane', authorName: 'Pane', body: 'Pane reminded the orchestrator to attach its plan' });
    add({ kind: 'event', authorKind: 'pane', authorName: 'Pane', body: 'Queued: devbox is busy · starts when load comes down' });
    add({ kind: 'event', authorKind: 'pane', authorName: 'Pane', body: 'Load came down: resumed in the same conversations' });
    for (let message = 0; message < 6; message += 1) {
      add({ kind: 'message', authorKind: 'agent', authorName: name, authorTab: tabs[segment % 3], body: `Step ${message + 1} of segment ${segment + 1}: **read**, changed and checked.\n\n- one\n- two\n\nA longer paragraph to give Markdown real work, with \`code\` and a [link](https://example.com).` });
    }
    add({ kind: 'event', authorKind: 'agent', authorName: name, body: `${name} attached findings: QA findings` });
    add({ kind: 'event', authorKind: 'agent', authorName: name, body: `${name} attached plan: Plan` });
    for (let index = 0; index < (segment % 2 === 0 ? 1 : 2); index += 1) {
      add({ kind: 'message', authorKind: 'person', authorName: 'you', toName: 'orchestrator', deliveredAt: at, body: `Comment ${++comments}: keep going.` });
    }
  }
  return rows;
}

export type FixtureKind = 'prototype' | 'long';

/** One fixture: the list, T-12's page and the approval queue. */
export interface TodoFixtures { snapshot: TodosSnapshot; detail: TodoDetail; notify: NotifySnapshot }

export function todoFixtures(kind: FixtureKind): TodoFixtures {
  const now = Date.now();
  const top = record(12, 'Invoice PDFs', {
    summary: 'Render every paid invoice as a PDF and attach it to the receipt email. Customers have asked for this since March.',
    doneWhen: [{ text: 'A paid invoice has a PDF within 10 s', met: true }, { text: 'The receipt email carries it', met: false }, { text: 'Totals match the invoice to the cent', met: false }],
  });
  const row: TodoListRow = {
    todo: top, machine: 'devbox', sessionName: 'Billing rewrite', projectName: 'billing', agentId: 'claude', subCounts: { done: 1, total: 2 },
    status: { status: 'waiting', reason: 'Q-11 · Which currencies must the PDF support at launch?', waitingApprovalId: 'q11', waitingQn: 'Q-11', waitingQuestion: 'Which currencies must the PDF support at launch?', waitingCount: 1 },
  };
  const attachment = (id: number, kind: 'plan' | 'decision' | 'mockup' | 'pr' | 'findings', label: string, target: string, addedBy: string) => ({ id, todoNumber: 12, kind, target, label, addedBy, source: 'attached' as const, addedAt: now - 100 * MIN, machine: 'devbox' });
  const detail: TodoDetail = {
    ...row,
    subTodos: [sub13, sub14],
    attachments: [{ attachments: [
      attachment(1, 'plan', 'Plan', '/tmp/plan.html', 'planner'), attachment(2, 'decision', 'Decisions', '/tmp/decisions.html', 'planner'),
      attachment(3, 'mockup', 'Receipt mock-up', '/tmp/receipt.png', 'planner'), attachment(4, 'pr', 'PR #7', 'https://github.com/acme/billing/pull/7', 'Pane'),
      attachment(5, 'findings', 'QA findings', '/tmp/findings.md', 'qa'),
    ] }],
    activity: kind === 'long' ? longActivity() : prototypeActivity(),
    approvalIds: ['q11'],
    chatTarget: { panelId: 'orch', name: 'orchestrator', kind: 'orchestrator' },
    orchestrator: { panelId: 'orch', name: 'orchestrator', agentId: 'claude' },
    load: { gate: 'normal', canPause: true },
    keepMoving: 'Pane keeps it moving.',
  };
  const approval: NotifyItem = {
    id: 'q11', ui: 'options', title: 'Q-11: Which currencies must the PDF support at launch?', state: 'waiting', createdAt: now - 5 * MIN,
    choices: [{ label: 'EUR only' }, { label: 'EUR and USD', recommended: true }, { label: 'Every currency Stripe has' }],
    source: { name: 'orchestrator', agent: 'Claude', panelId: 'orch', session: { id: 'sess-billing', name: 'Billing rewrite', paneId: 'pane-sess', orchestrator: true } },
    todo: { number: 12, title: 'Invoice PDFs' },
  };
  const notify: NotifySnapshot = {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items: [approval], queue: ['q11'], hidden: [], strip: null, stripSurface: null,
    pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
  };
  const snapshot: TodosSnapshot = {
    rows: [row], machine: 'devbox', ownSessionIds: [],
    gate: { state: 'normal', enabled: true, since: now },
  };
  return { snapshot, detail, notify };
}
