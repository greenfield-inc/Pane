import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../../shared/types/notify';
import type { TodoActivity } from '../../../../../shared/types/todos';
import { approvalCardView, deliveryLine, isWebTarget, mergeTodoChat, todoEventIcon } from './chatEntries';

function activity(id: number, createdAt: number, body = 'note'): TodoActivity {
  return { id, todoNumber: 16, kind: 'event', authorKind: 'pane', authorName: 'Pane', body, createdAt };
}

function approval(id: string, createdAt: number, overrides: Partial<NotifyItem> = {}): NotifyItem {
  return {
    id, ui: 'options', title: 'Q-11: Merge #1352 now that CI is green?', state: 'waiting', createdAt,
    source: { name: 'orchestrator', agent: 'Claude' },
    ...overrides,
  };
}

describe('mergeTodoChat', () => {
  it('places approval cards among the activity by when they were asked', () => {
    const entries = mergeTodoChat([activity(1, 10), activity(2, 30)], ['q11'], [approval('q11', 20)]);
    expect(entries.map((entry) => (entry.kind === 'activity' ? entry.activity.id : entry.item.id))).toEqual([1, 'q11', 2]);
  });

  it('leaves out approvals the snapshot no longer has, and repeats none', () => {
    const entries = mergeTodoChat([activity(1, 10)], ['gone', 'q11', 'q11'], [approval('q11', 5)]);
    expect(entries.map((entry) => entry.kind)).toEqual(['approval', 'activity']);
  });

  it('keeps activity ahead of a card asked at the same moment', () => {
    const entries = mergeTodoChat([activity(1, 10)], ['q11'], [approval('q11', 10)]);
    expect(entries[0].kind).toBe('activity');
  });
});

describe('approvalCardView', () => {
  it('reads a waiting approval with its Q-n split from the question', () => {
    const view = approvalCardView(approval('q11', 1, { context: 'Merge commit on main.' }));
    expect(view).toMatchObject({ qn: 'Q-11', question: 'Merge #1352 now that CI is green?', state: 'waiting', label: 'Q-11 · waiting on you', context: 'Merge commit on main.' });
  });

  it('reads an answered approval with its decision and answer', () => {
    const view = approvalCardView(approval('q10', 1, { title: 'Q-10: Which key?', state: 'answered', answerSummary: '⌘/ everywhere', decision: 'D-14' }));
    expect(view).toMatchObject({ label: 'Q-10 · answered · D-14', answer: '⌘/ everywhere', state: 'answered' });
  });

  it('says why a closed approval closed, and handles a title without a Q-n', () => {
    const view = approvalCardView(approval('x', 1, { title: 'Run it?', state: 'expired', closed: { by: 'pane', reason: 'Session archived', at: 2 } }));
    expect(view).toMatchObject({ question: 'Run it?', label: 'Approval · closed: Session archived', state: 'closed' });
  });
});

describe('todoEventIcon', () => {
  it('reads an event’s icon from its words', () => {
    expect(todoEventIcon('Created by the orchestrator from your message')).toBe('created');
    expect(todoEventIcon('Started by the orchestrator')).toBe('started');
    expect(todoEventIcon('Sub-to-do T-13 done: plan approved')).toBe('done');
    expect(todoEventIcon('Start held: devbox is busy')).toBe('queued');
    expect(todoEventIcon('Stopped by you')).toBe('stopped');
    expect(todoEventIcon('Quiet 30 min: Pane restarted the orchestrator')).toBe('alert');
    expect(todoEventIcon('Renamed')).toBe('note');
  });
});

describe('deliveryLine and isWebTarget', () => {
  it('says delivered only once the agent has it', () => {
    expect(deliveryLine({ deliveredAt: 5, toName: 'orchestrator' })).toBe('Delivered to orchestrator');
    expect(deliveryLine({})).toBe('waiting for the agent to finish its turn');
  });

  it('tells a URL from a file path', () => {
    expect(isWebTarget('https://github.com/x/y/pull/1')).toBe(true);
    expect(isWebTarget('/Users/me/plan.html')).toBe(false);
  });
});
