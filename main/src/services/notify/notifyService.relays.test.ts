import { EventEmitter } from 'events';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from '../configManager';
import type { AppConfig } from '../../types/config';
import type { NotifySource } from '../../../../shared/types/notify';
import type { RunpaneWorkspaceEntry } from '../../../../shared/types/runpaneOrchestration';
import { ApprovalStore } from '../approvals/approvalStore';
import { SessionInbox } from '../sessionInbox';
import { WorkspaceJournal } from '../workspaceJournal';
import { NotifyService, sameWorkerQuestion } from './notifyService';

type Entry = Omit<RunpaneWorkspaceEntry, 'gen' | 'at'>;

const orchestrator: NotifySource = { name: 'Session: Sales', agent: 'Claude', paneId: 'sp', panelId: 'orch', session: { id: 'session-a', name: 'Sales', paneId: 'sp', orchestrator: true } };

/** #1353: a worker re-reporting while its relayed question card is live. */
describe('NotifyService relayed worker questions', () => {
  let db: Database.Database;
  let store: ApprovalStore;
  let journal: WorkspaceJournal;
  let inbox: SessionInbox;
  let typed: Array<[string, string]>;
  const services: NotifyService[] = [];

  const start = () => {
    const config: AppConfig = { machineId: 'mini' };
    class FakeConfigManager extends EventEmitter {
      getConfig(): AppConfig { return config; }
    }
    const service = new NotifyService({
      // SAFETY: NotifyService reads only getConfig() and 'config-updated' from its ConfigManager.
      configManager: new FakeConfigManager() as ConfigManager,
      getMainWindow: () => null,
      findPane: () => undefined,
      rendererArguments: () => [],
      headless: true,
      machine: 'mini',
      publish: () => {},
      sendToMachine: async () => {},
      refreshMachine: async () => {},
      inbox,
      store,
      typeIntoTab: async (panelId, text) => {
        typed.push([panelId, text]);
        return 'delivered';
      },
    });
    services.push(service);
    return service;
  };
  const report = (extra: Partial<NonNullable<Entry['report']>> & { state: NonNullable<Entry['report']>['state'] }) => {
    journal.append({ kind: 'agent.report', paneId: 'wp', paneName: 'workos-sso', panelId: 'w1', agentType: 'claude', source: 'agent', report: { reportedAt: new Date().toISOString(), ...extra } });
    const items = inbox.list('session-a');
    return items[items.length - 1];
  };
  const waiting = (service: NotifyService) => service.queue.snapshot().items.filter(item => item.state === 'waiting');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1');
    db = new Database(':memory:');
    store = new ApprovalStore(db, 'mini');
    journal = new WorkspaceJournal();
    inbox = new SessionInbox(store, { sessionIdsFor: () => ['session-a'], itemsPerSession: () => 10 });
    inbox.attach(journal);
    typed = [];
  });

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    inbox.dispose();
    db.close();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('keeps the card, its relaying call and its answer route when the worker asks the same question again', async () => {
    const service = start();
    const first = report({ state: 'blocked', question: 'Q-3: Which invoice field?' });
    const relayed = service.queue.ask({ question: { ui: 'options', title: 'Q-3: Invoice id or number?', choices: [{ label: 'id' }, { label: 'number' }] }, relays: first.id, source: orchestrator });

    const second = report({ state: 'blocked', question: 'Q-3: Which invoice field? (still blocked)' });
    expect(second.id).not.toBe(first.id);
    const cards = waiting(service);
    expect(cards.map(card => [card.id, card.reportId, card.title])).toEqual([[first.id, second.id, 'Q-3: Invoice id or number?']]);
    expect(cards[0].relayedBy?.panelId).toBe('orch');

    // A third re-ask keeps it too, and the newest inbox id still finds the card.
    const third = report({ state: 'blocked', question: 'Q-3: Which invoice field?' });
    expect(waiting(service).map(card => [card.id, card.reportId])).toEqual([[first.id, third.id]]);
    const again = service.queue.ask({ question: { ui: 'options', title: 'Q-3: Invoice id or number?', choices: [{ label: 'id' }, { label: 'number' }] }, relays: third.id, source: orchestrator });

    service.queue.run({ type: 'answer', id: first.id, answer: { text: 'number' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await again).toMatchObject({ answer: 'number' });
    expect(await Promise.race([relayed, Promise.resolve('still waiting')])).toMatchObject({ unavailable: 'Another notify call is now waiting on this question.' });
    expect(typed).toEqual([['w1', 'answer: Q-3 → number (by you)']]);
    // The orchestrator records the D-n on the newest inbox item, and the card carries it.
    inbox.ack([third.id], 'session-a', 'D-4');
    expect(service.queue.snapshot().items.find(card => card.id === first.id)?.decision).toBe('D-4');
  });

  it('does not card a carried-over report again after a restart', () => {
    const before = start();
    const first = report({ state: 'blocked', question: 'Should I migrate?' });
    const second = report({ state: 'blocked', question: '  should I   migrate? ' });
    expect(waiting(before).map(card => [card.id, card.reportId])).toEqual([[first.id, second.id]]);
    before.dispose();

    const after = start();
    expect(waiting(after).map(card => [card.id, card.reportId])).toEqual([[first.id, second.id]]);
  });

  it('closes the card as before when the worker finishes', async () => {
    const service = start();
    const first = report({ state: 'blocked', question: 'Q-3: Which invoice field?' });
    const relayed = service.queue.ask({ question: { ui: 'ask', title: 'Q-3: Which invoice field?' }, relays: first.id, source: orchestrator });
    report({ state: 'done', summary: 'Went with the number.' });
    expect(await relayed).toEqual({ unavailable: 'Closed: the worker moved on.', next: 'Carry on without it. Ask again only if something has changed.' });
    expect(waiting(service)).toEqual([]);
    expect(service.queue.snapshot().items.find(card => card.id === first.id)?.closed?.reason).toBe('the worker moved on');
  });

  it('replaces the card cleanly when the worker asks a different question', async () => {
    const service = start();
    const first = report({ state: 'blocked', question: 'Q-3: Which invoice field?' });
    const relayed = service.queue.ask({ question: { ui: 'ask', title: 'Q-3: Which invoice field?' }, relays: first.id, source: orchestrator });
    const second = report({ state: 'blocked', question: 'Q-4: Which currency?' });
    expect(await relayed).toEqual({ unavailable: 'Closed: the worker asked a new question.', next: `Relay its new question with \`runpane notify --relays ${second.id}\`.` });
    expect(service.queue.snapshot().items.find(card => card.id === first.id)?.closed?.reason).toBe('the worker asked a new question');
    const cards = waiting(service);
    expect(cards.map(card => [card.id, card.title, card.reportId])).toEqual([[second.id, 'Q-4: Which currency?', undefined]]);
  });
});

describe('sameWorkerQuestion', () => {
  it('matches the same Q-n, or the same words when there is none', () => {
    expect(sameWorkerQuestion('Q-3: Which field?', 'Q-3: Which field, id or number?')).toBe(true);
    expect(sameWorkerQuestion('Q-3: Which field?', 'Q-4: Which field?')).toBe(false);
    expect(sameWorkerQuestion('Q-3: Which field?', 'Which field?')).toBe(false);
    expect(sameWorkerQuestion('Which  field?', 'which field? ')).toBe(true);
    expect(sameWorkerQuestion('Which field?', 'Which currency?')).toBe(false);
  });
});
