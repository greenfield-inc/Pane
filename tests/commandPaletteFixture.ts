// Shared by command-palette.spec.ts and command-palette.speed.spec.ts.
import { expect, type Page } from '@playwright/test';
import { installElectronApiMock, type ElectronApiMockOptions, gotoApp } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const PROJECTS: JsonObject[] = [
  { id: 1, name: 'Pane', path: '/code/Pane', active: true },
  { id: 2, name: 'experiments', path: '/code/experiments', active: false },
  { id: 3, name: 'bloom-mono', path: '/code/bloom-mono', active: false },
  { id: 4, name: 'pane-agent-orchestration-benchmark', path: '/code/benchmark', active: false },
];

function pane(id: string, name: string, projectId: number, extra: JsonObject = {}): JsonObject {
  return {
    id, name, projectId,
    worktreePath: `/code/worktrees/${name}`,
    prompt: '', status: 'ready', createdAt: ago(9000), output: [], jsonMessages: [],
    isRunning: false, archived: false, isHidden: false, worktreeOwnership: 'pane',
    ...extra,
  };
}

export const PANES: JsonObject[] = [
  pane('p-posthog', 'pane posthog', 1, { isFavorite: true, favoritePinnedAt: ago(9000), lastViewedAt: ago(2880) }),
  pane('p-film', 'pane-workspaces-film', 2, { lastViewedAt: ago(3000) }),
  pane('p-wsl', 'wsl-runpane', 1, {
    lastViewedAt: ago(60),
    gitStatus: { state: 'ahead', prNumber: 1105, prTitle: 'Make runpane work in Pane’s WSL terminals', prUrl: 'https://github.com/greenfield-inc/Pane/pull/1105' },
  }),
  pane('p-update', 'runpane-update-fix', 1, { lastViewedAt: ago(1) }),
  pane('p-polish', 'ui-polish-app', 3, { lastViewedAt: ago(5), worktreePath: '/code/worktrees/polish-branch' }),
  pane('p-dictate', 'dictate-in-pane', 2, { lastViewedAt: ago(300) }),
  pane('p-spotlight', 'spotlight-search', 1, { lastViewedAt: ago(0) }),
  ...['loops', 'mission-control', 'pane-chat-skills', 'pane-mobile', 'pane-tunnels'].map((name, index) =>
    pane(`p-extra-${index}`, name, 1, { lastViewedAt: ago(4000 + index) })),
];

function orchestrationSession(id: string, name: string, minutesAgo: number, paneIds: string[]) {
  const at = ago(minutesAgo);
  return {
    id, name, agent: 'claude', archived: false, isPinned: false,
    internalSessionId: `${id}-terminal`,
    panelIds: { claude: `${id}-claude`, codex: `${id}-codex`, cursor: `${id}-cursor` },
    goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
    associations: paneIds.map(paneId => ({ paneId, panelIds: [], attachedAt: at })),
    activity: [], revision: 1, createdAt: ago(9000), updatedAt: at,
  };
}

const SESSIONS = [
  orchestrationSession('s-contrib', 'pane contributors', 0, ['p-spotlight']),
  orchestrationSession('s-ui', 'Pane UI', 120, ['p-film', 'p-wsl', 'p-update']),
  orchestrationSession('s-posthog', 'pane posthog', 2880, ['p-posthog']),
];

export type AgentStatusFixture = { sessionId: string; panelId: string; state: 'blocked' | 'working' | 'idle' };

export async function boot(page: Page, options: ElectronApiMockOptions & { activePaneId?: string; panes?: JsonObject[]; agentStatuses?: AgentStatusFixture[] } = {}) {
  const { activePaneId = 'p-spotlight', panes = PANES, agentStatuses = [], ...mockOptions } = options;
  await installElectronApiMock(page, {
    initialProjects: PROJECTS,
    initialSessions: panes,
    initialUiState: { expandedProjects: [1, 2, 3, 4] },
    ...mockOptions,
  });
  await page.addInitScript(({ sessions, agentStatuses }) => {
    // The host's agent-status baseline, read once at startup.
    const originalInvoke = window.electronAPI.invoke;
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => channel === 'panels:agent-statuses'
      ? Promise.resolve({ success: true, data: agentStatuses })
      : originalInvoke(channel, ...args);
    const archived = new Set<string>();
    const view = () => sessions.map(session => ({ ...session, archived: archived.has(session.id) }));
    Object.assign(window.electronAPI, {
      orchestrationSessions: {
        ...window.electronAPI.orchestrationSessions,
        list: async () => ({ success: true, data: { sessions: view(), selectedSessionId: undefined } }),
        select: async ({ sessionId }: { sessionId: string }) => ({ success: true, data: { sessions: view(), selectedSessionId: sessionId } }),
        update: async ({ sessionId }: { sessionId: string }, update: { archived?: boolean }) => {
          if (update.archived) archived.add(sessionId);
          return { success: true, data: view().find(session => session.id === sessionId) };
        },
      },
    });
  }, { sessions: SESSIONS, agentStatuses });
  await gotoApp(page);
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  if (activePaneId) {
    await page.getByRole('button', { name: 'spotlight-search', exact: true }).first().click();
    await expect(page.locator('[aria-current="page"][aria-label="spotlight-search"]').first()).toBeVisible();
  }
}

export async function openSearch(page: Page) {
  await page.keyboard.press('ControlOrMeta+Shift+P');
  const input = page.getByRole('combobox', { name: 'Search', exact: true });
  await expect(input).toBeFocused();
  return input;
}

export const results = (page: Page) => page.getByRole('listbox', { name: 'Results' });

export const selectedOption = (page: Page) => page.locator('[role="option"][aria-selected="true"]');

// 2,500 bulk Panes plus the usual fixtures, each with one tracked agent panel (a third of them blocked).
export async function bootLarge(page: Page) {
  const many = Array.from({ length: 2_500 }, (_, index) =>
    pane(`p-bulk-${index}`, `bulk-${['runpane', 'posthog', 'wsl', 'film', 'loops'][index % 5]}-${index}`, 1 + (index % 4), { lastViewedAt: ago(index) }));
  const panes = [...PANES, ...many];
  // One tracked agent panel per Pane, a third of them blocked.
  const agentStatuses = panes.map((item, index): AgentStatusFixture => ({
    sessionId: String(item.id), panelId: `panel-${String(item.id)}`, state: index % 3 ? 'idle' : 'blocked',
  }));
  // Projects stay collapsed: this measures Search, not the sidebar's own rows.
  await boot(page, { panes, agentStatuses, activePaneId: '', initialUiState: { expandedProjects: [] } });
}
