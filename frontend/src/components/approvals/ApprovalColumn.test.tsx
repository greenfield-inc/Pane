import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NotifyItem, NotifySnapshot } from '../../../../shared/types/notify';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../../shared/types/notify';
import { useNotifyStore } from '../../stores/notifyStore';
import { useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { useConfigStore } from '../../stores/configStore';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { ApprovalCaughtUp, ApprovalColumn, ApprovalSentBefore, LinkTab } from './ApprovalColumn';

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
    shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [], cardsOn: { kind: 'any' }, thisMachine: null,
  };
  useNotifyStore.setState({ snapshot });
  return renderToStaticMarkup(
    <ApprovalColumn surface="session:s1" itemId={item.id} order={order} onSelect={() => undefined} groupLabel="Doozy approvals" closeLabel={closeLabel} onClose={() => undefined} items={[item]} />,
  );
}

function sendButton(markup: string): string {
  return markup.match(/<button[^>]*data-testid="approval-send"[^>]*>/)?.[0] ?? '';
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

describe('ApprovalColumn', () => {
  beforeEach(() => useApprovalColumnStore.setState({ open: {}, advanced: {} }));

  it('waiting: the pager, tabs in order, both questions and one reply box', () => {
    const visible = text(show(q20, ['a', 'q20', 'b'], 'Back to doozy-overhaul'));
    expect(visible).toContain('2 of 3');
    expect(visible).toContain('Back to doozy-overhaul');
    expect(visible).toMatch(/Decide Summary PR #2480 doozy-overhaul's tab/);
    expect(visible).toContain('Question 1 of 2');
    expect(visible).toContain('Question 2 of 2');
    expect(visible).toContain('Recommended');
    expect(visible).toContain('Pick an option, or reply in your own words');
  });

  it('T-88: the card it moved on to says what was sent, with Undo while held, and how many are left', () => {
    const sent: NotifyItem = { ...q20, id: 'q19', title: 'Q-19: Ship it?', state: 'sent', answerSummary: 'Ship it' };
    expect(text(renderToStaticMarkup(<ApprovalSentBefore item={sent} left={2} onUndo={() => undefined} />))).toBe('Sent “Ship it” to doozy-overhaul Undo 2 left');
    // Once the hold ends there is nothing to undo.
    expect(text(renderToStaticMarkup(<ApprovalSentBefore item={{ ...sent, state: 'answered' }} left={2} onUndo={() => undefined} />))).toBe('Sent “Ship it” to doozy-overhaul 2 left');
  });

  it('T-88: each option shows the number key that picks it', () => {
    const markup = show(q20);
    expect(markup).toContain('aria-keyshortcuts="1"');
    expect(markup).toContain('aria-keyshortcuts="2"');
  });

  it('T-88: the Recommended chip names ⇧↩ only when it would send', () => {
    const merge: NotifyItem = { ...q20, questions: undefined, choices: [{ label: 'Merge it', recommended: true }, { label: 'Wait' }] };
    // ⇧↩ on macOS, Shift+Enter elsewhere.
    expect(text(show(merge))).toContain(`Recommended · ${formatKeyDisplay('shift+Enter')} sends`);
    // Question 1 has no recommendation, so ⇧↩ can't answer both.
    expect(text(show(q20))).toContain('Recommended');
    expect(text(show(q20))).not.toContain(`${formatKeyDisplay('shift+Enter')} sends`);
    // A pick of the person's own hides it: tests/renderer/approval-keys.renderer.ts (a static render has no store state).
  });

  it('T-88: says all caught up when nothing else waits, with Undo and the way back', () => {
    const sent: NotifyItem = { ...q20, state: 'sent', answerSummary: 'One train' };
    const visible = text(renderToStaticMarkup(
      <ApprovalCaughtUp surface="session:s1" sent={sent} groupLabel="Doozy approvals" closeLabel="Back to chat" onClose={() => undefined} onUndo={() => undefined} />,
    ));
    expect(visible).toBe('All caught up Nothing else in Doozy approvals is waiting on you. Sent “One train” to doozy-overhaul · Undo Back to chat');
    // After a Dismiss there was nothing sent to name.
    expect(text(renderToStaticMarkup(<ApprovalCaughtUp surface="approvals" groupLabel="Approvals" onUndo={() => undefined} />))).toBe('All caught up Nothing else in Approvals is waiting on you.');
  });

  it('opens with nothing picked, recommended or not, and Send off (D-385)', () => {
    const markup = show(q20);
    expect(markup).not.toContain('aria-checked="true"');
    expect(sendButton(markup)).toContain('disabled');
  });

  it('Reading your reply…', () => {
    expect(text(show({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'reading' } }))).toContain('doozy-overhaul is reading your reply…');
  });

  it('Taken as a question, with its fix, in amber', () => {
    const markup = show({ ...q20, reply: { id: 'r', text: 'why?', at: 1, state: 'question', reader: { kind: 'asker', name: 'doozy-overhaul' } } });
    expect(text(markup)).toContain('Taken as a question: doozy-overhaul is getting more context…');
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

describe('ApprovalColumn: a link to another approval by Q-n', () => {
  const linking: NotifyItem = { ...q20, id: 'q22', title: 'Q-22: Merge after the migration?', links: [{ label: 'Q-1', approval: 'Q-1' }] };
  const link = { label: 'Q-1', approval: 'Q-1' };
  const tab = (item: NotifyItem, target: string | undefined) => text(renderToStaticMarkup(<LinkTab item={item} link={link} target={target} onOpenApproval={() => undefined} />));

  for (const todosEnabled of [true, false]) {
    describe(`with To-dos ${todosEnabled ? 'on' : 'off'}`, () => {
      beforeEach(() => useConfigStore.setState({ config: { todosEnabled } }));
      afterEach(() => useConfigStore.setState({ config: null }));

      it('offers the card it resolved to', () => {
        expect(tab(linking, 'doozy-q1')).toBe('Q-1 is another approval. Open it here');
      });

      it('says so when its own Session has no such Q-n, rather than open another', () => {
        expect(tab(linking, undefined)).toBe("Q-1 isn't here any more. Pane looks for Q-1 only among this Session's approvals, so it won't open another one with that name.");
        const remote = { ...linking, machineId: 'macbook', machine: 'tylers-macbook-pro' };
        expect(tab(remote, undefined)).toContain("only among this Session's approvals on tylers-macbook-pro,");
      });

      it('F-2: a card asked outside a Session or Pane says a Q-n can\'t be looked up, and an id link that\'s gone says only that', () => {
        const outside: NotifyItem = { ...linking, source: { name: 'repo-a', agent: 'Claude' }, connected: { kind: 'machine', id: 'mini', name: 'repo-a' } };
        expect(tab(outside, undefined)).toBe("Q-1 can't be opened from here: this approval was asked outside a Session or Pane, so Q-1 could be any caller's. A link by the approval's id opens it.");
        const byId = text(renderToStaticMarkup(<LinkTab item={linking} link={{ label: 'The plan card', approval: 'q-abc' }} target={undefined} onOpenApproval={() => undefined} />));
        expect(byId).toBe("The plan card isn't here any more.");
      });
    });
  }
});
