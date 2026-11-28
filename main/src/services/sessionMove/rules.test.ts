import path from 'path';
import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { agentFarmProfileOf, movedLine, heldBackChecks, profileChecks, sessionApprovals, tabAgentFarmLaunch, tabSnapshotFolder } from './rules';
import { buildPathMap } from './pathMap';

describe('agentFarmProfileOf', () => {
  it('reads the profile an Agent Farm tab launches, without its variant', () => {
    expect(agentFarmProfileOf('agent-farm run greenfield/planner:codex --arg parent=/x')).toBe('greenfield/planner');
    expect(agentFarmProfileOf('claude --dangerously-skip-permissions')).toBeNull();
  });

  // T-83 P3: a launch link's command names the shim by its path and carries --parent.
  it('reads a launch link\'s command as Agent Farm prints it, with the shim\'s path, only with links', () => {
    expect(agentFarmProfileOf('/Users/me/.pane/bin/agent-farm run greenfield/planner --config-root /Users/me/.pane/agent-farm --parent greenfield/orchestrator:claude@abc', true)).toBe('greenfield/planner');
    expect(agentFarmProfileOf("'/Users/Jo B/.pane/bin/agent-farm' run greenfield/reviewer:codex --parent greenfield/orchestrator@abc", true)).toBe('greenfield/reviewer');
    expect(agentFarmProfileOf('C:\\Users\\me\\.pane\\bin\\agent-farm-launch\\agent-farm run greenfield/planner --parent greenfield/orchestrator@abc', true)).toBe('greenfield/planner');
    expect(agentFarmProfileOf('my-agent-farm run x', true)).toBeNull();
  });

  // Review F-1, F-3: a path-named agent-farm adds no required profile, as before T-83 P3.
  it('reads only a bare agent-farm command without links, as before T-83 P3', () => {
    expect(agentFarmProfileOf('/opt/tools/agent-farm run greenfield/planner --arg parent=/x')).toBeNull();
    expect(agentFarmProfileOf('/Users/me/.pane/bin/agent-farm run greenfield/planner --parent greenfield/orchestrator@abc')).toBeNull();
    expect(agentFarmProfileOf('agent-farm run greenfield/planner:codex')).toBe('greenfield/planner');
  });
});

describe('movedLine', () => {
  it('names both machines and the path map, and asks to restart watches and servers', () => {
    const map = buildPathMap({ sourceHome: '/Users/alice', targetHome: '/Users/robert-b', entries: [] });
    const line = movedLine('studio-a', 'studio-b', map);
    expect(line).toContain('from studio-a to studio-b');
    expect(line).toContain('/Users/alice → /Users/robert-b');
    expect(line).toMatch(/re-arm your runpane watch/);
    expect(line).toMatch(/moved\.json/);
  });
});

describe('heldBackChecks', () => {
  const tab = (queued: number, running: boolean) => ({ panelId: 'p1', title: 'Chat', running, queued });
  const none = { carried: [], held: [] };

  it('lets open approvals move with the Session, and says so (T-44)', () => {
    expect(heldBackChecks({ carried: [item('1'), item('2')], held: [] }, [], false)).toEqual([expect.objectContaining({ id: 'approvals', level: 'ok', title: '2 open approvals move with the Session' })]);
  });

  it('blocks only an approval that can\'t move yet: an answer in its Undo hold, or a secret request', () => {
    expect(heldBackChecks({ carried: [item('1')], held: [item('2', { state: 'sent' })] }, [], false)).toEqual([
      expect.objectContaining({ id: 'approvals', level: 'block', title: '1 approval in this Session can\'t move yet' }),
    ]);
  });

  it('blocks queued chat messages that would not send before the tab stops (F-5)', () => {
    expect(heldBackChecks(none, [tab(1, true)], false)).toEqual([]);
    expect(heldBackChecks(none, [tab(1, false)], false)).toEqual([expect.objectContaining({ id: 'queue:p1', level: 'block' })]);
    // Once every tab stopped (Stop now), even a running tab's queue stays behind.
    expect(heldBackChecks(none, [tab(3, true)], true)).toEqual([expect.objectContaining({ title: '3 messages waiting in Chat' })]);
    expect(heldBackChecks(none, [tab(0, false)], true)).toEqual([]);
  });
});

function item(id: string, extra: Partial<NotifyItem> = {}): NotifyItem {
  return {
    id, ui: 'approve', title: `Q-${id}: Ship it?`, state: 'waiting', createdAt: 1,
    source: { name: 'worker', agent: 'Claude', paneId: 'member-pane', panelId: 'tab-1', session: { id: 'session-1', name: 'Doozy', paneId: 'orch-pane' } },
    ...extra,
  };
}

describe('sessionApprovals', () => {
  // The moving Session's tabs, and the card fields that file a card under it.
  const ids = {
    askedHere: (card: NotifyItem) => ['tab-1', 'orch-tab'].includes(card.source.panelId ?? ''),
    filedHere: (card: NotifyItem) => card.source.session?.id === 'session-1' || card.connected?.id === 'session-1',
  };

  it('carries waiting approvals, dismissed ones too, and holds none of them (T-3, T-44)', () => {
    const found = sessionApprovals([item('1', { dismissedAt: 5 }), item('2')], ids);
    expect(found.carried.map(approval => approval.id)).toEqual(['1', '2']);
    expect(found.held).toEqual([]);
  });

  it('holds an answer in its Undo hold, and an open card that can\'t move; ignores other Sessions\' and ended ones', () => {
    const elsewhere = item('3', { source: { name: 'w', agent: 'Claude', paneId: 'other-pane', panelId: 't', session: { id: 'session-2', name: 'X', paneId: 'x' } } });
    // Another Session's card that only mentions this Session (say, a link into its folder) is never this move's.
    const mentions = item('8', { links: [{ label: 'x', path: '/p/.pane/sessions/session-1/plan.html' }], source: { name: 'w', agent: 'Claude', panelId: 't9', session: { id: 'session-2', name: 'X', paneId: 'x' } } });
    // Filed under this Session but asked from a tab that isn't moving: it can't reach its asker there, so it holds the move.
    const outside = item('9', { source: { name: 'w', agent: 'Claude', panelId: 'elsewhere-tab', session: { id: 'session-1', name: 'Doozy', paneId: 'orch-pane' } } });
    // SAFETY: sessionApprovals reads only whether these fields are present, never their contents.
    const secret = item('5', { secret: { project: 'p', name: 'TOKEN' } as NotifyItem['secret'] });
    // SAFETY: as above, only its presence counts.
    const prompt = item('6', { agentPrompt: {} as NotifyItem['agentPrompt'] });
    const found = sessionApprovals([item('1', { state: 'sent' }), elsewhere, mentions, item('4', { state: 'answered' }), secret, prompt, item('7', { dismissedAt: 1, secret: secret.secret }), outside], ids);
    expect(found.held.map(approval => approval.id)).toEqual(['1', '5', '6', '9']);
    expect(found.carried).toEqual([]);
  });
});

// T-110 (D-3): a moved Session runs its snapshot's profile files, whatever the target has installed.
describe('profileChecks', () => {
  const at = { machine: 'Studio', source: 'Laptop' };
  it('accepts a profile the Session\'s snapshot holds though the target lacks it, and blocks one neither holds', () => {
    const { checks, installed } = profileChecks({ 'greenfield/planner': '0.1.2', 'team/lead': '1.0.0' }, {}, ['greenfield/planner'], { ...at, snapshots: true });
    expect(checks).toEqual([{ id: 'profile:team/lead', level: 'block', title: 'Agent Farm profile team/lead isn\'t on Studio', detail: expect.stringContaining('Install its plugin') }]);
    expect(installed).toEqual(['Agent Farm greenfield/planner 0.1.2, from the Session\'s snapshot']);
  });

  it('runs a held profile from the snapshot without warning that the installed version differs', () => {
    const { checks, installed } = profileChecks({ 'greenfield/planner': '0.1.2' }, { 'greenfield/planner': '0.2.0' }, ['greenfield/planner'], { ...at, snapshots: true });
    expect(checks).toEqual([]);
    expect(installed).toEqual(['Agent Farm greenfield/planner 0.1.2, from the Session\'s snapshot']);
  });

  it('checks the installed plugins as before when the target doesn\'t use snapshots (Profiles off there) or none holds the profile', () => {
    expect(profileChecks({ 'greenfield/planner': '0.1.2' }, {}, ['greenfield/planner'], { ...at, snapshots: false }).checks).toEqual([expect.objectContaining({ id: 'profile:greenfield/planner', level: 'block' })]);
    expect(profileChecks({ 'greenfield/planner': '0.1.2' }, { 'greenfield/planner': '0.2.0' }, [], { ...at, snapshots: true }).checks).toEqual([expect.objectContaining({ level: 'warning', title: 'greenfield/planner is 0.2.0 there, 0.1.2 here' })]);
    expect(profileChecks({ 'greenfield/planner': '0.1.2' }, { 'greenfield/planner': '0.1.2' }, [], { ...at, snapshots: true })).toEqual({ checks: [], installed: ['Agent Farm greenfield/planner 0.1.2'] });
  });
});

describe('tabSnapshotFolder', () => {
  const folder = path.resolve('/pane/sessions/s1');
  const snap = (digest: string) => path.join(folder, '.agent-farm', 'snapshots', digest);
  it('takes the command\'s --snapshot, else the tab\'s pinned one, else the Session\'s, inside the Session folder only', () => {
    expect(tabSnapshotFolder(`agent-farm run greenfield/planner --snapshot '${snap('d1')}'`, { agentFarmSnapshot: snap('d2') }, folder, '.agent-farm/snapshots/d3')).toBe(snap('d1'));
    expect(tabSnapshotFolder('agent-farm run greenfield/planner', { agentFarmSnapshot: snap('d2') }, folder, '.agent-farm/snapshots/d3')).toBe(snap('d2'));
    expect(tabSnapshotFolder('agent-farm run greenfield/planner', {}, folder, '.agent-farm/snapshots/d3')).toBe(snap('d3'));
    // A snapshot outside the Session folder doesn't travel, so it holds nothing there.
    expect(tabSnapshotFolder(`agent-farm run greenfield/planner --snapshot '${path.resolve('/repo/.agent-farm/snapshots/d9')}'`, {}, folder, '.agent-farm/snapshots/d3')).toBeUndefined();
    expect(tabSnapshotFolder('agent-farm run greenfield/planner', {}, folder, undefined)).toBeUndefined();
    // Review F-6: a folder with an apostrophe, quoted the POSIX way, reads back whole.
    const odd = path.join(folder, '.agent-farm', 'snapshots', "o'd");
    expect(tabSnapshotFolder(`agent-farm run greenfield/planner --snapshot '${odd.replace(/'/g, "'\\''")}'`, {}, folder, undefined)).toBe(odd);
  });
});

describe('tabAgentFarmLaunch: a move preflight sees a profile chat as it does a terminal (#1762 F-8)', () => {
  const folder = path.resolve('/pane/sessions/s1');
  const snap = (digest: string) => path.join(folder, '.agent-farm', 'snapshots', digest);
  it('reads a profile chat\'s structured launch and its own snapshot, which wins as --snapshot does', () => {
    expect(tabAgentFarmLaunch({ launch: { kind: 'profile', profile: 'greenfield/planner', snapshot: snap('d1') }, agentFarmSnapshot: snap('d2') }, folder, '.agent-farm/snapshots/d3'))
      .toEqual({ profile: 'greenfield/planner', folder: snap('d1') });
    expect(tabAgentFarmLaunch({ launch: { kind: 'profile', profile: 'greenfield/planner' }, agentFarmSnapshot: snap('d2') }, folder, undefined)).toEqual({ profile: 'greenfield/planner', folder: snap('d2') });
  });
  it('gives a chat pinned outside the Session folder no snapshot, so the target checks its installed plugins', () => {
    expect(tabAgentFarmLaunch({ launch: { kind: 'profile', profile: 'greenfield/planner', snapshot: path.resolve('/repo/.agent-farm/snapshots/d9') } }, folder, '.agent-farm/snapshots/d3'))
      .toEqual({ profile: 'greenfield/planner', folder: undefined });
  });
  it('reads a terminal\'s command, and nothing for a plain agent', () => {
    expect(tabAgentFarmLaunch({ launchCommand: 'agent-farm run greenfield/planner' }, folder, '.agent-farm/snapshots/d3')).toEqual({ profile: 'greenfield/planner', folder: snap('d3') });
    expect(tabAgentFarmLaunch({ launch: { kind: 'agent' } }, folder, '.agent-farm/snapshots/d3')).toBeNull();
    expect(tabAgentFarmLaunch({ launchCommand: 'claude' }, folder, undefined)).toBeNull();
  });
  it('with Profiles off, reads terminals only, as the move preflight did before', () => {
    expect(tabAgentFarmLaunch({ launch: { kind: 'profile', profile: 'greenfield/planner' } }, folder, undefined, { chats: false })).toBeNull();
  });
});
