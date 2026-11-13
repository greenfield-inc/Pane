import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import type { ChatAgentEntry } from '../../../../shared/types/chatTab';
import { arrangeComposerControls } from '../../../../shared/chatComposerControls';
import { chatAgentLabel, menuChatAgents } from '../../../../shared/chatAgentMenu';
import { RemoteRequestError } from '../../../../shared/remoteClient/remoteDaemonClient';
import { refreshChatAgents, useChatAgentsStore } from '../../stores/chatAgentsStore';
import { agentIcon, agentIdIcon } from '../ui/brandIconRegistry';
import { ChatModeChip, ChatRiskyModeMarker, riskySetting } from './ChatComposerControls';

function entry(id: string, fields: Partial<ChatAgentEntry> = {}): ChatAgentEntry {
  return { id, label: id, icon: id, source: 'config', installed: true, fullAccess: 'agent', switchFromTerminal: { ok: true }, ...fields };
}

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

  it('offers the agents older hosts run when the host does not know the catalog channel', async () => {
    await refreshChatAgents({ agents: () => Promise.reject(new RemoteRequestError('No Pane daemon command registered for channel "chat-tab:agents".', 404, 'ERR_UNKNOWN_CHANNEL')) });
    expect(useChatAgentsStore.getState().entries?.map(agent => agent.id)).toEqual(['claude', 'codex']);
    useChatAgentsStore.setState({ entries: undefined });
    // The same answer from a remote host, through the desktop's IPC bridge.
    await refreshChatAgents({ agents: () => Promise.reject(new Error('Error invoking remote method \'daemon:invoke\': Error [ERR_UNKNOWN_CHANNEL]: No Pane daemon command registered for channel "chat-tab:agents".')) });
    expect(useChatAgentsStore.getState().entries?.map(agent => agent.id)).toEqual(['claude', 'codex']);
  });

  it('keeps the last list and reports why when a read fails for another reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await refreshChatAgents({ agents: async () => [entry('opencode', { label: 'OpenCode' })] });
    await refreshChatAgents({ agents: () => Promise.reject(new Error('Error invoking remote method \'daemon:invoke\': Error: The host is not connected.')) });
    expect(useChatAgentsStore.getState()).toEqual({ entries: [entry('opencode', { label: 'OpenCode' })], error: 'Could not read the agents on this machine: The host is not connected.' });
  });

  afterEach(() => { vi.restoreAllMocks(); useChatAgentsStore.setState({ entries: undefined, error: undefined }); });
});

describe('an agent Pane has no entry for', () => {
  it('is named by its catalog label, else its config label, else its id', () => {
    expect(chatAgentLabel([entry('goose', { label: 'Goose' })], 'goose')).toBe('Goose');
    expect(chatAgentLabel(undefined, 'codex')).toBe('Codex');
    expect(chatAgentLabel(undefined, 'some-acp-agent')).toBe('some-acp-agent');
  });

  it('shows its catalog image when no brand icon matches, else the generic chat icon', () => {
    expect(renderToStaticMarkup(agentIcon({ icon: 'goose', iconUrl: 'https://example.test/goose.svg' }))).toContain('https://example.test/goose.svg');
    expect(renderToStaticMarkup(agentIdIcon('some-acp-agent'))).toContain('lucide-message-square');
    // A key that only contains a brand's name is not that brand.
    expect(renderToStaticMarkup(agentIcon({ icon: 'not-claude' }))).toContain('lucide-message-square');
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
