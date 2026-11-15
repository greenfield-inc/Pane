import { describe, expect, it } from 'vitest';
import type { MachineConnectionsEvent } from '../../../shared/types/machineConnections';
import type { RunpaneWorkspaceEntry } from '../../../shared/types/runpaneOrchestration';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { RemoteMemberEvents } from './remoteMemberEvents';
import { WorkspaceJournal } from './workspaceJournal';

const DEVBOX = 'tailnet-devbox';
const member = { machine: { id: DEVBOX, label: 'parsa-devbox' } };

/** The devbox: its own journal, a connection that is up or down, and the Mac at the other end. */
function setup() {
  const devbox = new WorkspaceJournal();
  const mac = new WorkspaceJournal();
  const listeners = new Set<(event: MachineConnectionsEvent) => void>();
  let online = true;
  const emit = (event: MachineConnectionsEvent) => { for (const listener of listeners) listener(event); };
  // The devbox's host sends each entry live while connected, as bootstrap does.
  devbox.subscribe(entry => { if (online) emit({ type: 'event', machineId: DEVBOX, channel: 'workspace:entry', args: [entry, devbox.epoch] }); });
  const bridge = new RemoteMemberEvents({
    machines: {
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      invoke: async (_machineId, channel, args): Promise<PaneCommandValue> => {
        if (!online) throw new Error('offline');
        expect(channel).toBe('runpane:workspace:wait');
        // SAFETY: RemoteMemberEvents sends one wait request with these fields; the test reads its own call.
        const request = args[0] as { since: number; epoch?: string; paneIds: string[]; kinds: RunpaneWorkspaceEntry['kind'][]; limit: number };
        if (request.epoch && request.epoch !== devbox.epoch) return { epoch: devbox.epoch, entries: [], reset: { reason: 'epoch-changed' } };
        const read = devbox.readAfter(request.since, { paneIds: request.paneIds, kinds: request.kinds }, request.limit);
        // SAFETY: a JSON round trip of journal entries is a PaneCommandValue, as the daemon sends it.
        return JSON.parse(JSON.stringify({ epoch: devbox.epoch, entries: read.entries })) as PaneCommandValue;
      },
    },
    journal: mac,
    members: {
      remoteMember: paneId => (paneId === 'pane-win' ? member : undefined),
      remoteMemberPaneIds: machineId => (machineId === DEVBOX ? ['pane-win'] : []),
    },
  });
  bridge.start();
  const report = (summary: string) => devbox.append({
    kind: 'agent.report', paneId: 'pane-win', paneName: 'Windows build', panelId: 'tab-1', source: 'agent',
    report: { state: 'done', summary, reportedAt: '2026-11-14T12:00:00.000Z' },
  });
  const reconnect = async () => { online = true; await bridge.catchUp(DEVBOX); };
  const recorded = () => mac.readAfter(0, { kinds: ['agent.report', 'agent.blocked', 'panel.exited'] }).entries;
  return { devbox, report, recorded, reconnect, goOffline: () => { online = false; } };
}

describe('RemoteMemberEvents', () => {
  it("records a member's live report once, tagged with its machine", () => {
    const { report, recorded } = setup();
    report('built');

    expect(recorded()).toMatchObject([{ kind: 'agent.report', paneId: 'pane-win', paneName: 'Windows build', report: { summary: 'built' }, machine: { id: DEVBOX, label: 'parsa-devbox', gen: 1 } }]);
  });

  it('delivers reports sent while the link was down after it returns, in order, and a further reconnect adds none', async () => {
    const { report, recorded, reconnect, goOffline } = setup();
    report('first');
    goOffline();
    report('second');
    report('third');
    await reconnect();
    await reconnect();

    expect(recorded().map(entry => entry.report?.summary)).toEqual(['first', 'second', 'third']);
  });

  it("ignores Panes that aren't this computer's members", () => {
    const { devbox, recorded } = setup();
    devbox.append({ kind: 'agent.report', paneId: 'someone-else', paneName: 'Other', source: 'agent', report: { state: 'done', reportedAt: '2026-11-14T12:00:00.000Z' } });

    expect(recorded()).toEqual([]);
  });
});
