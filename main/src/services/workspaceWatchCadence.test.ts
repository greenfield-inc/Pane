import { describe, expect, it } from 'vitest';
import type { RunpaneWorkspaceEntry, RunpaneWorkspaceEntryKind } from '../../../shared/types/runpaneOrchestration';
import { WatchCadence } from './workspaceWatchCadence';
import { matchesFilter } from './workspaceJournal';

const T0 = Date.parse('2026-09-13T01:00:00.000Z');
let nextGen = 0;

function entry(kind: RunpaneWorkspaceEntryKind, atMs: number, overrides: Partial<RunpaneWorkspaceEntry> = {}): RunpaneWorkspaceEntry {
  return {
    gen: ++nextGen,
    at: new Date(atMs).toISOString(),
    kind,
    paneId: 'pane-1',
    paneName: 'Monitor',
    panelId: 'panel-1',
    agentType: 'claude',
    source: 'agent',
    ...overrides,
  };
}

const kinds = (entries: RunpaneWorkspaceEntry[]) => entries.map(item => item.kind);

describe('WatchCadence', () => {
  it('flushes a worker report at once, with the lines the interval was holding', () => {
    const cadence = new WatchCadence({
      settleMs: 0, blockedSettleMs: 0, minIntervalMs: 600_000, emitKinds: ['agent.ready', 'agent.report'], key: '',
    });
    cadence.ingest([entry('agent.ready', T0, { panelId: 'panel-2' })], T0);
    expect(kinds(cadence.flush(T0))).toEqual(['agent.ready']);
    cadence.ingest([entry('agent.ready', T0 + 10_000, { panelId: 'panel-3' })], T0 + 10_000);
    expect(cadence.flush(T0 + 10_000)).toEqual([]);
    cadence.ingest([entry('agent.report', T0 + 20_000, { report: { state: 'ready', reportedAt: 'T' } })], T0 + 20_000);
    expect(cadence.nextDeadline(T0 + 20_000)).toBe(T0 + 20_000);
    expect(kinds(cadence.flush(T0 + 20_000))).toEqual(['agent.ready', 'agent.report']);
  });

  it('observes quiet READY to cancel BLOCKED before suppressing the notification', () => {
    const filter = { kinds: ['agent.ready', 'agent.blocked'] as const, quietPanelIds: ['panel-1'] };
    const cadence = new WatchCadence({ settleMs: 180_000, blockedSettleMs: 30_000, minIntervalMs: 600_000,
      emitKinds: filter.kinds, quietPanelIds: filter.quietPanelIds, key: 'quiet' });
    const readFilter = WatchCadence.observeFilter(filter);
    const blocked = entry('agent.blocked', T0);
    const ready = entry('agent.ready', T0 + 10_000);
    cadence.ingest([blocked].filter(item => matchesFilter(item, readFilter)), T0);
    expect(matchesFilter(ready, readFilter)).toBe(true);
    cadence.ingest([ready].filter(item => matchesFilter(item, readFilter)), T0 + 10_000);
    expect(cadence.flush(T0 + 600_000)).toEqual([]);
    expect(cadence.nextDeadline(T0 + 600_000)).toBeUndefined();
    cadence.ingest([entry('agent.blocked', T0 + 700_000)], T0 + 700_000);
    expect(kinds(cadence.flush(T0 + 730_000))).toEqual(['agent.blocked']);
  });

  it('cancels a READY silently when the panel goes busy inside the settle window', () => {
    const cadence = new WatchCadence({ settleMs: 120_000, blockedSettleMs: 0, minIntervalMs: 0, emitKinds: ['agent.ready'], key: '' });
    cadence.ingest([entry('agent.ready', T0)], T0);
    expect(cadence.flush(T0 + 30_000)).toEqual([]);
    expect(cadence.nextDeadline(T0 + 30_000)).toBe(T0 + 120_000);
    cadence.ingest([entry('agent.busy', T0 + 40_000)], T0 + 40_000);
    expect(cadence.flush(T0 + 200_000)).toEqual([]);
    expect(cadence.nextDeadline(T0 + 200_000)).toBeUndefined();
  });

  it('emits a READY that stays quiet for the whole window and records how long it settled', () => {
    const cadence = new WatchCadence({ settleMs: 120_000, blockedSettleMs: 0, minIntervalMs: 0, key: '' });
    cadence.ingest([entry('agent.ready', T0)], T0);
    expect(cadence.flush(T0 + 119_999)).toEqual([]);
    const flushed = cadence.flush(T0 + 120_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ kind: 'agent.ready', settledMs: 120_000 });
    expect(cadence.flush(T0 + 130_000)).toEqual([]);
  });

  it('holds a BLOCKED for its own window and drops it when the pane answers in time', () => {
    const cadence = new WatchCadence({ settleMs: 0, blockedSettleMs: 15_000, minIntervalMs: 0, key: '' });
    cadence.ingest([entry('agent.blocked', T0)], T0);
    expect(cadence.flush(T0 + 5_000)).toEqual([]);
    cadence.ingest([entry('agent.ready', T0 + 6_000)], T0 + 6_000);
    // The blocked→idle READY has no settle here, so it flushes; the BLOCKED never does.
    expect(kinds(cadence.flush(T0 + 6_000))).toEqual(['agent.ready']);
    expect(cadence.flush(T0 + 60_000)).toEqual([]);
  });

  it('lets a matured BLOCKED bypass the minimum interval and carry held lines with it', () => {
    const cadence = new WatchCadence({ settleMs: 0, blockedSettleMs: 15_000, minIntervalMs: 300_000, key: '' });
    cadence.ingest([entry('pane.created', T0, { panelId: undefined, source: 'session' })], T0);
    expect(kinds(cadence.flush(T0))).toEqual(['pane.created']);
    cadence.ingest([entry('agent.ready', T0 + 10_000)], T0 + 10_000);
    expect(cadence.flush(T0 + 10_000)).toEqual([]);
    expect(cadence.nextDeadline(T0 + 10_000)).toBe(T0 + 300_000);
    cadence.ingest([entry('agent.blocked', T0 + 20_000, { panelId: 'panel-2' })], T0 + 20_000);
    expect(cadence.nextDeadline(T0 + 20_000)).toBe(T0 + 35_000);
    expect(cadence.flush(T0 + 34_999)).toEqual([]);
    expect(kinds(cadence.flush(T0 + 35_000))).toEqual(['agent.ready', 'agent.blocked']);
  });

  it('lets a conflicting PR or failed checks bypass the minimum interval, but not passed checks or a merge', () => {
    const cadence = new WatchCadence({ settleMs: 0, blockedSettleMs: 0, minIntervalMs: 300_000, key: '' });
    const pr = { panelId: undefined, agentType: undefined, source: 'github' as const, pr: { number: 7, url: 'u', headOid: 'h' } };
    cadence.ingest([entry('agent.ready', T0)], T0);
    expect(kinds(cadence.flush(T0))).toEqual(['agent.ready']);
    cadence.ingest([entry('pr.checks', T0 + 1_000, { ...pr, checks: 'passed' }), entry('pr.merged', T0 + 1_000, pr)], T0 + 1_000);
    expect(cadence.flush(T0 + 1_000)).toEqual([]);
    cadence.ingest([entry('pr.checks', T0 + 2_000, { ...pr, checks: 'failed', failingChecks: ['lint'] })], T0 + 2_000);
    expect(kinds(cadence.flush(T0 + 2_000))).toEqual(['pr.checks', 'pr.merged', 'pr.checks']);
    cadence.ingest([entry('pr.conflicted', T0 + 3_000, pr)], T0 + 3_000);
    expect(cadence.nextDeadline(T0 + 3_000)).toBe(T0 + 3_000);
    expect(kinds(cadence.flush(T0 + 3_000))).toEqual(['pr.conflicted']);
  });

  it('batches non-urgent lines into one flush per interval', () => {
    const cadence = new WatchCadence({ settleMs: 0, blockedSettleMs: 0, minIntervalMs: 300_000, key: '' });
    cadence.ingest([entry('agent.ready', T0)], T0);
    expect(kinds(cadence.flush(T0))).toEqual(['agent.ready']);
    cadence.ingest([entry('agent.ready', T0 + 60_000, { panelId: 'panel-2' })], T0 + 60_000);
    cadence.ingest([entry('panel.exited', T0 + 120_000, { panelId: 'panel-3', source: 'exit', exitCode: 0 })], T0 + 120_000);
    cadence.ingest([entry('agent.idle', T0 + 180_000, { idleCount: 1, idleMs: 600_000 })], T0 + 180_000);
    expect(cadence.flush(T0 + 299_999)).toEqual([]);
    expect(cadence.nextDeadline(T0 + 200_000)).toBe(T0 + 300_000);
    expect(kinds(cadence.flush(T0 + 300_000))).toEqual(['agent.ready', 'panel.exited', 'agent.idle']);
    expect(cadence.flush(T0 + 300_001)).toEqual([]);
  });

  it('cancels pending entries for every panel of a pane that goes away', () => {
    const cadence = new WatchCadence({
      settleMs: 120_000,
      blockedSettleMs: 120_000,
      minIntervalMs: 0,
      emitKinds: ['agent.ready', 'agent.blocked'],
      key: '',
    });
    cadence.ingest([
      entry('agent.ready', T0, { panelId: 'panel-1' }),
      entry('agent.blocked', T0, { panelId: 'panel-2' }),
      entry('agent.ready', T0, { paneId: 'pane-2', panelId: 'panel-3' }),
    ], T0);
    expect(cadence.lowestUnflushedGen()).toBe(nextGen - 2);
    cadence.ingest([entry('pane.gone', T0 + 1_000, { panelId: undefined, source: 'session' })], T0 + 1_000);
    expect(cadence.nextDeadline(T0 + 1_000)).toBe(T0 + 120_000);
    const flushed = cadence.flush(T0 + 120_000);
    expect(flushed.map(item => item.panelId)).toEqual(['panel-3']);
    expect(cadence.lowestUnflushedGen()).toBeUndefined();
  });

  it('reports the lowest generation still pending or held, ignoring synthetic IDLE generations', () => {
    const cadence = new WatchCadence({ settleMs: 120_000, blockedSettleMs: 0, minIntervalMs: 300_000, key: '' });
    expect(cadence.lowestUnflushedGen()).toBeUndefined();
    const ready = entry('agent.ready', T0);
    const exited = entry('panel.exited', T0, { panelId: 'panel-2', source: 'exit', exitCode: 1 });
    cadence.ingest([ready, exited, entry('agent.idle', T0, { gen: 1, idleCount: 1, idleMs: 600_000 })], T0);
    expect(cadence.lowestUnflushedGen()).toBe(ready.gen);
    expect(kinds(cadence.flush(T0))).toEqual(['panel.exited', 'agent.idle']);
    expect(cadence.lowestUnflushedGen()).toBe(ready.gen);
    expect(kinds(cadence.flush(T0 + 300_000))).toEqual(['agent.ready']);
    expect(cadence.lowestUnflushedGen()).toBeUndefined();
  });

  it('observes BUSY for cancellation without ever emitting it when the consumer excluded it', () => {
    const cadence = new WatchCadence({
      settleMs: 120_000,
      blockedSettleMs: 0,
      minIntervalMs: 0,
      emitKinds: ['agent.ready', 'agent.blocked'],
      key: '',
    });
    cadence.ingest([entry('agent.busy', T0)], T0);
    expect(cadence.flush(T0)).toEqual([]);
    cadence.ingest([entry('agent.ready', T0 + 1_000)], T0 + 1_000);
    cadence.ingest([entry('agent.busy', T0 + 5_000)], T0 + 5_000);
    cadence.ingest([entry('agent.ready', T0 + 6_000)], T0 + 6_000);
    expect(cadence.flush(T0 + 121_000)).toEqual([]);
    expect(kinds(cadence.flush(T0 + 126_000))).toEqual(['agent.ready']);
  });
});
