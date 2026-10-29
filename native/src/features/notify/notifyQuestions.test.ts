import { describe, expect, it } from 'vitest';

import type { NotifyItem, NotifySharedState } from '@shared/types/notify';

import { notifySheetState, waitingQuestions } from './notifyQuestions';

const question: NotifyItem = {
  id: 'q1', ui: 'approve', title: 'Run the migration?', source: { paneId: 's1', name: 'api-fix', agent: 'Claude' }, state: 'waiting', createdAt: 2_000,
};

describe('notifySheetState', () => {
  const at = (revision: number, ...items: NotifyItem[]): NotifySharedState => ({ machine: 'Work Mac', epoch: 'e1', revision, enabled: true, queue: [], hidden: [], items });
  const sent: NotifyItem = { ...question, state: 'sent', answerSummary: 'Approved', answeredOn: 'Parsa’s iPhone' };
  const thisPhone = { epoch: 'e1', revision: 4 };

  it('shows a waiting question', () => {
    expect(notifySheetState(at(4, question), 'q1', null)).toEqual({ kind: 'question', item: question });
  });

  it('holds this phone\'s answer for Undo as soon as the host accepts it, before the snapshot catches up', () => {
    expect(notifySheetState(at(4, question), 'q1', thisPhone)).toEqual({ kind: 'held', title: 'Sent to Claude' });
    expect(notifySheetState(at(5, sent), 'q1', thisPhone)).toEqual({ kind: 'held', title: 'Sent to Claude', summary: 'Approved' });
  });

  it('holds another screen\'s answer for Undo too, naming that screen', () => {
    expect(notifySheetState(at(5, { ...sent, answeredOn: 'Parsa’s MacBook' }), 'q1', null))
      .toEqual({ kind: 'held', title: 'Answered on Parsa’s MacBook', summary: 'Approved' });
  });

  it('asks again once a newer snapshot shows the answer undone, here or elsewhere', () => {
    expect(notifySheetState(at(6, question), 'q1', thisPhone)).toEqual({ kind: 'question', item: question });
    expect(notifySheetState({ ...at(2, question), epoch: 'e2' }, 'q1', thisPhone)).toEqual({ kind: 'question', item: question });
  });

  it('closes after this phone\'s answer reaches the agent, and says who answered otherwise', () => {
    const answered: NotifyItem = { ...sent, state: 'answered', answeredOn: 'Parsa’s MacBook' };
    expect(notifySheetState(at(6, answered), 'q1', thisPhone)).toEqual({ kind: 'done', title: 'Sent to Claude', summary: 'Approved' });
    expect(notifySheetState(at(6, answered), 'q1', null)).toEqual({ kind: 'closed', message: 'Already answered on Parsa’s MacBook' });
    expect(notifySheetState(at(6, { ...question, state: 'answered' }), 'q1', null)).toEqual({ kind: 'closed', message: 'Already answered on another screen' });
  });

  it('says when the agent stopped waiting', () => {
    expect(notifySheetState(at(4, { ...question, state: 'expired' }), 'q1', null)).toEqual({ kind: 'closed', message: 'Claude stopped waiting' });
  });

  it('explains a question the host no longer holds', () => {
    expect(notifySheetState(at(4), 'q1', null)).toEqual({ kind: 'closed', message: 'This question is no longer waiting.' });
  });
});

describe('waitingQuestions', () => {
  it('lists only waiting questions, oldest first', () => {
    const newer: NotifyItem = { ...question, id: 'q2', createdAt: 3_000 };
    const older: NotifyItem = { ...question, id: 'q0', createdAt: 1_000, source: { name: 'docs', agent: 'Codex' } };
    const state: NotifySharedState = {
      machine: 'Work Mac', epoch: 'e1', revision: 1, enabled: true, queue: ['q0', 'q1', 'q2'], hidden: [],
      items: [newer, question, { ...question, id: 'q3', state: 'answered' }, { ...question, id: 'q4', ui: 'info', state: 'info' }, older],
    };
    expect(waitingQuestions(state).map(item => item.id)).toEqual(['q0', 'q1', 'q2']);
    expect(waitingQuestions(undefined)).toEqual([]);
  });
});
