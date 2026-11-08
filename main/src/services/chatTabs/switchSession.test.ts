import { describe, expect, it } from 'vitest';
import type { ToolPanel, TerminalPanelState } from '../../../../shared/types/panels';
import { PaneError } from '../../../../shared/paneError';
import { previewSessionSwitch, switchSessionToChat, type SessionSwitchPorts } from './switchSession';

interface Tab { id: string; pane: string; state: Partial<TerminalPanelState>; busy?: boolean; noConversation?: string; chatFails?: string }

/** A Session whose own Pane and two member Panes hold these terminal tabs; Switch to chat runs for real over fakes. */
function session(tabs: Tab[]) {
  const panels = new Map<string, ToolPanel>(tabs.map((tab, position) => [tab.id, {
    id: tab.id, sessionId: tab.pane, type: 'terminal', title: `${tab.id} tab`,
    state: { isActive: false, customState: tab.state }, metadata: { createdAt: '', lastActiveAt: '', position },
  }]));
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const log: string[] = [];
  let next = 0;
  const chatOf = new Map<string, string>();
  const ports: SessionSwitchPorts = {
    sessionTerminals: id => id === 'missing' ? undefined : tabs.filter(tab => panels.has(tab.id)).map(tab => ({ panel: panels.get(tab.id)!, paneName: tab.pane === 'own' ? 'Session' : tab.pane })),
    chatTabsEnabled: () => true,
    panel: id => panels.get(id),
    paneDirectory: () => '/work',
    terminal: {
      busy: async id => byId.get(id)?.busy === true,
      conversationId: async id => { const tab = byId.get(id); return tab?.noConversation ? { problem: tab.noConversation } : { id: `conv-${id}` }; },
      stop: async id => { log.push(`stop ${id}`); },
      restart: async id => { log.push(`restart ${id}`); },
      close: async id => { log.push(`close ${id}`); panels.delete(id); },
    },
    chat: {
      create: async replaces => { const id = `chat-${++next}`; chatOf.set(id, replaces.id); return id; },
      start: async id => {
        const reason = byId.get(chatOf.get(id) ?? '')?.chatFails;
        if (reason) throw new PaneError('CHAT_START_FAILED', reason, 'Keep working in the terminal.');
        log.push(`started ${chatOf.get(id)}`);
      },
      close: async () => undefined,
      activate: async () => undefined,
    },
    adoptSessionPanel: async () => ({ owner: 'chat' }),
    sessionLaunchCommand: () => undefined,
  };
  return { ports, log };
}

const claude: Partial<TerminalPanelState> = { agentType: 'claude' };
const codex: Partial<TerminalPanelState> = { agentType: 'codex' };
const shell: Partial<TerminalPanelState> = {};

describe('switching a whole Session to chat', () => {
  const tabs: Tab[] = [
    { id: 'orchestrator', pane: 'own', state: claude },
    { id: 'auth', pane: 'auth-fix', state: claude },
    { id: 'busy', pane: 'auth-fix', state: claude, busy: true },
    { id: 'plain', pane: 'docs', state: codex, noConversation: 'Codex reports its conversation ID only when it exits' },
    { id: 'shell', pane: 'docs', state: shell },
    { id: 'codex', pane: 'docs', state: { agentType: 'codex', agentSessionId: 'c-1' } },
  ];

  it('previews every terminal tab, saying which will switch and why the rest will not', async () => {
    const { ports, log } = session(tabs);
    const preview = await previewSessionSwitch('s-1', ports);
    expect(preview.items.map(item => [item.panelId, item.paneName, item.skip?.kind ?? 'switch'])).toEqual([
      ['orchestrator', 'Session', 'switch'],
      ['auth', 'auth-fix', 'switch'],
      ['busy', 'auth-fix', 'busy'],
      ['plain', 'docs', 'plain-codex'],
      ['shell', 'docs', 'not-agent'],
      ['codex', 'docs', 'switch'],
    ]);
    expect(preview.items.find(item => item.panelId === 'busy')?.skip?.reason).toBe('Claude is in the middle of a turn.');
    // Nothing has run yet, so no reason says "Nothing was switched".
    expect(preview.items.filter(item => item.skip?.reason.includes('Nothing was switched'))).toEqual([]);
    // A preview never touches an agent.
    expect(log).toEqual([]);
  });

  it('switches the switchable tabs one by one and reports the skipped ones', async () => {
    const { ports, log } = session(tabs);
    const result = await switchSessionToChat('s-1', undefined, ports);
    expect(result.items.map(item => [item.panelId, item.result])).toEqual([
      ['orchestrator', 'switched'], ['auth', 'switched'], ['busy', 'skipped'], ['plain', 'skipped'], ['shell', 'skipped'], ['codex', 'switched'],
    ]);
    // One at a time: each tab is stopped, reopened and closed before the next starts.
    expect(log).toEqual([
      'stop orchestrator', 'started orchestrator', 'close orchestrator',
      'stop auth', 'started auth', 'close auth',
      'stop codex', 'started codex', 'close codex',
    ]);
  });

  it('keeps going when one tab fails in the middle, and that tab gets its terminal back', async () => {
    const { ports, log } = session([
      { id: 'first', pane: 'own', state: claude },
      { id: 'middle', pane: 'auth-fix', state: claude, chatFails: 'Resource not found' },
      { id: 'last', pane: 'docs', state: claude },
    ]);
    const result = await switchSessionToChat('s-1', undefined, ports);
    expect(result.items.map(item => [item.panelId, item.result])).toEqual([['first', 'switched'], ['middle', 'failed'], ['last', 'switched']]);
    expect(result.items[1].skip?.reason).toMatch(/Resource not found.*running the same conversation again/);
    expect(log).toEqual(['stop first', 'started first', 'close first', 'stop middle', 'restart middle', 'stop last', 'started last', 'close last']);
  });

  it('switches only the tabs the person confirmed, and says so of the rest', async () => {
    const { ports, log } = session(tabs);
    const result = await switchSessionToChat('s-1', ['auth', 'busy', 'elsewhere'], ports);
    expect(result.items.map(item => [item.panelId, item.result, item.skip?.kind])).toEqual([
      ['orchestrator', 'skipped', 'unconfirmed'], ['auth', 'switched', undefined], ['busy', 'skipped', 'busy'], ['plain', 'skipped', 'plain-codex'], ['shell', 'skipped', 'not-agent'], ['codex', 'skipped', 'unconfirmed'],
    ]);
    expect(result.items[0].skip?.reason).toMatch(/not on the list when you confirmed/);
    expect(log).toEqual(['stop auth', 'started auth', 'close auth']);
  });

  it('refuses a Session that does not exist', async () => {
    const { ports } = session(tabs);
    await expect(previewSessionSwitch('missing', ports)).rejects.toMatchObject({ code: 'CHAT_SESSION_MISSING' });
    await expect(switchSessionToChat('missing', undefined, ports)).rejects.toMatchObject({ code: 'CHAT_SESSION_MISSING' });
  });
});
