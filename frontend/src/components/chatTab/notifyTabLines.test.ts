import { describe, expect, it } from 'vitest';
import { answerLine, approvalsTypedInto, closedLine, paneApprovalLine, replyLine } from '../../../../shared/notifyTabLines';
import type { NotifyItem } from '../../../../shared/types/notify';

function item(overrides: Partial<NotifyItem> = {}): NotifyItem {
  return {
    id: 'n1', ui: 'options', title: 'Q-4: Create bots by default?', state: 'answered', createdAt: 1,
    source: { panelId: 'orch', name: 'Omni Chat', agent: 'Claude' },
    answerSummary: 'Yes: create by default', answeredBy: { by: 'you' }, delivered: { via: 'tab', at: 2 }, ...overrides,
  };
}

describe('Pane\'s approval lines in a chat (T-133)', () => {
  it('reads the answer line Pane typed into the asking tab', () => {
    const asked = item();
    const text = answerLine(asked);
    expect(text).toBe('answer: Q-4 → Yes: create by default (by you)');
    expect(paneApprovalLine(text, 'orch', [asked])).toEqual({ kind: 'answer', refs: ['Q-4'] });
    expect(paneApprovalLine(`${text}\n`, 'orch', [asked])).toEqual({ kind: 'answer', refs: ['Q-4'] });
  });

  it('leaves a line no record vouches for as the person\'s own', () => {
    const asked = item();
    // No approval at all, another tab's approval, or the person's own words in the same shape.
    expect(paneApprovalLine(answerLine(asked), 'orch', [])).toBeUndefined();
    expect(paneApprovalLine(answerLine(asked), 'another-tab', [asked])).toBeUndefined();
    expect(paneApprovalLine('answer: Q-4 → No, drop it (by you)', 'orch', [asked])).toBeUndefined();
    expect(paneApprovalLine('answer: Q-9 → Yes: create by default (by you)', 'orch', [asked])).toBeUndefined();
    expect(paneApprovalLine('Please answer Q-4 for me', 'orch', [asked])).toBeUndefined();
  });

  it('reads a reply line typed into its reader\'s tab, and a quoted title with its id', () => {
    const replied = item({ title: 'Which bot should we use?', id: 'n2', reply: { id: 'r1', text: 'The existing one', at: 3, state: 'answer', reader: { kind: 'orchestrator', panelId: 'orch', name: 'the orchestrator' } }, source: { panelId: 'worker', name: 'w', agent: 'Claude' } });
    const text = replyLine(replied, replied.reply!);
    expect(text).toBe('reply: "Which bot should we use?" → "The existing one" [id n2] (by you)');
    expect(paneApprovalLine(text, 'orch', [replied])).toEqual({ kind: 'reply', refs: ['"Which bot should we use?"'] });
    // The id names another item: not this one.
    expect(paneApprovalLine(text.replace('[id n2]', '[id n9]'), 'orch', [replied])).toBeUndefined();
  });

  it('reads a close of one or several approvals only when each closed', () => {
    const a = item({ title: 'Q-1: A', state: 'expired', closed: { by: 'you', reason: 'Session archived', at: 4 } });
    const b = item({ id: 'n3', title: 'Q-2: B', state: 'expired', closed: { by: 'you', reason: 'Session archived', at: 4 } });
    const text = closedLine(['Q-1', 'Q-2'], '(by you): Session archived');
    expect(paneApprovalLine(text, 'orch', [a, b])).toEqual({ kind: 'closed', refs: ['Q-1', 'Q-2'] });
    expect(paneApprovalLine(text, 'orch', [a, item({ id: 'n3', title: 'Q-2: B', state: 'waiting' })])).toBeUndefined();
  });

  it('keeps only the approvals that type into this tab', () => {
    const relayed = item({ id: 'n4', source: { panelId: 'w', name: 'w', agent: 'Claude' }, relayedBy: { panelId: 'orch', name: 'the orchestrator' } });
    expect(approvalsTypedInto([item(), relayed, item({ id: 'n5', source: { panelId: 'x', name: 'x', agent: 'Claude' } })], 'orch').map(found => found.id)).toEqual(['n1', 'n4']);
  });
});
