import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { canSend, cardChip, cardSummary, cardTabs, dotTone, firstToOpen, markedQuestions, nextAfterSend, readyCount, replyLine, sessionApprovals } from './approvalCard';

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
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'reading' } })).toEqual({ tone: 'muted', text: 'Reading your reply…' });
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'reading', reader: { kind: 'autopilot', name: 'Autopilot' } } })?.text).toBe('Autopilot is reading your reply…');
    expect(replyLine({ ...q20, state: 'answered', reply: { id: 'r', text: 'only if undoable', picks: ['Yes, turn it on', 'One train'], at: 1, state: 'answer' } })).toEqual({
      tone: 'success', text: 'Taken as your answer: Yes, turn it on · One train, with your note “only if undoable”', fix: { as: 'question', label: 'It was a question' },
    });
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'question', reader: { kind: 'asker', name: 'doozy-overhaul' } } })).toMatchObject({ tone: 'warning', text: 'Taken as a question: asking doozy-overhaul. Getting more context…', fix: { as: 'answer' } });
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'question', fixed: 'question' } })?.fix).toBeUndefined();
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'both', at: 1, state: 'sent', reader: { kind: 'asker', name: 'Claude' } } })).toEqual({ tone: 'success', text: 'Sent to Claude' });
    expect(replyLine({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'unread' } })?.text).toMatch(/No agent can read replies right now/);
  });

  it('chips and pager dots follow the state', () => {
    expect(cardChip(v2)).toEqual({ tone: 'info', text: 'Updated · ready again' });
    expect(cardChip({ ...q20, reply: { id: 'r', text: 'x', at: 1, state: 'question' } })).toEqual({ tone: 'warning', text: 'Getting more context…' });
    expect(dotTone(v2, false)).toBe('info');
    expect(dotTone(v2, true)).toBe('current');
    expect(dotTone({ ...q20, reply: { id: 'r', text: 'x', at: 1, state: 'reading' } }, false)).toBe('warning');
  });

  it('a send moves on past what is being read', () => {
    const items = new Map<string, NotifyItem>([
      ['a', { ...q20, id: 'a' }],
      ['b', { ...q20, id: 'b', reply: { id: 'r', text: 'x', at: 1, state: 'reading' } }],
      ['c', { ...q20, id: 'c' }],
    ]);
    expect(nextAfterSend(['a', 'b', 'c'], 'a', items)).toBe('c');
    expect(nextAfterSend(['a', 'b'], 'a', items)).toBeUndefined();
  });

  it('Send needs a pick per question, or something typed', () => {
    expect(canSend(q20, ['Yes, turn it on'], '')).toBe(false);
    expect(canSend(q20, ['Yes, turn it on', 'One train'], '')).toBe(true);
    expect(canSend(q20, [], 'why?')).toBe(true);
    expect(canSend({ ...q20, agentPrompt: { yes: 'Yes', no: 'No' } }, [], 'why?')).toBe(false);
  });

  it('J13: tabs are Q&A, Summary, each reference, then the origin unless you are in it', () => {
    expect(cardTabs(q20).map(tab => tab.label)).toEqual(['Questions & answers', 'Summary', 'doozy-overhaul status', 'PR #2480', "doozy-overhaul's tab"]);
    expect(cardTabs(q20, 'w1').map(tab => tab.kind)).toEqual(['qa', 'summary', 'link', 'link']);
  });

  it('D-225: the Summary is built from the item, with every round', () => {
    const summary = cardSummary(v2);
    expect(summary.why).toBe(q20.context);
    expect(summary.recommendation).toEqual([{ question: 'One train?', label: 'All in one train' }]);
    expect(summary.references.map(reference => reference.kind)).toEqual(['file', 'url', 'origin']);
    expect(summary.history).toEqual([
      { version: 1, at: 1_000, whatChanged: [] },
      { version: 2, at: 2_000, asked: 'Can the switch be turned off again?', whatChanged: v2.revision?.whatChanged, by: 'doozy-overhaul' },
    ]);
  });

  it('J15: a Session count opens its newest ready-again approval, else its first waiting one', () => {
    const older = { ...q20, id: 'older', createdAt: 1 };
    const ready = { ...v2, id: 'ready', createdAt: 5 };
    const list = sessionApprovals([ready, older, { ...q20, id: 'other', source: { ...q20.source, session: { id: 's2', name: 'X', paneId: 'x' } } }], 's1');
    expect(list.map(item => item.id)).toEqual(['older', 'ready']);
    expect(firstToOpen(list)?.id).toBe('ready');
    expect(readyCount(list)).toBe(1);
    expect(firstToOpen([older])?.id).toBe('older');
  });
});
