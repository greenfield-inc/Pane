import Database from 'better-sqlite3-multiple-ciphers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TodoService } from './todoService';
import { TodoStore } from './todoStore';
import { FakeHost } from './todoTestHost';

const NOW = Date.UTC(2026, 10, 16, 12, 0);

interface Timed<T> {
  value: T;
  ms: number;
}

/** The plan's size budget: 2,000 to-dos (1,600 closed), 20,000 chat rows, 10,000 attachments on one machine. */
describe('to-dos size budget', () => {
  let db: Database.Database;
  let service: TodoService;
  let host: FakeHost;

  beforeAll(() => {
    db = new Database(':memory:');
    const store = new TodoStore(db);
    host = new FakeHost();
    for (let index = 0; index < 50; index += 1) {
      host.sessions.set(`s${index}`, { id: `s${index}`, name: `Session ${index}`, orchestratorPanelId: `o${index}`, archived: false, paneIds: [`p${index}`] });
      host.panels.set(`o${index}`, { name: 'orchestrator', sessionId: `s${index}`, orchestrator: true });
    }
    store.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) {
        const closed = index < 1_600;
        const todo = store.create({ title: `To-do ${index}`, sessionId: `s${index % 50}`, state: closed ? 'done' : 'in_progress', requester: { kind: 'person', name: 'you' }, createdBy: 'you', now: NOW - 3_600_000 });
        if (closed) store.update(todo.number, { closedAt: NOW - (index % 20) * 86_400_000 }, NOW - 1000);
        else store.update(todo.number, { startedAt: NOW - 3_600_000, lastProgressAt: NOW - 60_000 }, NOW - 1000);
      }
      for (let index = 0; index < 20_000; index += 1) store.addActivity({ todoNumber: (index % 2_000) + 1, kind: 'event', authorKind: 'pane', authorName: 'Pane', body: `Event ${index}`, now: NOW - index });
      for (let index = 0; index < 10_000; index += 1) store.attach({ todoNumber: (index % 2_000) + 1, kind: 'doc', target: `/docs/${index}.md`, label: `${index}.md`, addedBy: 'agent', source: 'attached', now: NOW - index });
      // One to-do with 200 own attachments.
      for (let index = 0; index < 195; index += 1) store.attach({ todoNumber: 1_999, kind: 'doc', target: `/big/${index}.md`, label: `${index}.md`, addedBy: 'agent', source: 'attached', now: NOW });
    });
    service = new TodoService(store, host, () => NOW);
  });
  afterAll(() => db.close());

  function timed<T>(run: () => T): Timed<T> {
    const start = performance.now();
    const value = run();
    return { value, ms: performance.now() - start };
  }

  it('reads the Open list in under 150 ms', () => {
    service.snapshot();
    const { value, ms } = timed(() => service.snapshot());
    expect(value.rows.filter(row => row.status.status !== 'done')).toHaveLength(400);
    expect(ms).toBeLessThan(150);
  });

  it('reads a to-do with 200 attachments in under 100 ms', () => {
    const { value, ms } = timed(() => service.detail(1_999));
    expect(value.attachments[0].attachments.length).toBeGreaterThanOrEqual(200);
    expect(ms).toBeLessThan(100);
  });

  it('runs a supervisor pass in under 20 ms', async () => {
    let now = NOW;
    const supervisor = new TodoService(new TodoStore(db), host, () => now);
    await supervisor.supervisorPass();
    now += 61_000;
    const start = performance.now();
    await supervisor.supervisorPass();
    expect(performance.now() - start).toBeLessThan(20);
  });
});
