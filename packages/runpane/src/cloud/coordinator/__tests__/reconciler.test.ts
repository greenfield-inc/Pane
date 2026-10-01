import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryAlertSink } from '../alerts';
import { RunawayGuard, SandboxActivity } from '../guards';
import { Reconciler } from '../reconciler';
import type { ReconcileOptions } from '../reconciler';
import type { DirectoryEntry, ProviderSandbox } from '../types';
import { entry, FakeClock, FakeDirectory, FakeProvider, sandbox } from './fakes';

function setup(sandboxes: ProviderSandbox[], entries: DirectoryEntry[] | null, options: Partial<ReconcileOptions> = {}) {
  const clock = new FakeClock();
  const provider = new FakeProvider(sandboxes);
  const directory = entries === null
    ? new FakeDirectory({ ok: false, error: 'ENOENT: directory.json' })
    : FakeDirectory.of(entries);
  const alerts = new MemoryAlertSink();
  const reconciler = new Reconciler({
    directory,
    provider,
    activity: new SandboxActivity(clock),
    guard: new RunawayGuard(clock, { maxLiveSandboxes: 3, maxResumesPerSandboxPerHour: 6, maxResumesPerHour: 60 }),
    alerts,
    clock,
  }, {
    managedNamePrefix: 'rp-',
    selfSandboxId: 'bx_coord',
    ignoreSandboxIds: [],
    orphanGraceMs: 30 * 60_000,
    stopOrphans: true,
    orphanStopGraceMs: 0,
    maxOrphanStopsPerRun: 3,
    dryRun: false,
    ...options,
  });
  return { provider, alerts, reconciler, directory, clock };
}

describe('Reconciler', () => {
  it('by default only reports a running orphan, once, and never stops it', async () => {
    const { reconciler, provider, alerts, clock } = setup(
      [sandbox('bx_a', 'running'), sandbox('bx_orphan', 'running')],
      [entry('s1', 'bx_a')],
      { stopOrphans: false, orphanStopGraceMs: 6 * 3_600_000 },
    );
    const first = await reconciler.runOnce();
    clock.time += 48 * 3_600_000;
    const later = await reconciler.runOnce();
    assert.deepEqual([first.orphans, later.orphans], [['bx_orphan'], ['bx_orphan']]);
    assert.deepEqual([first.stopped, later.stopped], [[], []]);
    assert.deepEqual(provider.mutations(), []);
    assert.deepEqual(alerts.alerts.filter((alert) => alert.code === 'orphan-found').map((alert) => alert.sandboxId), ['bx_orphan']);
  });

  it('with stopOrphans, stops an orphan only after it has been an orphan for the stop grace', async () => {
    const { reconciler, provider, alerts, clock } = setup(
      [sandbox('bx_a', 'running'), sandbox('bx_orphan', 'running')],
      [entry('s1', 'bx_a')],
      { orphanStopGraceMs: 6 * 3_600_000 },
    );
    // The sandbox is days old, but this coordinator only now sees it missing from the directory.
    const first = await reconciler.runOnce();
    assert.deepEqual(first.stopped, []);
    assert.match(first.skipped[0]?.reason ?? '', /orphan for 0 min; stopped after 360 min/);
    clock.time += 5 * 3_600_000;
    assert.deepEqual((await reconciler.runOnce()).stopped, []);
    assert.deepEqual(provider.mutations(), []);
    clock.time += 3_600_000;
    assert.deepEqual((await reconciler.runOnce()).stopped, ['bx_orphan']);
    assert.deepEqual(provider.mutations(), ['stop bx_orphan']);
    assert.ok(alerts.alerts.some((alert) => alert.code === 'orphan-stopped'));
  });

  it('restarts the stop grace when a sandbox stops being an orphan in between', async () => {
    const { reconciler, provider, directory, clock } = setup(
      [sandbox('bx_a', 'running'), sandbox('bx_orphan', 'running')],
      [entry('s1', 'bx_a')],
      { orphanStopGraceMs: 6 * 3_600_000 },
    );
    await reconciler.runOnce();
    clock.time += 5 * 3_600_000;
    directory.result = { ok: true, generatedAt: null, entries: [entry('s1', 'bx_a'), entry('s2', 'bx_orphan')] };
    await reconciler.runOnce();
    directory.result = { ok: true, generatedAt: null, entries: [entry('s1', 'bx_a')] };
    clock.time += 3_600_000;
    assert.deepEqual((await reconciler.runOnce()).stopped, []);
    assert.deepEqual(provider.mutations(), []);
  });

  it('stops a running orphan and alerts, never deleting', async () => {
    const { reconciler, provider, alerts } = setup(
      [sandbox('bx_a', 'running'), sandbox('bx_orphan', 'running')],
      [entry('s1', 'bx_a')],
    );
    const report = await reconciler.runOnce();
    assert.equal(report.aborted, null);
    assert.deepEqual(report.stopped, ['bx_orphan']);
    assert.deepEqual(provider.mutations(), ['stop bx_orphan']);
    assert.ok(alerts.alerts.some((alert) => alert.code === 'orphan-stopped'));
  });

  it('reports a failed orphan stop as skipped, without a stopped result or alert', async () => {
    const { reconciler, provider, alerts } = setup(
      [sandbox('bx_a', 'running'), sandbox('bx_orphan', 'running')],
      [entry('s1', 'bx_a')],
    );
    provider.stopErrors.push(new Error('boat: 503'));
    const report = await reconciler.runOnce();
    assert.equal(report.aborted, null);
    assert.deepEqual(report.stopped, []);
    assert.deepEqual(report.skipped, [{ sandboxId: 'bx_orphan', reason: 'stop failed: boat: 503' }]);
    assert.equal(provider.sandboxes.get('bx_orphan')?.state, 'running');
    assert.ok(!alerts.alerts.some((alert) => alert.code === 'orphan-stopped'));
  });

  it('aborts and stops nothing when the directory read fails', async () => {
    const { reconciler, provider, alerts } = setup([sandbox('bx_a', 'running'), sandbox('bx_b', 'running')], null);
    const report = await reconciler.runOnce();
    assert.equal(report.aborted, 'directory-unreadable');
    assert.deepEqual(provider.mutations(), []);
    assert.deepEqual(provider.calls, [], 'the provider is not even listed');
    assert.equal(alerts.alerts[0].code, 'reconcile-aborted-directory-unreadable');
  });

  it('aborts and stops nothing when the directory is empty but the provider lists managed sandboxes', async () => {
    const { reconciler, provider } = setup([sandbox('bx_a', 'running'), sandbox('bx_b', 'running')], []);
    const report = await reconciler.runOnce();
    assert.equal(report.aborted, 'directory-empty');
    assert.deepEqual(provider.mutations(), []);
  });

  it('aborts when the provider list fails', async () => {
    const { reconciler, provider } = setup([], [entry('s1', 'bx_a')]);
    provider.listError = new Error('HTTP 500');
    const report = await reconciler.runOnce();
    assert.equal(report.aborted, 'provider-error');
    assert.deepEqual(provider.mutations(), []);
  });

  it('aborts when more orphans would be stopped than allowed (a stale directory)', async () => {
    const { reconciler, provider } = setup(
      ['bx_a', 'bx_b', 'bx_c', 'bx_d', 'bx_e'].map((id) => sandbox(id, 'running')),
      [entry('s1', 'bx_a')],
    );
    const report = await reconciler.runOnce();
    assert.equal(report.aborted, 'too-many-orphans');
    assert.deepEqual(provider.mutations(), []);
  });

  it('ignores unmanaged sandboxes, the coordinator itself, and young orphans', async () => {
    const { reconciler, provider } = setup([
      sandbox('bx_a', 'running'),
      sandbox('bx_devbox', 'running', { name: 'rp-ci-other' }),
      sandbox('bx_other', 'running', { name: 'someone-elses-box' }),
      sandbox('bx_coord', 'running', { name: 'rp-coordinator' }),
      sandbox('bx_young', 'running', { createdAt: '2026-09-30T07:55:00Z' }),
      sandbox('bx_nocreated', 'running', { createdAt: null }),
    ], [entry('s1', 'bx_a')], { managedNamePrefix: 'rp-bx' });
    const report = await reconciler.runOnce();
    assert.equal(report.aborted, null);
    assert.deepEqual(provider.mutations(), []);
    assert.deepEqual(report.skipped.map((skip) => skip.sandboxId).sort(), ['bx_nocreated', 'bx_young']);
  });

  it('reports directory entries whose sandbox is gone as lost, without touching anything', async () => {
    const { reconciler, provider, alerts } = setup([sandbox('bx_a', 'running')], [entry('s1', 'bx_a'), entry('s2', 'bx_gone')]);
    const report = await reconciler.runOnce();
    assert.deepEqual(report.lost, ['bx_gone']);
    assert.deepEqual(provider.mutations(), []);
    assert.ok(alerts.alerts.some((alert) => alert.code === 'session-lost' && alert.sessionId === 's2'));
  });

  it('alerts when live managed sandboxes exceed the runaway limit', async () => {
    const sandboxes = ['bx_a', 'bx_b', 'bx_c', 'bx_d'].map((id) => sandbox(id, 'running'));
    const { reconciler, alerts, provider } = setup(sandboxes, sandboxes.map((item, index) => entry(`s${index}`, item.id)));
    await reconciler.runOnce();
    assert.ok(alerts.alerts.some((alert) => alert.code === 'runaway-guard'));
    assert.deepEqual(provider.mutations(), []);
  });

  it('dry run lists the orphans it would stop without stopping them', async () => {
    const { reconciler, provider } = setup(
      [sandbox('bx_a', 'running'), sandbox('bx_orphan', 'running')],
      [entry('s1', 'bx_a')],
    );
    const report = await reconciler.runOnce({ dryRun: true });
    assert.deepEqual(report.stopped, ['bx_orphan']);
    assert.deepEqual(provider.mutations(), []);
  });
});
