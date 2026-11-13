import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import type { ChatAgentEntry } from '../../../../shared/types/chatTab';
import { arrangeComposerControls } from '../../../../shared/chatComposerControls';
import { chatAgentLabel, menuChatAgents, refreshChatAgents, useChatAgentsStore } from '../../stores/chatAgentsStore';
import { agentIcon, agentIdIcon } from '../ui/brandIconRegistry';
import { AgentList } from '../settings/categories/AgentsSettings';
import { ChatModeChip, ChatRiskyModeMarker, riskySetting } from './ChatComposerControls';

function entry(id: string, fields: Partial<ChatAgentEntry> = {}): ChatAgentEntry {
  return { id, label: id, icon: id, source: 'config', installed: true, fullAccess: 'agent', switchFromTerminal: { ok: true }, ...fields };
}
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('the + menu\'s chat agents', () => {
  it('lists installed agents, Pane\'s own first, then registry agents, in catalog order', () => {
    const catalog = [
      entry('gemini', { label: 'Gemini CLI', source: 'registry' }),
      entry('claude', { label: 'Claude' }),
      entry('cursor', { label: 'Cursor', installed: false }),
      entry('opencode', { label: 'OpenCode' }),
      entry('goose', { label: 'goose', source: 'registry', installed: false }),
    ];
    expect(menuChatAgents(catalog).map(agent => agent.label)).toEqual(['Claude', 'OpenCode', 'Gemini CLI']);
  });

  it('offers the agents older hosts run when the host has no catalog', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await refreshChatAgents({ agents: () => Promise.reject(new Error('No handler registered for chat-tab:agents')) });
    expect(useChatAgentsStore.getState().entries?.map(agent => agent.id)).toEqual(['claude', 'codex']);
  });

  afterEach(() => { vi.restoreAllMocks(); useChatAgentsStore.setState({ entries: undefined }); });
});

describe('an agent Pane has no entry for', () => {
  it('is named by its catalog label, else its config label, else its id', () => {
    expect(chatAgentLabel([entry('goose', { label: 'Goose' })], 'goose')).toBe('Goose');
    expect(chatAgentLabel(undefined, 'codex')).toBe('Codex');
    expect(chatAgentLabel(undefined, 'some-acp-agent')).toBe('some-acp-agent');
  });

  it('shows its catalog image when no brand icon matches, else the generic chat icon', () => {
    expect(renderToStaticMarkup(agentIcon({ icon: 'goose', iconUrl: 'https://example.test/goose.svg' }))).toContain('src="https://example.test/goose.svg"');
    expect(renderToStaticMarkup(agentIdIcon('some-acp-agent'))).toContain('lucide-message-square');
    // A key that only contains a brand's name is not that brand.
    expect(renderToStaticMarkup(agentIcon({ icon: 'not-claude' }))).toContain('lucide-message-square');
  });
});

describe('Settings › Agents', () => {
  it('labels what each agent supports, who grants full access, and offers Install when it is missing', () => {
    const html = renderToStaticMarkup(<AgentList agents={[
      entry('claude', { label: 'Claude', version: '2.1.316', capabilities: { reopen: true, list: true, images: true } }),
      entry('opencode', { label: 'OpenCode', fullAccess: 'pane', installed: false, installUrl: 'https://example.test/install' }),
    ]} />);
    expect(text(html)).toContain('ClaudeVersion 2.1.316Reopens chatsLists past chatsImagesFull access by agent');
    // Capabilities not yet known show no labels.
    expect(text(html)).toContain('OpenCodeNot installedInstallFull access by Pane');
  });
});

describe('a chat Pane approves for', () => {
  const fullAccess = (on: boolean): AgentChatConfigOption => ({ id: 'pane.full-access', name: 'Full access', currentValue: on ? 'on' : 'off', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] });
  const mode: AgentChatConfigOption = { id: 'mode', name: 'Mode', category: 'mode', currentValue: 'build', options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] };

  it('marks Full access like a mode that never asks: an amber chip, and the phone marker', () => {
    const on = arrangeComposerControls([mode, fullAccess(true)]);
    const chip = renderToStaticMarkup(<ChatModeChip control={mode} risky={!!riskySetting(on)} disabled={false} configure={() => undefined} />);
    expect(chip).toContain('data-tone="warning"');
    expect(renderToStaticMarkup(<ChatRiskyModeMarker setting={riskySetting(on)} />)).toContain('aria-label="Full access: On"');
  });

  it('shows no marker while Full access is off', () => {
    expect(riskySetting(arrangeComposerControls([mode, fullAccess(false)]))).toBeUndefined();
  });
});
