import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TodoService } from './todoService';
import { FakeHost } from './todoTestHost';
import { TodoStore } from './todoStore';

const START = Date.UTC(2026, 10, 16, 9, 0);

describe('TodoService', () => {
  let db: Database.Database;
  let host: FakeHost;
  let now: number;
  let service: TodoService;
  const person = { kind: 'person' as const };

  beforeEach(() => {
    db = new Database(':memory:');
    host = new FakeHost();
    now = START;
    service = new TodoService(new TodoStore(db), host, () => now);
  });
  afterEach(() => db.close());

  async function settle() {
    for (let i = 0; i < 3; i += 1) await Promise.resolve();
  }

  describe('creating', () => {
    it('gives every top-level to-do its own Session and orchestrator, typed in with its requester and attachments', async () => {
      const tab = host.addRequester();
      const todo = await service.create({ title: 'Invoice PDFs', summary: 'Render them', doneWhen: ['PDF renders'], attach: [{ target: '/plans/invoice.html', kind: 'plan' }] }, { kind: 'agent', panelId: tab });
      expect(todo).toMatchObject({ ref: 'T-1', state: 'in_progress', sessionId: 's1', requester: { kind: 'orchestrator', sessionId: 'sA', panelId: 'tA', name: 'Billing rewrite orchestrator' } });
      expect(host.sessions.get('s1')?.name).toBe('T-1 · Invoice PDFs');
      const [opening] = host.typedInto('s1-orch');
      expect(opening).toContain('requested by Billing rewrite orchestrator');
      expect(opening).toContain('plan: invoice.html — /plans/invoice.html (on This Mac)');
      expect(service.ownSessionIds()).toEqual(['s1']);
      // The Session record says it is T-1's from its first write, before the to-do stores its id (T-7).
      expect(host.createdFor).toEqual([todo.number]);
    });

    it('with Start now off, saves it as To do with no Session until Start', async () => {
      const todo = await service.create({ title: 'Later', startNow: false }, person);
      expect(todo).toMatchObject({ state: 'todo', sessionId: null, requester: { kind: 'person', name: 'you' } });
      expect(service.snapshot().rows[0].status).toMatchObject({ status: 'idle', reason: 'not started' });
      await service.start(todo.number, person);
      expect(service.get(todo.number)).toMatchObject({ state: 'in_progress', sessionId: 's1' });
    });

    it('puts a sub-to-do in its parent’s Session, tells the orchestrator, and refuses a second level', async () => {
      const parent = await service.create({ title: 'Keyboard sheet' }, person);
      const sub = await service.create({ title: 'QA on a dev build', parentNumber: parent.number }, person);
      expect(sub).toMatchObject({ parentNumber: parent.number, sessionId: 's1', requester: { kind: 'person' } });
      await service.flush();
      expect(host.typedInto('s1-orch').at(-1)).toContain(`Added sub-to-do ${sub.ref}`);
      await expect(service.create({ title: 'Too deep', parentNumber: sub.number }, person)).rejects.toMatchObject({ code: 'ERR_TODO_TOO_DEEP' });
    });

    it('records the person as requester for a to-do created from a terminal outside Pane', async () => {
      const todo = await service.create({ title: 'From my shell', startNow: false }, { kind: 'agent' });
      expect(todo.requester).toEqual({ kind: 'person', name: 'you' });
    });

    it('rejects a to-do without a title', async () => {
      await expect(service.create({ title: '   ' }, person)).rejects.toMatchObject({ code: 'ERR_TODO_TITLE' });
    });
  });

  describe('attachments', () => {
    it('shows a parent’s attachments on its sub-to-dos and a sub-to-do’s on its parent, without copying', async () => {
      const parent = await service.create({ title: 'T-12', startNow: false }, person);
      const sub = await service.create({ title: 'T-14', parentNumber: parent.number }, person);
      service.attach(sub.number, { target: '/status/impl.json', kind: 'status' }, { kind: 'agent', panelId: 'w' });
      service.attach(parent.number, { target: 'https://github.com/o/r/pull/1390' }, person);
      expect(service.attachmentGroups(service.require(sub.number)).map(group => [group.from ?? null, group.attachments.map(item => item.label)])).toEqual([
        [null, ['impl.json']], [{ number: parent.number, relation: 'parent' }, ['PR #1390']],
      ]);
      expect(service.attachmentGroups(service.require(parent.number)).map(group => group.from?.number ?? null)).toEqual([null, sub.number]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM todo_attachments').get()).toEqual({ n: 2 });
    });

    it('reads a file named like a plan as the plan when no kind is given, so it opens as the Plan tab', async () => {
      const todo = await service.create({ title: 'Kinds', startNow: false }, person);
      const kinds = ['/b/plan.md', '/b/Plan-v2.html', '/b/notes.md', '/b/explain.html'].map(target => service.attach(todo.number, { target }, person).kind);
      expect(kinds).toEqual(['plan', 'plan', 'doc', 'doc']);
    });

    it('refuses review with no attachments unless the agent says why, and the card shows the reason', async () => {
      const todo = await service.create({ title: 'Docs' }, person);
      await expect(service.review(todo.number, {}, { kind: 'agent' })).rejects.toMatchObject({ code: 'ERR_TODO_REVIEW_NO_ATTACHMENTS' });
      await service.review(todo.number, { noAttachments: 'a one-line config change' }, { kind: 'agent' });
      expect(host.cards[0]).toMatchObject({ kind: 'review', choices: ['Accept', 'Ask for changes'] });
      expect(host.cards[0].context).toContain('No attachments: a one-line config change');
    });

    it('a sub-to-do’s attachment satisfies its parent’s review check', async () => {
      const parent = await service.create({ title: 'Parent' }, person);
      const sub = await service.create({ title: 'Sub', parentNumber: parent.number }, person);
      service.attach(sub.number, { target: '/qa/checklist.md' }, { kind: 'agent' });
      await service.review(parent.number, {}, { kind: 'agent' });
      expect(host.cards[0].links).toEqual([{ label: 'checklist.md', path: '/qa/checklist.md' }]);
    });

    it('attaches a PR, an approval’s files and a page an assigned tab opens, once each, with the source shown', async () => {
      const todo = await service.create({ title: 'PRs' }, person);
      host.panels.set('w1', { name: 'implementer', sessionId: 's1', orchestrator: false, paneId: 'p1' });
      service.assign(todo.number, 'w1', { kind: 'agent', panelId: 's1-orch' });
      service.onPr('p1', { url: 'https://github.com/o/r/pull/7', number: 7, title: 'Fix' });
      service.onPr('p1', { url: 'https://github.com/o/r/pull/7', number: 7, title: 'Fix' });
      service.onPanelOpened('w1', '/tmp/mockup.html');
      service.onApprovalItem({ id: 'a', ui: 'ask', title: 'Q', state: 'waiting', createdAt: 1, source: { name: 'w', agent: 'Claude' }, todo: { number: todo.number, title: 'PRs' }, links: [{ label: 'Plan', path: '/plan.html' }] });
      expect(service.attachmentGroups(service.require(todo.number))[0].attachments.map(item => [item.source, item.label])).toEqual([
        ['pr', '#7 Fix'], ['opened', 'mockup.html'], ['approval', 'Plan'],
      ]);
    });
  });

  describe('a report\'s --todo on the worker\'s machine (T-51, D-1 C, D-4)', () => {
    /** Makes to-dos up to T-n here, the last one titled `title`. */
    async function upTo(target: TodoService, n: number, title: string) {
      for (let i = 1; i < n; i += 1) await target.create({ title: `Filler ${i}`, startNow: false }, person);
      return target.create({ title, startNow: false }, person);
    }

    it('a Pane in no Session here leaves T-28 to the Session\'s machine: no refusal, no progress on this machine\'s own T-28', async () => {
      const own = await upTo(service, 28, 'Phone-number sign-up');
      const before = service.require(own.number);
      now += 60_000;
      const check = service.checkReportTodo('remote-worker-tab', 'T-28', false);
      expect(check.link).toBeUndefined();
      expect(check.warning).toContain('T-28 was not checked on this machine');
      expect(check.warning).toContain('Nothing was recorded');
      expect(service.require(own.number)).toEqual(before);
    });

    it('a number this machine has no open to-do for is accepted, with the warning, when the Pane is in no Session here', async () => {
      const check = service.checkReportTodo('remote-worker-tab', 'T-28', false);
      expect(check).toEqual({ warning: expect.stringContaining('reads T-28 as its own to-do') });
    });

    it('a Pane in a Session here keeps the D-408 check: a miss or a closed to-do is refused, an open one records progress', async () => {
      expect(() => service.checkReportTodo('w', 'T-28', true)).toThrow(expect.objectContaining({ code: 'ERR_TODO_NOT_FOUND' }));
      const own = await upTo(service, 2, 'Local work');
      now += 60_000;
      expect(service.checkReportTodo('w', 'T-2', true)).toEqual({ link: { number: 2, title: 'Local work', installId: 'install-a' } });
      expect(service.require(own.number).lastProgressAt).toBe(now);
      service.drop(own.number, {}, person);
      expect(() => service.checkReportTodo('w', 'T-2', true)).toThrow(expect.objectContaining({ code: 'ERR_TODO_CLOSED' }));
    });

    it('a to-do assigned to this tab is this machine\'s own, even in no Session: checked and recorded as before', async () => {
      const own = await service.create({ title: 'Assigned here' }, person);
      host.panels.set('w1', { name: 'implementer', sessionId: 's1', orchestrator: false, paneId: 'p1' });
      service.assign(own.number, 'w1', { kind: 'agent', panelId: 's1-orch' });
      now += 60_000;
      expect(service.checkReportTodo('w1', own.ref, false).link).toMatchObject({ number: own.number });
      expect(service.require(own.number).lastProgressAt).toBe(now);
    });

    it('a ref that is not a to-do number is refused on any machine', () => {
      expect(() => service.checkReportTodo('w', 'twenty-eight', false)).toThrow(expect.objectContaining({ code: 'ERR_TODO_NOT_FOUND' }));
    });

    it('links and the snapshot carry this machine\'s install id; an older Pane (none) sends none', async () => {
      await service.create({ title: 'Mine', startNow: false }, person);
      expect(service.todoLinkFor(undefined, 'T-1')).toEqual({ number: 1, title: 'Mine', installId: 'install-a' });
      expect(service.snapshot().installId).toBe('install-a');
      host.installIdValue = undefined;
      expect(service.todoLinkFor(undefined, 'T-1')).toEqual({ number: 1, title: 'Mine' });
      expect(service.snapshot()).not.toHaveProperty('installId');
    });
  });

  describe('done, review and accept', () => {
    it('refuses an agent marking an unaccepted top-level to-do done, pointing to review; --person-said goes through and is quoted', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      expect(() => service.done(todo.number, {}, { kind: 'agent' })).toThrow(expect.objectContaining({ code: 'ERR_TODO_DONE_NEEDS_REVIEW', next: expect.stringContaining('runpane todos review T-1') }));
      service.done(todo.number, { personSaid: 'close it, it shipped' }, { kind: 'agent' });
      expect(service.require(todo.number).state).toBe('done');
      expect(service.detail(todo.number).activity.some(row => row.body.includes('“close it, it shipped”'))).toBe(true);
    });

    it('lets an agent close a sub-to-do at once, and you close anything', async () => {
      const parent = await service.create({ title: 'P' }, person);
      const sub = await service.create({ title: 'S', parentNumber: parent.number }, person);
      expect(service.done(sub.number, {}, { kind: 'agent' }).state).toBe('done');
      expect(service.done(parent.number, {}, person).state).toBe('done');
    });

    it('Accept moves it to Accepted and tells the orchestrator to wrap up; then the agent may mark it done', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      service.attach(todo.number, { target: '/plan.html' }, { kind: 'agent' });
      await service.review(todo.number, {}, { kind: 'agent' });
      host.cards[0].answer({ answer: 'Accept' });
      await settle();
      expect(service.require(todo.number).state).toBe('accepted');
      await service.flush();
      expect(host.typedInto('s1-orch').at(-1)).toContain('Accepted. Do the post-acceptance work');
      expect(service.done(todo.number, {}, { kind: 'agent' }).state).toBe('done');
    });

    it('Ask for changes sends your note back and returns it to In progress', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      await service.review(todo.number, { noAttachments: 'none' }, { kind: 'agent' });
      host.cards[0].answer({ answer: 'Ask for changes', note: 'add dark mode' });
      await settle();
      expect(service.require(todo.number).state).toBe('in_progress');
      await service.flush();
      expect(host.typedInto('s1-orch').at(-1)).toContain('Changes asked for: add dark mode');
    });
  });

  describe('approvals from a to-do\'s own hidden Session (T-19)', () => {
    function promptInSession(id: string, sessionId: string, title = '{"title":"Allow pkill?"}') {
      db.prepare(`INSERT INTO approvals (id, machine, connected_kind, connected_id, connected_name, origin_kind, session_id, addressee, state, item_json, created_at)
        VALUES (?, 'm', 'session', ?, 'T-1 · Ship', 'claude-prompt', ?, 'person', 'waiting', ?, 1)`).run(id, sessionId, sessionId, title);
    }

    it('a permission prompt asked in its Session, with no --todo, makes it Waiting on you and shows on its page', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      const sessionId = service.require(todo.number).sessionId ?? '';
      expect(sessionId).not.toBe('');
      promptInSession('p1', sessionId);
      expect(service.detail(todo.number).status).toMatchObject({ status: 'waiting' });
      expect(service.detail(todo.number).approvalIds).toContain('p1');
    });

    it('another Session\'s prompt is not the to-do\'s', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      promptInSession('p2', 'some-other-session');
      expect(service.detail(todo.number).status.status).not.toBe('waiting');
      expect(service.detail(todo.number).approvalIds).not.toContain('p2');
    });

    it('a comment leaves a permission prompt for the person to answer', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      promptInSession('p3', service.require(todo.number).sessionId ?? '');
      await service.comment(todo.number, 'go on', person);
      expect(host.closed).toEqual([]);
    });

    it('asking for review again replaces the open review card, so one waits', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      await service.review(todo.number, { noAttachments: 'none' }, { kind: 'agent' });
      const first = host.cards[0].id;
      db.prepare(`INSERT INTO approvals (id, machine, connected_kind, connected_id, connected_name, origin_kind, addressee, state, item_json, created_at, todo_id)
        VALUES (?, 'm', 'machine', 'm', 'm', 'pane', 'person', 'waiting', '{"title":"Review T-1: Ship"}', 1, ?)`).run(first, todo.number);
      await service.review(todo.number, { noAttachments: 'none', summary: 'now with the report' }, { kind: 'agent' });
      expect(host.closed).toEqual([{ id: first, summary: expect.stringContaining('newer review request') }]);
      expect(host.cards).toHaveLength(2);
      expect(host.cards[1].context).toContain('now with the report');
    });
  });

  describe('a comment on a to-do waiting on you (T-20)', () => {
    function waitingCard(id: string, number: number, title = '{"title":"Q-7: Which currency?"}') {
      db.prepare(`INSERT INTO approvals (id, machine, connected_kind, connected_id, connected_name, origin_kind, addressee, state, item_json, qn, created_at, todo_id)
        VALUES (?, 'm', 'machine', 'm', 'm', 'agent', 'person', 'waiting', ?, 'Q-7', 1, ?)`).run(id, title, number);
    }

    it('on review: back to In progress, the review card closes, the orchestrator gets the comment', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      await service.flush();
      await service.review(todo.number, { noAttachments: 'none' }, { kind: 'agent' });
      waitingCard(host.cards[0].id, todo.number, '{"title":"Review T-1: Ship"}');
      expect(service.detail(todo.number).status.status).toBe('waiting');
      await service.comment(todo.number, 'Can you include a root cause report?', person);
      expect(service.require(todo.number).state).toBe('in_progress');
      expect(host.closed).toEqual([{ id: host.cards[0].id, summary: expect.stringContaining('Answered by your comment') }]);
      await service.flush();
      expect(host.typedInto('s1-orch').at(-1)).toContain('Can you include a root cause report?');
      expect(service.detail(todo.number).activity.map(row => row.body)).toContainEqual(expect.stringContaining('review is reopened'));
    });

    it('on review, Accept still marks it done when there was no comment', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      await service.review(todo.number, { noAttachments: 'none' }, { kind: 'agent' });
      host.cards[0].answer({ answer: 'Accept' });
      await settle();
      expect(service.require(todo.number).state).toBe('accepted');
      expect(host.closed).toEqual([]);
    });

    it('on the orchestrator\'s question: the card closes with your words and the orchestrator is woken with the comment', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      await service.flush();
      waitingCard('q7', todo.number);
      host.down.add('s1-orch');
      await service.comment(todo.number, 'Use EUR', person);
      expect(host.closed).toEqual([{ id: 'q7', summary: expect.stringContaining('Use EUR') }]);
      await service.flush();
      expect(host.resumed).toContain('s1-orch');
      expect(host.typedInto('s1-orch').at(-1)).toContain('Use EUR');
    });

    it('on a stuck card: the card closes and the to-do moves again', async () => {
      const todo = await service.create({ title: 'Ship' }, person);
      await service.flush();
      db.prepare('UPDATE todos SET stuck_card_id = ? WHERE number = ?').run('stuck1', todo.number);
      waitingCard('stuck1', todo.number, '{"title":"T-1 is stuck"}');
      await service.comment(todo.number, 'Keep going, try the other fix', person);
      expect(host.closed).toEqual([{ id: 'stuck1', summary: expect.stringContaining('Answered by your comment') }]);
      expect(service.require(todo.number).stuckCardId).toBeNull();
    });

    it('leaves a sub-to-do\'s question to its own card', async () => {
      const parent = await service.create({ title: 'P' }, person);
      const sub = await service.create({ title: 'S', parentNumber: parent.number }, person);
      waitingCard('sq', sub.number);
      await service.comment(parent.number, 'general note', person);
      expect(host.closed).toEqual([]);
    });
  });

  describe('chat routing and delivery', () => {
    it('types your message into the orchestrator only when it is idle with no unsent text, then reads Delivered', async () => {
      const todo = await service.create({ title: 'Chat' }, person);
      host.midTurn.add('s1-orch');
      const message = await service.comment(todo.number, 'use the blue one', person);
      await service.flush();
      expect(host.typedInto('s1-orch')).toHaveLength(1);
      host.midTurn.delete('s1-orch');
      host.unsent.add('s1-orch');
      await service.flush();
      expect(host.typedInto('s1-orch')).toHaveLength(1);
      host.unsent.delete('s1-orch');
      await service.flush();
      expect(host.typedInto('s1-orch').at(-1)).toBe('[From the person, via To-dos T-1] use the blue one\n\nReply in the to-do\u2019s chat with runpane todos comment T-1 "\u2026": the person reads that chat, not this tab.');
      expect(service.detail(todo.number).activity.find(row => row.id === message.id)?.deliveredAt).toBe(START);
    });

    it('sends a sub-to-do’s chat to its assignee, or to the orchestrator when asked', async () => {
      const parent = await service.create({ title: 'P' }, person);
      const sub = await service.create({ title: 'S', parentNumber: parent.number }, person);
      host.panels.set('w1', { name: 'implementer', sessionId: 's1', orchestrator: false });
      service.assign(sub.number, 'w1', { kind: 'agent', panelId: 's1-orch' });
      await service.comment(sub.number, 'hi worker', person);
      await service.comment(sub.number, 'hi boss', person, { toOrchestrator: true });
      for (let i = 0; i < 4; i += 1) await service.flush();
      expect(host.typedInto('w1').at(-1)).toBe('[From the person, via To-dos T-2] hi worker\n\nReply in the to-do\u2019s chat with runpane todos comment T-2 "\u2026": the person reads that chat, not this tab.');
      expect(host.typedInto('s1-orch').at(-1)).toBe('[From the person, via To-dos T-2] hi boss\n\nReply in the to-do\u2019s chat with runpane todos comment T-2 "\u2026": the person reads that chat, not this tab.');
    });

    it('a message to a tab closed before delivery leaves the queue with one line, and never stops the others or the next tick (F-4)', async () => {
      const closed = await service.create({ title: 'Closed tab' }, person);
      const other = await service.create({ title: 'Open tab' }, person);
      host.midTurn.add('s1-orch');
      await service.comment(closed.number, 'are you there?', person);
      host.midTurn.delete('s1-orch');
      host.panels.delete('s1-orch');
      host.down.add('s1-orch');
      host.resumePanel = async () => { throw new Error('No tab s1-orch'); };
      await service.comment(other.number, 'carry on', person);
      await service.fastTick();
      await service.fastTick();
      expect(service.queuedFor('s1-orch')).toEqual([]);
      expect(host.typedInto('s2-orch').at(-1)).toContain('carry on');
      const lines = () => service.detail(closed.number).activity.filter(row => row.body === "Couldn't reach the tab: its tab closed");
      expect(lines()).toHaveLength(1);
      // A relaunch rebuilds the message from the chat; it settles again without a second line.
      const again = new TodoService(new TodoStore(db), host, () => now);
      await expect(again.fastTick()).resolves.toBeUndefined();
      expect(again.queuedFor('s1-orch')).toEqual([]);
      expect(lines()).toHaveLength(1);
    });

    it('keeps a message for a tab that fails to restart for three tries, then says so and moves on (F-4)', async () => {
      const todo = await service.create({ title: 'Will not start' }, person);
      host.down.add('s1-orch');
      let tries = 0;
      host.resumePanel = async () => { tries += 1; throw new Error('resume failed'); };
      await service.comment(todo.number, 'wake up', person);
      for (let i = 0; i < 6; i += 1) await service.flush();
      expect(tries).toBe(3);
      expect(service.queuedFor('s1-orch')).toEqual([]);
      expect(service.detail(todo.number).activity.at(-1)?.body).toBe("Couldn't reach orchestrator: it failed to restart");
    });

    it('resumes a down tab before delivering to it', async () => {
      const todo = await service.create({ title: 'Down' }, person);
      host.down.add('s1-orch');
      await service.comment(todo.number, 'still there?', person);
      await service.flush();
      expect(host.resumed).toEqual(['s1-orch']);
      await service.flush();
      expect(host.typedInto('s1-orch').at(-1)).toContain('still there?');
    });

    it('refuses an agent reply over 2,000 characters, saying to summarise', async () => {
      const todo = await service.create({ title: 'Long' }, person);
      await expect(service.comment(todo.number, 'x'.repeat(2001), { kind: 'agent', panelId: 's1-orch' })).rejects.toMatchObject({ code: 'ERR_TODO_REPLY_TOO_LONG', next: expect.stringContaining('Summarise') });
    });

    it('asks the requester first; its reply reaches the to-do’s orchestrator; --escalate makes it your approval', async () => {
      const tab = host.addRequester();
      const todo = await service.create({ title: 'Invoices' }, { kind: 'agent', panelId: tab });
      expect(await service.ask(todo.number, 'Which currency?', { kind: 'agent', panelId: 's1-orch' })).toEqual({ routedTo: 'requester' });
      await service.flush();
      expect(host.typedInto('tA').at(-1)).toContain('[From To-dos T-1, asked by its orchestrator] Which currency?');
      await service.comment(todo.number, 'EUR', { kind: 'agent', panelId: 'tA' });
      await service.flush();
      expect(host.typedInto('s1-orch').at(-1)).toBe('[From Billing rewrite orchestrator, via To-dos T-1] EUR');
      await service.comment(todo.number, 'I don’t know', { kind: 'agent', panelId: 'tA' }, { escalate: true });
      expect(host.cards[0]).toMatchObject({ kind: 'question', title: 'Which currency?', askerPanelId: 's1-orch' });
    });

    it('types your answer to a todos ask question into the tab that asked, once, as an answer or a typed reply (F-3)', async () => {
      const todo = await service.create({ title: 'Ask me' }, person);
      host.panels.set('w1', { name: 'implementer', sessionId: 's1', orchestrator: false });
      await service.ask(todo.number, 'EUR or USD?', { kind: 'agent', panelId: 'w1' });
      host.cards[0].answer({ answer: 'EUR' });
      await settle();
      await service.flush();
      expect(host.typedInto('w1')).toEqual(['[From the person, via To-dos T-1] Answer to your question: EUR']);
      await service.ask(todo.number, 'Which bank?', { kind: 'agent', panelId: 'w1' });
      host.cards[1].answer({ reply: 'The usual one' });
      await settle();
      await service.flush();
      expect(host.typedInto('w1').at(-1)).toBe('[From the person, via To-dos T-1] Answer to your question: The usual one');
      expect(host.typedInto('w1')).toHaveLength(2);
    });

    it('sends the answer to the to-do’s orchestrator when the question came from no tab (F-3)', async () => {
      const todo = await service.create({ title: 'From the CLI' }, person);
      await service.ask(todo.number, 'Ship it?', { kind: 'agent' });
      host.cards[0].answer({ answer: 'Yes' });
      await settle();
      await service.flush();
      expect(host.typedInto('s1-orch').at(-1)).toBe('[From the person, via To-dos T-1] Answer to your question: Yes');
    });

    it('asks you directly when you are the requester or the requester’s Session is gone', async () => {
      const mine = await service.create({ title: 'Mine' }, person);
      expect((await service.ask(mine.number, 'OK?', { kind: 'agent', panelId: 's1-orch' })).routedTo).toBe('person');
      const tab = host.addRequester();
      const theirs = await service.create({ title: 'Theirs' }, { kind: 'agent', panelId: tab });
      host.sessions.get('sA')!.archived = true;
      expect((await service.ask(theirs.number, 'OK?', { kind: 'agent', panelId: 's2-orch' })).routedTo).toBe('person');
    });

    describe('replies (round 7)', () => {
      const worker = () => host.panels.set('w1', { name: 'implementer', sessionId: 's1', orchestrator: false });

      it('types a reply under an agent’s card into that agent’s tab, not the orchestrator’s, and threads its next message under the reply (R15)', async () => {
        const todo = await service.create({ title: 'Replies' }, person);
        worker();
        const card = await service.comment(todo.number, 'Plan is ready', { kind: 'agent', panelId: 'w1' });
        await service.flush();
        const before = host.typedInto('s1-orch').length;
        const reply = await service.comment(todo.number, 'use the blue one', person, { replyTo: card.id });
        await service.flush();
        expect(reply).toMatchObject({ replyTo: card.id, toTab: 'w1' });
        expect(host.typedInto('w1').at(-1)).toContain('[From the person, via To-dos T-1] use the blue one');
        expect(host.typedInto('s1-orch')).toHaveLength(before);
        const answer = await service.comment(todo.number, 'Switched to blue', { kind: 'agent', panelId: 'w1' });
        expect(answer.replyTo).toBe(reply.id);
        // Only the first answer threads; the agent's later messages stand in its run.
        expect((await service.comment(todo.number, 'Tests pass', { kind: 'agent', panelId: 'w1' })).replyTo).toBeUndefined();
      });

      it('sends a reply to the orchestrator, and says so, when the card’s tab is gone (R16)', async () => {
        const todo = await service.create({ title: 'Gone' }, person);
        worker();
        const card = await service.comment(todo.number, 'Plan is ready', { kind: 'agent', panelId: 'w1' });
        host.panels.delete('w1');
        const reply = await service.comment(todo.number, 'thanks', person, { replyTo: card.id });
        await service.flush();
        expect(reply.toTab).toBe('s1-orch');
        expect(host.typedInto('s1-orch').at(-1)).toContain('thanks');
        expect(service.detail(todo.number).activity.at(-1)?.body).toBe('implementer’s tab is closed; sent to the orchestrator');
      });

      it('sends a reply on your own comment to whoever the comment went to (R17)', async () => {
        const parent = await service.create({ title: 'P' }, person);
        const sub = await service.create({ title: 'S', parentNumber: parent.number }, person);
        worker();
        service.assign(sub.number, 'w1', { kind: 'agent', panelId: 's1-orch' });
        const mine = await service.comment(sub.number, 'hi worker', person);
        const reply = await service.comment(sub.number, 'and one more thing', person, { replyTo: mine.id });
        for (let i = 0; i < 4; i += 1) await service.flush();
        expect(reply.toTab).toBe('w1');
        expect(host.typedInto('w1').at(-1)).toContain('and one more thing');
      });

      it('refuses a reply to another to-do’s row or a tab outside the Session, and types nothing (R18)', async () => {
        const one = await service.create({ title: 'One' }, person);
        const two = await service.create({ title: 'Two' }, person);
        const other = await service.comment(two.number, 'from two', { kind: 'agent', panelId: 's2-orch' });
        await expect(service.comment(one.number, 'x', person, { replyTo: other.id })).rejects.toMatchObject({ code: 'ERR_TODO_REPLY_TARGET', next: expect.any(String) });
        host.panels.set('stranger', { name: 'stranger', sessionId: 'elsewhere', orchestrator: false });
        const card = await service.comment(one.number, 'hello', { kind: 'agent', panelId: 'stranger' });
        await service.flush();
        const typed = host.typedInto('stranger').length;
        await expect(service.comment(one.number, 'x', person, { replyTo: card.id })).rejects.toMatchObject({ code: 'ERR_TODO_REPLY_TARGET' });
        await service.flush();
        expect(host.typedInto('stranger')).toHaveLength(typed);
        expect(service.detail(one.number).activity.some(row => row.body === 'x')).toBe(false);
      });
    });

    it('sends the requester one line on review, done, drop and stuck', async () => {
      const tab = host.addRequester();
      const todo = await service.create({ title: 'Inv' }, { kind: 'agent', panelId: tab });
      await service.review(todo.number, { noAttachments: 'x' }, { kind: 'agent' });
      host.cards[0].answer({ answer: 'Accept' });
      await settle();
      service.done(todo.number, {}, { kind: 'agent' });
      for (let i = 0; i < 4; i += 1) await service.flush();
      expect(host.typedInto('tA')).toEqual([
        '[From Pane, To-dos] T-1 "Inv", which you requested, asks the person for review.',
        '[From Pane, To-dos] T-1 "Inv", which you requested, is done.',
      ]);
    });
  });

  describe('Stop', () => {
    it('types into the orchestrator when idle and reads Idle · stopped by you', async () => {
      const todo = await service.create({ title: 'Stop me' }, person);
      service.stop(todo.number, person);
      await service.flush();
      expect(host.typedInto('s1-orch').at(-1)).toContain('Stop T-1: finish your current step');
      expect(service.snapshot().rows[0].status).toMatchObject({ status: 'idle', reason: 'stopped by you' });
    });
  });

  describe('the load gate', () => {
    async function holdGate() {
      host.load = { cpuPercent: 5, memory: 'warning' };
      await service.create({ title: 'Running', startNow: true }, person);
      for (let i = 0; i <= 3; i += 1) { await service.loadTick(); now += 10_000; }
      expect(service.gate.state).toBe('holding');
    }

    it('leaves a new to-do Queued with no Session while holding, then starts it when load is back to Normal', async () => {
      await holdGate();
      const queued = await service.create({ title: 'Waits' }, person);
      expect(queued).toMatchObject({ sessionId: null, loadHold: 'queued' });
      expect(service.snapshot().rows.find(row => row.todo.number === queued.number)?.status.reason).toBe('This Mac is busy · starts when load comes down');
      host.load = { cpuPercent: 5, memory: 'ok' };
      for (let i = 0; i <= 13; i += 1) { await service.loadTick(); now += 10_000; }
      expect(service.require(queued.number)).toMatchObject({ loadHold: null, sessionId: 's2' });
    });

    it('keeps a queued first start whose launch fails queued and retried, then puts it back in To do saying why (F-5)', async () => {
      await holdGate();
      const queued = await service.create({ title: 'Waits' }, person);
      let tries = 0;
      const create = host.createSession.bind(host);
      host.createSession = async () => { tries += 1; throw new Error('the agent failed to start'); };
      host.load = { cpuPercent: 5, memory: 'ok' };
      for (let i = 0; i <= 13 && tries === 0; i += 1) { await service.loadTick(); now += 10_000; }
      expect(tries).toBe(1);
      expect(service.require(queued.number)).toMatchObject({ state: 'in_progress', sessionId: null, loadHold: 'queued' });
      expect(service.detail(queued.number).activity.at(-1)?.body).toBe("Couldn't start: the agent failed to start · Pane tries again when load allows");
      for (let i = 0; i <= 60 && tries < 3; i += 1) { await service.loadTick(); now += 10_000; }
      expect(tries).toBe(3);
      expect(service.require(queued.number)).toMatchObject({ state: 'todo', sessionId: null, loadHold: null });
      expect(service.detail(queued.number).activity.at(-1)?.body).toBe("Couldn't start after 3 tries: the agent failed to start · Start it again when ready");
      host.createSession = create;
      await service.start(queued.number, person, { anyway: true });
      expect(service.require(queued.number).sessionId).toBe('s2');
    });

    it('a restart held while Holding is a real restart when load clears, and keeps the quiet time (F-7)', async () => {
      const todo = await service.create({ title: 'Quiet under load' }, person);
      const progressAt = service.require(todo.number).lastProgressAt;
      host.load = { cpuPercent: 5, memory: 'warning' };
      const queuedLine = () => service.detail(todo.number).activity.some(row => row.body === 'Restart queued: the machine is busy');
      for (let step = 0; step < 6 * 40 && !queuedLine(); step += 1) {
        now += 10_000;
        await service.loadTick();
        await service.supervisorPass();
      }
      expect(service.gate.state).toBe('holding');
      expect(service.require(todo.number).loadHold).toBe('queued');
      expect(service.snapshot().rows.find(row => row.todo.number === todo.number)?.status.status).toBe('queued');
      for (let i = 0; i < 3; i += 1) await service.flush();
      expect(service.queuedFor('s1-orch')).toEqual([]);
      const typedBefore = host.typedInto('s1-orch').length;
      host.load = { cpuPercent: 5, memory: 'ok' };
      for (let step = 0; step < 30 && host.restarted.length === 0; step += 1) { now += 10_000; await service.loadTick(); }
      expect(host.restarted).toEqual(['s1-orch']);
      expect(host.resumed).toEqual([]);
      const after = service.require(todo.number);
      expect(after).toMatchObject({ loadHold: null, episodeRestarts: 1, lastProgressAt: progressAt });
      for (let i = 0; i < 3; i += 1) await service.flush();
      const typed = host.typedInto('s1-orch').slice(typedBefore);
      expect(typed).toHaveLength(1);
      expect(typed[0]).toContain('Pane restarted you because T-1 went quiet.');
      expect(service.detail(todo.number).activity.at(-1)?.body).toMatch(/^Quiet \d+m: Pane restarted the orchestrator in its same conversation$/);
    });

    it('Start anyway starts at once and marks it Never pause', async () => {
      await holdGate();
      const todo = await service.create({ title: 'Urgent', startNow: false }, person);
      await service.start(todo.number, person, { anyway: true });
      expect(service.require(todo.number)).toMatchObject({ loadOverride: 'never_pause', sessionId: 's2', loadHold: null });
    });

    it('refuses agent starts from a to-do’s Session with machine_busy, then says Capacity is back once', async () => {
      await holdGate();
      expect(() => service.checkAgentStart('s1', null, 's1-orch')).toThrow(expect.objectContaining({ code: 'ERR_MACHINE_BUSY' }));
      expect(() => service.checkAgentStart('elsewhere', null, 'x')).not.toThrow();
      host.load = { cpuPercent: 5, memory: 'ok' };
      for (let i = 0; i <= 13; i += 1) { await service.loadTick(); now += 10_000; }
      await service.flush();
      expect(host.typedInto('s1-orch').filter(text => text.includes('Capacity is back'))).toHaveLength(1);
    });

    it('sheds the newest-started to-do under critical memory, never the last one, and pauses its tabs once idle', async () => {
      const first = await service.create({ title: 'Old' }, person);
      now += 60_000;
      const second = await service.create({ title: 'New' }, person);
      host.load = { cpuPercent: 5, memory: 'critical' };
      for (let i = 0; i <= 7; i += 1) { await service.loadTick(); now += 10_000; }
      expect(service.require(second.number).loadHold).toBe('paused');
      expect(service.require(first.number).loadHold).toBeNull();
      await service.flush();
      expect(host.typedInto('s2-orch').at(-1)).toContain('Pausing T-2 for machine load');
      await service.loadTick();
      now += 10_000;
      await service.loadTick();
      expect(host.paused).toEqual([['s2-orch']]);
      expect(service.snapshot().rows.find(row => row.todo.number === second.number)?.status.reason).toBe('paused for load · resumes when load comes down');
    });

    it('holds and pauses nothing with the setting off', async () => {
      host.gateEnabled = false;
      host.load = { cpuPercent: 5, memory: 'critical' };
      await service.create({ title: 'A' }, person);
      for (let i = 0; i <= 7; i += 1) { await service.loadTick(); now += 10_000; }
      expect((await service.create({ title: 'B' }, person)).loadHold).toBeNull();
    });
  });

  describe('To-dos off and back on (T-39)', () => {
    it('while off, no tick, wake, supervisor rung or message runs, and launch resume waits', async () => {
      const todo = await service.create({ title: 'Quiet' }, person);
      const typed = host.typed.length;
      host.todosEnabled = false;
      for (let minute = 0; minute < 45; minute += 1) {
        now += 60_000;
        await service.fastTick();
        await service.wakeTick();
        await service.loadTick();
        await service.supervisorPass();
      }
      await service.comment(todo.number, 'are you there?', person);
      await service.flush();
      expect(host.typed.length).toBe(typed);
      expect(host.restarted).toEqual([]);
      expect(host.cards).toEqual([]);
      expect(await service.resumeOnLaunch('launch')).toEqual({ restarted: 0, queued: 0 });
      expect(service.launchHasResumed).toBe(false);
    });

    it('turned back on, a to-do already on the ladder starts its whole quiet episode again and its stuck card closes', async () => {
      const todo = await service.create({ title: 'Quiet' }, person);
      for (let minute = 0; minute <= 45 && host.cards.length === 0; minute += 1) {
        now += 60_000;
        await service.fastTick();
        await service.supervisorPass();
      }
      expect(host.cards).toHaveLength(1);
      expect(service.get(todo.number)).toMatchObject({ episodeReminders: expect.any(Number) });
      expect(service.get(todo.number)?.stuckSince).not.toBeNull();

      now += 80 * 60_000; // off for 80 minutes
      service.restartClocksAfterTurnedOn();

      expect(host.closed.map(card => card.id)).toEqual([host.cards[0].id]);
      expect(service.get(todo.number)).toMatchObject({ lastProgressAt: now, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stuckCardId: null });
      expect(service.detail(todo.number).activity.at(-1)?.body).toBe('To-dos was turned back on: its quiet time starts again now');
      const restarts = host.restarted.length;
      await service.supervisorPass();
      expect(host.restarted.length).toBe(restarts);
    });
  });

  describe('launch resume', () => {
    it('at the 30-minute rung stops and starts a live quiet orchestrator again, not a Resume that does nothing (F-7)', async () => {
      const todo = await service.create({ title: 'Quiet' }, person);
      for (let minute = 0; minute <= 40 && host.restarted.length === 0; minute += 1) {
        now += 60_000;
        await service.fastTick();
        await service.supervisorPass();
      }
      expect(host.restarted).toEqual(['s1-orch']);
      expect(host.resumed).toEqual([]);
      expect(service.detail(todo.number).activity.some(row => /Quiet \d+m: Pane restarted the orchestrator in its same conversation/.test(row.body))).toBe(true);
    });

    it('says the restart failed when the tab didn’t start again, and holds off while the person has a draft (F-7)', async () => {
      const todo = await service.create({ title: 'Quiet' }, person);
      host.unsent.add('s1-orch');
      for (let minute = 0; minute < 35; minute += 1) { now += 60_000; await service.supervisorPass(); }
      expect(host.restarted).toEqual([]);
      host.unsent.delete('s1-orch');
      host.restartPanel = async id => { host.restarted.push(id); return false; };
      now += 60_000;
      await service.supervisorPass();
      expect(host.restarted).toEqual(['s1-orch']);
      expect(service.detail(todo.number).activity.at(-1)?.body).toMatch(/^Quiet \d+m: Pane couldn't restart the orchestrator$/);
    });

    it('restarts in-progress and accepted to-dos’ agents in place; waiting, stopped and to-do items stay down', async () => {
      const running = await service.create({ title: 'Running' }, person);
      const accepted = await service.create({ title: 'Accepted' }, person);
      const waiting = await service.create({ title: 'Waiting' }, person);
      const stopped = await service.create({ title: 'Stopped' }, person);
      await service.create({ title: 'Not started', startNow: false }, person);
      db.prepare("UPDATE todos SET state = 'accepted' WHERE number = ?").run(accepted.number);
      db.prepare("UPDATE approvals SET todo_id = NULL").run();
      await service.ask(waiting.number, 'Q?', { kind: 'agent', panelId: 's3-orch' });
      db.prepare(`INSERT INTO approvals (id, machine, connected_kind, connected_id, connected_name, origin_kind, addressee, state, item_json, created_at, todo_id)
        VALUES ('q', 'm', 'machine', 'm', 'm', 'agent', 'person', 'waiting', '{"title":"Q?"}', 1, ?)`).run(waiting.number);
      service.stop(stopped.number, person);
      for (const id of ['s1-orch', 's2-orch', 's3-orch', 's4-orch']) host.down.add(id);
      const result = await service.resumeOnLaunch();
      expect(host.resumed.sort()).toEqual(['s1-orch', 's2-orch']);
      expect(result.restarted).toBe(2);
      await service.flush();
      expect(host.typedInto('s1-orch').at(-1)).toContain(`Pane restarted. Still yours:\n\n${running.ref}`);
    });
  });

  describe('archive', () => {
    it('archives the clean Panes and names each one kept', async () => {
      const todo = await service.create({ title: 'Archive me' }, person);
      service.done(todo.number, {}, person);
      const result = await service.archive(todo.number, person);
      expect(result.kept).toEqual([{ name: 'keyboard-approvals', reason: '2 unpushed commits' }]);
      expect(service.detail(todo.number).activity.at(-1)?.body).toBe('Archived 1 Pane. Kept keyboard-approvals: 2 unpushed commits.');
    });

    it('refuses to archive an open to-do', async () => {
      const todo = await service.create({ title: 'Open' }, person);
      await expect(service.archive(todo.number, person)).rejects.toMatchObject({ code: 'ERR_TODO_ARCHIVE_OPEN' });
    });
  });

  describe('statuses through the service', () => {
    it('reads Working after its orchestrator has been mid-turn for 10 s, and Idle 10 s after the turn ends', async () => {
      const todo = await service.create({ title: 'Work' }, person);
      host.midTurn.add('s1-orch');
      await service.fastTick();
      now += 4_000; await service.fastTick();
      expect(service.snapshot().rows[0].status.status).toBe('idle');
      now += 6_000; await service.fastTick();
      expect(service.snapshot().rows[0].status.status).toBe('working');
      host.midTurn.delete('s1-orch');
      now += 4_000; await service.fastTick();
      expect(service.snapshot().rows[0].status.status).toBe('working');
      now += 8_000; await service.fastTick();
      expect(service.detail(todo.number).status.status).toBe('idle');
    });

    it('a parent reads Waiting on you while its sub-to-do’s approval waits', async () => {
      const parent = await service.create({ title: 'P' }, person);
      const sub = await service.create({ title: 'S', parentNumber: parent.number }, person);
      db.prepare(`INSERT INTO approvals (id, machine, connected_kind, connected_id, connected_name, origin_kind, addressee, state, item_json, qn, created_at, todo_id)
        VALUES ('q', 'm', 'machine', 'm', 'm', 'agent', 'person', 'waiting', '{"title":"Q-13: Run it?"}', 'Q-13', 1, ?)`).run(sub.number);
      expect(service.detail(parent.number).status).toMatchObject({ status: 'waiting', reason: 'Q-13 · Run it?' });
    });
  });
});
