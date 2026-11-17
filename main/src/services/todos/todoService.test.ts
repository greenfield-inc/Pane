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
      expect(host.typedInto('s1-orch').at(-1)).toBe('[From the person, via To-dos T-1] use the blue one');
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
      expect(host.typedInto('w1').at(-1)).toBe('[From the person, via To-dos T-2] hi worker');
      expect(host.typedInto('s1-orch').at(-1)).toBe('[From the person, via To-dos T-2] hi boss');
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

    it('asks you directly when you are the requester or the requester’s Session is gone', async () => {
      const mine = await service.create({ title: 'Mine' }, person);
      expect((await service.ask(mine.number, 'OK?', { kind: 'agent', panelId: 's1-orch' })).routedTo).toBe('person');
      const tab = host.addRequester();
      const theirs = await service.create({ title: 'Theirs' }, { kind: 'agent', panelId: tab });
      host.sessions.get('sA')!.archived = true;
      expect((await service.ask(theirs.number, 'OK?', { kind: 'agent', panelId: 's2-orch' })).routedTo).toBe('person');
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

  describe('launch resume', () => {
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
