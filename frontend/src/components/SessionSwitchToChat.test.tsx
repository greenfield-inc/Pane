import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatAgentEntry, SessionChatSwitchItem, SessionChatSwitchSkip } from '../../../shared/types/chatTab';
import type { ToolPanel } from '../../../shared/types/panels';
import { switchMenuState } from '../utils/sessionChatSwitch';
import { SessionSwitchMenuItem } from './SessionSwitchToChat';
import { switchToChatMenuItems } from './panels/switchToChatMenu';

const text = (html: string) => html.replace(/<[^>]+>/g, '');
function tab(panelId: string, skip?: SessionChatSwitchSkip, reason = 'why'): SessionChatSwitchItem {
  const item: SessionChatSwitchItem = { panelId, title: panelId, paneName: 'Pane' };
  if (skip) item.skip = { kind: skip, reason };
  return item;
}
const preview = (...items: SessionChatSwitchItem[]) => ({ sessionId: 's1', items });

describe('Switch to chat in a Session menu, always shown (D-337)', () => {
  it('is ready when some tab can switch, and keeps the preview for the dialog', () => {
    const read = preview(tab('a'), tab('b', 'busy'));
    expect(switchMenuState(read, 'this machine')).toEqual({ state: 'ready', preview: read });
  });

  it('counts what cannot switch by reason, leaving plain shells out', () => {
    expect(switchMenuState(preview(tab('a', 'busy'), tab('b', 'no-conversation'), tab('c', 'busy'), tab('d', 'not-agent')), 'this machine'))
      .toEqual({ state: 'unavailable', reason: 'Nothing to switch: 2 busy, 1 no saved conversation' });
  });

  it('says there is nothing to switch when the Session has no terminal agent tab', () => {
    expect(switchMenuState(preview(), 'this machine')).toEqual({ state: 'unavailable', reason: 'No terminal agent tabs to switch' });
    expect(switchMenuState(preview(tab('shell', 'not-agent')), 'this machine')).toEqual({ state: 'unavailable', reason: 'No terminal agent tabs to switch' });
  });

  it('names the machine when its preview says chat tabs are off there', () => {
    const off = tab('a', 'other', 'Chat tabs are turned off on this machine.');
    expect(switchMenuState(preview(off), 'build-box')).toEqual({ state: 'unavailable', reason: 'Chat tabs are off on build-box' });
  });

  it('shows a spinner and Checking… while the preview loads, without opening anything', () => {
    const html = renderToStaticMarkup(<SessionSwitchMenuItem menu={{ state: 'checking' }} onOpen={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('animate-spin');
    expect(text(html)).toBe('Switch to chat…Checking…');
  });

  it('offers the dialog when ready', () => {
    const html = renderToStaticMarkup(<SessionSwitchMenuItem menu={{ state: 'ready', preview: preview(tab('a')) }} onOpen={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('aria-disabled="false"');
    expect(text(html)).toBe('Switch to chat…');
  });

  it('is disabled with its reason when nothing can switch', () => {
    const html = renderToStaticMarkup(<SessionSwitchMenuItem menu={{ state: 'unavailable', reason: 'Nothing to switch: 2 busy' }} onOpen={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('aria-disabled="true"');
    expect(text(html)).toBe('Switch to chat…Nothing to switch: 2 busy');
  });

  it('adds Turn on chat tabs when they are off on this window\'s host', () => {
    const html = renderToStaticMarkup(<SessionSwitchMenuItem menu={{ state: 'unavailable', reason: 'Chat tabs are off on this machine', turnOn: true }} onOpen={() => undefined} onClose={() => undefined} />);
    expect(text(html)).toBe('Switch to chat…Chat tabs are off on this machineTurn on chat tabs');
  });
});

describe('Switch to chat in a tab menu, always shown for agent tabs the catalog lists (D-337)', () => {
  const entry = (id: string, switchFromTerminal: ChatAgentEntry['switchFromTerminal']): ChatAgentEntry =>
    ({ id, label: id, icon: id, source: 'config', installed: true, fullAccess: 'agent', switchFromTerminal });
  const agents = [entry('codex', { ok: true }), entry('cursor', { ok: false, reason: 'Cursor chats cannot open its terminal conversations.' })];
  const panel = (type: ToolPanel['type'], agentType?: string): ToolPanel => ({
    id: 'p1', sessionId: 's1', type, title: 'Agent',
    state: { isActive: true, customState: agentType ? { agentType } : {} },
    metadata: { createdAt: '', lastActiveAt: '', position: 0 },
  });
  const shown = (items: ReturnType<typeof switchToChatMenuItems>) => items.map(item => ({ id: item.id, disabled: item.disabled === true, description: item.description }));

  it('opens the dialog for a terminal tab whose agent can switch when chat tabs are on', () => {
    expect(shown(switchToChatMenuItems(panel('terminal', 'codex'), true, agents, () => undefined))).toEqual([{ id: 'switch-to-chat', disabled: false, description: undefined }]);
  });

  it('is disabled with the catalog\'s reason for an agent that cannot switch', () => {
    expect(shown(switchToChatMenuItems(panel('terminal', 'cursor'), true, agents, () => undefined))).toEqual([
      { id: 'switch-to-chat', disabled: true, description: 'Cursor chats cannot open its terminal conversations.' },
    ]);
  });

  it('is disabled with Turn on when chat tabs are off', () => {
    expect(shown(switchToChatMenuItems(panel('terminal', 'codex'), false, agents, () => undefined))).toEqual([
      { id: 'switch-to-chat', disabled: true, description: 'Chat tabs are off on this machine' },
      { id: 'turn-on-chat-tabs', disabled: false, description: undefined },
    ]);
  });

  it('is disabled on a chat tab, and absent from tabs that run no agent the catalog lists', () => {
    expect(shown(switchToChatMenuItems(panel('chat'), true, agents, () => undefined))).toEqual([{ id: 'switch-to-chat', disabled: true, description: 'This tab is already a chat' }]);
    expect(switchToChatMenuItems(panel('terminal'), true, agents, () => undefined)).toEqual([]);
    expect(switchToChatMenuItems(panel('terminal', 'aider'), true, agents, () => undefined)).toEqual([]);
  });
});
