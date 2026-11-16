import { describe, expect, it } from 'vitest';
import { protectionOf, type ProtectionReaders } from './paneProtections';

const readers = (over: Partial<ProtectionReaders> = {}): ProtectionReaders => ({
  pinned: () => false,
  focusedPaneId: () => undefined,
  panelIds: () => ['t1', 't2'],
  agentState: () => 'idle',
  hasOpenNotify: () => false,
  hasUncommittedChanges: async () => false,
  ...over,
});

describe('protectionOf', () => {
  it('lets an idle, clean, unpinned Pane through', async () => {
    expect(await protectionOf('p', readers())).toBeNull();
  });

  it.each([
    ['pinned', { pinned: () => true }, 'It is pinned.'],
    ['focused', { focusedPaneId: () => 'p' }, 'It is the Pane you are looking at.'],
    ['agent working', { agentState: (id: string) => (id === 't2' ? 'working' : 'idle') }, 'An agent is working in it.'],
    ['agent waiting', { agentState: () => 'blocked' }, 'An agent is waiting on you in it.'],
    ['open Notify card', { hasOpenNotify: () => true }, 'It has an open Notify card.'],
    ['uncommitted changes', { hasUncommittedChanges: async () => true }, 'It has uncommitted changes.'],
    ['git cannot tell', { hasUncommittedChanges: async () => { throw new Error('not a git repo'); } }, 'Pane could not check it for uncommitted changes.'],
  ])('protects a Pane when %s', async (_name, over, reason) => {
    expect(await protectionOf('p', readers(over))).toBe(reason);
  });
});
