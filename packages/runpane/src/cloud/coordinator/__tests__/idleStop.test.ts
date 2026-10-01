import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryAlertSink } from '../alerts';
import { SandboxActivity } from '../guards';
import { IdleStopper, STOP_LEASE_MS } from '../idleStop';
import type { IdleStopOptions } from '../idleStop';
import { entry, FakeClock, FakeDirectory, FakeProbe, FakeProvider, sandbox } from './fakes';

function setup(options: Partial<IdleStopOptions> = {}) {
  const clock = new FakeClock();
  const provider = new FakeProvider([sandbox('bx_a', 'running')]);
  const probe = new FakeProbe();
  const directory = FakeDirectory.of([entry('s1', 'bx_a')]);
  const activity = new SandboxActivity(clock);
  const alerts = new MemoryAlertSink();
  const idle = new IdleStopper({ directory, provider, probe, activity, alerts, clock }, {
    requiredConsecutiveSafe: 2,
    wakeGraceMs: 600_000,
    dryRun: false,
    ...options,
  });
  return { clock, provider, probe, directory, activity, alerts, idle };
}

describe('IdleStopper', () => {
  it('asks for a stop lease only with the answer that completes the streak, and stops fenced', async () => {
    const { idle, provider, probe } = setup();
    await idle.runOnce();
    const second = await idle.runOnce();
    assert.equal(second.results[0].decision, 'stopped');
    assert.match(second.results[0].detail, /; fenced$/u);
    assert.deepEqual(probe.calls.filter((call) => call.startsWith('safe ')), [
      'safe https://rp-s1.tail.ts.net token-s1',
      `safe https://rp-s1.tail.ts.net token-s1 lease=${STOP_LEASE_MS}`,
    ]);
    assert.deepEqual(provider.mutations(), ['stop bx_a']);
    assert.ok(!probe.calls.some((call) => call.startsWith('release ')), 'a stopped sandbox lets its lease lapse');
  });

  it('releases the lease whenever it does not stop: a failed stop, an unconfirmed checkpoint, a dry run asks none', async () => {
    const failed = setup({ requiredConsecutiveSafe: 1 });
    failed.provider.stopErrors.push(new Error('boat: 503'));
    assert.equal((await failed.idle.runOnce()).results[0].decision, 'stop-failed');
    assert.ok(failed.probe.calls.includes('release https://rp-s1.tail.ts.net'));

    const unconfirmed = setup({ requiredConsecutiveSafe: 1 });
    unconfirmed.probe.safeByUrl.set('https://rp-s1.tail.ts.net', { kind: 'safe', checkpointed: false, lease: null });
    assert.equal((await unconfirmed.idle.runOnce()).results[0].decision, 'not-checkpointed');
    assert.ok(unconfirmed.probe.calls.includes('release https://rp-s1.tail.ts.net'));

    const dry = setup({ requiredConsecutiveSafe: 1, dryRun: true });
    assert.equal((await dry.idle.runOnce()).results[0].decision, 'would-stop');
    assert.ok(!dry.probe.calls.some((call) => call.includes('lease=') || call.startsWith('release ')));
  });

  it('does not stop when too little of the lease is left after a slow answer', async () => {
    const { idle, provider, probe, clock } = setup({ requiredConsecutiveSafe: 1 });
    const answer = probe.safeToStop.bind(probe);
    probe.safeToStop = async (baseUrl, token, options) => {
      await clock.sleep(STOP_LEASE_MS - 20_000);
      return answer(baseUrl, token, options);
    };
    const report = await idle.runOnce();
    assert.equal(report.results[0].decision, 'lease-expired');
    assert.deepEqual(provider.mutations(), []);
    assert.ok(probe.calls.includes('release https://rp-s1.tail.ts.net'));
  });

  it('still stops a daemon without stop leases, and says it was not fenced', async () => {
    const { idle, provider, probe } = setup({ requiredConsecutiveSafe: 1 });
    probe.grantsLeases = false;
    const report = await idle.runOnce();
    assert.equal(report.results[0].decision, 'stopped');
    assert.match(report.results[0].detail, /not fenced/u);
    assert.deepEqual(provider.mutations(), ['stop bx_a']);
  });

  it('stops only after the required number of consecutive safe answers', async () => {
    const { idle, provider } = setup();
    const first = await idle.runOnce();
    assert.equal(first.results[0].decision, 'safe-streak');
    assert.deepEqual(provider.mutations(), []);
    const second = await idle.runOnce();
    assert.equal(second.results[0].decision, 'stopped');
    assert.deepEqual(provider.mutations(), ['stop bx_a']);
  });

  it('never stops while the daemon says an agent is working, and an unsafe answer resets the streak', async () => {
    const { idle, provider, probe } = setup();
    await idle.runOnce();
    probe.safeByUrl.set('https://rp-s1.tail.ts.net', { kind: 'unsafe', reasons: ['agent-working: claude panel p1'] });
    const busy = await idle.runOnce();
    assert.equal(busy.results[0].decision, 'unsafe');
    assert.match(busy.results[0].detail, /agent-working/);
    probe.safeByUrl.delete('https://rp-s1.tail.ts.net');
    const afterReset = await idle.runOnce();
    assert.equal(afterReset.results[0].decision, 'safe-streak');
    assert.deepEqual(provider.mutations(), []);
  });

  it('does not stop when safe-to-stop errors, is unsupported, or the daemon is unreachable', async () => {
    for (const setupProbe of [
      (probe: FakeProbe) => probe.safeByUrl.set('https://rp-s1.tail.ts.net', { kind: 'error', error: 'timeout' }),
      (probe: FakeProbe) => probe.safeByUrl.set('https://rp-s1.tail.ts.net', { kind: 'unsupported', error: 'ERR_UNKNOWN_CHANNEL' }),
      (probe: FakeProbe) => probe.healthByUrl.set('https://rp-s1.tail.ts.net', { reachable: false, error: 'ECONNREFUSED' }),
      (probe: FakeProbe) => probe.healthByUrl.set('https://rp-s1.tail.ts.net', { reachable: true, ready: false, version: null, detail: null }),
    ]) {
      const { idle, provider, probe } = setup({ requiredConsecutiveSafe: 1 });
      setupProbe(probe);
      await idle.runOnce();
      await idle.runOnce();
      assert.deepEqual(provider.mutations(), []);
    }
  });

  it('never stops on a safe answer whose checkpoint the daemon did not confirm, and resets the streak', async () => {
    const { idle, provider, probe, alerts } = setup();
    await idle.runOnce();
    probe.safeByUrl.set('https://rp-s1.tail.ts.net', { kind: 'safe', checkpointed: false, lease: null });
    const unconfirmed = await idle.runOnce();
    assert.equal(unconfirmed.results[0].decision, 'not-checkpointed');
    assert.deepEqual(provider.mutations(), []);
    assert.equal(alerts.alerts.at(-1)?.code, 'idle-stop-not-checkpointed');
    probe.safeByUrl.delete('https://rp-s1.tail.ts.net');
    assert.equal((await idle.runOnce()).results[0].decision, 'safe-streak');
    assert.deepEqual(provider.mutations(), []);
  });

  it('reports a failed provider stop without a stopped result or alert', async () => {
    const { idle, provider, alerts } = setup({ requiredConsecutiveSafe: 1 });
    provider.stopErrors.push(new Error('boat: 503'));
    const report = await idle.runOnce();
    assert.equal(report.results[0].decision, 'stop-failed');
    assert.match(report.results[0].detail, /503/);
    assert.equal(provider.sandboxes.get('bx_a')?.state, 'running');
    assert.ok(!alerts.alerts.some((alert) => alert.code === 'idle-stopped'));
    assert.equal(alerts.alerts.at(-1)?.code, 'idle-stop-failed');
  });

  it('does not stop without a coordinator token, or when not running', async () => {
    const noToken = setup({ requiredConsecutiveSafe: 1 });
    noToken.directory.result = { ok: true, generatedAt: null, entries: [entry('s1', 'bx_a', { coordinatorToken: null })] };
    assert.equal((await noToken.idle.runOnce()).results[0].decision, 'no-token');
    assert.deepEqual(noToken.provider.mutations(), []);

    const stopped = setup({ requiredConsecutiveSafe: 1 });
    stopped.provider.sandboxes.set('bx_a', sandbox('bx_a', 'stopped'));
    assert.equal((await stopped.idle.runOnce()).results[0].decision, 'not-running');
    assert.deepEqual(stopped.provider.mutations(), []);
  });

  it('leaves a recently woken sandbox alone for the grace period', async () => {
    const { idle, provider, activity, clock } = setup({ requiredConsecutiveSafe: 1 });
    activity.markWoken('bx_a');
    clock.time += 60_000;
    assert.equal((await idle.runOnce()).results[0].decision, 'woken-recently');
    clock.time += 600_000;
    assert.equal((await idle.runOnce()).results[0].decision, 'stopped');
    assert.deepEqual(provider.mutations(), ['stop bx_a']);
  });

  it('skips a sandbox another coordinator action holds', async () => {
    const { idle, provider, activity } = setup({ requiredConsecutiveSafe: 1 });
    let release: () => void = () => undefined;
    const held = activity.exclusive('bx_a', () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    assert.equal((await idle.runOnce()).results[0].decision, 'busy');
    release();
    await held;
    assert.deepEqual(provider.mutations(), []);
  });

  it('dry run reports would-stop without calling the provider', async () => {
    const { idle, provider } = setup({ requiredConsecutiveSafe: 1, dryRun: true });
    assert.equal((await idle.runOnce()).results[0].decision, 'would-stop');
    assert.deepEqual(provider.mutations(), []);
  });

  it('does nothing when the directory cannot be read', async () => {
    const { idle, provider, directory, alerts } = setup({ requiredConsecutiveSafe: 1 });
    directory.result = { ok: false, error: 'ENOENT' };
    const report = await idle.runOnce();
    assert.equal(report.ok, false);
    assert.deepEqual(provider.mutations(), []);
    assert.equal(alerts.alerts[0].code, 'idle-check-directory-unreadable');
  });
});
