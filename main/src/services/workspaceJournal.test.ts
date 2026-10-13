import { describe, expect, it, vi } from 'vitest';
import { WorkspaceJournal, workspaceFilterKey } from './workspaceJournal';

/** What the daemon knows about a panel's agent, before and after wrapper detection. */
interface WrapperIdentity {
  isCliPanel: boolean;
  agentType?: string;
}

describe('WorkspaceJournal', () => {
  it('appends gapless entries and filters reads', () => {
    let now = 1000;
    const journal = new WorkspaceJournal({ now: () => now });
    journal.append({ kind: 'pane.created', paneId: 'one', paneName: 'One', source: 'session' });
    now += 1;
    journal.append({ kind: 'agent.busy', paneId: 'one', paneName: 'One', panelId: 'p1', source: 'agent' });
    journal.append({ kind: 'pane.created', paneId: 'two', paneName: 'Two', source: 'session' });

    expect(journal.readAfter(0, { paneIds: ['one'] }).entries.map(entry => entry.gen)).toEqual([1, 2]);
    expect(journal.generation).toBe(3);
  });

  it('parks a wait and resolves it on a matching append', async () => {
    const journal = new WorkspaceJournal();
    const waiting = journal.waitAfter(0, { kinds: ['agent.ready'] }, 1000);
    journal.append({ kind: 'agent.busy', paneId: 'one', paneName: 'One', source: 'agent' });
    journal.append({ kind: 'agent.ready', paneId: 'one', paneName: 'One', source: 'agent' });

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      entries: [{ kind: 'agent.ready', gen: 2 }],
    });
  });

  it('reports ring eviction instead of silently losing entries', () => {
    const journal = new WorkspaceJournal({ capacity: 2 });
    for (const paneId of ['one', 'two', 'three']) {
      journal.append({ kind: 'pane.created', paneId, paneName: paneId, source: 'session' });
    }

    expect(journal.readAfter(0)).toMatchObject({
      dropped: 1,
      entries: [{ gen: 2 }, { gen: 3 }],
    });
  });

  it('returns a resumable generation when a burst exceeds the read limit', () => {
    const journal = new WorkspaceJournal();
    for (const paneId of ['one', 'two', 'three']) {
      journal.append({ kind: 'pane.created', paneId, paneName: paneId, source: 'session' });
    }

    const first = journal.readAfter(0, {}, 2);
    expect(first).toMatchObject({ generation: 2, entries: [{ gen: 1 }, { gen: 2 }] });
    expect(journal.readAfter(first.generation)).toMatchObject({
      generation: 3,
      entries: [{ gen: 3 }],
    });
  });

  it('turns event fanout transitions into named journal entries', () => {
    let now = Date.parse('2026-08-26T10:00:10.000Z');
    const journal = new WorkspaceJournal({
      now: () => now,
      resolvePanel: panelId => ({
        panelId,
        paneId: 'pane-1',
        isCliPanel: true,
        agentType: 'codex',
        lastActivityAt: '2026-08-26T10:00:00.000Z',
        screenText: 'output\n> ship it\n',
      }),
    });
    journal.send('session:created', { id: 'pane-1', name: 'Monitor', worktreePath: '/repo/monitor' });
    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'working', reason: 'spinner' });
    now += 10_000;
    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'idle', reason: 'prompt' });
    journal.send('session:deleted', { id: 'pane-1' });

    const entries = journal.readAfter(0, { includeHeldInput: true }).entries;
    expect(entries.map(entry => entry.kind)).toEqual(['pane.created', 'agent.busy', 'agent.ready', 'pane.gone']);
    expect(entries[2]).toMatchObject({ paneName: 'Monitor', settledMs: 20_000, heldInput: 'ship it' });
    const presenceOnly = journal.readAfter(0, { includeHeldInputPresence: true }).entries[2];
    expect(presenceOnly).toMatchObject({ heldInputPresent: true });
    expect(presenceOnly).not.toHaveProperty('heldInput');
    expect(journal.readySince('panel-1')).toBe(now);
  });

  it('reports a wrapper-launched panel to agents-only readers once its agent is known', () => {
    // A panel launched as `agent-farm run`: plain until Pane detects Claude behind it.
    const wrapper: WrapperIdentity = { isCliPanel: false };
    const journal = new WorkspaceJournal({
      resolvePane: paneId => ({ paneId, paneName: 'Farm' }),
      resolvePanel: panelId => ({ panelId, paneId: 'pane-1', ...wrapper }),
    });
    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'working' });
    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'idle' });
    expect(journal.readAfter(0, { agentsOnly: true }).entries).toEqual([]);

    wrapper.isCliPanel = true;
    wrapper.agentType = 'claude';
    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'working' });
    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'blocked' });
    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'idle' });

    expect(journal.readAfter(0, { agentsOnly: true }).entries.map(entry => [entry.kind, entry.agentType])).toEqual([
      ['agent.busy', 'claude'],
      ['agent.blocked', 'claude'],
      ['agent.ready', 'claude'],
    ]);
  });

  it('does not report the Claude Code prompt suggestion as held input', () => {
    const screens = new Map<string, string>([
      ['panel-suggestion', 'done\n> Try "fix the bug"\n'],
      ['panel-real', 'done\n> please rerun tests\n'],
    ]);
    const journal = new WorkspaceJournal({
      resolvePanel: panelId => ({ panelId, paneId: 'pane-1', isCliPanel: true, agentType: 'claude', screenText: screens.get(panelId) }),
    });
    journal.send('session:created', { id: 'pane-1', name: 'Monitor' });
    for (const panelId of screens.keys()) {
      journal.send('panel:agentStatus', { panelId, sessionId: 'pane-1', state: 'working' });
      journal.send('panel:agentStatus', { panelId, sessionId: 'pane-1', state: 'idle' });
    }

    const ready = journal.readAfter(0, { kinds: ['agent.ready'], includeHeldInput: true, includeHeldInputPresence: true }).entries;
    expect(ready.map(entry => entry.panelId)).toEqual(['panel-suggestion', 'panel-real']);
    expect(ready[0]).not.toHaveProperty('heldInput');
    expect(ready[0]).not.toHaveProperty('heldInputPresent');
    expect(ready[1]).toMatchObject({ heldInput: 'please rerun tests', heldInputPresent: true });
  });

  it('clears the ready clock when a panel becomes busy or exits', () => {
    let now = 1_000;
    const journal = new WorkspaceJournal({
      now: () => now,
      resolvePanel: panelId => ({ panelId, paneId: 'pane-1', isCliPanel: true }),
    });
    journal.send('session:created', { id: 'pane-1', name: 'Monitor' });
    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'working' });
    now = 2_000;
    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'idle' });
    expect(journal.readySince('panel-1')).toBe(2_000);

    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'working' });
    expect(journal.readySince('panel-1')).toBeUndefined();

    now = 3_000;
    journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state: 'idle' });
    expect(journal.readySince('panel-1')).toBe(3_000);
    journal.send('panel:event', {
      type: 'terminal:exit',
      source: { panelId: 'panel-1', sessionId: 'pane-1' },
      data: { exitCode: 0 },
    });
    expect(journal.readySince('panel-1')).toBeUndefined();
  });

  it('forgets panel state when a terminal exits', () => {
    const journal = new WorkspaceJournal({
      resolvePanel: panelId => ({ panelId, paneId: 'pane-1', isCliPanel: true }),
    });
    journal.send('session:created', { id: 'pane-1', name: 'Monitor' });
    journal.send('panel:agentStatus', {
      panelId: 'panel-1',
      sessionId: 'pane-1',
      state: 'working',
    });
    journal.send('panel:event', {
      type: 'terminal:exit',
      source: { panelId: 'panel-1', sessionId: 'pane-1' },
      data: { exitCode: 0 },
    });
    journal.send('panel:agentStatus', {
      panelId: 'panel-1',
      sessionId: 'pane-1',
      state: 'working',
    });

    expect(journal.readAfter(0).entries.map(entry => entry.kind)).toEqual([
      'pane.created',
      'agent.busy',
      'panel.exited',
      'agent.busy',
    ]);
  });

  it('records exits for successive lifetimes even when the new terminal exits before its first poll', () => {
    const journal = new WorkspaceJournal({ resolvePane: paneId => ({ paneId, paneName: 'Pane' }) });
    const exit = { type: 'terminal:exit', source: { panelId: 'p', sessionId: 's' }, data: { exitCode: 0 } };
    journal.send('panel:event', exit);
    journal.send('panel:event', exit);
    journal.send('panel:agentStatus', { panelId: 'p', sessionId: 's', state: 'unknown', reason: 'terminal_start' });
    journal.send('panel:event', exit);
    expect(journal.readAfter(0).entries.map(entry => entry.kind)).toEqual(['panel.exited', 'panel.exited']);
  });

  it('ignores agent-status events from ordinary shell panels', () => {
    let isCliPanel = false;
    const journal = new WorkspaceJournal({
      resolvePanel: panelId => ({ panelId, paneId: 'pane-1', isCliPanel }),
    });
    journal.send('session:created', { id: 'pane-1', name: 'Monitor' });
    journal.send('panel:agentStatus', {
      panelId: 'panel-1',
      sessionId: 'pane-1',
      state: 'working',
    });

    isCliPanel = true;
    journal.send('panel:agentStatus', {
      panelId: 'panel-1',
      sessionId: 'pane-1',
      state: 'working',
    });

    expect(journal.readAfter(0).entries.map(entry => entry.kind)).toEqual([
      'pane.created',
      'agent.busy',
    ]);
  });

  describe('Session scope', () => {
    const sessionId = '__orchestration_session_s1__';
    function sessionJournal() {
      const members = new Map<string, readonly string[]>([['one', []]]);
      const journal = new WorkspaceJournal({
        resolvePane: paneId => ({ paneId, paneName: paneId.toUpperCase() }),
        resolveSessionMembership: id => id === sessionId
          ? { panes: members, ownPaneIds: new Set(['owner']), ownPanelIds: new Set(['orchestrator']) }
          : undefined,
      });
      const ready = (paneId: string, panelId: string) => journal.append({
        kind: 'agent.ready', paneId, paneName: paneId, panelId, agentType: 'claude', source: 'agent',
      });
      return { journal, members, ready };
    }

    it('resolves membership on every read, so associate and detach need no re-arm', () => {
      const { journal, members, ready } = sessionJournal();
      const filter = { sessionId };
      ready('one', 'p1');
      ready('two', 'p2');
      expect(journal.readAfter(0, filter).entries.map(entry => entry.paneId)).toEqual(['one']);

      members.set('two', []);
      expect(journal.readAfter(0, filter).entries.map(entry => entry.paneId)).toEqual(['one', 'two']);

      members.delete('one');
      ready('one', 'p1');
      expect(journal.readAfter(2, filter).entries).toEqual([]);
      expect(journal.readAfter(0, { sessionId: 'missing' }).entries).toEqual([]);
    });

    it('honors association panel limits and never reports the orchestrator itself', () => {
      const { journal, members, ready } = sessionJournal();
      members.set('one', ['p1']);
      ready('one', 'p1');
      ready('one', 'p-other');
      ready('one', 'orchestrator');
      ready('owner', 'p-owner');
      journal.append({ kind: 'pane.gone', paneId: 'one', paneName: 'one', source: 'session' });

      expect(journal.readAfter(0, { sessionId }).entries.map(entry => [entry.kind, entry.panelId])).toEqual([
        ['agent.ready', 'p1'],
        ['pane.gone', undefined],
      ]);
    });

    it('records associate and detach as pane.associated and pane.detached for the Session', async () => {
      const { journal, members } = sessionJournal();
      const waiting = journal.waitAfter(0, { sessionId, agentsOnly: true }, 1000);
      members.set('two', []);
      journal.send('orchestration-sessions:changed', { sessionId, kind: 'associated', sessionName: 'Release', paneIds: ['two'] });
      await expect(waiting).resolves.toMatchObject({
        entries: [{ kind: 'pane.associated', paneId: 'two', paneName: 'TWO', sessionId, sessionName: 'Release', source: 'session' }],
      });

      members.delete('two');
      journal.send('orchestration-sessions:changed', { sessionId, kind: 'detached', sessionName: 'Release', paneIds: ['two'] });
      journal.send('orchestration-sessions:changed', { sessionId, kind: 'updated' });
      // The Pane has left, but its LEFT entry still belongs to the Session.
      expect(journal.readAfter(1, { sessionId }).entries).toMatchObject([{ kind: 'pane.detached', paneId: 'two' }]);
      expect(journal.readAfter(0, { sessionId: 'other' }).entries).toEqual([]);
      expect(journal.generation).toBe(2);
    });

    it('keeps membership kinds out of consumers that did not ask for them', () => {
      const { journal } = sessionJournal();
      journal.send('orchestration-sessions:changed', { sessionId, kind: 'associated', paneIds: ['two'] });

      expect(journal.readAfter(0, {}).entries).toEqual([]);
      expect(journal.readAfter(0, { kinds: ['pane.associated'], agentsOnly: true }).entries).toHaveLength(1);
    });

    it('delivers PR entries to Session watchers and to consumers that list them, never to older kinds-less consumers', () => {
      const { journal } = sessionJournal();
      const pr = { number: 747, url: 'https://github.com/acme/app/pull/747', headOid: 'abc' };
      expect(journal.appendPaneEntry('one', { kind: 'pr.conflicted', source: 'github', pr })).toMatchObject({ paneName: 'ONE' });
      journal.appendPaneEntry('two', { kind: 'pr.merged', source: 'github', pr });

      expect(journal.readAfter(0, {}).entries).toEqual([]);
      expect(journal.readAfter(0, { sessionId, agentsOnly: true }).entries).toMatchObject([
        { kind: 'pr.conflicted', paneId: 'one', pr, source: 'github' },
      ]);
      expect(journal.readAfter(0, { kinds: ['pr.merged'], agentsOnly: true }).entries.map(entry => entry.paneId)).toEqual(['two']);
      expect(journal.readAfter(0, { sessionId, kinds: ['agent.ready'] }).entries).toEqual([]);
    });

    it('delivers a member worker report to Session watchers, and still keeps it from kinds-less consumers', () => {
      const { journal } = sessionJournal();
      const report = { state: 'ready' as const, pr: 747, reportedAt: '2026-09-27T18:00:00.000Z' };
      journal.appendPaneEntry('one', { kind: 'agent.report', panelId: 'p1', agentType: 'claude', source: 'agent', report });
      journal.appendPaneEntry('two', { kind: 'agent.report', panelId: 'p2', agentType: 'claude', source: 'agent', report });

      expect(journal.readAfter(0, {}).entries).toEqual([]);
      expect(journal.readAfter(0, { sessionId }).entries).toMatchObject([{ kind: 'agent.report', paneId: 'one', report }]);
      expect(journal.readAfter(0, { sessionId, kinds: ['agent.ready'] }).entries).toEqual([]);
    });

    it('keys a Session scope by the Session rather than its Panes', () => {
      expect(workspaceFilterKey({ sessionId })).toBe(workspaceFilterKey({ sessionId }));
      expect(workspaceFilterKey({ sessionId })).not.toBe(workspaceFilterKey({ sessionId: 'other' }));
      expect(workspaceFilterKey({ sessionId })).not.toBe(workspaceFilterKey({}));
    });
  });

  it('delivers agent.report only to a consumer that lists it in kinds', async () => {
    const journal = new WorkspaceJournal({
      resolvePane: paneId => ({ paneId, paneName: 'Fix login', repoId: 7 }),
    });
    const anyKind = journal.waitAfter(0, {}, 50);
    const optedIn = journal.waitAfter(0, { kinds: ['agent.ready', 'agent.report'] }, 1000);
    const report = { state: 'ready' as const, pr: 747, head: 'fc5dce9', reportedAt: '2026-09-27T18:00:00.000Z' };
    journal.appendPaneEntry('pane-1', { kind: 'agent.report', panelId: 'panel-1', agentType: 'claude', source: 'agent', report });

    await expect(optedIn).resolves.toMatchObject({
      timedOut: false,
      entries: [{ kind: 'agent.report', paneId: 'pane-1', paneName: 'Fix login', repoId: 7, panelId: 'panel-1', report }],
    });
    await expect(anyKind).resolves.toMatchObject({ timedOut: true, entries: [] });
    expect(journal.readAfter(0).entries).toEqual([]);
    expect(journal.readAfter(0, { kinds: ['agent.ready'] }).entries).toEqual([]);
  });

  it('times out without inventing an entry', async () => {
    vi.useFakeTimers();
    const journal = new WorkspaceJournal();
    const waiting = journal.waitAfter(0, {}, 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(waiting).resolves.toMatchObject({ timedOut: true, entries: [] });
    vi.useRealTimers();
  });
});

it('records one exit per PTY lifetime when the same panel is restarted', () => {
  const journal = new WorkspaceJournal();
  journal.send('session:created', { id: 'pane', name: 'Pane' });
  const source = { panelId: 'panel', sessionId: 'pane' };
  const exit = { type: 'terminal:exit', source, data: { exitCode: 0 } };
  journal.send('panel:event', exit);
  journal.send('panel:event', exit);
  journal.send('panel:event', { type: 'terminal:started', source, data: {} });
  journal.send('panel:event', { ...exit, data: { exitCode: 1 } });
  expect(journal.readAfter(0, { kinds: ['panel.exited'] }).entries.map(entry => entry.exitCode)).toEqual([0, 1]);
});
