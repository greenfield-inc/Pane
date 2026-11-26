import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatePanelRequest, ToolPanel } from '../../../../shared/types/panels';
import type { ProfileSubagentNode } from '../../../../shared/types/profileEditor';
import { useConfigStore } from '../../stores/configStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { AppConfig } from '../../types/config';
import type { Session } from '../../types/session';
import { openSubagentTab as openWith, tabActionLabel, tabCommand, tabPane } from './subagentTab';

const createPanel = vi.fn<(request: CreatePanelRequest) => Promise<ToolPanel>>();
const activatePanel = vi.fn<(paneId: string, panelId: string) => Promise<void>>(async () => undefined);
const leaveProfilesFor = vi.fn<(paneId: string) => Promise<void>>(async () => undefined);
const openSubagentTab = (node: ProfileSubagentNode) => openWith(node, { createPanel, showPane: leaveProfilesFor, activatePanel });

/** A terminal tab as the host returns it. */
function terminalTab(id: string, sessionId: string, title: string): ToolPanel {
  return { id, sessionId, type: 'terminal', title, state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
}

function link(mode: ProfileSubagentNode['mode'], extra: Partial<ProfileSubagentNode> = {}): ProfileSubagentNode {
  return {
    kind: 'subagent', id: `o/sub:${extra.alias ?? 'planner'}`, alias: 'planner', agent: 'greenfield/planner', label: 'Planner', mode,
    command: mode === 'native' ? undefined : 'agent-farm run greenfield/planner --agent-only', children: [], ...extra,
  };
}

function pane(id: string, extra: Partial<Session> = {}): Session {
  // SAFETY: the module reads only id, name and archived.
  return { id, name: `Pane ${id}`, ...extra } as Session;
}

describe('tabCommand', () => {
  it('is the listed command for launch and process links', () => {
    expect(tabCommand(link('launch'))).toBe('agent-farm run greenfield/planner --agent-only');
    expect(tabCommand(link('process', { command: '  agent-farm run greenfield/advisor --agent-only ' }))).toBe('agent-farm run greenfield/advisor --agent-only');
  });

  it('is undefined for an agent inside its parent, an any link, a link that does not resolve, or no command', () => {
    expect(tabCommand(link('native', { command: 'agent-farm run x' }))).toBeUndefined();
    expect(tabCommand(link('launch', { any: true }))).toBeUndefined();
    expect(tabCommand(link('launch', { error: 'not found' }))).toBeUndefined();
    expect(tabCommand(link('launch', { command: ' ' }))).toBeUndefined();
  });
});

describe('tabPane and the label', () => {
  it('is the Pane you came from, a main-repo Pane included, but never an archived or unknown one', () => {
    const sessions = [pane('a'), pane('b', { archived: true })];
    expect(tabPane('a', sessions, null)?.name).toBe('Pane a');
    expect(tabPane('m', sessions, pane('m'))?.name).toBe('Pane m');
    expect(tabPane('b', sessions, null)).toBeUndefined();
    expect(tabPane('z', sessions, null)).toBeUndefined();
    expect(tabPane(null, sessions, null)).toBeUndefined();
  });

  it('names the Pane when there is one', () => {
    expect(tabActionLabel(link('launch'), pane('a'))).toBe('Open Planner in a tab in Pane a');
    expect(tabActionLabel(link('launch'), undefined)).toBe('Open Planner in a tab');
  });
});

describe('openSubagentTab', () => {
  const initial = {
    config: useConfigStore.getState().config,
    profilesReturn: useNavigationStore.getState().profilesReturn,
    sessions: useSessionStore.getState().sessions,
  };

  beforeEach(() => {
    createPanel.mockReset();
    activatePanel.mockClear();
    leaveProfilesFor.mockClear();
    // SAFETY: the module reads only sessionProfilesEnabled.
    useConfigStore.setState({ config: { sessionProfilesEnabled: true } as AppConfig });
    useNavigationStore.setState({ profilesReturn: { view: 'sessions', projectId: null, paneId: 'a' } });
    useSessionStore.setState({ sessions: [pane('a')] });
  });

  afterEach(() => {
    useConfigStore.setState({ config: initial.config });
    useNavigationStore.setState({ profilesReturn: initial.profilesReturn });
    useSessionStore.setState({ sessions: initial.sessions });
  });

  it('opens a terminal tab running the listed command in the Pane you came from, then shows it', async () => {
    createPanel.mockResolvedValue(terminalTab('p1', 'a', 'Planner'));
    await expect(openSubagentTab(link('launch'))).resolves.toBeNull();
    expect(createPanel).toHaveBeenCalledWith({ sessionId: 'a', type: 'terminal', title: 'Planner', initialState: { customState: { initialCommand: 'agent-farm run greenfield/planner --agent-only' } } });
    expect(usePanelStore.getState().panels.a?.some(panel => panel.id === 'p1')).toBe(true);
    expect(leaveProfilesFor).toHaveBeenCalledWith('a');
    expect(activatePanel).toHaveBeenCalledWith('a', 'p1');
  });

  it('says why and starts nothing when no Pane is there to hold the tab', async () => {
    useNavigationStore.setState({ profilesReturn: { view: 'sessions', projectId: null, paneId: null } });
    await expect(openSubagentTab(link('launch'))).resolves.toBe('Pane didn’t open Planner: no Pane is open to put its tab in. Open a Pane, then come back to Profiles and try again.');
    expect(createPanel).not.toHaveBeenCalled();
    expect(leaveProfilesFor).not.toHaveBeenCalled();
  });

  it('says what failed and stays on Profiles when the tab cannot be made', async () => {
    createPanel.mockRejectedValue(new Error('Session not found.'));
    await expect(openSubagentTab(link('launch'))).resolves.toBe('Pane didn’t open Planner in Pane a: Session not found. Nothing was started; try again, or run agent-farm run greenfield/planner --agent-only in a terminal tab.');
    expect(leaveProfilesFor).not.toHaveBeenCalled();
  });

  it('opens nothing with Profiles off (D-474) or for an agent inside its parent', async () => {
    // SAFETY: the module reads only sessionProfilesEnabled.
    useConfigStore.setState({ config: { sessionProfilesEnabled: false } as AppConfig });
    await expect(openSubagentTab(link('launch'))).resolves.toMatch(/^Turn on Profiles/);
    // SAFETY: as above.
    useConfigStore.setState({ config: { sessionProfilesEnabled: true } as AppConfig });
    await expect(openSubagentTab(link('native'))).resolves.toBe('Planner runs inside its parent, so it has no tab of its own.');
    expect(createPanel).not.toHaveBeenCalled();
  });
});
