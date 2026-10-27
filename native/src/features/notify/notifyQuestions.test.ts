import { describe, expect, it } from 'vitest';

import type { NotifyItem, NotifySharedState } from '@shared/types/notify';

import { notifySheetState, waitingQuestions } from './notifyQuestions';

const question: NotifyItem = {
  id: 'q1', ui: 'approve', title: 'Run the migration?', source: { paneId: 's1', name: 'api-fix', agent: 'Claude' }, state: 'waiting', createdAt: 2_000,
};

describe('notifySheetState', () => {
  it('shows a waiting question', () => {
    expect(notifySheetState(question)).toEqual({ kind: 'question', item: question });
  });

  it('names the device that answered first', () => {
    expect(notifySheetState({ ...question, state: 'sent', answeredOn: 'Parsa’s MacBook' }))
      .toEqual({ kind: 'closed', message: 'Already answered on Parsa’s MacBook' });
    expect(notifySheetState({ ...question, state: 'answered' })).toEqual({ kind: 'closed', message: 'Already answered on another screen' });
  });

  it('says when the agent stopped waiting', () => {
    expect(notifySheetState({ ...question, state: 'expired' })).toEqual({ kind: 'closed', message: 'Claude stopped waiting' });
  });

  it('explains a question the host no longer holds', () => {
    expect(notifySheetState(undefined)).toEqual({ kind: 'closed', message: 'This question is no longer waiting.' });
  });
});

describe('waitingQuestions', () => {
  it('lists only waiting questions, oldest first', () => {
    const newer: NotifyItem = { ...question, id: 'q2', createdAt: 3_000 };
    const older: NotifyItem = { ...question, id: 'q0', createdAt: 1_000, source: { name: 'docs', agent: 'Codex' } };
    const state: NotifySharedState = {
      machine: 'Work Mac', enabled: true, queue: ['q0', 'q1', 'q2'], hidden: [],
      items: [newer, question, { ...question, id: 'q3', state: 'answered' }, { ...question, id: 'q4', ui: 'info', state: 'info' }, older],
    };
    expect(waitingQuestions(state).map(item => item.id)).toEqual(['q0', 'q1', 'q2']);
    expect(waitingQuestions(undefined)).toEqual([]);
  });
});
