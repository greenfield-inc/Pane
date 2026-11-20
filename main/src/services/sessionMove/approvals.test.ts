import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { bindMovedApprovals, type ApprovalScope } from './approvals';

const scope: ApprovalScope = {
  sessionId: 'sess-1', sessionName: 'S', ownerPaneId: '__owner__',
  tabs: new Map([['t-agent', 'p1'], ['t-orch', '__owner__']]), roots: ['/b/worktrees/p1', '/b/.pane/sessions/sess-1'],
};
const card = (extra: Partial<NotifyItem> = {}): NotifyItem => ({
  id: 'in-7', ui: 'options', title: 'Q-7: Ship it?', state: 'waiting', createdAt: 1,
  source: { name: 'Pane p1', agent: 'Claude', paneId: 'p1', panelId: 't-agent', session: { id: 'sess-1', name: 'S', paneId: '__owner__' } },
  ...extra,
});

describe('bindMovedApprovals (T-44)', () => {
  it('files a card under this Session, drops what routed it on the source, and keeps only this move\'s files', () => {
    const [{ item }] = bindMovedApprovals([{ item: card({
      relayedBy: { panelId: 'elsewhere', name: 'x' }, todo: { number: 4, title: 't' }, summaryOf: ['other'],
      links: [{ label: 'plan', path: '/b/.pane/sessions/sess-1/plan.html' }, { label: 'key', path: '/b/.ssh/id_ed25519' }, { label: 'web', url: 'https://example.invalid' }, { label: 'f', url: 'file:///etc/hosts' }],
      summaryPage: '/etc/passwd', statusFile: '/b/worktrees/p1/status.md',
      connected: { kind: 'session', id: 'other-session', name: 'Other', paneId: 'x' },
    }) }], scope);
    expect(item).toMatchObject({ connected: { kind: 'session', id: 'sess-1', paneId: '__owner__' }, statusFile: '/b/worktrees/p1/status.md' });
    expect(item.links).toEqual([{ label: 'plan', path: '/b/.pane/sessions/sess-1/plan.html' }, { label: 'web', url: 'https://example.invalid' }]);
    expect(item.relayedBy).toBeUndefined();
    expect(item.todo).toBeUndefined();
    expect(item.summaryOf).toBeUndefined();
    expect(item.summaryPage).toBeUndefined();
  });

  it('refuses a card whose asker is a tab this move didn\'t bring, or a question from another Session or tab', () => {
    expect(() => bindMovedApprovals([{ item: card({ source: { name: 'x', agent: 'Claude', panelId: 'some-local-tab' } }) }], scope)).toThrow(/didn't come with it/);
    expect(() => bindMovedApprovals([{ item: card({ source: { name: 'x', agent: 'Claude', paneId: '__owner__', panelId: 't-agent' } }) }], scope)).toThrow(/didn't come with it/);
    const report = { id: 'in-7', sessionId: 'other-session', kind: 'report' as const, at: '', paneId: 'p1', paneName: 'p1', panelId: 't-agent' };
    expect(() => bindMovedApprovals([{ item: card(), report }], scope)).toThrow(/another Session's or tab's/);
  });
});
