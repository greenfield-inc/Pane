import { describe, expect, it } from 'vitest';

import type { NotifyItem, NotifySharedState } from '@shared/types/notify';

import { isReply, notifySheetState, optionsAnswer, replyStatus, revisionNote, waitingQuestions } from './notifyQuestions';

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

  it('closes on a secret as soon as the host accepts it, with no Undo, and says where it was saved', () => {
    const secret: NotifyItem = { ...question, ui: 'secret', title: 'Stripe key', secret: { project: 'stripe', name: 'STRIPE_KEY' } };
    expect(notifySheetState(at(4, secret), 'q1', thisPhone)).toEqual({ kind: 'done', title: 'Answered' });
    expect(notifySheetState(at(5, { ...secret, state: 'answered', answerSummary: 'Saved as stripe/STRIPE_KEY' }), 'q1', thisPhone))
      .toEqual({ kind: 'done', title: 'Answered', summary: 'Saved as stripe/STRIPE_KEY' });
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

  it("sends an agent's terminal prompt to its terminal once the agent stopped waiting on Pane", () => {
    const prompt: NotifyItem = { ...question, ui: 'options', choices: [{ label: 'Yes' }, { label: 'No' }], agentPrompt: { yes: 'Yes', no: 'No', inTerminal: true } };
    expect(notifySheetState(at(4, prompt), 'q1', null)).toEqual({ kind: 'closed', message: 'Claude is asking in the terminal now. Open the Pane to answer.' });
  });

  it('says when the agent stopped waiting', () => {
    expect(notifySheetState(at(4, { ...question, state: 'expired' }), 'q1', null)).toEqual({ kind: 'closed', message: 'Claude stopped waiting' });
  });

  it('shows the receipt once one says who answered or why it closed', () => {
    const byAutopilot: NotifyItem = { ...question, state: 'answered', answeredBy: { by: 'autopilot', because: 'D-22' } };
    expect(notifySheetState(at(6, byAutopilot), 'q1', null)).toEqual({ kind: 'closed', message: 'Answered by Autopilot · because D-22' });
    const closed: NotifyItem = { ...question, state: 'expired', closed: { by: 'pane', reason: 'Session archived', at: 1 } };
    expect(notifySheetState(at(6, closed), 'q1', null)).toEqual({ kind: 'closed', message: 'Closed: Session archived' });
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

describe('the reply states (P7, J19)', () => {
  const options: NotifyItem = { ...question, id: 'q20', ui: 'options', title: 'Turn on trains?', choices: [{ label: 'Yes, turn it on' }, { label: 'No' }] };
  const reply = (extra: Partial<NonNullable<NotifyItem['reply']>>): NotifyItem['reply'] => ({ id: 'r1', text: 'Only if it can be undone', at: 5_000, state: 'reading', reader: { kind: 'asker', name: 'doozy-overhaul' }, ...extra });

  it('shows nothing for an approval with no reply and no new version', () => {
    expect(replyStatus(options)).toBeNull();
  });

  it('reads a reply as being read, by Autopilot when it is the reader', () => {
    expect(replyStatus({ ...options, reply: reply({ picks: ['Yes, turn it on'] }) })).toEqual({ text: 'Reading your reply…', tone: 'muted', detail: 'You wrote: “Only if it can be undone” (picked: Yes, turn it on)' });
    expect(replyStatus({ ...options, reply: reply({ picks: [''], reader: { kind: 'autopilot', name: 'Autopilot' } }) })?.text).toBe('Autopilot is reading your reply…');
  });

  it('says how a reply was taken, with the one-tap fix until the person makes one', () => {
    expect(replyStatus({ ...options, state: 'answered', reply: reply({ state: 'answer' }) })).toMatchObject({ text: 'Taken as your answer', tone: 'success', fix: { as: 'question', label: 'It was a question' } });
    expect(replyStatus({ ...options, reply: reply({ state: 'question' }) })).toEqual({ text: 'Taken as a question: asking doozy-overhaul', tone: 'warning', detail: 'Getting more context…', fix: { as: 'answer', label: 'It was my answer' } });
    expect(replyStatus({ ...options, reply: reply({ state: 'question', status: 'Checking the rollback path', fixed: 'question' }) })).toEqual({ text: 'Taken as a question: asking doozy-overhaul', tone: 'warning', detail: 'Checking the rollback path' });
  });

  it('names the agent a built-in question went to, and says when no agent can read replies', () => {
    expect(replyStatus({ ...options, state: 'answered', reply: reply({ state: 'sent' }) })?.text).toBe('Sent to Claude');
    expect(replyStatus({ ...options, reply: reply({ state: 'unread', reader: undefined }) })?.text).toBe('No agent can read replies right now. You can still pick an option.');
  });

  it('reads "Updated · ready again" with its version until the person replies again', () => {
    const updated: NotifyItem = { ...options, version: 2, readyAgain: 9_000, reply: reply({ state: 'question' }) };
    expect(replyStatus(updated)).toEqual({ text: 'Updated · ready again · v2', tone: 'accent' });
    expect(replyStatus({ ...updated, reply: reply({ at: 10_000 }) })?.text).toBe('Reading your reply…');
    expect(replyStatus({ ...updated, state: 'answered', reply: undefined })).toBeNull();
  });

  it('gives the detail screen What changed: the question asked and the asker’s lines', () => {
    expect(revisionNote(options)).toBeNull();
    const revised: NotifyItem = { ...options, version: 2, revision: { asked: 'Can it be undone?', whatChanged: ['Added an undo step', ''], by: 'doozy-overhaul', at: 9_000 } };
    expect(revisionNote(revised)).toEqual({ version: 2, asked: 'Can it be undone?', by: 'doozy-overhaul', whatChanged: ['Added an undo step'] });
  });
});

describe('optionsAnswer', () => {
  const one: NotifyItem = { ...question, ui: 'options', choices: [{ label: 'Yes' }, { label: 'No' }] };
  const two: NotifyItem = { ...question, ui: 'options', questions: [{ title: 'Turn it on?', choices: [{ label: 'Yes' }] }, { title: 'How many trains?', choices: [{ label: 'One train' }] }] };

  it('keeps a pick alone as today’s choice answer', () => {
    expect(optionsAnswer(one, ['Yes'], '  ')).toEqual({ choice: 'Yes' });
    expect(isReply({ choice: 'Yes' })).toBe(false);
  });

  it('sends anything typed as a reply, with the pick or an empty string', () => {
    expect(optionsAnswer(one, ['Yes'], ' Only if it can be undone ')).toEqual({ picks: ['Yes'], text: 'Only if it can be undone' });
    expect(optionsAnswer(one, [], 'Can it be undone?')).toEqual({ picks: [''], text: 'Can it be undone?' });
    expect(isReply({ picks: [''], text: 'Can it be undone?' })).toBe(true);
  });

  it('sends several questions’ picks together once each has one, or with text whatever is picked', () => {
    expect(optionsAnswer(two, ['Yes'], '')).toBeNull();
    expect(optionsAnswer(two, ['Yes', 'One train'], '')).toEqual({ picks: ['Yes', 'One train'] });
    expect(isReply({ picks: ['Yes', 'One train'] })).toBe(false);
    expect(optionsAnswer(two, [undefined, 'One train'], 'Why one?')).toEqual({ picks: ['', 'One train'], text: 'Why one?' });
    expect(optionsAnswer(one, [], '')).toBeNull();
  });
});
