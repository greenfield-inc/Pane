import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TodoService } from './todoService';
import { TodoStore } from './todoStore';
import { FakeHost } from './todoTestHost';

/** Monday 16 Nov 2026, 9:00 AM in Los Angeles. */
const START = Date.UTC(2026, 10, 16, 17, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ZONE = 'America/Los_Angeles';
const CLOCK = /\d{1,2}:\d{2} [AP]M/;

/** Round 9 (T-17): snoozing, waking and reminders, through the service with a fake clock and a real sessions.db. */
describe('TodoService snoozing (round 9)', () => {
  let db: Database.Database;
  let host: FakeHost;
  let now: number;
  let service: TodoService;
  const person = { kind: 'person' as const };
  const orchestrator = { kind: 'agent' as const, panelId: 's1-orch' };

  beforeEach(() => {
    db = new Database(':memory:');
    host = new FakeHost();
    now = START;
    service = new TodoService(new TodoStore(db), host, () => now);
  });
  afterEach(() => db.close());

  async function settle() {
    for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
  }

  async function flushAll(target = service) {
    for (let i = 0; i < 3; i += 1) await target.flush();
  }

  /** A started to-do: its Session s<n> and orchestrator s<n>-orch, its opening prompt already typed. */
  async function running(title = 'Ship') {
    const todo = await service.create({ title }, person);
    await flushAll();
    return todo;
  }

  function typedSince(panelId: string, before: number, target = host): string[] {
    return target.typedInto(panelId).slice(before);
  }

  function events(number: number): string[] {
    return service.detail(number).activity.filter(row => row.kind === 'event').map(row => row.body);
  }

  /** A second Pane on the same database: the Sessions and tabs survive, the cards and calls don't. */
  function restart() {
    const host2 = new FakeHost();
    for (const [id, session] of host.sessions) host2.sessions.set(id, session);
    for (const [id, panel] of host.panels) host2.panels.set(id, panel);
    return { again: new TodoService(new TodoStore(db), host2, () => now), host2 };
  }

  describe('S1: snoozing', () => {
    it('stops it quietly, clears its stuck counters and card, and the orchestrator hears once, after its turn', async () => {
      const todo = await running();
      const before = host.typedInto('s1-orch').length;
      host.midTurn.add('s1-orch');
      db.prepare('UPDATE todos SET episode_reminders = 2, stuck_since = ?, stuck_card_id = ? WHERE number = ?').run(START - HOUR, 'stuck-1', todo.number);
      const snoozed = service.snooze(todo.number, { until: START + 6 * HOUR, zone: ZONE, note: 'check Sentry' }, person);
      expect(snoozed).toMatchObject({
        state: 'stopped', episodeReminders: 0, stuckSince: null, stuckCardId: null,
        snooze: { until: START + 6 * HOUR, zone: ZONE, note: 'check Sentry', action: 'agents', by: 'you', from: 'in_progress', reminderCardId: null },
      });
      expect(host.closed).toEqual([{ id: 'stuck-1', summary: expect.stringContaining('Snoozed') }]);
      expect(service.snapshot().rows[0].status).toMatchObject({ status: 'snoozed', reason: expect.stringMatching(/^until Mon \d{1,2}:\d{2} [AP]M · check Sentry$/) });
      // A build that knows nothing of snoozing reads a stopped to-do (S14).
      expect(db.prepare('SELECT state FROM todos WHERE number = ?').get(todo.number)).toEqual({ state: 'stopped' });

      await flushAll();
      expect(host.typedInto('s1-orch')).toHaveLength(before);
      host.midTurn.delete('s1-orch');
      await flushAll();
      const typed = typedSince('s1-orch', before);
      expect(typed).toHaveLength(1);
      expect(typed[0]).toMatch(/^\[From Pane, To-dos\] Snoozed T-1 until .*: finish your current step, tell its workers to stop after theirs, then wait\. Pane wakes you then with: check Sentry/);
      expect(events(todo.number).at(-1)).toMatch(/^Snoozed until Mon .* by you: check Sentry$/);

      // Three hours past the ladder's 40 minutes, with its tab down: no reminder, restart or card.
      host.down.add('s1-orch');
      await service.resumeOnLaunch();
      for (let minute = 0; minute < 220; minute += 1) {
        now += MINUTE;
        await service.fastTick();
        await service.wakeTick();
        await service.loadTick();
        await service.supervisorPass();
      }
      expect(typedSince('s1-orch', before)).toHaveLength(1);
      expect(host.resumed).toEqual([]);
      expect(host.cards).toEqual([]);
      expect(service.require(todo.number).snooze).toBeDefined();
    });

    it('S3: an orchestrator’s own snooze isn’t typed back to it; its workers hear, and it reads set by the orchestrator', async () => {
      const todo = await running();
      const sub = await service.create({ title: 'Sub', parentNumber: todo.number }, person);
      host.panels.set('w1', { name: 'implementer', sessionId: 's1', orchestrator: false });
      service.assign(sub.number, 'w1', orchestrator);
      await flushAll();
      const [orchestratorBefore, workerBefore] = [host.typedInto('s1-orch').length, host.typedInto('w1').length];
      const snoozed = service.snooze(todo.number, { until: START + HOUR, zone: ZONE, note: 'deploy done?' }, orchestrator);
      expect(snoozed.snooze?.by).toBe('orchestrator');
      await flushAll();
      expect(typedSince('s1-orch', orchestratorBefore)).toEqual([]);
      expect(typedSince('w1', workerBefore)).toEqual([expect.stringMatching(/^\[From Pane, To-dos\] T-1 is snoozed until .*: finish your current step, then wait\./)]);
    });
  });

  describe('S2: the time arrives', () => {
    it('wakes within a tick: In progress, its orchestrator restarted in place, one reminder with the note, the ladder from now', async () => {
      const todo = await running();
      service.snooze(todo.number, { until: START + HOUR, zone: ZONE, note: 'check Sentry' }, person);
      await flushAll();
      await service.resumeOnLaunch();
      host.down.add('s1-orch');
      const before = host.typedInto('s1-orch').length;
      now = START + HOUR - 1000;
      await service.wakeTick();
      expect(service.require(todo.number).snooze).toBeDefined();
      now = START + HOUR + 1000;
      await service.wakeTick();
      const woke = service.require(todo.number);
      expect(woke).toMatchObject({ state: 'in_progress', lastProgressAt: now, episodeReminders: 0, episodeRestarts: 0, stuckSince: null, loadHold: null });
      expect(woke.snooze).toBeUndefined();
      expect(host.resumed).toEqual(['s1-orch']);
      await flushAll();
      const typed = typedSince('s1-orch', before);
      expect(typed).toHaveLength(1);
      expect(typed[0]).toMatch(/^\[From Pane, To-dos\] Reminder for T-1 "Ship" \(snoozed until Mon \d{1,2}:\d{2} [AP]M\): check Sentry/);
      expect(typed[0]).toContain('Attachments: none yet.');
      expect(typed[0]).not.toContain('overdue');
      expect(events(todo.number)).toContainEqual(expect.stringMatching(new RegExp(`^Woke at ${CLOCK.source}$`)));
      await service.wakeTick();
      expect(host.resumed).toEqual(['s1-orch']);
    });

    it('waits for launch resume before its first wake check', async () => {
      const todo = await running();
      service.snooze(todo.number, { until: START + HOUR, zone: ZONE }, person);
      now = START + 2 * HOUR;
      await service.wakeTick();
      expect(service.require(todo.number).snooze).toBeDefined();
      await service.resumeOnLaunch();
      await service.wakeTick();
      expect(service.require(todo.number).state).toBe('in_progress');
    });
  });

  describe('S4: a pure reminder', () => {
    async function reminder(at = START + HOUR) {
      now = at - HOUR;
      const todo = await service.create({ title: 'Northwind', snooze: { until: at, zone: ZONE, note: 'did they reply?' } }, person);
      await service.resumeOnLaunch();
      now = at;
      await service.wakeTick();
      return todo;
    }

    it('is created snoozed with no Session, and at the time raises a reminder card and goes back to To do', async () => {
      now = START;
      const created = await service.create({ title: 'Northwind', snooze: { until: START + HOUR, zone: ZONE, note: 'did they reply?' } }, person);
      expect(created).toMatchObject({ state: 'stopped', sessionId: null, snooze: { action: 'remind', from: 'todo', note: 'did they reply?', by: 'you' } });
      expect(events(created.number).at(-1)).toMatch(/^Snoozed until .* by you: did they reply\?$/);
      await service.resumeOnLaunch();
      now = START + HOUR;
      await service.wakeTick();
      expect(host.cards).toHaveLength(1);
      expect(host.cards[0]).toMatchObject({ kind: 'reminder', title: 'Reminder: T-1 Northwind', choices: ['Done', 'Hand to an agent', 'Snooze 1 hour', 'Snooze to the next morning'] });
      expect(host.cards[0].context).toContain('did they reply?');
      expect(service.require(created.number)).toMatchObject({ state: 'todo', sessionId: null });
      expect(service.require(created.number).snooze).toBeUndefined();
      expect(host.createdFor).toEqual([]);
      expect(events(created.number)).toContainEqual(expect.stringMatching(/^Reminder at .*: Pane asked you$/));
    });

    it('Done closes it', async () => {
      const todo = await reminder();
      host.cards[0].answer({ answer: 'Done' });
      await settle();
      expect(service.require(todo.number).state).toBe('done');
    });

    it('Snooze 1 hour snoozes it again with the same note', async () => {
      const todo = await reminder();
      host.cards[0].answer({ answer: 'Snooze 1 hour' });
      await settle();
      expect(service.require(todo.number)).toMatchObject({ state: 'stopped', snooze: { until: now + HOUR, note: 'did they reply?', action: 'remind', from: 'todo' } });
    });

    it('Snooze to the next morning gives Monday 9:00 AM in its zone when pressed on a Saturday', async () => {
      // Saturday 21 Nov, 10:00 AM in Los Angeles.
      const todo = await reminder(Date.UTC(2026, 10, 21, 18, 0));
      host.cards[0].answer({ answer: 'Snooze to the next morning' });
      await settle();
      expect(service.require(todo.number).snooze?.until).toBe(Date.UTC(2026, 10, 23, 17, 0));
    });

    it('Hand to an agent starts it, with the note and your words in the orchestrator’s first message', async () => {
      const todo = await reminder();
      host.cards[0].answer({ answer: 'Hand to an agent', note: 'chase them by email' });
      await settle();
      expect(service.require(todo.number)).toMatchObject({ state: 'in_progress', sessionId: 's1' });
      const [opening] = host.typedInto('s1-orch');
      expect(opening).toContain('did they reply?');
      expect(opening).toContain('chase them by email');
    });

    it('refuses a Remind me… time in the past and creates nothing', async () => {
      await expect(service.create({ title: 'Late', snooze: { until: START - 1, zone: ZONE } }, person)).rejects.toMatchObject({ code: 'todo_snooze_past' });
      expect(service.snapshot().rows).toEqual([]);
    });
  });

  it('S5: Just remind me on a to-do with a Session raises a card, wakes no agent and returns it to its earlier state', async () => {
    const todo = await running();
    service.snooze(todo.number, { until: START + HOUR, zone: ZONE, note: 'look at the dashboard', action: 'remind' }, person);
    await flushAll();
    await service.resumeOnLaunch();
    host.down.add('s1-orch');
    const before = host.typedInto('s1-orch').length;
    now = START + HOUR;
    await service.wakeTick();
    await flushAll();
    expect(host.cards).toEqual([expect.objectContaining({ kind: 'reminder', context: expect.stringContaining('look at the dashboard') })]);
    expect(service.require(todo.number).state).toBe('in_progress');
    expect(host.resumed).toEqual([]);
    expect(typedSince('s1-orch', before)).toEqual([]);
  });

  it('S5: after a restart, launch resume and the supervisor leave a Just-remind-me to-do alone while its card is out (QA round 9 F1)', async () => {
    const todo = await running();
    service.snooze(todo.number, { until: START + HOUR, zone: ZONE, note: 'look at the dashboard', action: 'remind' }, person);
    await flushAll();
    await service.resumeOnLaunch();
    now = START + HOUR;
    await service.wakeTick();
    await flushAll();
    expect(host.cards).toHaveLength(1);
    // Pane quits before the person answers: the card is gone and the orchestrator is down.
    now += 2 * 60_000;
    const { again, host2 } = restart();
    host2.down.add('s1-orch');
    const before = host2.typedInto('s1-orch').length;
    await again.resumeOnLaunch();
    await flushAll(again);
    now += 30 * 60_000;
    await again.supervisorPass();
    await flushAll(again);
    expect(host2.cards).toEqual([expect.objectContaining({ kind: 'reminder' })]);
    expect(host2.resumed).toEqual([]);
    expect(typedSince('s1-orch', before, host2)).toEqual([]);
  });

  describe('S6: Pane restarts past the time', () => {
    it('wakes once after launch resume, overdue by 3h, and its orchestrator is restarted once', async () => {
      const todo = await running();
      service.snooze(todo.number, { until: START + HOUR, zone: ZONE, note: 'check Sentry' }, person);
      await flushAll();
      now = START + 4 * HOUR;
      const { again, host2 } = restart();
      host2.down.add('s1-orch');
      await again.wakeTick();
      expect(again.require(todo.number).snooze).toBeDefined();
      await again.resumeOnLaunch();
      expect(host2.resumed).toEqual([]);
      await again.wakeTick();
      await again.wakeTick();
      await again.resumeOnLaunch('wake');
      expect(host2.resumed).toEqual(['s1-orch']);
      await flushAll(again);
      const typed = host2.typedInto('s1-orch');
      expect(typed).toHaveLength(1);
      expect(typed[0]).toContain('(snoozed until ');
      expect(typed[0]).toContain(', overdue by 3h: Pane was closed): check Sentry');
      expect(again.detail(todo.number).activity.map(row => row.body)).toContainEqual(expect.stringMatching(/^Woke at .*, overdue by 3h: Pane was closed$/));
    });

    it('raises again a reminder card lost in the restart, and its answer still works', async () => {
      const todo = await service.create({ title: 'Northwind', snooze: { until: START + HOUR, zone: ZONE, note: 'did they reply?' } }, person);
      await service.resumeOnLaunch();
      now = START + HOUR;
      await service.wakeTick();
      const lost = host.cards[0].id;
      now += HOUR;
      const { again, host2 } = restart();
      await again.resumeOnLaunch();
      expect(host2.cards).toEqual([expect.objectContaining({ kind: 'reminder', context: expect.stringContaining('did they reply?') })]);
      expect(host2.cards[0].id).not.toBe(lost);
      // Once that card waits (as an approval), another launch leaves it be.
      db.prepare(`INSERT INTO approvals (id, machine, connected_kind, connected_id, connected_name, origin_kind, addressee, state, item_json, created_at, todo_id)
        VALUES (?, 'm', 'machine', 'm', 'm', 'pane', 'person', 'waiting', '{"title":"Reminder: T-1 Northwind"}', 1, ?)`).run(host2.cards[0].id, todo.number);
      expect(again.detail(todo.number).status.status).toBe('waiting');
      const third = restart();
      await third.again.resumeOnLaunch();
      expect(third.host2.cards).toEqual([]);
      host2.cards[0].answer({ answer: 'Done' });
      await settle();
      expect(again.require(todo.number).state).toBe('done');
    });
  });

  it('S7: after the Mac sleeps past its time it wakes on the first tick, overdue by 14h, with one message and one restart', async () => {
    const todo = await running();
    service.snooze(todo.number, { until: START + HOUR, zone: ZONE, note: 'check Sentry' }, person);
    await flushAll();
    await service.resumeOnLaunch();
    await service.wakeTick();
    // Asleep: no ticks for 15 hours.
    now = START + 15 * HOUR;
    host.down.add('s1-orch');
    const before = host.typedInto('s1-orch').length;
    await service.wakeTick();
    // powerMonitor's resume runs launch resume 10 s later.
    now += 10_000;
    await service.resumeOnLaunch('wake');
    await flushAll();
    const typed = typedSince('s1-orch', before);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain('overdue by 14h: the Mac was asleep');
    expect(host.resumed).toEqual(['s1-orch']);
  });

  describe('S8: load', () => {
    async function holdGate() {
      host.load = { cpuPercent: 5, memory: 'warning' };
      for (let i = 0; i <= 3; i += 1) { await service.loadTick(); now += 10_000; }
      expect(service.gate.state).toBe('holding');
    }

    it('while the gate holds, a due to-do reads Queued, then wakes with its note when load comes down', async () => {
      const todo = await running();
      await running('Keeps the gate sampling');
      service.snooze(todo.number, { until: START + 2 * MINUTE, zone: ZONE, note: 'retry the deploy' }, person);
      await service.resumeOnLaunch();
      await holdGate();
      now = START + 3 * MINUTE;
      await service.wakeTick();
      expect(service.require(todo.number)).toMatchObject({ state: 'in_progress', loadHold: 'queued' });
      expect(service.snapshot().rows.find(row => row.todo.number === todo.number)?.status).toEqual({ status: 'queued', reason: 'This Mac is busy · starts when load comes down' });
      await flushAll();
      expect(host.typedInto('s1-orch').some(text => text.includes('Reminder for T-1'))).toBe(false);
      host.load = { cpuPercent: 5, memory: 'ok' };
      for (let i = 0; i <= 13; i += 1) { await service.loadTick(); now += 10_000; }
      expect(service.require(todo.number).loadHold).toBeNull();
      await flushAll();
      const reminders = host.typedInto('s1-orch').filter(text => text.includes('Reminder for T-1'));
      expect(reminders).toEqual([expect.stringContaining('retry the deploy')]);
      expect(host.typedInto('s1-orch').some(text => text.startsWith('[From the person, via To-dos T-1] Resume T-1'))).toBe(false);
    });

    it('Never pause wakes it at once while the gate holds', async () => {
      const todo = await running();
      await running('Keeps the gate sampling');
      service.setNeverPause(todo.number, true, person);
      service.snooze(todo.number, { until: START + 2 * MINUTE, zone: ZONE }, person);
      await service.resumeOnLaunch();
      await holdGate();
      now = START + 3 * MINUTE;
      await service.wakeTick();
      expect(service.require(todo.number)).toMatchObject({ state: 'in_progress', loadHold: null });
    });

    it('ten falling due at once wake three a tick', async () => {
      for (let i = 0; i < 10; i += 1) {
        const todo = await running(`Due ${i}`);
        service.snooze(todo.number, { until: START + HOUR, zone: ZONE }, person);
        host.down.add(`s${i + 1}-orch`);
      }
      await service.resumeOnLaunch();
      now = START + HOUR;
      const awake = () => service.snapshot().rows.filter(row => row.todo.state === 'in_progress').length;
      const counts: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        await service.wakeTick();
        counts.push(awake());
      }
      expect(counts).toEqual([3, 6, 9, 10]);
      expect(host.resumed).toHaveLength(10);
    });
  });

  describe('S9: comments while snoozed', () => {
    it('holds a comment, then delivers it inside the wake message and marks it delivered', async () => {
      const todo = await running();
      service.snooze(todo.number, { until: START + HOUR, zone: ZONE, note: 'check Sentry' }, person);
      await flushAll();
      const before = host.typedInto('s1-orch').length;
      const held = await service.comment(todo.number, 'use the blue one', person);
      expect(held).toMatchObject({ toTab: 's1-orch' });
      expect(held.deliveredAt).toBeUndefined();
      await flushAll();
      expect(typedSince('s1-orch', before)).toEqual([]);
      // Held across a restart too.
      const { again, host2 } = restart();
      await flushAll(again);
      expect(host2.typedInto('s1-orch')).toEqual([]);

      await service.resumeOnLaunch();
      now = START + HOUR;
      await service.wakeTick();
      await flushAll();
      const typed = typedSince('s1-orch', before);
      expect(typed).toHaveLength(1);
      expect(typed[0]).toContain('Reminder for T-1');
      expect(typed[0]).toContain('While it was snoozed, the person wrote:\n- use the blue one');
      expect(service.detail(todo.number).activity.find(row => row.id === held.id)?.deliveredAt).toBe(now);
    });

    it('Wake now and send: waking early delivers the held comment at once', async () => {
      const todo = await running();
      service.snooze(todo.number, { until: START + 5 * HOUR, zone: ZONE }, person);
      await flushAll();
      const before = host.typedInto('s1-orch').length;
      await service.comment(todo.number, 'actually, go now', person);
      await service.wake(todo.number, person);
      await flushAll();
      const typed = typedSince('s1-orch', before);
      expect(typed).toEqual([expect.stringContaining('actually, go now')]);
      expect(typed[0]).toContain('woken early by you');
      expect(events(todo.number)).toContain('Woken early by you');
    });
  });

  describe('S10: every action on a snoozed to-do', () => {
    it('Wake now, Resume and Start wake it early, logged in the thread', async () => {
      const first = await running('First');
      service.snooze(first.number, { until: START + HOUR, zone: ZONE }, person);
      expect((await service.wake(first.number, person)).state).toBe('in_progress');
      expect(events(first.number).at(-1)).toBe('Woken early by you');

      const second = await running('Second');
      service.snooze(second.number, { until: START + HOUR, zone: ZONE }, person);
      expect((await service.resume(second.number, person)).todo).toMatchObject({ state: 'in_progress' });
      expect(service.require(second.number).snooze).toBeUndefined();
      expect(events(second.number)).toContain('Woken early by you');

      const reminder = await service.create({ title: 'Reminder', snooze: { until: START + HOUR, zone: ZONE, note: 'call them' } }, person);
      await service.start(reminder.number, person);
      expect(service.require(reminder.number)).toMatchObject({ state: 'in_progress', sessionId: 's3' });
      expect(service.require(reminder.number).snooze).toBeUndefined();
      expect(host.typedInto('s3-orch')[0]).toContain('call them');
    });

    it('Wake now on a pure reminder raises its card, as its time would', async () => {
      const reminder = await service.create({ title: 'Reminder', snooze: { until: START + HOUR, zone: ZONE, note: 'call them' } }, person);
      await service.wake(reminder.number, person);
      expect(host.cards).toEqual([expect.objectContaining({ kind: 'reminder' })]);
      expect(service.require(reminder.number).state).toBe('todo');
    });

    it('Stop, Done and Drop clear the snooze', async () => {
      for (const action of ['stop', 'done', 'drop'] as const) {
        const todo = await running(action);
        service.snooze(todo.number, { until: START + HOUR, zone: ZONE }, person);
        if (action === 'stop') service.stop(todo.number, person);
        else if (action === 'done') service.done(todo.number, {}, person);
        else service.drop(todo.number, {}, person);
        const after = service.require(todo.number);
        expect(after.state).toBe({ stop: 'stopped', done: 'done', drop: 'dropped' }[action]);
        expect(after.snooze).toBeUndefined();
      }
      expect(service.snapshot().rows.some(row => row.status.status === 'snoozed')).toBe(false);
    });

    it('Change replaces the time and the note, keeps where it came from, and logs it', async () => {
      const todo = await running();
      service.snooze(todo.number, { until: START + HOUR, zone: ZONE, note: 'first' }, person);
      const changed = service.snooze(todo.number, { until: START + 3 * HOUR, zone: ZONE, note: 'second' }, person);
      expect(changed.snooze).toMatchObject({ until: START + 3 * HOUR, note: 'second', from: 'in_progress' });
      expect(events(todo.number).at(-1)).toMatch(/^Snooze changed to .* by you: second$/);
      await flushAll();
      expect(host.typedInto('s1-orch').filter(text => text.includes('Snoozed T-1'))).toHaveLength(1);
    });
  });

  it('S12: setting the clock back never wakes it early; setting it forward wakes what is now due', async () => {
    const todo = await running();
    service.snooze(todo.number, { until: START + 30 * MINUTE, zone: ZONE }, person);
    await service.resumeOnLaunch();
    now = START - HOUR;
    await service.wakeTick();
    expect(service.require(todo.number).snooze).toBeDefined();
    now = START + HOUR;
    await service.wakeTick();
    expect(service.require(todo.number).state).toBe('in_progress');
  });

  it('S13: refuses a past time, an unknown zone, over a year out, a sub-to-do, In review, Accepted and Done, changing nothing', async () => {
    const todo = await running();
    const sub = await service.create({ title: 'Sub', parentNumber: todo.number }, person);
    const before = service.require(todo.number);
    const attempt = (number: number, until: number, zone = ZONE) => () => service.snooze(number, { until, zone }, person);
    const refused = (code: string, next: RegExp = /./) => expect.objectContaining({ code, next: expect.stringMatching(next) });
    expect(attempt(todo.number, START - 1)).toThrow(refused('todo_snooze_past'));
    expect(attempt(todo.number, START + 400 * 24 * HOUR)).toThrow(refused('todo_snooze_time'));
    expect(attempt(todo.number, START + HOUR, 'Mars/Olympus')).toThrow(refused('todo_snooze_time'));
    expect(attempt(sub.number, START + HOUR)).toThrow(refused('todo_snooze_state', /snooze its parent T-1/));
    expect(service.require(todo.number)).toEqual(before);
    expect(service.require(sub.number).snooze).toBeUndefined();
    for (const state of ['in_review', 'accepted', 'done'] as const) {
      db.prepare('UPDATE todos SET state = ? WHERE number = ?').run(state, todo.number);
      expect(attempt(todo.number, START + HOUR)).toThrow(refused('todo_snooze_state'));
      expect(service.require(todo.number).snooze).toBeUndefined();
    }
  });
});
