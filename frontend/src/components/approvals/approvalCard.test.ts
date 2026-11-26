import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { todoKey } from '../../../../shared/todoKey';
import { bridgedFrom, canReplyAlone, canSend, cardChip, cardTabs, dockApprovals, dockKey, dotTone, firstToOpen, latestReplied, markedQuestions, readyCount, recommendedAnswer, replyLine, sessionApprovals, sessionColumnNext } from './approvalCard';

const q20: NotifyItem = {
  id: 'q20',
  ui: 'options',
  title: 'Q-20: Turn on the new-agent switch for dev QA, and merge as one train?',
  context: 'Q-20 blocks only the end of validation.',
  questions: [
    { title: 'May I turn the switch on?', choices: [{ label: 'Yes, turn it on', detail: 'One UPDATE on dev QA only.' }, { label: 'Not yet' }] },
    { title: 'One train?', choices: [{ label: 'One train', recommended: true }, { label: 'Gate each lower PR' }] },
  ],
  links: [{ label: 'doozy-overhaul status', path: '/tmp/status.json' }, { label: 'PR #2480', url: 'https://github.com/x/y/pull/2480' }],
  source: { name: 'doozy-overhaul', agent: 'Claude', paneId: 'wp', panelId: 'w1', session: { id: 's1', name: 'Doozy', paneId: 'sp' } },
  state: 'waiting',
  createdAt: 1_000,
  originKind: 'worker',
  relayedBy: { panelId: 'orch', name: 'the Doozy orchestrator' },
};

const v2: NotifyItem = {
  ...q20,
  version: 2,
  questions: [
    { title: 'May I turn the switch on?', choices: [{ label: 'Yes, turn it on', detail: 'One UPDATE; the reverse turns it off.' }, { label: 'Yes, and turn it off after my test' }, { label: 'Not yet' }] },
    { title: 'One train?', choices: [{ label: 'All in one train', was: 'One train', recommended: true }] },
  ],
  versions: [{ version: 1, title: q20.title, context: q20.context, questions: q20.questions, at: 1_000 }],
  revision: { asked: 'Can the switch be turned off again?', whatChanged: ['Reworded “Yes, turn it on”', 'Added “Yes, and turn it off after my test”'], by: 'doozy-overhaul', at: 2_000 },
  readyAgain: 2_000,
};

describe('the approval card', () => {
  it('marks NEW, REWORDED (by detail or by was) and REMOVED against the version before', () => {
    const [first, second] = markedQuestions(v2);
    expect(first.choices.map(choice => choice.mark)).toEqual(['reworded', 'new', undefined]);
    expect(first.choices[0].before).toEqual({ label: 'Yes, turn it on', detail: 'One UPDATE on dev QA only.' });
    expect(second.choices[0]).toMatchObject({ mark: 'reworded', before: { label: 'One train' } });
    expect(second.removed).toEqual(['Gate each lower PR']);
    expect(markedQuestions(q20).every(question => question.choices.every(choice => !choice.mark))).toBe(true);
  });

  it('says how a reply was taken, with its fix until it was used', () => {
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'reading' } })).toEqual({ tone: 'muted', text: 'doozy-overhaul is reading your reply…' });
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'reading', reader: { kind: 'autopilot', name: 'Autopilot' } } })?.text).toBe('Autopilot is reading your reply…');
    expect(replyLine({ ...q20, state: 'answered', reply: { id: 'r', text: 'only if undoable', picks: ['Yes, turn it on', 'One train'], at: 1, state: 'answer' } })).toEqual({
      tone: 'success', text: 'Taken as your answer: Yes, turn it on · One train, with your note “only if undoable”', fix: { as: 'question', label: 'It was a question' },
    });
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'question', reader: { kind: 'asker', name: 'doozy-overhaul' } } })).toMatchObject({ tone: 'warning', text: 'Taken as a question: doozy-overhaul is getting more context…', fix: { as: 'answer' } });
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'question', fixed: 'question' } })?.fix).toBeUndefined();
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'both', at: 1, state: 'sent', reader: { kind: 'asker', name: 'Claude' } } })).toEqual({ tone: 'success', text: 'Sent to Claude' });
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'unread' } })?.text).toMatch(/No agent can read replies right now/);
  });

  it('chips and pager dots follow the state', () => {
    expect(cardChip(v2)).toEqual({ tone: 'info', text: 'Updated · ready again' });
    expect(cardChip({ ...q20, reply: { id: 'r', text: 'x', at: 1, state: 'question' } })).toEqual({ tone: 'warning', text: 'doozy-overhaul is getting more context' });
    expect(dotTone(v2, false)).toBe('info');
    expect(dotTone(v2, true)).toBe('current');
    expect(dotTone({ ...q20, reply: { id: 'r', text: 'x', at: 1, state: 'reading' } }, false)).toBe('warning');
  });

  it('P6: the dock pages past what is being read until it is ready again, and leaves out the chat\'s own question (P5)', () => {
    const reading = { ...q20, id: 'b', reply: { id: 'r', text: 'x', at: 1, state: 'reading' as const } };
    const ready = { ...reading, id: 'c', readyAgain: 5 };
    const own = { ...q20, id: 'd', replyIsAnswer: true, source: { ...q20.source, panelId: 'chat-1' } };
    const posted = { ...q20, id: 'e', source: { ...q20.source, panelId: 'chat-1' } };
    expect(dockApprovals([{ ...q20, id: 'a' }, reading, ready, own, posted], 'chat-1').map(item => item.id)).toEqual(['a', 'c', 'e']);
    expect(bridgedFrom(own, 'chat-1')).toBe(true);
    expect(bridgedFrom(own, 'other-chat')).toBe(false);
  });

  it('Dismiss leaves a card out of the chat\'s dock until the item changes (Q-389)', () => {
    const a = { ...q20, id: 'a' };
    const b = { ...q20, id: 'b' };
    const dismissed = { a: dockKey(a) };
    expect(dockApprovals([a, b], 'chat-1', dismissed).map(item => item.id)).toEqual(['b']);
    // A new version, a reply or a ready-again brings it back.
    expect(dockApprovals([{ ...a, version: 2 }, b], 'chat-1', dismissed).map(item => item.id)).toEqual(['a', 'b']);
    expect(dockApprovals([{ ...a, readyAgain: 9 }, b], 'chat-1', dismissed).map(item => item.id)).toEqual(['a', 'b']);
    expect(dockApprovals([{ ...a, reply: { id: 'r9', text: 'x', at: 1, state: 'unread' as const } }, b], 'chat-1', dismissed).map(item => item.id)).toEqual(['a', 'b']);
  });

  it('P7: the status line follows the reply sent last in the Session, until it is dismissed', () => {
    const reading = { ...q20, id: 'b', reply: { id: 'r1', text: 'x', at: 10, state: 'reading' as const } };
    const taken = { ...q20, id: 'c', state: 'answered' as const, reply: { id: 'r2', text: 'y', at: 20, state: 'answer' as const } };
    expect(latestReplied([reading, taken], 's1', new Set())?.id).toBe('c');
    expect(latestReplied([reading, taken], 's1', new Set(['r2']))?.id).toBe('b');
    expect(latestReplied([reading, taken], 'other', new Set())).toBeUndefined();
    // --update clears the reply it answered: the line still says it came back ready again.
    const ready = { ...q20, id: 'd', readyAgain: 30 };
    expect(latestReplied([reading, taken, ready], 's1', new Set())?.id).toBe('d');
  });

  it('words typed with no pick go on their own, except on a prompt, an options-only question or while a reply is read (F-1)', () => {
    expect(canReplyAlone(q20)).toBe(true);
    expect(canSend(q20, [], 'Which one is reversible?')).toBe(true);
    expect(canReplyAlone({ ...q20, optionsOnly: true })).toBe(false);
    expect(canReplyAlone({ ...q20, agentPrompt: { yes: 'Yes', no: 'No' } })).toBe(false);
    expect(canReplyAlone({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'reading', deliveredAt: 2 } })).toBe(false);
    expect(canReplyAlone({ ...q20, state: 'answered' })).toBe(false);
  });

  it('Send needs a pick per question, or something typed', () => {
    expect(canSend(q20, ['Yes, turn it on'], '')).toBe(false);
    expect(canSend(q20, ['Yes, turn it on', 'One train'], '')).toBe(true);
    expect(canSend(q20, [], 'why?')).toBe(true);
    expect(canSend({ ...q20, agentPrompt: { yes: 'Yes', no: 'No' } }, [], 'why?')).toBe(false);
  });

  it('T-88: ⇧↩ answers with the recommended option of each question, only when nothing is picked or typed (D-385)', () => {
    const single: NotifyItem = { ...q20, questions: undefined, choices: [{ label: 'Merge it', recommended: true }, { label: 'Wait' }] };
    expect(recommendedAnswer(single, [], '')).toEqual({ send: ['Merge it'] });
    const both: NotifyItem = { ...q20, questions: [q20.questions![1], { title: 'Tag it?', choices: [{ label: 'No' }, { label: 'Yes', recommended: true }] }] };
    expect(recommendedAnswer(both, ['', ''], '')).toEqual({ send: ['One train', 'Yes'] });
    // The person's own pick or words: ⇧↩ does nothing special, ⌘↩ sends theirs.
    expect(recommendedAnswer(both, ['', 'No'], '')).toBeNull();
    expect(recommendedAnswer(single, [], 'only after QA')).toBeNull();
    // A question with no recommendation: nothing goes, and it says which.
    expect(recommendedAnswer(q20, [], '')).toEqual({ missing: [0] });
    expect(recommendedAnswer({ ...q20, ui: 'approve', questions: undefined }, [], '')).toEqual({ missing: [0] });
    expect(recommendedAnswer({ ...single, state: 'sent' }, [], '')).toBeNull();
  });

  it('J13: tabs are Q&A, Summary, each reference, then the origin unless you are in it', () => {
    expect(cardTabs(q20).map(tab => tab.label)).toEqual(['Decide', 'Summary', 'doozy-overhaul status', 'PR #2480', "doozy-overhaul's tab"]);
    expect(cardTabs(q20, 'w1').map(tab => tab.kind)).toEqual(['qa', 'summary', 'link', 'link']);
  });

  it('J15: a Session count opens its newest ready-again approval, else its first waiting one', () => {
    const older = { ...q20, id: 'older', createdAt: 1 };
    const ready = { ...v2, id: 'ready', createdAt: 5 };
    const list = sessionApprovals([ready, older, { ...q20, id: 'other', source: { ...q20.source, session: { id: 's2', name: 'X', paneId: 'x' } } }], 's1');
    expect(list.map(item => item.id)).toEqual(['ready', 'older']);
    expect(firstToOpen(list)?.id).toBe('ready');
    expect(readyCount(list)).toBe(1);
    expect(firstToOpen([older])?.id).toBe('older');
  });

  it('T-88: a Session lists its approvals newest first, an updated one by its latest version', () => {
    const first = { ...q20, id: 'first', createdAt: 1_000 };
    const second = { ...q20, id: 'second', createdAt: 2_000 };
    const third = { ...q20, id: 'third', createdAt: 3_000 };
    expect(sessionApprovals([first, third, second], 's1').map(item => item.id)).toEqual(['third', 'second', 'first']);
    const updated = { ...first, version: 2, revision: { asked: 'why?', whatChanged: ['reworded'], by: 'agent', at: 4_000 } };
    expect(sessionApprovals([updated, third, second], 's1').map(item => item.id)).toEqual(['first', 'third', 'second']);
    expect(firstToOpen(sessionApprovals([first, third, second], 's1'))?.id).toBe('third');
  });

  it('T-22: a Session\'s column also lists the approvals of the to-dos it requested, from their hidden Sessions too, once each', () => {
    const fromHidden = { ...q20, id: 'perm', source: { ...q20.source, session: { id: 'todo-3', name: 'T-3 · Pane Selection', paneId: 'h' } } };
    const linked = { ...q20, id: 'review', source: { ...q20.source, session: { id: 'todo-3', name: 'T-3 · Pane Selection', paneId: 'h' } }, todo: { number: 3, title: 'Pane Selection' } };
    const unrelated = { ...q20, id: 'other', source: { ...q20.source, session: { id: 'todo-9', name: 'T-9', paneId: 'n' } } };
    const scope = { machineId: 'local', sessionIds: new Set(['todo-3']), todoKeys: new Set([todoKey('local', 3)]) };
    expect(sessionApprovals([q20, fromHidden, linked, unrelated], 's1', scope).map(item => item.id).sort()).toEqual(['perm', 'q20', 'review'].sort());
    expect(sessionApprovals([fromHidden, linked], 's1').map(item => item.id)).toEqual([]);
  });

  it('T-51: a Session docks only its own machine\'s cards, and none from a machine gone offline', () => {
    const local28 = { ...q20, id: 'local-28', source: { ...q20.source, session: { id: 'other', name: 'Other', paneId: 'o' } }, todo: { number: 28, title: 'Accept the BAA' } };
    const macbook28 = { ...local28, id: 'macbook:q-84', machineId: 'macbook', machine: 'Tylers-MacBook-Pro', title: 'Q-84: Phone-number accounts' };
    const offline = { ...q20, id: 'offline', machineId: 'local', unreachable: true };
    const scope = { machineId: 'local', sessionIds: new Set<string>(), todoKeys: new Set([todoKey('local', 27), todoKey('local', 28)]) };
    expect(sessionApprovals([q20, local28, macbook28, offline], 's1', scope).map(item => item.id)).toEqual(['local-28', 'q20']);
    // The MacBook's own Session, opened from All machines, docks the MacBook's card and not this computer's.
    const onMacbook = { machineId: 'macbook', sessionIds: new Set<string>(), todoKeys: new Set([todoKey('macbook', 28)]) };
    expect(sessionApprovals([local28, macbook28], 's1', onMacbook).map(item => item.id)).toEqual(['macbook:q-84']);
  });

  it('T-51 F-2: a Session\'s open column moves on when its card\'s machine goes offline or the card is another machine\'s', () => {
    const mine = { ...q20, id: 'mine', machineId: 'macbook' };
    const other = { ...q20, id: 'other', machineId: 'macbook', createdAt: 2_000 };
    expect(sessionColumnNext(mine, [mine, other], 'macbook')).toEqual({ keep: true });
    // Answered or gone from the list, it stays for its receipt.
    expect(sessionColumnNext({ ...mine, state: 'answered' }, [other], 'macbook')).toEqual({ keep: true });
    expect(sessionColumnNext(undefined, [other], 'macbook')).toEqual({ keep: true });
    expect(sessionColumnNext({ ...mine, unreachable: true }, [other], 'macbook')).toEqual({ open: 'other' });
    expect(sessionColumnNext({ ...mine, unreachable: true }, [], 'macbook')).toEqual({ close: true });
    expect(sessionColumnNext(mine, [], 'local')).toEqual({ close: true });
  });

  it('a Session whose approvals were dismissed has none open, so no count or badge', () => {
    const dismissed = [{ ...q20, dismissedAt: 2_000 }, { ...q20, id: 'q21', dismissedAt: 2_500 }];
    expect(sessionApprovals(dismissed, 's1')).toEqual([]);
    expect(readyCount(sessionApprovals(dismissed, 's1'))).toBe(0);
    expect(firstToOpen(sessionApprovals(dismissed, 's1'))).toBeUndefined();
    // A dismissed one beside a waiting one: only the waiting one counts.
    expect(sessionApprovals([...dismissed, { ...q20, id: 'open' }], 's1').map(item => item.id)).toEqual(['open']);
  });
});
