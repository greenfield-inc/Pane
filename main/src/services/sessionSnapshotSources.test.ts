import { describe, expect, it, vi } from 'vitest';
import { hostSnapshotSources, type HostSnapshotReaders } from './sessionSnapshotSources';
import { PaneError } from '../../../shared/paneError';
import type { ChatTabView } from '../../../shared/types/chatTab';
import type { ToolPanel } from '../../../shared/types/panels';

const chatTab: ToolPanel = { id: 'chat-a', sessionId: 'pane-a', type: 'chat', title: 'Claude', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
const chatView: ChatTabView = { panelId: 'chat-a', agent: 'claude', generation: 1, status: 'stopped', canAttachImages: false, controls: [], commands: [], permissions: [], questions: [], queue: [], messageCount: 0 };

/** The host's readers, each a spy; a chat tab manager whose `view` is what was asked of it. */
function readers(storedLayout: (paneId: string) => string | null = () => null) {
  const view = vi.fn<(panelId: string, limit?: number, start?: boolean) => ChatTabView>(() => chatView);
  const send = vi.fn();
  const list = vi.fn(async () => ({ sessions: [] }));
  const getPanelsForSession = vi.fn(() => [chatTab]);
  const host: HostSnapshotReaders = {
    sessions: { list },
    panels: { getPanelsForSession, getPanel: () => chatTab },
    chats: () => ({ view }),
    storedLayout,
    events: () => ({ send }),
  };
  return { host, view, send, list, getPanelsForSession };
}

describe('hostSnapshotSources', () => {
  it('reads a chat tab without starting its agent', () => {
    const { host, view } = readers();

    expect(hostSnapshotSources(host).chat('chat-a', 30)).toEqual(chatView);

    expect(view).toHaveBeenCalledWith('chat-a', 30, false);
  });

  it('reads a chat tab that is gone as nothing', () => {
    const { host, view } = readers();
    view.mockImplementation(() => { throw new PaneError('CHAT_PANEL_MISSING', 'This chat tab no longer exists.', 'Open another chat tab.'); });

    expect(hostSnapshotSources(host).chat('chat-a', 30)).toBeUndefined();
  });

  it('lists Sessions as summaries, and tabs as the Pane holds them', async () => {
    const { host, list, getPanelsForSession } = readers();
    const sources = hostSnapshotSources(host);

    await sources.sessions();

    expect(list).toHaveBeenCalledWith({ summary: true });
    expect(sources.tabs('pane-a')).toEqual([chatTab]);
    expect(getPanelsForSession).toHaveBeenCalledWith('pane-a');
  });

  it('reads a stored layout, and a corrupt or missing one as none', () => {
    const layout = { version: 1, root: { type: 'group', id: 'g', panelIds: ['chat-a'], activePanelId: 'chat-a' } };
    const stored = [JSON.stringify(layout), '{not json', null];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sources = hostSnapshotSources(readers(() => stored.shift() ?? null).host);

    expect(sources.layout('pane-a')).toEqual(layout);
    expect(sources.layout('pane-a')).toBeNull();
    expect(sources.layout('pane-a')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('announces a change on the event stream', () => {
    const { host, send } = readers();

    hostSnapshotSources(host).announce('a', 42);

    expect(send).toHaveBeenCalledWith('session-snapshot:changed', { sessionId: 'a', revision: 42 });
  });
});
