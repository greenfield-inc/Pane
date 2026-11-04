import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { groupApprovals } from './approvalGroups';

const launch = { id: 'session-1', name: 'Pane Fixes', paneId: 'session-pane' };
const infra = { id: 'session-2', name: 'Infra', paneId: 'infra-pane' };

function item(id: string, createdAt: number, extra: Partial<NotifyItem> = {}): NotifyItem {
  return { id, ui: 'approve', title: id, source: { name: 'pane', agent: 'Claude' }, state: 'waiting', createdAt, ...extra };
}

describe('groupApprovals', () => {
  it('groups waiting items by Session and machine, oldest first, with "Not in a Session" last', () => {
    const items = [
      item('loose', 1, { source: { name: 'docs', agent: 'Cursor' } }),
      item('plan', 2, { source: { name: 'Pane Fixes', agent: 'Claude', session: { ...launch, orchestrator: true } } }),
      item('terraform', 3, { source: { name: 'infra-queue', agent: 'Claude', session: infra }, machine: 'studio', machineId: 'studio' }),
      item('sidebar', 4, { source: { name: 'session-order', agent: 'Claude', session: launch } }),
      item('held', 5, { state: 'sent', source: { name: 'Pane Fixes', agent: 'Claude', session: launch } }),
      item('fyi', 6, { ui: 'info', state: 'info' }),
      item('done', 7, { state: 'answered', resolvedAt: 9 }),
    ];
    const { waiting, groups } = groupApprovals(items, 'waiting');

    expect(waiting).toBe(4);
    expect(groups.map(group => [group.label, group.machineId, group.items.map(entry => entry.id)])).toEqual([
      ['Pane Fixes', undefined, ['plan', 'sidebar', 'held']],
      ['Infra', 'studio', ['terraform']],
      ['Not in a Session', undefined, ['loose']],
    ]);
    expect(groups[0].session).toEqual({ ...launch, orchestrator: true });
  });

  it('keeps one Session on two machines as two groups', () => {
    const items = [
      item('a', 1, { source: { name: 'x', agent: 'Claude', session: launch }, machineId: 'local', machine: 'macbook' }),
      item('b', 2, { source: { name: 'y', agent: 'Claude', session: launch }, machineId: 'studio', machine: 'studio' }),
    ];
    expect(groupApprovals(items, 'waiting').groups.map(group => group.machineId)).toEqual(['local', 'studio']);
  });

  it('lists answered and expired items and updates newest first under Answered, with the same grouping', () => {
    const items = [
      item('old', 1, { state: 'answered', resolvedAt: 10, source: { name: 'x', agent: 'Claude', session: launch } }),
      item('gone', 2, { state: 'expired', resolvedAt: 30 }),
      item('new', 3, { state: 'answered', resolvedAt: 20, source: { name: 'x', agent: 'Claude', session: launch } }),
      item('open', 4),
      item('update', 5, { ui: 'info', state: 'info' }),
    ];
    const answered = groupApprovals(items, 'answered');
    expect(answered.answered).toBe(4);
    expect(answered.groups.map(group => group.items.map(entry => entry.id))).toEqual([['new', 'old'], ['gone', 'update']]);
  });
});
