import { describe, expect, it } from 'vitest';
import { SessionController, type ConversationRecord, type RuntimeDriver } from './sessionController';

const original: ConversationRecord = {
  panelId: 'panel-a', workspaceId: 'workspace-a', provider: 'claude',
  nativeSessionId: 'conversation-a', generation: 1, active: 'terminal', preferred: 'terminal',
};

/** Test provider: the external agent can delay release independently of Pane. */
function provider() {
  const owners = new Set(['terminal']);
  let release: (() => void) | undefined;
  const driver: RuntimeDriver = {
    preflight: async () => undefined,
    checkpoint: async () => ({ ready: true }),
    release: async () => new Promise<void>(resolve => {
      release = () => { owners.delete('terminal'); resolve(); };
    }),
    acquire: async (_record, mode) => {
      if (owners.size) throw new Error('Conversation already has a writer');
      owners.add(mode);
      return { nativeSessionId: 'conversation-a', historyVerified: true };
    },
  };
  return { driver, owners, release: () => release?.() };
}

function storage() {
  let saved = structuredClone(original);
  return { read: () => structuredClone(saved), write: (record: ConversationRecord) => { saved = structuredClone(record); } };
}

describe('conversation runtime handoff', () => {
  it('retains a durably returned fork when its history load fails instead of restoring an old identity', async () => {
    const store = storage();
    const released: string[] = [];
    const driver: RuntimeDriver = {
      preflight: async () => undefined,
      checkpoint: async () => ({ ready: false, reason: 'Running' }),
      release: async (_record, mode) => { released.push(mode); },
      acquire: async (_record, mode) => {
        expect(mode).toBe('chat');
        store.write({ ...store.read(), nativeSessionId: 'durable-fork' });
        throw new Error('History transport disconnected');
      },
    };
    const controller = new SessionController(store, driver);
    await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_HANDOFF_FAILED' });
    expect(controller.snapshot()).toMatchObject({ active: 'stopped', nativeSessionId: 'durable-fork', generation: 2 });
    expect(released).toEqual(['terminal', 'chat']);
  });
  it('preserves a running turn when both interfaces attach to the same verified provider owner', async () => {
    const store = storage();
    const driver: RuntimeDriver = {
      preflight: async () => undefined,
      handoff: async record => ({ nativeSessionId: record.nativeSessionId, historyVerified: true }),
      checkpoint: async () => { throw new Error('Must not wait for a checkpoint'); },
      release: async () => { throw new Error('Must not stop the shared owner'); },
      acquire: async () => { throw new Error('Must not start a second owner'); },
    };
    const controller = new SessionController(store, driver);
    await controller.switchTo('chat', 1);
    expect(controller.snapshot()).toMatchObject({ active: 'chat', nativeSessionId: 'conversation-a', generation: 2 });
    await controller.switchTo('terminal', 2);
    expect(controller.snapshot()).toMatchObject({ active: 'terminal', nativeSessionId: 'conversation-a', generation: 3 });
  });
  it('stops an active original before forking and returns to the fork in the same tab', async () => {
    const store = storage();
    let running = true;
    const owners = new Set(['terminal']);
    const driver: RuntimeDriver = {
      preflight: async () => undefined,
      checkpoint: async () => ({ ready: false, reason: 'The original is responding' }),
      release: async (_record, mode) => { running = false; owners.delete(mode); },
      acquire: async (record, mode) => {
        expect(running).toBe(false);
        expect(owners.size).toBe(0);
        owners.add(mode);
        if (mode === 'chat') return { nativeSessionId: 'fork-b', historyVerified: true, forked: true };
        expect(record.nativeSessionId).toBe('fork-b');
        return { nativeSessionId: record.nativeSessionId, historyVerified: true };
      },
    };
    const controller = new SessionController(store, driver);
    await controller.switchTo('chat', 1);
    expect(controller.snapshot()).toMatchObject({ panelId: 'panel-a', active: 'chat', nativeSessionId: 'fork-b', generation: 2 });
    expect(controller.snapshot().pendingSwitch).toBeUndefined();
    await controller.switchTo('terminal', 2);
    expect(controller.snapshot()).toMatchObject({ panelId: 'panel-a', active: 'terminal', nativeSessionId: 'fork-b', generation: 3 });
    expect([...owners]).toEqual(['terminal']);
  });
  it('requires explicit recovery after a host restart and verifies both possible owners before resuming the exact id', async () => {
    const store = storage();
    store.write({ ...original, active: 'chat', preferred: 'chat' });
    const owners = new Set<string>();
    const driver: RuntimeDriver = {
      preflight: async () => undefined,
      checkpoint: async () => ({ ready: true }),
      release: async (_record, mode) => { if (owners.has(mode)) throw new Error('Previous owner still alive'); },
      acquire: async record => {
        expect(owners.size).toBe(0);
        owners.add('chat');
        return { nativeSessionId: record.nativeSessionId, historyVerified: true };
      },
    };
    const controller = new SessionController(store, driver);
    expect(controller.snapshot().active).toBe('stopped');
    expect(owners.size).toBe(0);
    await controller.recover('chat', 1);
    expect(controller.snapshot()).toMatchObject({ active: 'chat', generation: 2, nativeSessionId: 'conversation-a' });
    expect([...owners]).toEqual(['chat']);
  });
  it('freezes input before checking transferability and cancelling work that raced preflight', async () => {
    const store = storage();
    let working = false;
    const owners = new Set(['terminal']);
    const driver: RuntimeDriver = {
      preflight: async () => { working = true; },
      checkpoint: async () => {
        expect(() => controller.assertWritable(1)).toThrow(/switch/i);
        return { ready: false, reason: 'A new turn arrived' };
      },
      release: async (_record, mode) => { working = false; owners.delete(mode); },
      acquire: async (_record, mode, options) => {
        expect(working).toBe(false);
        expect(owners.size).toBe(0);
        expect(options).toEqual({ fork: true });
        owners.add(mode);
        return { nativeSessionId: 'fork-after-race', historyVerified: true, forked: true };
      },
    };
    const controller = new SessionController(store, driver);
    await controller.switchTo('chat', 1);
    expect(controller.snapshot()).toMatchObject({ active: 'chat', nativeSessionId: 'fork-after-race', generation: 2 });
  });
  it('leaves the source usable when preflight fails or the feature is disabled', async () => {
    const runtime = provider();
    runtime.driver.preflight = async () => { throw new Error('Adapter missing'); };
    const controller = new SessionController(storage(), runtime.driver);
    await expect(controller.switchTo('chat', 1)).rejects.toThrow('Adapter missing');
    expect(controller.snapshot()).toEqual(original);
    expect(() => controller.assertWritable(1)).not.toThrow();
    const disabled = new SessionController(storage(), runtime.driver, () => false);
    await expect(disabled.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_DISABLED' });
    expect(disabled.snapshot()).toEqual(original);
    expect([...runtime.owners]).toEqual(['terminal']);
  });

  it('does not resume another writer after an ambiguous release, including after host restart', async () => {
    const store = storage();
    const runtime = provider();
    runtime.driver.release = async () => { throw new Error('Agent child still alive'); };
    const controller = new SessionController(store, runtime.driver);
    await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_OWNERSHIP_UNCERTAIN' });
    expect([...runtime.owners]).toEqual(['terminal']);
    expect(controller.snapshot()).toMatchObject({ active: 'stopped', nativeSessionId: 'conversation-a' });
    const restarted = new SessionController(store, runtime.driver);
    await expect(restarted.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_TRANSITION_IN_PROGRESS' });
    expect([...runtime.owners]).toEqual(['terminal']);
  });

  it('leaves a crash during target loading in recovery without automatically acquiring anything', () => {
    const store = storage();
    store.write({ ...original, transition: { source: 'terminal', target: 'chat', phase: 'loading' } });
    const runtime = provider();
    const restarted = new SessionController(store, runtime.driver);
    expect(restarted.snapshot()).toMatchObject({ active: 'stopped' });
    expect(restarted.snapshot().recovery).toMatch(/interrupted/i);
    expect([...runtime.owners]).toEqual(['terminal']);
  });

  it('recovers the exact source after a failed load only when the target has released ownership', async () => {
    const store = storage();
    const owners = new Set(['terminal']);
    const driver: RuntimeDriver = {
      preflight: async () => undefined,
      checkpoint: async () => ({ ready: true }),
      release: async (_record, mode) => { owners.delete(mode); },
      acquire: async (record, mode) => {
        if (owners.size) throw new Error('Duplicate writer');
        owners.add(mode);
        if (mode === 'chat') throw new Error('Adapter failed during history replay');
        expect(record.nativeSessionId).toBe('conversation-a');
        return { nativeSessionId: record.nativeSessionId, historyVerified: true };
      },
    };
    const controller = new SessionController(store, driver);
    await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_HANDOFF_FAILED' });
    expect([...owners]).toEqual(['terminal']);
    expect(controller.snapshot()).toMatchObject({ active: 'terminal', preferred: 'chat', generation: 2 });
    expect(controller.snapshot().transition).toBeUndefined();
  });

  it('keeps all callers frozen until the source has released the exact conversation', async () => {
    const runtime = provider();
    const controller = new SessionController(storage(), runtime.driver);
    const pending = controller.switchTo('chat', 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.snapshot()).toMatchObject({ active: 'terminal', transition: { phase: 'releasing', target: 'chat' } });
    expect(() => controller.assertWritable(1)).toThrow(/switch/i);
    await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_TRANSITION_IN_PROGRESS' });
    expect([...runtime.owners]).toEqual(['terminal']);
    runtime.release();
    await pending;
    expect(controller.snapshot()).toMatchObject({ active: 'chat', generation: 2, nativeSessionId: 'conversation-a' });
    expect(controller.snapshot().transition).toBeUndefined();
    expect(() => controller.assertWritable(1)).toThrow(/changed/i);
    expect(() => controller.assertWritable(2)).not.toThrow();
  });
});

it('freezes all senders before stop and refuses a concurrent switch until cleanup finishes', async () => {
  const runtime = provider();
  const controller = new SessionController(storage(), runtime.driver);
  let finish: (() => void) | undefined;
  const stopped = controller.stop(() => new Promise<void>(resolve => { finish = resolve; }));
  expect(() => controller.assertWritable(1)).toThrow();
  await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_TRANSITION_IN_PROGRESS' });
  finish?.();
  await stopped;
  expect(controller.snapshot()).toMatchObject({ active: 'stopped', generation: 2 });
  expect(controller.snapshot().recovery).toBeUndefined();
});

it('releases a failed recovery target before leaving the exact conversation stopped', async () => {
  const store = storage();
  store.write({ ...original, active: 'stopped' });
  const owners = new Set<string>();
  const driver: RuntimeDriver = {
    preflight: async () => undefined, checkpoint: async () => ({ ready: true }),
    release: async (_record, mode) => { owners.delete(mode); },
    acquire: async () => { owners.add('chat'); throw new Error('History replay failed'); },
  };
  const controller = new SessionController(store, driver);
  await expect(controller.recover('chat', 1)).rejects.toMatchObject({ code: 'CHAT_RECOVERY_FAILED' });
  expect(owners.size).toBe(0);
  expect(controller.snapshot()).toMatchObject({ active: 'stopped', nativeSessionId: 'conversation-a' });
});


it('keeps a partial-transfer notice on the adopted fork without exposing a routine fork notice', async () => {
  const store = storage();
  const driver: RuntimeDriver = {
    preflight: async () => undefined,
    checkpoint: async () => ({ ready: false, reason: 'No exact checkpoint' }),
    release: async () => undefined,
    acquire: async () => ({ nativeSessionId: 'partial-fork', historyVerified: true, forked: true, transferNotice: 'The provider could not copy one image attachment.' }),
  };
  const controller = new SessionController(store, driver);
  await controller.switchTo('chat', 1);
  expect(controller.snapshot()).toMatchObject({ active: 'chat', nativeSessionId: 'partial-fork', transferNotice: 'The provider could not copy one image attachment.' });
});

it('leaves an unacknowledged fork stopped instead of automatically restoring or forking again', async () => {
  const store = storage();
  let acquisitions = 0;
  const driver: RuntimeDriver = {
    preflight: async () => undefined, checkpoint: async () => ({ ready: false, reason: 'Active work' }),
    release: async () => undefined,
    acquire: async () => {
      acquisitions++;
      store.write({ ...store.read(), forkUnconfirmed: true });
      throw new Error('Connection ended before the fork identity arrived');
    },
  };
  const controller = new SessionController(store, driver);
  await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_HANDOFF_FAILED' });
  expect(acquisitions).toBe(1);
  expect(controller.snapshot()).toMatchObject({ active: 'stopped', nativeSessionId: 'conversation-a', forkUnconfirmed: true });
});
