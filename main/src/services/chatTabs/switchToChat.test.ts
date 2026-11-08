import { describe, expect, it } from 'vitest';
import type { ToolPanel, TerminalPanelState } from '../../../../shared/types/panels';
import type { ChatPanelState, ChatTabSwitchBanner } from '../../../../shared/types/chatTab';
import { PaneError } from '../../../../shared/paneError';
import { switchToChat, terminalConversation, terminalRestored, type SessionAdoption, type SwitchToChatPorts, type TerminalConversation } from './switchToChat';
import { withSessionFolderAccess } from '../agents/sessionFolderAccess';
import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';

interface World {
  panels: Map<string, ToolPanel>;
  log: string[];
  chats: Map<string, ChatPanelState>;
  busy: boolean;
  /** Session ids the chat adapter can load. */
  loadable: Set<string>;
  startError?: PaneError;
  enabled: boolean;
  /** What Pane knows about the terminal's conversation. */
  conversation: TerminalConversation;
  /** The banner the started chat ends up with (the manager resolves "most recent" at start). */
  startedBanner?: ChatTabSwitchBanner;
  /** The Session's saved launch for this tab, when it is a Session orchestrator. */
  sessionCommand?: string;
  /** The Session that owns the terminal, by its agent tab ID. */
  owner?: string;
  adoption?: SessionAdoption;
  adoptThrows?: boolean;
  closeFails?: boolean;
  restartFails?: boolean;
}

function terminal(state: Partial<TerminalPanelState>, extra: Partial<ToolPanel> = {}): ToolPanel {
  return { id: 'term', sessionId: 'pane-1', type: 'terminal', title: 'Claude', state: { isActive: true, customState: { agentType: 'claude', ...state } }, metadata: { createdAt: '', lastActiveAt: '', position: 0 }, ...extra };
}

function world(panel: ToolPanel, overrides: Partial<World> = {}) {
  const w: World = { panels: new Map([[panel.id, panel]]), log: [], chats: new Map(), busy: false, loadable: new Set(['conv-1']), enabled: true, conversation: { sure: true, id: 'conv-1', messages: true }, ...overrides };
  let next = 0;
  const ports: SwitchToChatPorts = {
    chatTabsEnabled: () => w.enabled,
    panel: id => w.panels.get(id),
    paneDirectory: () => '/work/pane-1',
    terminal: {
      busy: async () => w.busy,
      conversation: async () => w.conversation,
      stop: async id => { w.log.push(`stop ${id}`); },
      restart: async id => {
        if (w.restartFails) throw new Error('shell is gone');
        w.log.push(`restart ${id}`);
      },
      close: async id => {
        if (w.closeFails) throw new Error('panel is locked');
        w.log.push(`close ${id}`); w.panels.delete(id);
      },
    },
    chat: {
      create: async (replaces, state) => {
        expect(replaces.id).toBe(panel.id);
        const id = `chat-${++next}`;
        w.chats.set(id, state);
        w.log.push(`create ${id} ${state.open ? `open ${state.open}` : state.acpSessionId ? `load ${state.acpSessionId}` : 'new'}`);
        return id;
      },
      start: async id => {
        if (w.startError) throw w.startError;
        const state = w.chats.get(id)!;
        if (state.acpSessionId && !w.loadable.has(state.acpSessionId)) throw new PaneError('CHAT_START_FAILED', 'Resource not found', 'Press Restart.');
        if (w.startedBanner) w.chats.set(id, { ...state, banner: w.startedBanner });
        w.log.push(`started ${id}`);
      },
      banner: id => w.chats.get(id)?.banner,
      close: async id => { w.log.push(`close ${id}`); w.chats.delete(id); },
      activate: async id => { w.log.push(`activate ${id}`); },
    },
    adoptSessionPanel: async (from, to) => {
      if (w.adoptThrows) throw new Error('lost the Session store');
      if (w.adoption) return w.adoption;
      w.log.push(`adopt ${from} -> ${to}`);
      if (w.owner === from) w.owner = to;
      return { owner: 'chat' };
    },
    sessionLaunchCommand: () => w.sessionCommand,
  };
  return { world: w, ports };
}

describe('Switch to chat', () => {
  it('reopens the conversation in a chat tab with the same launch, then closes the terminal', async () => {
    const { world: w, ports } = world(terminal({ launchCommand: 'agent-farm run greenfield/orchestrator --arg docs=grain', orchestrationSessionId: 'session-1', sessionFolder: '/sessions/one' }));
    await expect(switchToChat('term', ports)).resolves.toEqual({ panelId: 'chat-1', terminalKept: false, outcome: 'known' });
    expect(w.log).toEqual(['stop term', 'create chat-1 load conv-1', 'started chat-1', 'adopt term -> chat-1', 'activate chat-1', 'close term']);
    expect(w.chats.get('chat-1')).toMatchObject({
      agent: 'claude', acpSessionId: 'conv-1', cwd: '/work/pane-1',
      launch: { kind: 'profile', profile: 'greenfield/orchestrator', args: { docs: 'grain' } },
      orchestrationSessionId: 'session-1', sessionFolder: '/sessions/one',
    });
    expect(w.chats.get('chat-1')?.initialInput).toBeUndefined();
    expect(w.chats.get('chat-1')?.banner).toBeUndefined();
    expect(w.chats.get('chat-1')?.notice).toBeUndefined();
  });

  it('starts a new conversation with the "no messages yet" note when the known conversation has none, never loading or restarting it (J3)', async () => {
    const { world: w, ports } = world(terminal({}), { conversation: { sure: true, id: 'conv-empty', messages: false } });
    await expect(switchToChat('term', ports)).resolves.toMatchObject({ terminalKept: false, outcome: 'new' });
    expect(w.log).toEqual(['stop term', 'create chat-1 new', 'started chat-1', 'adopt term -> chat-1', 'activate chat-1', 'close term']);
    expect(w.chats.get('chat-1')).toMatchObject({ banner: { kind: 'known-empty' } });
    expect(w.chats.get('chat-1')?.acpSessionId).toBeUndefined();
  });

  it('opens the folder\'s most recent conversation when Pane is not sure, and reports it (J4)', async () => {
    const { world: w, ports } = world(terminal({}), { conversation: { sure: false, why: 'no report' }, startedBanner: { kind: 'most-recent' } });
    await expect(switchToChat('term', ports)).resolves.toMatchObject({ terminalKept: false, outcome: 'most-recent' });
    expect(w.log.slice(0, 3)).toEqual(['stop term', 'create chat-1 open most-recent', 'started chat-1']);
    expect(w.chats.get('chat-1')?.acpSessionId).toBeUndefined();
  });

  it('reports a new conversation when nothing in the folder could be opened (J5)', async () => {
    const { ports } = world(terminal({}), { conversation: { sure: false, why: 'no report' }, startedBanner: { kind: 'none' } });
    await expect(switchToChat('term', ports)).resolves.toMatchObject({ outcome: 'new' });
  });

  it('leaves the terminal stopped when Pane was not sure and the chat fails, and says so (J8)', async () => {
    const { world: w, ports } = world(terminal({}), { conversation: { sure: false, why: 'no report' }, startError: new PaneError('CHAT_START_FAILED', 'The chat agent didn\'t start within 60 seconds.', 'Press Restart.') });
    const failure = await switchToChat('term', ports).catch(error => error);
    expect(failure).toMatchObject({ code: 'CHAT_SWITCH_NOT_STARTED' });
    expect(failure.message).toBe('The chat agent didn\'t start within 60 seconds. The terminal is stopped, because Pane wasn\'t sure which conversation to restart it on. Your conversations are saved.');
    expect(w.log).toEqual(['stop term', 'create chat-1 open most-recent', 'close chat-1']);
    expect(w.log).not.toContain('restart term');
  });

  it('never restarts a terminal on a known conversation with no messages when the chat fails (bug case A)', async () => {
    const { world: w, ports } = world(terminal({}), { conversation: { sure: true, id: 'conv-empty', messages: false }, startError: new PaneError('CHAT_START_FAILED', 'Adapter exited', 'Press Restart.') });
    await expect(switchToChat('term', ports)).rejects.toMatchObject({ code: 'CHAT_SWITCH_NOT_STARTED', message: expect.stringContaining('no messages yet') });
    expect(w.log).not.toContain('restart term');
  });

  it('decides what it is sure of before the stop, and sends the terminal nothing when it changes nothing (J10)', async () => {
    const { world: w, ports } = world(terminal({}), { busy: true, conversation: { sure: false, why: 'no report' } });
    await expect(switchToChat('term', ports)).rejects.toMatchObject({ code: 'CHAT_SWITCH_BUSY' });
    expect(w.log).toEqual([]);
  });

  it('fails cleanly when the conversation does not reopen: the actual reason, no chat tab, the terminal running again', async () => {
    const { world: w, ports } = world(terminal({}), { startError: new PaneError('CHAT_PROFILE_FAILED', 'Agent Farm could not prepare greenfield/orchestrator: ACP adapter not found.', 'Check the profile name.') });
    const failure = await switchToChat('term', ports).catch(error => error);
    expect(failure).toBeInstanceOf(PaneError);
    expect(failure.code).toBe('CHAT_SWITCH_FAILED');
    expect(failure.message).toBe('Agent Farm could not prepare greenfield/orchestrator: ACP adapter not found. The terminal is back on the same conversation (conv-1), with its history.');
    expect(failure.message).not.toMatch(/starting a new one|running the same conversation again/);
    expect(failure.next).toMatch(/Try again/);
    expect(w.log).toEqual(['stop term', 'create chat-1 load conv-1', 'close chat-1', 'restart term']);
    expect(w.chats.size).toBe(0);
    expect(w.panels.has('term')).toBe(true);
  });

  it('says so when the terminal does not come back either', async () => {
    const { ports } = world(terminal({}), { loadable: new Set(), restartFails: true });
    await expect(switchToChat('term', ports)).rejects.toMatchObject({ code: 'CHAT_SWITCH_FAILED', message: expect.stringMatching(/did not start again \(shell is gone\), so it is stopped\. Its conversation \(conv-1\) is saved\./) });
  });

  it('asks the person to wait or stop a mid-turn agent, and touches nothing', async () => {
    const { world: w, ports } = world(terminal({}), { busy: true });
    await expect(switchToChat('term', ports)).rejects.toMatchObject({ code: 'CHAT_SWITCH_BUSY', next: expect.stringMatching(/wait|stop/i) });
    expect(w.log).toEqual([]);
  });

  it('switches a Session orchestrator with the launch the Session saved, not a plain agent', async () => {
    const { world: w, ports } = world(terminal({ initialCommand: 'claude' }), { sessionCommand: 'agent-farm run greenfield/orchestrator --arg docs=grain', owner: 'term' });
    await switchToChat('term', ports);
    expect(w.chats.get('chat-1')?.launch).toEqual({ kind: 'profile', profile: 'greenfield/orchestrator', args: { docs: 'grain' } });
    expect(w.owner).toBe('chat-1');
  });

  it('reads a Pane tab\'s launch from its initial command when it saved no launch command', async () => {
    const { world: w, ports } = world(terminal({ initialCommand: 'claude --dangerously-skip-permissions' }));
    await switchToChat('term', ports);
    expect(w.chats.get('chat-1')?.launch).toEqual({ kind: 'agent', mode: 'bypassPermissions' });
  });

  it('keeps the terminal, changing nothing, when its launch has a flag a chat tab cannot run', async () => {
    const { world: w, ports } = world(terminal({ launchCommand: 'claude --dangerously-skip-permissions --verbose' }));
    await expect(switchToChat('term', ports)).rejects.toMatchObject({ code: 'CHAT_SWITCH_LAUNCH_UNSUPPORTED', message: expect.stringContaining('--verbose') });
    expect(w.log).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('switches Claude in a Session\'s Pane, keeping its Session folder (D-161)', async () => {
    const folder = '/Users/me/.pane/sessions/s-1';
    const command = withSessionFolderAccess({ title: 'Claude Code', command: RUNPANE_CONTRACT.agentTemplates.claude.command, agent: 'claude' }, folder).command;
    const { world: w, ports } = world(terminal({ initialCommand: command, launchCommand: command, sessionFolder: folder }));
    await expect(switchToChat('term', ports)).resolves.toMatchObject({ terminalKept: false });
    expect(w.chats.get('chat-1')).toMatchObject({ launch: { kind: 'agent', mode: 'bypassPermissions' }, sessionFolder: folder });
  });

  it('fails cleanly when the Session stayed on its terminal and the chat can be removed', async () => {
    const { world: w, ports } = world(terminal({}), { owner: 'term', adoption: { owner: 'terminal', chatReleased: true, reason: 'store is read-only' } });
    await expect(switchToChat('term', ports)).rejects.toMatchObject({ code: 'CHAT_SWITCH_FAILED', message: expect.stringContaining('read-only') });
    expect(w.chats.size).toBe(0);
    expect(w.owner).toBe('term');
    expect(w.log.slice(-2)).toEqual(['close chat-1', 'restart term']);
  });

  it('keeps both tabs, removing nothing and not restarting the agent, when the chat cannot be released (review F-8)', async () => {
    const { world: w, ports } = world(terminal({}), { owner: 'term', adoption: { owner: 'terminal', chatReleased: false, reason: 'disk full' } });
    await expect(switchToChat('term', ports)).resolves.toMatchObject({ panelId: 'chat-1', terminalKept: true, reason: expect.stringContaining('disk full') });
    expect(w.chats.has('chat-1')).toBe(true);
    expect(w.panels.has('term')).toBe(true);
    expect(w.log).not.toContain('restart term');
  });

  it('keeps both tabs when who owns the Session is unknown (review F-8)', async () => {
    const { world: w, ports } = world(terminal({}), { owner: 'term', adoptThrows: true });
    await expect(switchToChat('term', ports)).resolves.toMatchObject({ panelId: 'chat-1', terminalKept: true, reason: expect.stringContaining('lost the Session store') });
    expect(w.chats.has('chat-1')).toBe(true);
    expect(w.log).not.toContain('close chat-1');
    expect(w.log).not.toContain('close term');
  });

  it('never deletes the chat a Session adopted when the terminal tab will not close', async () => {
    const { world: w, ports } = world(terminal({}), { owner: 'term', closeFails: true });
    await expect(switchToChat('term', ports)).resolves.toMatchObject({ panelId: 'chat-1', terminalKept: true, reason: expect.stringContaining('could not be closed') });
    expect(w.owner).toBe('chat-1');
    expect(w.chats.has('chat-1')).toBe(true);
    expect(w.log).not.toContain('close chat-1');
  });

  it('refuses tabs it cannot switch, with nothing changed', async () => {
    await expect(switchToChat('term', world(terminal({}), { enabled: false }).ports)).rejects.toMatchObject({ code: 'CHAT_TABS_DISABLED' });
    await expect(switchToChat('term', world(terminal({ agentType: 'cursor' })).ports)).rejects.toMatchObject({ code: 'CHAT_SWITCH_UNSUPPORTED' });
    await expect(switchToChat('term', world(terminal({}, { type: 'diff' })).ports)).rejects.toMatchObject({ code: 'CHAT_SWITCH_UNSUPPORTED' });
    await expect(switchToChat('missing', world(terminal({})).ports)).rejects.toMatchObject({ code: 'CHAT_PANEL_MISSING' });
  });
});

describe('whether the terminal came back after a failed switch', () => {
  it('counts a ready agent, one at its own prompt, or a running one whose input box could not be confirmed', () => {
    expect(terminalRestored(undefined)).toBe(true);
    expect(terminalRestored({ ok: true })).toBe(true);
    expect(terminalRestored({ ok: false, blocked: { message: 'Trust this folder?' } })).toBe(true);
    expect(terminalRestored({ ok: false, reason: { code: 'agent-not-ready', message: 'not ready' }, state: { running: true } })).toBe(true);
  });

  it('does not count an agent that is not there', () => {
    expect(terminalRestored({ ok: false, reason: { code: 'agent-not-ready', message: 'not ready' }, state: { running: false } })).toBe(false);
    expect(terminalRestored({ ok: false, reason: { code: 'command-exited', message: 'exited' }, state: { running: true } })).toBe(false);
    expect(terminalRestored({ ok: false })).toBe(false);
  });
});

describe('which conversation Pane is sure a terminal is on (D-269)', () => {
  const report = { id: 'conv-a', source: 'clear', launchId: 'launch-2', reportedAt: '2026-11-08T00:00:00Z' };
  const found = () => 'found' as const;

  it('is sure only of a report from the launch running now', () => {
    expect(terminalConversation({ agentType: 'claude', conversationReport: report }, 'launch-2', found)).toEqual({ sure: true, id: 'conv-a', messages: true });
    expect(terminalConversation({ agentType: 'claude', conversationReport: report }, 'launch-3', found)).toMatchObject({ sure: false, why: expect.stringContaining('earlier launch') });
    expect(terminalConversation({ agentType: 'claude', conversationReport: report }, undefined, found)).toMatchObject({ sure: false });
    expect(terminalConversation({ agentType: 'claude' }, 'launch-2', found)).toMatchObject({ sure: false });
  });

  it('is never sure of a Codex terminal, even with a report', () => {
    expect(terminalConversation({ agentType: 'codex', conversationReport: report }, 'launch-2', found)).toMatchObject({ sure: false });
  });

  it('knows a conversation with no transcript has no messages, and is not sure when two transcripts share its ID', () => {
    expect(terminalConversation({ agentType: 'claude', conversationReport: report }, 'launch-2', () => 'missing')).toEqual({ sure: true, id: 'conv-a', messages: false });
    expect(terminalConversation({ agentType: 'claude', conversationReport: report }, 'launch-2', () => 'unknown')).toEqual({ sure: true, id: 'conv-a', messages: true });
    expect(terminalConversation({ agentType: 'claude', conversationReport: report }, 'launch-2', () => 'ambiguous')).toMatchObject({ sure: false, why: expect.stringContaining('two transcripts') });
  });
});
