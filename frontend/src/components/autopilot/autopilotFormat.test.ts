import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import type { AutopilotStack } from '../../../../shared/types/autopilot';
import { groupItemRows, itemKind, stackPositionLabel } from './autopilotFormat';
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

describe('Autopilot labels', () => {
  it('names an item by what it asks', () => {
    expect(itemKind(item('a'))).toBe('Approval');
    expect(itemKind(item('b', { ui: 'options' }))).toBe('Question');
    expect(itemKind(item('c', { agentPrompt: { yes: 'Yes', no: 'No' } }))).toBe('Permission');
    expect(itemKind(item('d', { source: { name: 'Autopilot', agent: 'Claude', autopilot: true } }))).toBe('Autopilot');
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
