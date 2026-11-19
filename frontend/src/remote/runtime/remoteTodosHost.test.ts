import { describe, expect, it } from 'vitest';
import type { NotifyCommand, NotifyItem, NotifySharedState } from '../../../../shared/types/notify';
import { isNewerSharedState, remoteNotifyCommand, sharedStateAsSnapshot } from './remoteTodosHost';

const item: NotifyItem = {
  id: 'q11', ui: 'options', title: 'Which currencies must the PDF support at launch?', state: 'waiting', createdAt: 1,
  source: { name: 'orchestrator', agent: 'Claude' },
};

const shared: NotifySharedState = { machine: 'devbox', epoch: 'e1', revision: 4, enabled: true, items: [item], queue: ['q11'], hidden: [] };

describe('the web app reads the host\'s approvals as a Notify snapshot', () => {
  it('keeps the items, queue and hidden list, and shows no strip of its own', () => {
    const snapshot = sharedStateAsSnapshot(shared);
    expect(snapshot.items).toEqual([item]);
    expect(snapshot.queue).toEqual(['q11']);
    expect(snapshot.hidden).toEqual([]);
    expect(snapshot.strip).toBeNull();
    expect(snapshot.stripSurface).toBeNull();
    expect(snapshot.settings.enabled).toBe(true);
  });

  it('follows the host switching approvals off', () => {
    expect(sharedStateAsSnapshot({ ...shared, enabled: false }).settings.enabled).toBe(false);
  });
});

describe('a host state applies only when it is newer', () => {
  it('applies the first state, a higher revision, or a new epoch (the host restarted)', () => {
    expect(isNewerSharedState(null, shared)).toBe(true);
    expect(isNewerSharedState({ epoch: 'e1', revision: 3 }, shared)).toBe(true);
    expect(isNewerSharedState({ epoch: 'e0', revision: 90 }, shared)).toBe(true);
  });

  it('ignores a read that answers after a newer event', () => {
    expect(isNewerSharedState({ epoch: 'e1', revision: 4 }, shared)).toBe(false);
    expect(isNewerSharedState({ epoch: 'e1', revision: 5 }, shared)).toBe(false);
  });
});

describe('the approval column\'s commands go to the host as remote commands', () => {
  it('passes answers, undo, close, reopen, override and the reply fix through', () => {
    const answer: NotifyCommand = { type: 'answer', id: 'q11', answer: { picks: ['EUR and USD'] } };
    expect(remoteNotifyCommand(answer)).toEqual(answer);
    expect(remoteNotifyCommand({ type: 'undo', id: 'q11' })).toEqual({ type: 'undo', id: 'q11' });
    expect(remoteNotifyCommand({ type: 'close', id: 'q11', reason: 'not needed' })).toEqual({ type: 'close', id: 'q11', reason: 'not needed' });
    expect(remoteNotifyCommand({ type: 'reopen', id: 'q11' })).toEqual({ type: 'reopen', id: 'q11' });
    expect(remoteNotifyCommand({ type: 'override', id: 'q11', answer: { picks: [], text: 'GBP too' } })).toEqual({ type: 'override', id: 'q11', answer: { picks: [], text: 'GBP too' } });
    expect(remoteNotifyCommand({ type: 'fix-reply', id: 'q11', as: 'answer' })).toEqual({ type: 'fix-reply', id: 'q11', as: 'answer' });
    expect(remoteNotifyCommand({ type: 'open-link', id: 'q11', index: 0 })).toEqual({ type: 'open-link', id: 'q11', index: 0 });
  });

  it('passes a remind the host can schedule, and keeps "when I\'m back in Pane" for the desktop', () => {
    expect(remoteNotifyCommand({ type: 'remind', id: 'q11', after: '1h' })).toEqual({ type: 'remind', id: 'q11', after: '1h' });
    expect(remoteNotifyCommand({ type: 'remind', id: 'q11', after: 'pane' })).toBeNull();
  });

  it('keeps the desktop\'s own window commands on the desktop', () => {
    expect(remoteNotifyCommand({ type: 'open-in-pane', id: 'q11' })).toBeNull();
    expect(remoteNotifyCommand({ type: 'pause', minutes: 30 })).toBeNull();
    expect(remoteNotifyCommand({ type: 'hover-info', id: 'q11', hovering: true })).toBeNull();
  });
});
