import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import type { AutopilotStack } from '../../../../shared/types/autopilot';
import { cantSeeMachines, groupItemRows, itemKind, notBroughtInCount, offlineItemRows, offlineSavedMachines, stackPositionLabel } from './autopilotFormat';
import type { MachineEntry } from '../../utils/machineList';
import type { MachineState } from '../../../../shared/types/machineConnections';
import { controlLine, parseItemIds, parseLogEntries, queuedControlLabel } from '../../../../shared/autopilotTranscript';

const paneFixes = { id: 's1', name: 'Pane Fixes', paneId: 'o1', orchestrator: true };
const infra = { id: 's2', name: 'Infra', paneId: 'o2' };
const item = (id: string, extra: Partial<NotifyItem> = {}): NotifyItem => ({ id, ui: 'approve', title: id, state: 'waiting', createdAt: 1, source: { name: 'planner', agent: 'Claude' }, ...extra });
const stack = (ids: string[], shown?: string): AutopilotStack => ({ entries: ids.map((id, index) => ({ id: `e${index}`, ref: { kind: 'item', notifyId: id }, title: id, tabs: [], addedAt: 1 })), shownId: shown ?? null });

describe('Autopilot chat item rows', () => {
  it('reads one id per line and ignores blanks, bullets and duplicates', () => {
    expect(parseItemIds('q14\n\n- q5\n* q10\nq14\n')).toEqual(['q14', 'q5', 'q10']);
  });

  it('groups items by Session in the order the block names them, with each item\'s live state', () => {
    const items = [
      item('q14', { source: { name: 'planner', agent: 'Claude', session: paneFixes } }),
      item('tf', { agentPrompt: { yes: 'Yes', no: 'No' }, source: { name: 'infra-queue', agent: 'Claude', session: infra } }),
      item('q5', { ui: 'options', state: 'answered', source: { name: 'planner', agent: 'Claude', session: paneFixes } }),
    ];
    const groups = groupItemRows(['q14', 'q5', 'tf', 'gone'], items, stack(['q14'], 'e0'));
    expect(groups.map(group => [group.label, group.rows.map(row => [row.id, row.state])])).toEqual([
      ['Pane Fixes', [['q14', 'shown'], ['q5', 'answered']]],
      ['Infra', [['tf', 'waiting']]],
      ['Earlier', [['gone', 'gone']]],
    ]);
  });

  it('keeps the current item current while its answer is in the Undo hold', () => {
    const groups = groupItemRows(['q14'], [item('q14', { state: 'sent' })], stack(['q14'], 'e0'));
    expect(groups[0].rows[0].state).toBe('shown');
  });

  it('files Autopilot\'s own items under Autopilot', () => {
    const groups = groupItemRows(['ap'], [item('ap', { source: { name: 'Autopilot', agent: 'Claude', autopilot: true } })], stack([]));
    expect(groups[0]).toMatchObject({ label: 'Autopilot', autopilot: true });
  });
});

describe('Autopilot and offline machines', () => {
  const away = (id: string, extra: Partial<NotifyItem> = {}) => item(id, { machine: 'Mac mini', machineId: 'mini', unreachable: true, ...extra });

  it('leaves an offline machine\'s open items out of the rows, one row per machine instead', () => {
    const items = [item('here'), away('a'), away('b'), away('done', { state: 'answered' })];
    const groups = groupItemRows(['here', 'a', 'b', 'done'], items, stack(['a'], 'e0'));
    expect(groups.flatMap(group => group.rows.map(row => row.id))).toEqual(['here', 'done']);
    expect(offlineItemRows(['here', 'a', 'b', 'done'], items)).toEqual([{ machineId: 'mini', machine: 'Mac mini', count: 2 }]);
  });

  const machine = (extra: Partial<MachineEntry>): MachineEntry => ({ id: 'x', name: 'x', os: 'macOS', kind: 'tailnet', slot: 0, letters: 'X', markKey: 'x', customMark: false, active: false, presence: 'solid', stateText: '', subtitle: '', action: 'connect', ...extra });
  const listed = (name: string, extra: Partial<NonNullable<MachineEntry['tailnet']>> = {}) => ({ name, dnsName: `${name}.ts.net`, url: '', os: 'macOS' as const, ownerLogin: 'me', mine: true, state: 'available' as const, ...extra });

  it('lists the person\'s Tailscale machines that aren\'t saved here', () => {
    const machines = [
      machine({ id: 'local', name: 'mini', kind: 'local' }),
      machine({ id: 'tailnet:book', name: 'book', tailnet: listed('book') }),
      machine({ id: 'tailnet:shut', name: 'shut', action: 'none', tailnet: listed('shut', { state: 'unreachable' }) }),
      // SAFETY: only a profile's presence matters to this list.
      machine({ id: 'saved', name: 'saved', profile: { id: 'saved' } as MachineEntry['profile'], tailnet: listed('saved', { profileId: 'saved' }) }),
      machine({ id: 'tailnet:theirs', name: 'theirs', tailnet: listed('theirs', { mine: false }) }),
      machine({ id: 'tailnet:off', name: 'off', action: 'none', tailnet: listed('off', { state: 'offline' }) }),
    ];
    expect(cantSeeMachines(machines).map(entry => entry.name)).toEqual(['book', 'shut']);
  });

  it('names saved machines it can\'t reach, past their grace', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const state = (id: string, extra: Partial<MachineState>): MachineState => ({ id, label: id, kind: 'remote', status: 'online', offlineSince: null, ...extra });
    const machines = [
      state('local', { kind: 'local' }),
      state('mini', { label: 'mini-label', status: 'offline', offlineSince: '2026-11-04T11:00:00Z' }),
      state('blip', { status: 'offline', offlineSince: '2026-11-04T11:59:59Z' }),
      state('new', { status: 'connecting' }),
    ];
    expect(offlineSavedMachines(machines, [{ id: 'mini', name: 'Mac mini' }], now)).toEqual([{ id: 'mini', name: 'Mac mini' }]);
    expect(offlineSavedMachines(machines, [], now)).toEqual([{ id: 'mini', name: 'mini-label' }]);
  });

  it('counts the answerable items neither on the stack nor shown in the chat', () => {
    const items = [item('on-stack'), item('in-chat'), item('new'), item('newer'), item('stale', { staleSince: 1 }), away('off'), item('done', { state: 'answered' })];
    expect(notBroughtInCount(items, stack(['on-stack']), { 'in-chat': 1 })).toBe(2);
  });
});

describe('Autopilot labels', () => {
  it('names an item by what it asks', () => {
    expect(itemKind(item('a'))).toBe('Approval');
    expect(itemKind(item('b', { ui: 'options' }))).toBe('Question');
    expect(itemKind(item('c', { agentPrompt: { yes: 'Yes', no: 'No' } }))).toBe('Permission');
    expect(itemKind(item('d', { source: { name: 'Autopilot', agent: 'Claude', autopilot: true } }))).toBe('Autopilot');
    expect(itemKind(item('e', { relay: { inboxItemId: 'i', worker: 'w', question: 'q' }, ui: 'ask' }))).toBe('Question');
  });

  it('says where the person is on the stack', () => {
    expect(stackPositionLabel(stack([]))).toBe('Empty');
    expect(stackPositionLabel(stack(['a', 'b', 'c'], 'e0'))).toBe('1 of 3');
    expect(stackPositionLabel(stack(['a', 'b', 'c'], 'e2'))).toBe('3 of 3');
  });

  it('shows Pane\'s control lines as short notices, and leaves the person\'s own messages alone', () => {
    expect(controlLine('[Pane · Start] The person pressed Start. Follow the skill.')).toBe('You pressed Start');
    expect(controlLine('[Pane · Pause] The person paused you.')).toBe('You paused Autopilot');
    expect(controlLine('[Pane · Go on] Pick the walk up.')).toBe('You pressed Go on');
    expect(controlLine('[Pane · Sentinel on] The person turned on Sentinel Mode.')).toBe('Sentinel on');
    expect(controlLine('[Pane · Sentinel off] The person is back.')).toBe('Sentinel off · welcome back');
    // The 5-minute check is Pane talking to Autopilot: nothing for the person to read.
    expect(controlLine('[Pane · Sentinel check] Five minutes since the last check.')).toBe('');
    expect(controlLine('[Pane · Back] The person opened Autopilot while Sentinel stays on.')).toBe('Welcome back');
    expect(controlLine('[Pane · Instructions] The person changed their own instructions for you.')).toBe('Your instructions updated');
    expect(controlLine('Does package 1 remove anything the phone uses?')).toBeUndefined();
  });

  it('reads Sentinel\'s log entries, and drops lines it cannot read', () => {
    const entries = parseLogEntries('{"at":"10:12","session":"Pane Fixes","kind":"answered","what":"Keep #1215\'s prompts? → yes","why":"D-21 in the cover sheet"}\nnot json\n{"at":"10:38","session":"Infra","kind":"nudged","what":"orchestrator idle 25 min"}\n{"kind":"sideways"}');
    expect(entries.map(entry => [entry.kind, entry.session])).toEqual([['answered', 'Pane Fixes'], ['nudged', 'Infra']]);
  });
});

describe('queuedControlLabel', () => {
  it('names a queued Pane line by its notice, a hidden one as Sentinel check, and leaves the person\'s text alone', () => {
    expect(queuedControlLabel('[Pane · Sentinel on] The person turned on Sentinel Mode and may be away.')).toBe('Sentinel on');
    expect(queuedControlLabel('[Pane · Sentinel check] Five minutes since the last check.')).toBe('Sentinel check');
    expect(queuedControlLabel('[Pane · Carry on] You have been idle for 3 minutes.')).toBe('Carry on');
    expect(controlLine('[Pane · Carry on] You have been idle for 3 minutes.')).toBe('');
    expect(queuedControlLabel('Approve the first one')).toBeUndefined();
  });
});
