import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from '../configManager';
import type { AppConfig } from '../../types/config';
import { NotifyService } from './notifyService';
import Database from 'better-sqlite3-multiple-ciphers';
import type { TerminalAgentReport } from '../../../../shared/types/panels';
import type { RunpaneInboxItem } from '../../../../shared/types/runpaneOrchestration';
import { TodoService } from '../todos/todoService';
import { FakeHost } from '../todos/todoTestHost';
import { TodoStore } from '../todos/todoStore';
import { activeTodoService } from '../todos/todosFeature';

describe('NotifyService in-use poll', () => {
  let idleSeconds: number;
  let reads: number;
  let service: NotifyService;
  let config: AppConfig;
  let configManager: EventEmitter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1');
    // Away when Pane starts: the start-up sweep reads that.
    idleSeconds = 600;
    reads = 0;
    config = { machineId: 'mini' };
    class FakeConfigManager extends EventEmitter {
      getConfig(): AppConfig { return config; }
    }
    configManager = new FakeConfigManager();
    service = new NotifyService({
      // SAFETY: NotifyService reads only getConfig() and 'config-updated' from its ConfigManager.
      configManager: configManager as ConfigManager,
      getMainWindow: () => null,
      findPane: () => undefined,
      rendererArguments: () => [],
      headless: true,
      machine: 'mini',
      publish: () => {},
      sendToMachine: async () => {},
      refreshMachine: async () => {},
      idleSeconds: () => { reads += 1; return idleSeconds; },
    });
    service.queue.setPaneFocused(true);
  });

  afterEach(() => {
    service.dispose();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('does not read whether the computer is in use while nothing waits', async () => {
    reads = 0;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(reads).toBe(0);
  });

  it('redraws within 5 seconds when the person leaves after a question arrives, though they came back unpolled', async () => {
    idleSeconds = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    void service.queue.ask({ question: { ui: 'ask', title: 'Ship it?' }, source: { name: 'feature', agent: 'Claude', paneId: 'p1', panelId: 't1' } });
    expect(service.queue.snapshot().stripSurface).toBe('pane');

    const changes = vi.fn();
    service.queue.on('change', changes);
    idleSeconds = 600;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(changes).toHaveBeenCalled();
    expect(service.queue.snapshot().stripSurface).toBeNull();
  });

  it('reads in use again when Approvals come back on with a saved question', async () => {
    idleSeconds = 0;
    // Asked an hour ago, so it is past its quiet grace and on the strip.
    service.queue.addWorkerQuestion({ id: 'q1', question: 'Ship it?', source: { name: 'feature', agent: 'Claude', paneId: 'p1', panelId: 't1' }, at: Date.now() - 3_600_000 });
    const setApprovals = (enabled: boolean) => {
      config = { ...config, notify: { ...config.notify, enabled } };
      configManager.emit('config-updated', config);
    };
    setApprovals(false);
    await vi.advanceTimersByTimeAsync(10_000);
    setApprovals(true);
    reads = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBeGreaterThanOrEqual(2);
  });
});

describe('NotifyService links in a card', () => {
  let service: NotifyService | undefined;
  afterEach(() => {
    service?.dispose();
    vi.unstubAllEnvs();
  });

  function withSetting(openLinksIn: 'pane' | 'system') {
    vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1');
    const navigated = vi.fn();
    const opened = vi.fn(async () => undefined);
    // The main window, with only what navigating uses.
    const window: BrowserWindow = Object.assign(Object.create(BrowserWindow.prototype), { isDestroyed: () => false, isMinimized: () => false, restore: () => {}, show: () => {}, focus: () => {}, webContents: { send: navigated } });
    class FakeConfigManager extends EventEmitter {
      getConfig(): AppConfig { return { machineId: 'mini' }; }
    }
    service = new NotifyService({
      // SAFETY: NotifyService reads only getConfig() and 'config-updated' from its ConfigManager.
      configManager: new FakeConfigManager() as ConfigManager,
      getMainWindow: () => window,
      findPane: () => undefined,
      rendererArguments: () => [],
      headless: true,
      machine: 'mini',
      publish: () => {},
      sendToMachine: async () => {},
      refreshMachine: async () => {},
      linksOpenIn: () => openLinksIn,
      openExternal: opened,
    });
    void service.queue.ask({ question: { ui: 'info', title: 'Preview is up' }, source: { name: 'feature', agent: 'Claude', paneId: 'p1', panelId: 't1' } });
    const id = service.queue.snapshot().items[0]?.id ?? '';
    return { service, id, navigated, opened };
  }

  it('opens a card\'s link beside its Pane in the main window, raised', async () => {
    const { service, id, navigated, opened } = withSetting('pane');
    await service.run({ type: 'open-url', id, url: 'https://example.com/preview' });
    expect(navigated).toHaveBeenCalledWith('notify:navigate', { link: 'https://example.com/preview', paneId: 'p1' });
    expect(opened).not.toHaveBeenCalled();
  });

  it('opens a card\'s link in the system browser when Settings > Links says so', async () => {
    const { service, id, navigated, opened } = withSetting('system');
    await service.run({ type: 'open-url', id, url: 'https://example.com/preview' });
    expect(opened).toHaveBeenCalledWith('https://example.com/preview');
    expect(navigated).not.toHaveBeenCalled();
  });
});

describe('NotifyService: a remote member\'s --todo (T-51, D-1 C, D-4)', () => {
  let service: NotifyService | undefined;
  const dbs: Database.Database[] = [];
  afterEach(() => {
    service?.dispose();
    for (const db of dbs.splice(0)) db.close();
    vi.unstubAllEnvs();
  });

  /** A machine's to-dos up to T-28, its T-28 titled `title`. */
  async function machineWithT28(title: string, installId: string | undefined) {
    const db = new Database(':memory:');
    dbs.push(db);
    const host = new FakeHost();
    host.installIdValue = installId;
    const todos = new TodoService(new TodoStore(db), host, () => Date.UTC(2026, 10, 24, 9, 0));
    for (let i = 1; i < 28; i += 1) await todos.create({ title: `Filler ${i}`, startNow: false }, { kind: 'person' });
    await todos.create({ title, startNow: false }, { kind: 'person' });
    return todos;
  }

  /** Machine A's Notify, holding a blocked report from a member Pane on the MacBook. */
  function sessionMachine(todos: TodoService, report: TerminalAgentReport, todosOn = true) {
    vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1');
    class FakeConfigManager extends EventEmitter {
      getConfig(): AppConfig { return { machineId: 'install-a', todosEnabled: todosOn }; }
    }
    const entry: RunpaneInboxItem = { id: 'in-1', sessionId: 'sess-a', kind: 'report', at: new Date(Date.UTC(2026, 10, 24, 9, 0)).toISOString(), paneId: 'pane-b', paneName: 'Signup', panelId: 'tab-b', agentType: 'claude', report };
    const configManager = new FakeConfigManager();
    service = new NotifyService({
      // SAFETY: NotifyService reads only getConfig() and 'config-updated' from its ConfigManager.
      configManager: configManager as ConfigManager,
      getMainWindow: () => null,
      findPane: () => undefined,
      rendererArguments: () => [],
      headless: true,
      machine: 'mini',
      publish: () => {},
      sendToMachine: async () => {},
      refreshMachine: async () => {},
      memberMachine: (paneId) => (paneId === 'pane-b' ? 'tylers-macbook-pro' : undefined),
      // As main wires it (ipc/notify.ts): the to-do service only while To-dos is on.
      todoOf: (panelId, explicit) => activeTodoService({ todoService: todos, configManager })?.todoLinkFor(panelId, explicit),
      sessionRecord: () => ({ name: 'Firecracker Grain', paneId: 'owner-a', archived: false }),
      inbox: { all: () => [entry], subscribe: () => () => {}, subscribeEnded: () => () => {} },
    });
    return service.queue.snapshot().items.find(item => item.id === 'in-1');
  }

  it('both machines have a T-28: the card on the Session\'s machine links its own T-28, and the worker\'s T-28 is untouched', async () => {
    const worker = await machineWithT28('Phone-number sign-up, sign-in and invites', 'install-b');
    const session = await machineWithT28('Accept Google Cloud\'s HIPAA BAA', 'install-a');
    const workersOwn = worker.require(28);
    // On the MacBook: the Pane is in no Session there, so its check writes nothing.
    const check = worker.checkReportTodo('tab-b', 'T-28', false);
    expect(check.link).toBeUndefined();
    expect(worker.require(28)).toEqual(workersOwn);
    // On the mini: the report arrives with the MacBook's install id, and links the mini's T-28.
    const card = sessionMachine(session, { state: 'blocked', question: 'Q-84: Phone-number accounts: go?', todo: 'T-28', installId: 'install-b', reportedAt: new Date().toISOString() });
    expect(card?.todo).toEqual({ number: 28, title: 'Accept Google Cloud\'s HIPAA BAA', installId: 'install-a' });
    expect(card?.source.name).toBe('Signup on tylers-macbook-pro');
  });

  it('a number the Session\'s machine has no open to-do for leaves the card unlinked, and says why in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = await machineWithT28('Mine', 'install-a');
    const card = sessionMachine(session, { state: 'blocked', question: 'Q-2: go?', todo: 'T-99', installId: 'install-b', reportedAt: new Date().toISOString() });
    expect(card).toBeDefined();
    expect(card?.todo).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('A worker on tylers-macbook-pro asked about T-99, which is no open to-do on this machine'));
    warn.mockRestore();
  });

  it('an older worker machine sends no install id: the Session\'s machine still links its own T-28', async () => {
    const session = await machineWithT28('Accept Google Cloud\'s HIPAA BAA', 'install-a');
    const card = sessionMachine(session, { state: 'blocked', question: 'Q-84: go?', todo: 'T-28', reportedAt: new Date().toISOString() });
    expect(card?.todo).toMatchObject({ number: 28, title: 'Accept Google Cloud\'s HIPAA BAA' });
  });

  it('To-dos off on the Session\'s machine: the card shows with no to-do link and its T-28 is untouched', async () => {
    const session = await machineWithT28('Accept Google Cloud\'s HIPAA BAA', 'install-a');
    const before = session.require(28);
    const card = sessionMachine(session, { state: 'blocked', question: 'Q-84: go?', todo: 'T-28', installId: 'install-b', reportedAt: new Date().toISOString() }, false);
    expect(card).toBeDefined();
    expect(card?.todo).toBeUndefined();
    expect(session.require(28)).toEqual(before);
  });
});
