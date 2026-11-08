import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NotifyItem, NotifySnapshot } from '../../../../shared/types/notify';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../../shared/types/notify';
import { useNotifyStore } from '../../stores/notifyStore';
import { useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { ApprovalColumn } from './ApprovalColumn';

const q20: NotifyItem = {
  id: 'q20',
  ui: 'options',
  title: 'Q-20: Turn on the new-agent switch for dev QA, and merge as one train?',
  context: 'One UPDATE in my status file keeps the test on the new agent.',
  questions: [
    { title: 'May I turn the switch on?', choices: [{ label: 'Yes, turn it on', detail: 'One UPDATE on dev QA only.' }, { label: 'Not yet' }] },
    { title: 'One train?', choices: [{ label: 'One train', recommended: true }, { label: 'Gate each lower PR' }] },
  ],
  links: [{ label: 'PR #2480', url: 'https://github.com/x/y/pull/2480' }],
  source: { name: 'doozy-overhaul', agent: 'Claude', paneId: 'wp', panelId: 'w1', session: { id: 's1', name: 'Doozy', paneId: 'sp' } },
  state: 'waiting',
  createdAt: Date.now() - 4 * 60_000,
  originKind: 'worker',
};

function show(item: NotifyItem, order: string[] = [item.id], closeLabel?: string): string {
  const snapshot: NotifySnapshot = {
    settings: DEFAULT_NOTIFY_SETTINGS, items: [item], queue: [], hidden: [], strip: null, stripSurface: null, pausedUntil: null,
    shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
  };
  useNotifyStore.setState({ snapshot });
  return renderToStaticMarkup(
    <ApprovalColumn surface="session:s1" itemId={item.id} order={order} onSelect={() => undefined} groupLabel="Doozy approvals" closeLabel={closeLabel} onClose={() => undefined} items={[item]} />,
  );
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

describe('ApprovalColumn', () => {
  beforeEach(() => useApprovalColumnStore.setState({ open: {}, lastReplied: null }));

  it('waiting: the pager, tabs in order, both questions and one reply box', () => {
    const visible = text(show(q20, ['a', 'q20', 'b'], 'Back to doozy-overhaul'));
    expect(visible).toContain('2 of 3');
    expect(visible).toContain('Back to doozy-overhaul');
    expect(visible).toMatch(/Questions & answers Summary PR #2480 doozy-overhaul's tab/);
    expect(visible).toContain('Question 1 of 2');
    expect(visible).toContain('Question 2 of 2');
    expect(visible).toContain('Recommended');
    expect(visible).toContain('Pick an option, or reply in your own words: an answer, or a question about it.');
  });

  it('Reading your reply…', () => {
    expect(text(show({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'reading' } }))).toContain('Reading your reply…');
  });

  it('Taken as a question, with its fix, in amber', () => {
    const markup = show({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'question', reader: { kind: 'asker', name: 'doozy-overhaul' } } });
    expect(text(markup)).toContain('Taken as a question: asking doozy-overhaul. Getting more context…');
    expect(text(markup)).toContain('It was my answer');
    expect(markup).toContain('data-tone="warning"');
  });

  it('Taken as your answer, with It was a question', () => {
    const visible = text(show({ ...q20, state: 'answered', answerSummary: 'Yes, turn it on · One train', reply: { id: 'r', text: 'only if undoable', picks: ['Yes, turn it on', 'One train'], at: 1, state: 'answer' } }));
    expect(visible).toContain('Taken as your answer: Yes, turn it on · One train, with your note “only if undoable”');
    expect(visible).toContain('It was a question');
  });

  it('Updated · ready again: your question, What changed, the marks, REMOVED and the earlier version', () => {
    const v2: NotifyItem = {
      ...q20,
      version: 2,
      readyAgain: Date.now(),
      questions: [
        { title: 'May I turn the switch on?', choices: [{ label: 'Yes, turn it on', detail: 'The reverse UPDATE turns it off.' }, { label: 'Yes, and turn it off after my test' }, { label: 'Not yet' }] },
        { title: 'One train?', choices: [{ label: 'One train', recommended: true }] },
      ],
      versions: [{ version: 1, title: q20.title, context: q20.context, questions: q20.questions, at: q20.createdAt }],
      revision: { asked: 'Can the switch be turned off again?', whatChanged: ['Reworded “Yes, turn it on”', 'Added “Yes, and turn it off after my test”'], by: 'doozy-overhaul', at: Date.now() },
    };
    const markup = show(v2);
    const visible = text(markup);
    expect(visible).toContain('Updated · ready again');
    expect(visible).toContain('Updated after your question · ready again');
    expect(visible).toContain('v2');
    expect(visible).toContain('You asked “Can the switch be turned off again?”');
    expect(visible).toContain('What changed · doozy-overhaul');
    expect(markup).toContain('data-mark="reworded"');
    expect(markup).toContain('data-mark="new"');
    expect(visible).toContain('was: One UPDATE on dev QA only.');
    expect(visible).toContain('Removed Gate each lower PR');
    expect(visible).toContain('Earlier version · v1, as first asked');
  });

  it('Sent to the agent, for a built-in question', () => {
    expect(text(show({ ...q20, state: 'answered', replyIsAnswer: true, reply: { id: 'r', text: 'both', at: 1, state: 'sent', reader: { kind: 'asker', name: 'Claude' } } }))).toContain('Sent to Claude');
  });

  it('No agent can read replies right now', () => {
    expect(text(show({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'unread' } }))).toContain('No agent can read replies right now. You can still pick an option.');
  });
});
