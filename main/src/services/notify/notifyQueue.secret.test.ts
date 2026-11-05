import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotifyQueue, type NotifyQueueEnvironment } from './notifyQueue';
import { PaneError } from '../../../../shared/paneError';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyQuestion, type NotifyResult } from '../../../../shared/types/notify';

const CANARY = 'pane-canary-5f3a9c-never-shown';
const claude = { paneId: 'pane-1', panelId: 'panel-1', name: 'checkout-flow', agent: 'Claude' };
const stripeKey: NotifyQuestion = {
  ui: 'secret',
  title: 'Stripe test secret key',
  context: 'Run the webhook integration tests against Stripe\'s test mode.',
  secret: { project: 'stripe', name: 'STRIPE_SECRET_KEY' },
};

function makeQueue(secrets: NotifyQueueEnvironment['secrets']) {
  return new NotifyQueue({ settings: () => DEFAULT_NOTIFY_SETTINGS, showOutsideSupported: true, shortcutRegistered: () => true, instructionFiles: () => [], machine: 'studio', secrets });
}

function fakeSecrets(existing: string[] = []) {
  const saved = new Map<string, string>(existing.map(key => [key, 'old']));
  let failure: Error | null = null;
  return {
    saved,
    failNext: (error: Error) => { failure = error; },
    env: {
      exists: (project: string, name: string) => saved.has(`${project}/${name}`),
      save: async (project: string, name: string, value: string) => {
        if (failure) {
          const error = failure;
          failure = null;
          throw error;
        }
        saved.set(`${project}/${name}`, value);
      },
    },
  };
}

function ask(queue: NotifyQueue, question: NotifyQuestion) {
  const results: NotifyResult[] = [];
  void queue.ask({ question, source: claude }).then(result => results.push(result));
  return { get result() { return results[0]; } };
}

/** Everything any surface or the agent can see from the queue, as one string. */
function everythingVisible(queue: NotifyQueue, result: NotifyResult | undefined): string {
  return JSON.stringify([queue.snapshot(), queue.sharedState(), result]);
}

describe('NotifyQueue secret cards', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves the typed value to the secret store and gives the agent, the history and every surface only "saved"', async () => {
    const secrets = fakeSecrets();
    const queue = makeQueue(secrets.env);
    const call = ask(queue, stripeKey);
    const [id] = queue.snapshot().queue;

    await queue.run({ type: 'answer', id, answer: { text: CANARY } });
    await vi.advanceTimersByTimeAsync(0);

    expect(secrets.saved.get('stripe/STRIPE_SECRET_KEY')).toBe(CANARY);
    expect(call.result).toEqual({ status: 'saved', project: 'stripe', name: 'STRIPE_SECRET_KEY' });
    expect(queue.snapshot().items.find(candidate => candidate.id === id)).toMatchObject({ state: 'answered', answerSummary: 'Saved as stripe/STRIPE_SECRET_KEY' });
    // Shared only while it waits, so screens on Pane versions before secrets can read the rest again.
    expect(queue.sharedState().items.map(candidate => candidate.id)).not.toContain(id);
    expect(everythingVisible(queue, call.result)).not.toContain(CANARY);
  });

  it('says when saving replaces an existing secret', () => {
    const queue = makeQueue(fakeSecrets(['stripe/STRIPE_SECRET_KEY']).env);
    ask(queue, stripeKey);

    expect(queue.sharedState().items[0].secret).toEqual({ project: 'stripe', name: 'STRIPE_SECRET_KEY', replaces: true });
  });

  it('returns declined and stores nothing when the person declines', async () => {
    const secrets = fakeSecrets();
    const queue = makeQueue(secrets.env);
    const call = ask(queue, stripeKey);
    const [id] = queue.snapshot().queue;

    await queue.run({ type: 'answer', id, answer: { approved: false } });
    await vi.advanceTimersByTimeAsync(0);

    expect(call.result).toEqual({ status: 'declined' });
    expect(secrets.saved.size).toBe(0);
    expect(queue.snapshot().items[0].answerSummary).toBe('Declined');
  });

  it('keeps the card waiting with the reason when the store refuses, and saves on the next try', async () => {
    const secrets = fakeSecrets();
    const queue = makeQueue(secrets.env);
    const call = ask(queue, stripeKey);
    const [id] = queue.snapshot().queue;
    secrets.failNext(new PaneError('SECRET_WRITE_FAILED', 'Pane could not store stripe/STRIPE_SECRET_KEY: the keychain is locked. Nothing was changed.', 'Unlock the login keychain in Keychain Access, then try again.'));

    await expect(queue.runRemote({ type: 'answer', id, answer: { text: CANARY } }, 'iPhone')).rejects.toMatchObject({ code: 'SECRET_WRITE_FAILED' });

    expect(call.result).toBeUndefined();
    expect(queue.sharedState().items[0]).toMatchObject({ state: 'waiting', secretError: expect.stringContaining('keychain is locked') });
    expect(everythingVisible(queue, call.result)).not.toContain(CANARY);

    await queue.runRemote({ type: 'answer', id, answer: { text: CANARY } }, 'iPhone');
    await vi.advanceTimersByTimeAsync(0);
    expect(call.result).toEqual({ status: 'saved', project: 'stripe', name: 'STRIPE_SECRET_KEY' });
    expect(queue.snapshot().items[0]).toMatchObject({ answeredOn: 'iPhone', answerSummary: 'Saved as stripe/STRIPE_SECRET_KEY' });
    expect(queue.snapshot().items[0].secretError).toBeUndefined();
  });

  it('refuses a choice or empty text instead of saving it', async () => {
    const secrets = fakeSecrets();
    const queue = makeQueue(secrets.env);
    ask(queue, stripeKey);
    const [id] = queue.snapshot().queue;

    await expect(queue.runRemote({ type: 'answer', id, answer: { choice: 'Yes' } }, 'iPhone')).rejects.toMatchObject({ code: 'ERR_NOTIFY_INVALID' });
    await expect(queue.runRemote({ type: 'answer', id, answer: { text: '' } }, 'iPhone')).rejects.toMatchObject({ code: 'ERR_NOTIFY_INVALID' });
    expect(secrets.saved.size).toBe(0);
    expect(queue.sharedState().items[0].state).toBe('waiting');
  });

  it('answers unavailable on a host that cannot save secrets, pointing at Settings rather than the terminal', async () => {
    const queue = makeQueue(undefined);
    const result = await queue.ask({ question: stripeKey, source: claude });
    expect(result).toMatchObject({ unavailable: expect.any(String), next: expect.stringContaining('Settings > Secrets') });
    expect(JSON.stringify(result)).not.toContain('terminal');
  });
});
