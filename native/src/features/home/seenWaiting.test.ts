import { describe, expect, it } from 'vitest';

import type { NotifyItem, NotifySharedState } from '@shared/types/notify';

import { buildAllMachinesList, type MachineFeed } from '@/features/allMachines/allMachinesList';

import { freshCounts, GONE_GRACE_MS, reconcileSeen, waitingThings, type SeenMap, type SeenTarget } from './seenWaiting';

const notify = (items: Array<Partial<NotifyItem> & Pick<NotifyItem, 'id' | 'createdAt'>>): NotifySharedState => ({
  machine: 'host', epoch: 'e1', revision: 1, enabled: true, queue: [], hidden: [],
  items: items.map(item => ({ title: 'Ship it?', ui: 'approve', state: 'waiting', source: { name: 'agent', agent: 'Claude' }, ...item })) as NotifyItem[],
});

// A Session "Release" runs the Pane "api"; "web" sits outside it. "web" waits at a prompt in its terminal.
const mac = (items: Parameters<typeof notify>[0]): MachineFeed => ({
  key: 'mac',
  name: 'studio-mac',
  snapshot: {
    projects: [{ id: 1, name: 'acme', sessions: [{ id: 'api', name: 'api' }, { id: 'web', name: 'web' }] }],
    statuses: { agentStatus: { p2: 'blocked' }, agentStatusSession: { p2: 'web' }, agentType: {}, unseen: {} },
    notify: notify(items),
    sessions: [{ id: 'release', name: 'Release', associations: [{ paneId: 'api' }] } as never],
  },
});

const things = (feed: MachineFeed) => waitingThings(buildAllMachinesList([feed], ''));
const step = (seen: SeenMap | null, feed: MachineFeed, open: SeenTarget[] = [], now = 0) => reconcileSeen({ seen, things: things(feed), complete: new Set(['mac']), open, now });

describe('new since last seen', () => {
  const before = mac([{ id: 'q1', createdAt: 1, source: { name: 'api', agent: 'Claude', paneId: 'api' } }]);
  const after = mac([
    { id: 'q1', createdAt: 1, source: { name: 'api', agent: 'Claude', paneId: 'api' } },
    { id: 'q2', createdAt: 2, source: { name: 'api', agent: 'Claude', paneId: 'api' } },
  ]);

  it('calls nothing new on the first launch, then counts what arrives on the tile, its Session and its Pane', () => {
    const first = step(null, before).seen;
    expect(freshCounts(things(before), first).total).toBe(0);

    const fresh = freshCounts(things(after), step(first, after).seen);
    expect(fresh.total).toBe(1);
    expect(fresh.bySession.get('mac:release')).toBe(1);
    expect(fresh.byPane.get('mac:api')).toBe(1);
    expect(fresh.byPane.get('mac:web')).toBeUndefined();
  });

  it('waits for a machine to answer before taking the first launch as seen', () => {
    expect(reconcileSeen({ seen: null, things: [], complete: new Set(), open: [], now: 0 }).seen).toBeNull();
  });

  it('clears what an open Pane shows, and everything when Needs you is open', () => {
    const seen = step(null, before).seen;
    const pane = step(seen, after, [{ machineKey: 'mac', paneId: 'api' }]);
    expect(pane.marked).toEqual(['mac:question:q2']);
    expect(freshCounts(things(after), pane.seen).total).toBe(0);

    const another = mac([{ id: 'q3', createdAt: 3 }]);
    expect(freshCounts(things(another), step(seen, another, [{ machineKey: 'mac', paneId: 'api' }]).seen).total).toBe(1);
    expect(freshCounts(things(another), step(seen, another, ['needs']).seen).total).toBe(0);
  });

  it('keeps a thing seen through a short absence, and calls it new when it returns later', () => {
    const seen = step(null, before).seen;
    const answered = mac([]);
    const gone = step(seen, answered, [], 1_000).seen;
    expect(freshCounts(things(before), step(gone, before, [], 2_000).seen).total).toBe(0);
    const forgotten = step(gone, answered, [], 1_000 + GONE_GRACE_MS).seen;
    expect(freshCounts(things(before), step(forgotten, before, [], 1_000 + GONE_GRACE_MS).seen).total).toBe(1);
  });

  it('keeps what it saw on a machine whose lists have not answered', () => {
    const seen = step(null, before).seen;
    const kept = reconcileSeen({ seen, things: [], complete: new Set(), open: [], now: GONE_GRACE_MS * 10 }).seen;
    expect(freshCounts(things(before), kept).total).toBe(0);
  });
});
