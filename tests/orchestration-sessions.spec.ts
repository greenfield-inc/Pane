import type { CustomCommandResume } from '../shared/types/customCommandResume';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import type { PanelActivationRequest, PanelLayoutNode, SessionPanelLayout, ToolPanel } from '../shared/types/panels';
import type { TailnetMachine, TailnetMachineList } from '../shared/types/workspaceAccess';

type UiAssociationFixture = {
  paneId: string;
  panelIds: string[];
  attachedAt: string;
};

type UiPaneOverviewFixture = {
  paneId: string;
  name: string;
  branch?: string;
  archived: boolean;
  missing: boolean;
  panels: Array<{
    panelId: string;
    title: string;
    state: 'blocked' | 'working' | 'idle' | 'unknown';
    initialized: boolean;
    missing?: boolean;
  }>;
  git?: {
    state: string;
    hasUncommittedChanges?: boolean;
  };
};

type UiSessionFixture = {
  runtime?: 'windows' | 'wsl';
  wslDistribution?: string;
  id: string;
  name: string;
  agent: 'claude' | 'codex' | 'cursor';
  launchCommand?: string;
  customResume?: CustomCommandResume | null;
  profile?: string;
  internalSessionId: string;
  panelIds: Record<'claude' | 'codex' | 'cursor', string>;
  goal: string;
  context: string;
  decisions: string[];
  blockers: string[];
  nextAction: string;
  evidence: [];
  outputs: [];
  associations: UiAssociationFixture[];
  activity: Array<{
    id: string;
    kind: 'created' | 'updated';
    message: string;
    at: string;
    source: 'user' | 'system';
  }>;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  isPinned: boolean;
};

type SessionFixtureOptions = {
  projects?: JsonObject[];
  activeProjectId?: number;
  distributions?: string[];
  listDelayMs?: number;
  getDelayMs?: number;
  overviewPanes?: Record<string, UiPaneOverviewFixture[]>;
  defaultOrchestratorAgent?: UiSessionFixture['agent'];
  initialConfig?: JsonObject;
  rememberPaneLayouts?: boolean;
  tailnetMachines?: TailnetMachineList;
};

function sessionFixture(
  id: string,
  name: string,
  goal: string,
  context: string,
  createdAt: string,
  associations: UiAssociationFixture[] = [],
  archived = false,
  isPinned = false,
): UiSessionFixture {
  const panelIds = {
    claude: `__orchestration_panel_${id}_claude`,
    codex: `__orchestration_panel_${id}_codex`,
    cursor: `__orchestration_panel_${id}_cursor`,
  } as const;
  return {
    id,
    name,
    agent: 'claude',
    internalSessionId: `__orchestration_session_${id}terminal__`,
    panelIds,
    goal,
    context,
    decisions: [],
    blockers: [],
    nextAction: 'Review the context.',
    evidence: [],
    outputs: [],
    associations,
    activity: [{
      id: `${id}-created`,
      kind: 'created',
      message: `Created Session “${name}”.`,
      at: createdAt,
      source: 'system',
    }],
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    archived,
    isPinned,
  };
}

function paneFixture(
  id: string,
  name: string,
  isFavorite = false,
): JsonObject {
  const pane: JsonObject = {
    id,
    name,
    worktreePath: `/tmp/${id}`,
    prompt: `Work for ${name}`,
    status: 'ready',
    createdAt: '2026-09-16T12:00:00.000Z',
    lastActivity: '2026-09-16T12:00:00.000Z',
    output: [],
    jsonMessages: [],
    isRunning: false,
    projectId: 1,
    isFavorite,
    worktreeOwnership: 'pane',
    archived: false,
    isHidden: false,
    gitStatus: {
      state: 'modified',
      additions: 17,
      deletions: 2,
    },
  };
  if (isFavorite) pane.favoritePinnedAt = '2026-09-16T12:02:00.000Z';
  return pane;
}

async function installSessionsFixture(
  page: Page,
  initialSessions: UiSessionFixture[],
  paneSessions: JsonObject[] = [],
  fixtureOptions: SessionFixtureOptions = {},
): Promise<void> {
  await installElectronApiMock(page, {
    initialConfig: { defaultOrchestratorAgent: fixtureOptions.defaultOrchestratorAgent ?? 'claude', ...fixtureOptions.initialConfig },
    initialProjects: fixtureOptions.projects ?? [{ id: 1, name: 'Pane fixtures', path: '/tmp/pane-fixtures', active: true }],
    activeProjectId: fixtureOptions.activeProjectId,
    initialSessions: paneSessions,
    rememberPaneLayouts: fixtureOptions.rememberPaneLayouts,
    tailnetMachines: fixtureOptions.tailnetMachines,
  });
  await page.addInitScript(({ seed, listDelayMs, getDelayMs, overviewPanes, distributions }: { seed: UiSessionFixture[]; listDelayMs: number; getDelayMs: number; overviewPanes: Record<string, UiPaneOverviewFixture[]>; distributions: string[] }) => {
    type SessionRecord = UiSessionFixture;
    type Selector = { sessionId?: string; name?: string };
    type Update = Partial<Pick<SessionRecord, 'name' | 'goal' | 'context' | 'decisions' | 'blockers' | 'nextAction' | 'archived' | 'isPinned' | 'launchCommand' | 'profile' | 'customResume'>> & { expectedRevision?: number };
    type Response<Value> = { success: true; data: Value };

    const clone = <Value>(value: Value): Value => structuredClone(value);
    const success = <Value>(data: Value): Response<Value> => ({ success: true, data });
    const now = new Date(0).toISOString();
    const storageKey = '__pane_test_orchestration_sessions__';
    type StoredState = {
      sessions: UiSessionFixture[];
      selectedSessionId?: string;
      nextId: number;
    };
    const readStoredState = (): StoredState | undefined => {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return undefined;
      try {
        // SAFETY: Only this fixture writes the test-specific localStorage key, using StoredState below.
        return JSON.parse(raw) as StoredState;
      } catch {
        return undefined;
      }
    };
    const storedState = readStoredState();
    let sessions = clone(storedState?.sessions ?? seed);
    let selectedSessionId = storedState?.selectedSessionId && sessions.some(session => session.id === storedState.selectedSessionId)
      ? storedState.selectedSessionId
      : sessions.find(session => !session.archived)?.id;
    let nextId = storedState?.nextId ?? 1;
    const persistState = () => {
      window.localStorage.setItem(storageKey, JSON.stringify({ sessions, selectedSessionId, nextId } satisfies StoredState));
    };
    let currentListDelayMs = listDelayMs;
    let currentGetDelayMs = getDelayMs;
    let heldLists: Promise<void> | null = null;
    let releaseHeldLists = () => {};
    let selectCalls = 0;
    const selectedIds: string[] = [];
    let overviewCalls = 0;
    let nextOrchestrationUpdateError: string | null = null;
    // A failed answer, or a thrown error the way an older host's refusal reaches the renderer.
    let nextReorderFailure: { message: string; thrown: boolean } | null = null;
    const reorderCalls: string[][] = [];
    let nextMembershipRejection: string | null = null;
    const rejectPendingMembership = () => {
      if (nextMembershipRejection === null) return;
      const failure = nextMembershipRejection;
      nextMembershipRejection = null;
      throw new Error(failure);
    };
    const viewRequests: Array<{ sessionId: string; agent: SessionRecord['agent']; panelId: string }> = [];

    const find = (selector: Selector): SessionRecord => {
      const session = sessions.find(candidate =>
        (selector.sessionId ? candidate.id === selector.sessionId : true)
        && (selector.name ? candidate.name === selector.name : true),
      ) ?? (selector.sessionId ? sessions.find(candidate => candidate.name === selector.sessionId) : undefined);
      if (!session) throw new Error(`Session ${selector.sessionId ?? selector.name} not found`);
      return session;
    };
    const view = (record: SessionRecord) => ({
      session: clone(record),
      internalSession: {
        id: record.internalSessionId,
        name: record.name,
        worktreePath: '/tmp/issue-653-session-fixture',
        prompt: record.goal,
        status: 'stopped',
        createdAt: record.createdAt,
        lastActivity: record.updatedAt,
        output: [`Conversation history for ${record.name}`],
        jsonMessages: [],
        isRunning: false,
        permissionMode: 'ignore',
        toolType: 'none',
        archived: false,
        isHidden: true,
      },
      panel: {
        id: record.panelIds[record.agent],
        sessionId: record.internalSessionId,
        type: 'terminal',
        title: `${record.name} · ${record.agent}`,
        state: {
          isActive: true,
          hasBeenViewed: true,
          customState: {
            agentType: record.agent,
            isCliPanel: true,
            isInitialized: false,
            initialCommand: record.agent === 'claude' ? 'claude --dangerously-skip-permissions' : 'codex --yolo',
          },
        },
        metadata: { createdAt: record.createdAt, lastActiveAt: record.updatedAt, position: 0, permanent: true },
      },
      agent: record.agent,
      cwd: '/tmp/issue-653-session-fixture',
      guidePath: '/tmp/issue-653-session-fixture/guide.md',
      started: false,
    });
    const changed = (kind = 'updated', selectionChanged = false) => {
      const detail = { sessionId: selectedSessionId, kind, selectionChanged };
      return window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail }));
    };

    const api = {
      runtimes: async () => success({ distributions }),
      list: async () => {
        const selected = selectedSessionId && sessions.find(session => session.id === selectedSessionId && !session.archived)
          ? selectedSessionId
          : undefined;
        const snapshot = { sessions: clone(sessions), selectedSessionId: selected };
        if (heldLists) await heldLists;
        if (currentListDelayMs > 0) await new Promise(resolve => setTimeout(resolve, currentListDelayMs));
        return success(snapshot);
      },
      select: async (selector: Selector) => {
        selectCalls += 1;
        const record = find(selector);
        selectedIds.push(record.id);
        if (record.archived) return { success: false, error: 'Archived Sessions cannot be opened' };
        selectedSessionId = record.id;
        persistState();
        changed('selected');
        return success({ sessions: clone(sessions), selectedSessionId });
      },
      create: async (input: { name: string; goal?: string; context?: string; agent?: SessionRecord['agent']; launchCommand?: string; profile?: string; customResume?: CustomCommandResume | null; runtime?: 'windows' | 'wsl'; wslDistribution?: string; isPinned?: boolean }) => {
        const id = `created-session-${nextId++}`;
        const record: SessionRecord = {
          id,
          name: input.name,
          runtime: input.runtime,
          wslDistribution: input.wslDistribution,
          agent: input.agent ?? 'claude',
          launchCommand: input.launchCommand,
          customResume: input.customResume,
          profile: input.profile,
          internalSessionId: `__orchestration_session_${id}terminal__`,
          panelIds: {
            claude: `__orchestration_panel_${id}_claude`,
            codex: `__orchestration_panel_${id}_codex`,
            cursor: `__orchestration_panel_${id}_cursor`,
          },
          goal: input.goal ?? '',
          context: input.context ?? '',
          decisions: [],
          blockers: [],
          nextAction: 'Review the context.',
          evidence: [],
          outputs: [],
          associations: [],
          activity: [{ id: `${id}-created`, kind: 'created', message: `Created Session “${input.name}”.`, at: now, source: 'system' }],
          revision: 1,
          createdAt: now,
          updatedAt: now,
          archived: false,
          isPinned: input.isPinned ?? false,
        };
        sessions = [...sessions, record];
        selectedSessionId = id;
        persistState();
        changed();
        return success(view(record));
      },
      get: async (selector: Selector) => {
        const record = find(selector);
        viewRequests.push({ sessionId: record.id, agent: record.agent, panelId: record.panelIds[record.agent] });
        if (currentGetDelayMs > 0) await new Promise(resolve => setTimeout(resolve, currentGetDelayMs));
        return success(view(record));
      },
      update: async (selector: Selector, input: Update) => {
        if (nextOrchestrationUpdateError) {
          const failure = nextOrchestrationUpdateError;
          nextOrchestrationUpdateError = null;
          return { success: false, error: failure };
        }
        const record = find(selector);
        if (input.expectedRevision !== undefined && input.expectedRevision !== record.revision) {
          return { success: false, error: 'Session changed while saving the overview' };
        }
        const previousSelectedSessionId = selectedSessionId;
        Object.assign(record, {
          name: input.name?.trim() ?? record.name,
          goal: input.goal?.trim() ?? record.goal,
          context: input.context?.trim() ?? record.context,
          decisions: input.decisions ? [...input.decisions] : record.decisions,
          blockers: input.blockers ? [...input.blockers] : record.blockers,
          nextAction: input.nextAction?.trim() ?? record.nextAction,
          archived: input.archived ?? record.archived,
          isPinned: input.isPinned ?? record.isPinned,
          launchCommand: input.launchCommand ?? record.launchCommand,
          customResume: input.customResume !== undefined ? input.customResume : record.customResume,
          profile: input.profile ?? record.profile,
          revision: record.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        record.activity = [...record.activity, {
          id: `${record.id}-updated-${record.revision}`,
          kind: 'updated',
          message: 'Updated Session context.',
          at: record.updatedAt,
          source: 'user',
        }];
        if (record.archived && selectedSessionId === record.id) {
          selectedSessionId = sessions.find(candidate => candidate.id !== record.id && !candidate.archived)?.id;
        }
        persistState();
        changed('updated', previousSelectedSessionId !== selectedSessionId);
        return success(clone(record));
      },
      reorder: async (sessionIds: string[]) => {
        reorderCalls.push([...sessionIds]);
        if (nextReorderFailure) {
          const failure = nextReorderFailure;
          nextReorderFailure = null;
          if (failure.thrown) throw new Error(failure.message);
          return { success: false, error: failure.message };
        }
        // Like the host: the listed Sessions trade the places they hold.
        const listed = [...new Set(sessionIds)].filter(id => sessions.some(session => session.id === id));
        const byId = new Map(sessions.map(session => [session.id, session]));
        let next = 0;
        sessions = sessions.map(session => listed.includes(session.id) ? byId.get(listed[next++]) ?? session : session);
        persistState();
        changed('reordered');
        return success({ sessions: clone(sessions), selectedSessionId });
      },
      setAgent: async (selector: Selector, agent: SessionRecord['agent']) => {
        const record = find(selector);
        record.agent = agent;
        record.revision += 1;
        persistState();
        return success(view(record));
      },
      associate: async (selector: Selector, association: { paneId: string; panelIds?: string[] }) => {
        rejectPendingMembership();
        const record = find(selector);
        if (!record.associations.some(candidate => candidate.paneId === association.paneId)) {
          record.associations.push({
            paneId: association.paneId,
            panelIds: association.panelIds ?? [],
            attachedAt: new Date().toISOString(),
          });
          persistState();
          changed();
        }
        return success(clone(record));
      },
      detach: async (selector: Selector, paneId?: string) => {
        rejectPendingMembership();
        const record = find(selector);
        record.associations = paneId
          ? record.associations.filter(association => association.paneId !== paneId)
          : [];
        persistState();
        changed();
        return success(clone(record));
      },
      overview: async (selector: Selector) => {
        const record = find(selector);
        overviewCalls += 1;
        return success({ session: clone(record), status: 'unassociated', panes: clone(overviewPanes[record.id] ?? []), activity: clone(record.activity), refreshedAt: new Date().toISOString() });
      },
    };

    Object.assign(window.electronAPI, { orchestrationSessions: api });
    Object.assign(window.__paneTestElectronMock, {
      setOrchestrationListDelay: (delayMs: number) => { currentListDelayMs = delayMs; },
      setOrchestrationGetDelay: (delayMs: number) => { currentGetDelayMs = delayMs; },
      // Holds every list answer, taken from the Sessions at call time, until release.
      holdOrchestrationLists: () => { heldLists = new Promise(resolve => { releaseHeldLists = resolve; }); },
      releaseOrchestrationLists: () => { heldLists = null; releaseHeldLists(); },
      getOrchestrationSelectCalls: () => selectCalls,
      getOrchestrationSelectedIds: () => [...selectedIds],
      getOrchestrationViewRequests: () => clone(viewRequests),
      getOrchestrationOverviewCalls: () => overviewCalls,
      setOrchestrationOverviewPanes: (sessionId: string, panes: UiPaneOverviewFixture[]) => {
        overviewPanes[sessionId] = clone(panes);
      },
      setExternalOrchestrationAgent: (agent: SessionRecord['agent'], sessionId = selectedSessionId) => {
        if (!sessionId) throw new Error('No Session is selected');
        const record = find({ sessionId });
        record.agent = agent;
        record.revision += 1;
        record.updatedAt = new Date().toISOString();
        window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { sessionId, kind: 'updated' } }));
      },
      emitOrchestrationChanged: (kind = 'updated') => window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { sessionId: selectedSessionId, kind } })),
      getOrchestrationSelectedSessionId: () => selectedSessionId,
      getOrchestrationRecord: (sessionId: string) => clone(sessions.find(session => session.id === sessionId) ?? null),
      failNextOrchestrationUpdate: (message: string) => { nextOrchestrationUpdateError = message; },
      failNextOrchestrationReorder: (message: string, thrown = false) => { nextReorderFailure = { message, thrown }; },
      getOrchestrationReorderCalls: () => clone(reorderCalls),
      // Stands in for a lost transport: the next associate or detach rejects instead of answering.
      rejectNextOrchestrationMembership: (message: string) => { nextMembershipRejection = message; },
      // Stands in for another host's Sessions: the list changes without an event.
      replaceOrchestrationSessions: (next: SessionRecord[]) => {
        sessions = clone(next);
        selectedSessionId = sessions.find(session => !session.archived)?.id;
      },
    });
  }, { seed: initialSessions, listDelayMs: fixtureOptions.listDelayMs ?? 0, getDelayMs: fixtureOptions.getDelayMs ?? 0, overviewPanes: fixtureOptions.overviewPanes ?? {}, distributions: fixtureOptions.distributions ?? [] });
}

async function dismissStartupDialogs(page: Page): Promise<void> {
  const analyticsDecline = page.getByRole('button', { name: 'No thanks' });
  if (await analyticsDecline.isVisible({ timeout: 3000 }).catch(() => false)) await analyticsDecline.click();
  const getStarted = page.getByRole('button', { name: 'Get Started' });
  if (await getStarted.isVisible({ timeout: 2000 }).catch(() => false)) await getStarted.click();
}

async function layoutBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Expected layout target to be visible');
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

for (const theme of ['light', 'night-owl']) {
  for (const compact of [false, true]) {
    test(`sidebar actions remain reachable while scrolling (${theme}, compact: ${compact})`, async ({ page }) => {
      await page.setViewportSize({ width: 1200, height: 800 });
      await installSessionsFixture(page, Array.from({ length: 30 }, (_, i) =>
        sessionFixture(`scroll-${i}`, `Session ${i + 1}`, '', '', '2026-01-01T00:00:00.000Z'),
      ), [], {
        projects: Array.from({ length: 30 }, (_, i) => ({
          id: i + 1, name: `Project ${i + 1}`, path: `/tmp/project-${i}`,
          active: i === 0, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
        })),
        activeProjectId: 1,
        initialConfig: { theme },
      });
      await page.goto('/');
      await dismissStartupDialogs(page);
      await expect(page.getByTestId('sessions-section-header')).toBeVisible();
      if (compact) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      const sidebar = page.getByTestId('sidebar');
      const creation = compact
        ? page.getByTestId('compact-new-orchestration-session')
        : page.getByTestId('new-orchestration-session');
      // The rail has no per-project create button; its footer keeps More.
      const stickyAction = compact
        ? page.getByRole('button', { name: 'More', exact: true })
        : page.getByTestId('new-project');
      const reachable = async (control: Locator) => {
        await expect.poll(() => control.evaluate(element => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })).toBe(true);
      };
      for (const fraction of [0, 0.5, 1]) {
        await sidebar.evaluate((element, progress) => {
          const scrollers = [...element.querySelectorAll<HTMLElement>('*')].filter(node =>
            getComputedStyle(node).overflowY === 'auto' && node.scrollHeight > node.clientHeight,
          );
          if (scrollers.length !== 1) throw new Error(`Expected one scrolling list, got ${scrollers.length}`);
          scrollers[0].scrollTop = (scrollers[0].scrollHeight - scrollers[0].clientHeight) * progress;
        }, fraction);
        await page.screenshot({ path: `tmp/verify/sidebar-sticky/${theme}-${compact ? 'rail' : 'expanded'}-${fraction}.png` });
        await reachable(page.getByRole('button', { name: 'New', exact: true }));
        await reachable(creation);
        await reachable(stickyAction);
        if (compact) {
          await reachable(page.getByRole('button', { name: 'Expand sidebar', exact: true }));
          await reachable(page.getByRole('button', { name: 'Settings', exact: true }));
        }
      }
      await creation.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(creation).toBeFocused();
      await expect(creation).toHaveCSS('outline-width', '2px');
      await reachable(creation);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Create Session', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await creation.focus();
      // Traverse the long list in both directions: a visible focus ring must
      // never land underneath either pinned header.
      for (const key of ['Tab', 'Shift+Tab']) {
        for (let i = 0; i < 65; i++) {
          await page.keyboard.press(key);
          const focused = sidebar.locator(':focus');
          if (await focused.count()) await reachable(focused);
        }
      }
      const projectsToggle = compact
        ? page.getByTestId('compact-repositories-toggle')
        : page.getByRole('button', { name: 'Projects', exact: true });
      await projectsToggle.click();
      await reachable(stickyAction);
      if (!compact) {
        await expect(sidebar.getByText('Project 30', { exact: true })).toHaveCount(0);
      }
      await projectsToggle.click();
      await reachable(stickyAction);
    });
  }
}

test('empty and folded sidebar sections keep their actions beside the headings', async ({ page }) => {
  await installSessionsFixture(page, []);
  await page.goto('/');
  await dismissStartupDialogs(page);
  const sessions = page.getByTestId('sessions-section-header');
  const projects = page.getByRole('button', { name: 'Projects', exact: true });
  await expect(sessions).toBeVisible();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await projects.click();
    const sessionBox = await layoutBox(sessions);
    const projectBox = await layoutBox(projects);
    expect(projectBox.y).toBeGreaterThanOrEqual(sessionBox.y + sessionBox.height);
    expect(projectBox.y).toBeLessThan(sessionBox.y + sessionBox.height + 24);
    await expect(page.getByTestId('new-orchestration-session')).toBeInViewport();
    await expect(page.getByTestId('new-project')).toBeInViewport();
  }
});

test('Session runtime defaults to Windows and submits the selected installed distribution', async ({ page }) => {
  await installSessionsFixture(page, [], [], { distributions: ['Ubuntu-24.04', 'Debian'] });
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  const runtime = page.getByLabel('Run agent in');
  await expect(runtime).toHaveValue('');
  await runtime.selectOption('Ubuntu-24.04');
  await page.getByLabel('Session name (optional)', { exact: true }).fill('WSL planning');
  await page.screenshot({ path: 'tmp/verify/session-runtime/01-wsl-create.png' });
  await page.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'WSL planning', exact: true })).toBeAttached();
  const result = await page.evaluate(() => window.electronAPI.orchestrationSessions.list());
  expect(result.data?.sessions.find(session => session.name === 'WSL planning')).toMatchObject({ runtime: 'wsl', wslDistribution: 'Ubuntu-24.04' });
});

test('Session runtime is hidden when the host offers no WSL distributions', async ({ page }) => {
  await installSessionsFixture(page, []);
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  await expect(page.getByLabel('Run agent in')).toHaveCount(0);
});

test('selecting WSL restores a Cursor default while preserving an explicit agent choice', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' });
  });
  await installSessionsFixture(page, [], [], { distributions: ['Ubuntu-24.04'], defaultOrchestratorAgent: 'cursor' });
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  await expect(page.getByRole('radio', { name: 'Cursor', exact: true })).toHaveCount(0);
  const runtime = page.getByLabel('Run agent in');
  await runtime.selectOption('Ubuntu-24.04');
  await expect(page.getByRole('radio', { name: 'Cursor', exact: true })).toBeChecked();
  await page.getByTestId('create-session-agent-codex').click();
  await runtime.selectOption('');
  await runtime.selectOption('Ubuntu-24.04');
  await expect(page.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
});

test('Sessions create, rename, switch, and keep chat surfaces focused', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('roadmap', 'Roadmap', 'Plan the next release.', 'Roadmap context stays here.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('onboarding', 'Onboarding', 'Improve onboarding.', 'Onboarding context stays here.', '2026-09-16T12:01:00.000Z'),
    sessionFixture('existing-new-chat', 'new chat', '', '', '2026-09-16T12:02:00.000Z'),
    sessionFixture('existing-new-chat-2', ' NEW CHAT 2 ', '', '', '2026-09-16T12:03:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await expect(page.getByTestId('sessions-section-header')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('orchestration-session-roadmap').click();
  await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Show details', exact: true })).toBeVisible();
  await expect(page.getByText('Roadmap context stays here.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  const roadmapOverview = page.getByRole('complementary', { name: 'Session overview', exact: true });
  await expect(roadmapOverview.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
  await expect(roadmapOverview.getByRole('heading', { name: 'Associated Panes', exact: true })).toBeVisible();
  await expect(roadmapOverview.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(roadmapOverview.getByText('Created Session “Roadmap”.', { exact: true })).toBeVisible();
  await expect(roadmapOverview.getByRole('heading', { name: 'Goal', exact: true })).toBeVisible();
  await expect(roadmapOverview.getByText('Plan the next release.', { exact: true })).toBeVisible();
  for (const label of ['Context', 'Decisions', 'Blockers', 'Next action', 'Evidence and outputs']) {
    await expect(roadmapOverview.getByText(label, { exact: true })).toHaveCount(0);
  }

  await page.getByTestId('new-orchestration-session').click();
  const createDialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  await expect(createDialog.getByRole('heading', { name: 'Create Session', exact: true })).toBeVisible();
  await expect(createDialog.getByLabel('Session name (optional)', { exact: true })).toHaveValue('');
  await expect(createDialog.getByLabel('Goal', { exact: true })).toHaveCount(0);
  await expect(createDialog.getByLabel('Context', { exact: true })).toHaveCount(0);
  await expect(createDialog.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();
  await createDialog.getByTestId('create-session-agent-codex').click();
  await expect(createDialog.getByRole('button', { name: 'Create Session', exact: true })).toBeInViewport();
  await expect(createDialog.getByLabel('Session behavior profile')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/pane-session-create-compact.png' });
  await expect(createDialog.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
  await createDialog.getByRole('button', { name: 'Create Session', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'New chat 3', exact: true })).toBeAttached();
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveCount(0);
  const configUpdates = await page.evaluate(() => {
    // SAFETY: installElectronApiMock installs this controller before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getConfigUpdates: () => JsonObject[] } };
    return mockWindow.__paneTestElectronMock.getConfigUpdates();
  });
  expect(configUpdates).toContainEqual({ defaultOrchestratorAgent: 'codex' });
  await expect(page.getByText('Roadmap context stays here.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show details', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  await page.getByRole('button', { name: 'Rename Session' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Release checklist renamed');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Release checklist renamed', exact: true, level: 1 })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Open Session Release checklist renamed', exact: true })).toBeVisible();

  await page.getByTestId('new-orchestration-session').click();
  const namedCreateDialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  await namedCreateDialog.getByLabel('Session name (optional)', { exact: true }).fill('  Custom named chat  ');
  await expect(namedCreateDialog.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
  await namedCreateDialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Custom named chat', exact: true })).toBeAttached();
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveCount(0);

  await page.getByRole('button', { name: 'Open Session Onboarding', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Onboarding', exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  const onboardingOverview = page.getByRole('complementary', { name: 'Session overview', exact: true });
  await expect(onboardingOverview.getByRole('heading', { name: 'Onboarding', exact: true })).toBeVisible();
  await expect(onboardingOverview.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(onboardingOverview.getByText('Onboarding context stays here.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Checklist context stays here.', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open Session Release checklist renamed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Release checklist renamed', exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  await expect(page.getByText('Checklist context stays here.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Onboarding context stays here.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('Session creation agent picker supports native radio keyboard semantics', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Linux' });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('keyboard', 'Keyboard chat', 'Keyboard goal.', 'Keyboard context.', '2026-09-16T12:00:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await page.getByTestId('new-orchestration-session').click();
  const dialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  const radios = dialog.getByRole('radio');
  await expect(radios).toHaveCount(3);
  await expect(dialog.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();

  await radios.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.nth(1)).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(radios.nth(2)).toBeFocused();
  await expect(radios.nth(2)).toBeChecked();
  await page.keyboard.press('Space');
  await expect(radios.nth(2)).toBeChecked();
});

test('Session creation hides unsupported Cursor on Windows', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('windows', 'Windows chat', 'Windows goal.', 'Windows context.', '2026-09-16T12:00:00.000Z'),
  ], [], { defaultOrchestratorAgent: 'cursor' });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await page.getByTestId('new-orchestration-session').click();
  const dialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  await expect(dialog.getByRole('radio', { name: 'Cursor', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New chat', exact: true })).toBeAttached();
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveCount(0);
});

test('Session metadata refresh stays quiet and cannot steal a later selection', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  const firstSessionRow = page.getByTestId('orchestration-session-alpha');
  await expect(firstSessionRow).toBeVisible({ timeout: 10_000 });
  await firstSessionRow.click();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeAttached({ timeout: 10_000 });
  const sessionsHeader = page.getByTestId('sessions-section-header');
  const beforeHeaderBox = await layoutBox(sessionsHeader);
  const beforeFirstRowBox = await layoutBox(firstSessionRow);
  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setOrchestrationListDelay: (delayMs: number) => void;
        emitOrchestrationChanged: (kind?: string) => void;
        getOrchestrationSelectCalls: () => number;
      };
    };
    mockWindow.__paneTestElectronMock.setOrchestrationListDelay(50);
    for (let index = 0; index < 10; index += 1) {
      mockWindow.__paneTestElectronMock.emitOrchestrationChanged('updated');
    }
  });
  await page.waitForTimeout(150);
  await expect(page.getByText('Opening Sessions…', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectCalls();
  })).toBe(1);

  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setOrchestrationListDelay: (delayMs: number) => void;
        emitOrchestrationChanged: (kind?: string) => void;
      };
    };
    mockWindow.__paneTestElectronMock.setOrchestrationListDelay(300);
    mockWindow.__paneTestElectronMock.emitOrchestrationChanged('updated');
  });
  await page.getByRole('button', { name: 'Open Session Beta', exact: true }).click();
  // Switching Session no longer reloads the whole list — each tile fetches its
  // own Session — so the sidebar spinner only appears for a refresh already in
  // flight. What matters here is unchanged: the delayed refresh lands without
  // moving the sidebar or stealing the newer selection.
  const loadingStatus = page.getByRole('status', { name: 'Loading Sessions', exact: true });
  expect(await layoutBox(sessionsHeader)).toEqual(beforeHeaderBox);
  expect(await layoutBox(firstSessionRow)).toEqual(beforeFirstRowBox);
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeAttached();
  await page.waitForTimeout(400);
  await expect(loadingStatus).toHaveCount(0);
  expect(await layoutBox(sessionsHeader)).toEqual(beforeHeaderBox);
  expect(await layoutBox(firstSessionRow)).toEqual(beforeFirstRowBox);
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeAttached();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectCalls();
  })).toBe(2);
});

test('Session view follows an external agent switch without selecting again or reloading on event bursts', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  const alphaRow = page.getByTestId('orchestration-session-alpha');
  await expect(alphaRow).toBeVisible({ timeout: 10_000 });
  await alphaRow.click();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeAttached({ timeout: 10_000 });
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveCount(0);
  const initialViewRequests = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: { getOrchestrationViewRequests: () => Array<{ sessionId: string; agent: string; panelId: string }> };
    };
    return mockWindow.__paneTestElectronMock.getOrchestrationViewRequests();
  });
  const initialSelectCalls = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectCalls();
  });

  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setExternalOrchestrationAgent: (agent: 'claude' | 'codex' | 'cursor', sessionId?: string) => void;
      };
    };
    mockWindow.__paneTestElectronMock.setExternalOrchestrationAgent('codex', 'alpha');
  });
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: { getOrchestrationViewRequests: () => Array<{ sessionId: string; agent: string; panelId: string }> };
    };
    return mockWindow.__paneTestElectronMock.getOrchestrationViewRequests().length;
  })).toBe(initialViewRequests.length + 1);
  const switchedViewRequests = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: { getOrchestrationViewRequests: () => Array<{ sessionId: string; agent: string; panelId: string }> };
    };
    return mockWindow.__paneTestElectronMock.getOrchestrationViewRequests();
  });
  expect(switchedViewRequests.at(-1)).toEqual({
    sessionId: 'alpha',
    agent: 'codex',
    panelId: '__orchestration_panel_alpha_codex',
  });
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectCalls();
  })).toBe(initialSelectCalls);

  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: { emitOrchestrationChanged: (kind?: string) => void };
    };
    for (let index = 0; index < 10; index += 1) {
      mockWindow.__paneTestElectronMock.emitOrchestrationChanged('updated');
    }
  });
  await page.waitForTimeout(150);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: { getOrchestrationViewRequests: () => Array<{ sessionId: string; agent: string; panelId: string }> };
    };
    return mockWindow.__paneTestElectronMock.getOrchestrationViewRequests().length;
  })).toBe(initialViewRequests.length + 1);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectCalls();
  })).toBe(initialSelectCalls);
});

test('Sessions group live managed Panes while preserving the focused Pane rows', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture(
      'evolution',
      'Pane evolution',
      'Track the Pane sidebar evolution.',
      'Evolution context.',
      '2026-09-16T12:00:00.000Z',
      [
        { paneId: 'pane-evolution-worker', panelIds: [], attachedAt: '2026-09-16T12:00:00.000Z' },
        { paneId: 'missing-pane', panelIds: [], attachedAt: '2026-09-16T12:00:00.000Z' },
      ],
    ),
    sessionFixture(
      'doozy',
      'Doozy fixes',
      'Track Doozy fixes.',
      'Doozy context.',
      '2026-09-16T12:01:00.000Z',
      [{ paneId: 'pane-doozy-worker', panelIds: [], attachedAt: '2026-09-16T12:01:00.000Z' }],
    ),
  ], [
    paneFixture('pane-evolution-worker', 'Pane/pane chat to session'),
    paneFixture('pane-doozy-worker', 'Pane/managed pane sidebar'),
    paneFixture('pinned-pane', 'Pinned pane', true),
  ], {
    overviewPanes: {
      evolution: [{
        paneId: 'pane-evolution-worker',
        name: 'Pane/pane chat to session',
        branch: 'feature/sidebar',
        archived: false,
        missing: false,
        git: { state: 'dirty', hasUncommittedChanges: true, ahead: 2 },
        panels: [
          { panelId: 'unstarted-terminal', title: 'Unstarted terminal', state: 'unknown', initialized: false },
          { panelId: 'initialized-terminal', title: 'Initialized terminal', state: 'unknown', initialized: true },
          { panelId: 'working-terminal', title: 'Working terminal', state: 'working', initialized: true },
          { panelId: 'missing-terminal', title: 'Missing terminal', state: 'unknown', initialized: false, missing: true },
        ],
      }],
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await expect(page.getByTestId('sessions-section-header')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('usage-nav')).toHaveCount(0);
  const sessionsToggle = page.getByTestId('sessions-section-header').getByRole('button', { name: 'Sessions', exact: true });
  await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'true');
  await sessionsToggle.click();
  await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('orchestration-session-evolution')).toBeHidden();
  await page.getByTestId('new-orchestration-session').click();
  const collapsedCreateDialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  await expect(collapsedCreateDialog.getByRole('heading', { name: 'Create Session', exact: true })).toBeVisible();
  await collapsedCreateDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await sessionsToggle.click();
  await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('orchestration-session-evolution')).toContainText('Pane evolution');
  await expect(page.getByTestId('orchestration-session-evolution')).toContainText('1');
  await expect(page.getByTestId('orchestration-session-doozy')).toContainText('Doozy fixes');
  // Sessions start collapsed until you open them.
  await expect(page.getByRole('button', { name: 'Expand Pane evolution Panes' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Expand Doozy fixes Panes' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Pane/pane chat to session', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pane/managed pane sidebar', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('sidebar').getByRole('group', { name: 'Pinned', exact: true }).getByText('Pinned pane', { exact: true })).toBeVisible();

  const evolutionRow = page.getByTestId('orchestration-session-evolution');
  const childrenToggle = page.getByRole('button', { name: 'Collapse Pane evolution Panes' });
  // Opening a Session's view does not expand it; only its chevron does.
  await evolutionRow.click();
  await expect(page.getByRole('button', { name: 'Expand Pane evolution Panes' })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Expand Pane evolution Panes' }).press('Enter');
  await expect(childrenToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Pane/pane chat to session', exact: true })).toBeVisible();
  await expect(page.getByText('missing-pane', { exact: true })).toHaveCount(0);
  await evolutionRow.click();
  await expect(childrenToggle).toHaveAttribute('aria-expanded', 'true');
  await childrenToggle.click();
  await expect(page.getByRole('button', { name: 'Expand Pane evolution Panes' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Pane/pane chat to session', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Expand Pane evolution Panes' }).click();
  await expect(childrenToggle).toHaveAttribute('aria-expanded', 'true');

  // Expansion choices survive the sidebar switching to the compact rail and back.
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand Doozy fixes Panes' })).toHaveAttribute('aria-expanded', 'false');
  await expect(childrenToggle).toHaveAttribute('aria-expanded', 'true');
  await sessionsToggle.click();
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'false');
  await sessionsToggle.click();

  await expect(page.getByRole('heading', { name: 'Pane evolution', exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  const evolutionOverview = page.getByRole('complementary', { name: 'Session overview', exact: true });
  await expect(evolutionOverview.getByText('Unstarted terminal', { exact: true })).toBeVisible();
  await expect(evolutionOverview.getByText('Initialized terminal', { exact: true })).toBeVisible();
  await expect(evolutionOverview.getByText('Working', { exact: true })).toBeVisible();
  await expect(evolutionOverview.getByText('Missing', { exact: true })).toBeVisible();
  await expect(evolutionOverview.getByText('Unknown', { exact: true })).toHaveCount(0);
  await expect(evolutionOverview.getByText('Not started', { exact: true })).toHaveCount(0);
  await expect(evolutionOverview.getByText('Status unavailable', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  const sessionChanges = page.getByRole('complementary', { name: 'Session changes' });
  await expect(sessionChanges).toContainText('Pane/pane chat to session');
  await expect(sessionChanges).toContainText('Uncommitted changes');
  await expect(sessionChanges).toContainText('2 ahead');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();

  await page.evaluate(async () => {
    await window.electronAPI.orchestrationSessions.update(
      { sessionId: 'evolution' },
      { context: 'Updated evolution context.' },
    );
  });
  await expect(evolutionOverview.getByText('Updated Session context.', { exact: true })).toBeVisible();

  const doozyRow = page.getByTestId('orchestration-session-doozy');
  await doozyRow.click();
  await expect(page.getByRole('heading', { name: 'Doozy fixes', exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Expand Doozy fixes Panes' }).click();
  await page.getByRole('button', { name: 'Pane/managed pane sidebar', exact: true }).click();
  await doozyRow.click();
  await expect(page.getByRole('heading', { name: 'Doozy fixes', exact: true })).toBeAttached();

  await page.evaluate(async () => {
    await window.electronAPI.orchestrationSessions.associate(
      { sessionId: 'evolution' },
      { paneId: 'pinned-pane' },
    );
  });
  await expect(page.getByTestId('orchestration-session-evolution')).toContainText('2');
  await expect(page.locator('#orchestration-session-panes-sessions-evolution').getByRole('button', { name: 'Pinned pane', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Expand project Pane fixtures', exact: true }).click();
  const child = page.locator('#orchestration-session-panes-sessions-doozy').getByRole('button', { name: 'Pane/managed pane sidebar', exact: true });
  const repository = page.locator('#project-sessions-1').getByRole('button', { name: 'Pane/managed pane sidebar', exact: true });
  const selectedRow = (button: typeof child) => button.locator('xpath=ancestor::div[contains(@class,"group/session")][1]');
  await child.click();
  await expect(selectedRow(child)).toHaveClass(/bg-surface-selected/);
  await expect(selectedRow(repository)).not.toHaveClass(/bg-surface-selected/);
  await repository.click();
  await expect(selectedRow(repository)).toHaveClass(/bg-surface-selected/);
  await expect(selectedRow(child)).not.toHaveClass(/bg-surface-selected/);
  await doozyRow.click();
  await expect(selectedRow(repository)).not.toHaveClass(/bg-surface-selected/);
  await expect(selectedRow(child)).not.toHaveClass(/bg-surface-selected/);
});

test('Sessions stay collapsed until you open one, and this computer remembers it per host', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const association = (paneId: string) => [{ paneId, panelIds: [], attachedAt: '2026-09-16T12:00:00.000Z' }];
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z', association('pane-alpha'), false, true),
    sessionFixture('beta', 'Beta', 'Goal.', 'Context.', '2026-09-16T12:01:00.000Z', association('pane-beta')),
    sessionFixture('charlie', 'Charlie', 'Goal.', 'Context.', '2026-09-16T12:02:00.000Z', association('pane-charlie')),
  ], [
    paneFixture('pane-alpha', 'Alpha worker'),
    paneFixture('pane-beta', 'Beta worker'),
    paneFixture('pane-charlie', 'Charlie worker'),
    paneFixture('pane-charlie-new', 'Charlie new worker'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  const pinnedAlpha = page.locator('#orchestration-session-panes-pinned-alpha');
  const listedAlpha = page.locator('#orchestration-session-panes-sessions-alpha');
  const pinnedToggle = page.locator('[aria-controls="orchestration-session-panes-pinned-alpha"]');
  const listedToggle = (name: string) => page.locator(`[aria-controls="orchestration-session-panes-sessions-${name.toLowerCase()}"]`);

  // Collapsed in both lists until opened.
  await expect(listedToggle('Beta')).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
  await expect(listedToggle('Alpha')).toHaveAttribute('aria-expanded', 'false');
  await expect(pinnedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: /^(Alpha|Beta|Charlie) worker$/ })).toHaveCount(0);

  // Opening Alpha under Pinned opens it under Sessions too, and collapsing it there closes both.
  await pinnedToggle.click();
  await expect(pinnedAlpha.getByText('Alpha worker')).toBeVisible();
  await expect(listedAlpha.getByText('Alpha worker')).toBeVisible();
  await listedToggle('Alpha').click();
  await expect(pinnedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Alpha worker', exact: true })).toHaveCount(0);

  // Open Alpha by mouse and Beta by keyboard; a reload keeps both, and Charlie stays collapsed.
  await listedToggle('Alpha').click();
  await listedToggle('Beta').press('Enter');
  await expect(listedToggle('Beta')).toHaveAttribute('aria-expanded', 'true');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissStartupDialogs(page);
  await expect(listedToggle('Alpha')).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  await expect(listedToggle('Beta')).toHaveAttribute('aria-expanded', 'true');
  await expect(listedToggle('Charlie')).toHaveAttribute('aria-expanded', 'false');

  // An agent adding a Pane, runpane focusing it, and a resync leave Charlie collapsed.
  await page.evaluate(async () => {
    await window.electronAPI.orchestrationSessions.associate({ sessionId: 'charlie' }, { paneId: 'pane-charlie-new' });
    // SAFETY: installSessionsFixture and installElectronApiMock add these controls before the app loads.
    const mock = (window as typeof window & { __paneTestElectronMock: {
      emitPaneFocusRequested: (paneId: string) => void;
      emitRemoteDaemonResyncRequested: (event: { hostChanged: boolean }) => void;
    } }).__paneTestElectronMock;
    mock.emitPaneFocusRequested('pane-charlie-new');
    mock.emitRemoteDaemonResyncRequested({ hostChanged: false });
  });
  await expect(page.getByTestId('orchestration-session-charlie')).toContainText('2');
  await expect(page.getByTestId('window-title-bar-label')).toContainText('Charlie new worker');
  await expect(listedToggle('Charlie')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#orchestration-session-panes-sessions-charlie')).toBeHidden();

  // Another host starts collapsed and keeps its own choice; coming back restores this computer's.
  const switchHost = (profileId: string | null) => page.evaluate((id) => {
    // SAFETY: installElectronApiMock adds these controls before the app loads.
    const mock = (window as typeof window & { __paneTestElectronMock: {
      setActiveRemoteProfileId: (profileId: string | null) => void;
      emitRemoteDaemonResyncRequested: (event: { hostChanged: boolean }) => void;
    } }).__paneTestElectronMock;
    mock.setActiveRemoteProfileId(id);
    mock.emitRemoteDaemonResyncRequested({ hostChanged: true });
  }, profileId);
  await switchHost('host-b');
  await expect(listedToggle('Alpha')).toHaveAttribute('aria-expanded', 'false');
  await expect(listedToggle('Beta')).toHaveAttribute('aria-expanded', 'false');
  await listedToggle('Charlie').click();
  await expect(listedToggle('Charlie')).toHaveAttribute('aria-expanded', 'true');
  await switchHost(null);
  await expect(listedToggle('Alpha')).toHaveAttribute('aria-expanded', 'true');
  await expect(listedToggle('Beta')).toHaveAttribute('aria-expanded', 'true');
  await expect(listedToggle('Charlie')).toHaveAttribute('aria-expanded', 'false');
});

test('Session rows show whether their child Panes are working or waiting', async ({ page }) => {
  await installSessionsFixture(page, [
    sessionFixture('activity', 'Activity', '', '', '2026-09-16T12:00:00.000Z', [
      { paneId: 'pane-alpha', panelIds: [], attachedAt: '2026-09-16T12:00:00.000Z' },
      { paneId: 'pane-beta', panelIds: [], attachedAt: '2026-09-16T12:00:00.000Z' },
    ]),
  ], [paneFixture('pane-alpha', 'Alpha pane'), paneFixture('pane-beta', 'Beta pane')]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  const row = page.getByTestId('orchestration-session-activity');
  await expect(row).toContainText('2');
  const emit = (panelId: string, sessionId: string, state: string) => page.evaluate(({ panelId, sessionId, state }) => {
    // SAFETY: installElectronApiMock adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { emitPanelAgentStatus: (panelId: string, sessionId: string, state: string) => void } };
    mockWindow.__paneTestElectronMock.emitPanelAgentStatus(panelId, sessionId, state);
  }, { panelId, sessionId, state });

  await emit('alpha-agent', 'pane-alpha', 'working');
  await emit('beta-agent', 'pane-beta', 'working');
  await expect(row).toContainText('2 working');
  await emit('beta-agent', 'pane-beta', 'blocked');
  await expect(row).toContainText('1 needs input');
  await emit('alpha-agent', 'pane-alpha', 'idle');
  await emit('beta-agent', 'pane-beta', 'idle');
  await expect(row).not.toContainText('working');
  await expect(row).not.toContainText('input');
});

test('a banner explains the folder-trust prompt only while the Session agent shows it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [sessionFixture('alpha', 'Alpha', '', '', '2026-09-16T12:00:00.000Z')]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await page.getByTestId('orchestration-session-alpha').click();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeAttached({ timeout: 10_000 });
  const emit = (state: string, reason: string) => page.evaluate(({ state, reason }) => {
    // SAFETY: installElectronApiMock adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { emitPanelAgentStatus: (panelId: string, sessionId: string, state: string, reason: string) => void } };
    mockWindow.__paneTestElectronMock.emitPanelAgentStatus('__orchestration_panel_alpha_claude', '__orchestration_session_alphaterminal__', state, reason);
  }, { state, reason });
  const banner = page.getByRole('status').filter({ hasText: 'asking whether to trust this folder' });

  await emit('blocked', 'live_selection_menu');
  await expect(banner).toHaveCount(0);
  await emit('blocked', 'workspace_trust_prompt');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('title', /Pane's own folder for this Session's notes/);
  await emit('idle', 'live_prompt_box');
  await expect(banner).toHaveCount(0);
});

test('Sessions can be pinned, persist across reload, and unpin back to the normal list', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  const alphaRow = page.getByTestId('orchestration-session-alpha');
  await expect(alphaRow).toBeVisible({ timeout: 10_000 });
  // A Session without Panes has nothing to expand.
  await expect(page.getByRole('button', { name: /Alpha children/ })).toHaveCount(0);
  await expect(page.locator('#orchestration-session-panes-sessions-alpha')).toHaveCount(0);
  await alphaRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin Session', exact: true }).click();

  const pinnedRow = page.getByTestId('orchestration-pinned-session-alpha');
  await expect(pinnedRow).toBeVisible();
  const sectionOrder = await page.locator('[data-testid="orchestration-pinned-section-header"], [data-testid="sessions-section-header"]').evaluateAll(nodes => (
    nodes.map(node => node.getAttribute('data-testid'))
  ));
  expect(sectionOrder).toEqual(['orchestration-pinned-section-header', 'sessions-section-header']);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationRecord: (sessionId: string) => UiSessionFixture | null } };
    return mockWindow.__paneTestElectronMock.getOrchestrationRecord('alpha')?.isPinned;
  })).toBe(true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(pinnedRow).toBeVisible({ timeout: 10_000 });
  await pinnedRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unpin Session', exact: true }).click();
  await expect(pinnedRow).toHaveCount(0);
  await expect(alphaRow).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationRecord: (sessionId: string) => UiSessionFixture | null } };
    return mockWindow.__paneTestElectronMock.getOrchestrationRecord('alpha')?.isPinned;
  })).toBe(false);
});

test('Start pinned creates the Session pinned and is remembered for the next Session', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installSessionsFixture(page, []);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissStartupDialogs(page);
  const dialog = page.getByRole('dialog', { name: 'Create Session', exact: true });
  const startPinned = dialog.getByRole('switch', { name: 'Start pinned', exact: true });

  await page.getByTestId('new-orchestration-session').click();
  await expect(startPinned).not.toBeChecked();
  await startPinned.click();
  await dialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByTestId('orchestration-pinned-session-created-session-1')).toBeVisible();

  await page.getByTestId('new-orchestration-session').click();
  await expect(startPinned).toBeChecked();
  await startPinned.click();
  await dialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByTestId('orchestration-session-created-session-2')).toBeVisible();
  await expect(page.getByTestId('orchestration-pinned-session-created-session-2')).toHaveCount(0);
});

test('Start pinned starts on when the saved config says so', async ({ page }) => {
  await installSessionsFixture(page, [], [], { initialConfig: { defaultSessionPinned: true } });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  await expect(page.getByRole('dialog', { name: 'Create Session', exact: true }).getByRole('switch', { name: 'Start pinned', exact: true })).toBeChecked();
});

test('switching hosts replaces the Sessions and pinned Sessions in the sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('local-pinned', 'Local pinned', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z', [], false, true),
    sessionFixture('local', 'Local', 'Goal.', 'Context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await expect(page.getByTestId('orchestration-pinned-session-local-pinned')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('orchestration-session-local')).toBeVisible();
  // An archive Undo belongs to the host that archived the Session.
  await page.getByTestId('orchestration-session-local').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive Session', exact: true }).click();
  const undoToast = page.getByRole('status').filter({ hasText: 'Archived Local' });
  await expect(undoToast).toBeVisible();

  await page.evaluate((remoteSessions) => {
    // SAFETY: installSessionsFixture and installElectronApiMock add these controls before the app loads.
    const mock = (window as typeof window & { __paneTestElectronMock: {
      replaceOrchestrationSessions: (sessions: UiSessionFixture[]) => void;
      emitRemoteDaemonResyncRequested: (event: { hostChanged: boolean }) => void;
    } }).__paneTestElectronMock;
    mock.replaceOrchestrationSessions(remoteSessions);
    mock.emitRemoteDaemonResyncRequested({ hostChanged: true });
  }, [
    sessionFixture('remote-pinned', 'Remote pinned', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z', [], false, true),
    sessionFixture('remote', 'Remote', 'Goal.', 'Context.', '2026-09-16T12:01:00.000Z'),
  ]);

  // Gone with the host, well before the toast's own timer would close it.
  await expect(undoToast).toHaveCount(0, { timeout: 2_000 });
  await expect(page.getByTestId('orchestration-pinned-session-remote-pinned')).toBeVisible();
  await expect(page.getByTestId('orchestration-session-remote')).toBeVisible();
  await expect(page.getByTestId('orchestration-pinned-session-local-pinned')).toHaveCount(0);
  await expect(page.getByTestId('orchestration-session-local')).toHaveCount(0);
});

test('an Undo still refreshing when the host changes does not reopen the Session on the new host', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('shared-id', 'Local', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('local-other', 'Local other', 'Goal.', 'Context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  const localRow = page.getByTestId('orchestration-session-shared-id');
  await expect(localRow).toBeVisible({ timeout: 10_000 });
  await localRow.click();
  await expect(page.getByRole('heading', { name: 'Local', exact: true })).toBeAttached({ timeout: 10_000 });
  await localRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive Session', exact: true }).click();
  const home = page.getByRole('heading', { name: 'Preferences', exact: true });
  await expect(home).toBeVisible();

  type HostSwitchMock = {
    holdOrchestrationLists: () => void;
    releaseOrchestrationLists: () => void;
    getOrchestrationSelectedIds: () => string[];
    getOrchestrationRecord: (sessionId: string) => UiSessionFixture | null;
    replaceOrchestrationSessions: (sessions: UiSessionFixture[]) => void;
    emitRemoteDaemonResyncRequested: (event: { hostChanged: boolean }) => void;
  };
  // SAFETY: installSessionsFixture and installElectronApiMock add these controls before the app loads.
  const selectedIds = () => page.evaluate(() => (window as typeof window & { __paneTestElectronMock: HostSwitchMock }).__paneTestElectronMock.getOrchestrationSelectedIds());
  const selectionsBeforeUndo = (await selectedIds()).length;
  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    (window as typeof window & { __paneTestElectronMock: HostSwitchMock }).__paneTestElectronMock.holdOrchestrationLists();
  });
  await page.getByRole('status').filter({ hasText: 'Archived Local' }).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    return (window as typeof window & { __paneTestElectronMock: HostSwitchMock }).__paneTestElectronMock.getOrchestrationRecord('shared-id')?.archived;
  })).toBe(false);

  // The new host has an active Session with the same id, so a stale reopen would land on it.
  await page.evaluate((remoteSessions) => {
    // SAFETY: installSessionsFixture and installElectronApiMock add these controls before the app loads.
    const mock = (window as typeof window & { __paneTestElectronMock: HostSwitchMock }).__paneTestElectronMock;
    mock.replaceOrchestrationSessions(remoteSessions);
    mock.emitRemoteDaemonResyncRequested({ hostChanged: true });
    mock.releaseOrchestrationLists();
  }, [
    sessionFixture('remote', 'Remote', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('shared-id', 'Remote twin', 'Goal.', 'Context.', '2026-09-16T12:01:00.000Z'),
  ]);

  await expect(page.getByTestId('orchestration-session-remote')).toBeVisible();
  await expect(page.getByTestId('orchestration-session-shared-id')).toBeVisible();
  await page.waitForTimeout(500);
  // The app may auto-select another Session; it must never select the restored id on the new host.
  expect((await selectedIds()).slice(selectionsBeforeUndo)).not.toContain('shared-id');
  await expect(home).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Remote twin', exact: true })).toHaveCount(0);
});

test('Undo restores an archived Session without pulling the person off where they went next', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  const alphaRow = page.getByTestId('orchestration-session-alpha');
  await expect(alphaRow).toBeVisible({ timeout: 10_000 });
  await alphaRow.click();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeAttached({ timeout: 10_000 });
  await alphaRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive Session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible();

  await page.getByTestId('orchestration-session-beta').click();
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeAttached();
  await page.getByRole('status').filter({ hasText: 'Archived Alpha' }).getByRole('button', { name: 'Undo', exact: true }).click();

  await expect(page.getByTestId('orchestration-session-alpha')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeAttached();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toHaveCount(0);
});

test('Session rows archive and restore without losing selection or associated Panes', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture(
      'alpha',
      'Alpha',
      'Alpha goal.',
      'Alpha context.',
      '2026-09-16T12:00:00.000Z',
      [{ paneId: 'pane-alpha', panelIds: [], attachedAt: '2026-09-16T12:00:00.000Z' }],
    ),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ], [paneFixture('pane-alpha', 'Associated Alpha Pane')]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  const alphaRow = page.getByTestId('orchestration-session-alpha');
  await expect(alphaRow).toBeVisible({ timeout: 10_000 });
  await alphaRow.click();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeAttached({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Expand Alpha Panes' }).click();
  await expect(page.getByRole('button', { name: 'Associated Alpha Pane', exact: true })).toBeVisible();

  await alphaRow.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Archive Session', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Archive Session', exact: true }).click();

  await expect(alphaRow).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Archived Alpha' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible();
  // Home holds even after the app auto-selects another active Session (Beta) for the chat view.
  await page.waitForTimeout(1_000);
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectedSessionId: () => string | undefined } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectedSessionId();
  })).toBe('beta');

  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  const archivedAlpha = page.getByTestId('archived-orchestration-session-alpha');
  await expect(archivedAlpha).toBeVisible();
  // The open Archived list survives the sidebar switching to the compact rail and back.
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Archived', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(archivedAlpha).toBeVisible();
  const archivedList = page.getByTestId('archived-orchestration-sessions').locator('..');
  await expect(archivedList.getByText('Panes', { exact: true })).toBeVisible();
  await expect(page.getByText('No archived Panes', { exact: true })).toBeVisible();
  await archivedAlpha.getByRole('button', { name: 'Restore Session Alpha', exact: true }).click();
  await expect(archivedAlpha).toHaveCount(0);
  await expect(page.getByText('No archived Sessions', { exact: true })).toBeVisible();
  await expect(page.getByTestId('orchestration-session-alpha')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Associated Alpha Pane', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectedSessionId: () => string | undefined; getOrchestrationRecord: (sessionId: string) => UiSessionFixture | null } };
    return {
      selected: mockWindow.__paneTestElectronMock.getOrchestrationSelectedSessionId(),
      record: mockWindow.__paneTestElectronMock.getOrchestrationRecord('alpha'),
    };
  })).toMatchObject({
    selected: 'beta',
    record: { archived: false, associations: [{ paneId: 'pane-alpha' }] },
  });
});

test('the Session actions menu works by keyboard, and its archive Undo survives collapsing the sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await expect(page.getByTestId('orchestration-session-alpha')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('orchestration-session-alpha').click();
  const alphaChat = page.getByRole('heading', { name: 'Alpha', exact: true });
  await expect(alphaChat).toBeAttached({ timeout: 10_000 });

  const actions = page.getByRole('button', { name: 'Actions for Alpha', exact: true });
  await actions.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Pin Session', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Archive Session', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Pin Session', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(actions).toBeFocused();
  // Tab leaves the menu closed behind it.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Pin Session', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await actions.focus();

  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('orchestration-session-alpha')).toHaveCount(0);
  // Archiving the open Session lands on Home.
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Archived Alpha' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(toast).toHaveCount(0);
  await expect(page.getByTestId('compact-orchestration-session-alpha')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationRecord: (sessionId: string) => UiSessionFixture | null } };
    return mockWindow.__paneTestElectronMock.getOrchestrationRecord('alpha')?.archived;
  })).toBe(false);
  // Undo reopens the Session that was open when it was archived.
  await expect(alphaChat).toBeAttached();
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toHaveCount(0);
});


test('a Pane opened from a Session names it in the title bar as a way back', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  // The window title bar renders on macOS without the overlay flag.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
  });
  await installSessionsFixture(page, [
    sessionFixture(
      'launch',
      'Checkout launch',
      '',
      '',
      '2026-09-16T12:00:00.000Z',
      [{ paneId: 'pane-checkout', panelIds: [], attachedAt: '2026-09-16T12:00:00.000Z' }],
    ),
  ], [paneFixture('pane-checkout', 'checkout-redesign')]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await page.getByRole('button', { name: 'Expand Checkout launch Panes' }).click();
  await page.getByRole('button', { name: 'checkout-redesign', exact: true }).click();
  const label = page.getByTestId('window-title-bar-label');
  await expect(label).toHaveText('Checkout launch›checkout-redesign');
  const back = label.getByRole('button', { name: 'Back to Session Checkout launch', exact: true });
  await expect(back).toHaveCSS('-webkit-app-region', 'no-drag');

  await back.click();
  await expect(page.getByRole('heading', { name: 'Checkout launch', exact: true })).toBeAttached({ timeout: 10_000 });
  await expect(label).toHaveText('Session·Checkout launch');
});

test('a Pane row menu adds the Pane to a Session and removes it again', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ], [paneFixture('pane-loose', 'Loose Pane')]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  const betaRow = page.getByTestId('orchestration-session-beta');
  await expect(betaRow).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Expand project Pane fixtures', exact: true }).click();
  const paneRows = page.getByTestId('sidebar').getByRole('button', { name: 'Loose Pane', exact: true });
  // A lost transport reports the failure instead of failing silently.
  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { rejectNextOrchestrationMembership: (message: string) => void } };
    mockWindow.__paneTestElectronMock.rejectNextOrchestrationMembership('Review transport disconnected');
  });
  await paneRows.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to Session', exact: true }).click();
  await page.getByRole('menu', { name: 'Add Loose Pane to a Session' }).getByRole('menuitem', { name: 'Beta', exact: true }).click();
  const failure = page.getByRole('dialog').filter({ hasText: 'Session update failed' });
  await expect(failure).toContainText('Review transport disconnected');
  await failure.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(paneRows).toHaveCount(1);

  await paneRows.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to Session', exact: true }).click();
  await page.getByRole('menu', { name: 'Add Loose Pane to a Session' }).getByRole('menuitem', { name: 'Beta', exact: true }).click();
  // The Session's first Pane gives it a chevron but leaves it collapsed.
  await expect(page.getByRole('button', { name: 'Expand Beta Panes' })).toHaveAttribute('aria-expanded', 'false');
  await expect(paneRows).toHaveCount(1);
  await page.getByRole('button', { name: 'Expand Beta Panes' }).click();
  await expect(paneRows).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationRecord: (sessionId: string) => UiSessionFixture | null } };
    return mockWindow.__paneTestElectronMock.getOrchestrationRecord('beta')?.associations.map(association => association.paneId);
  })).toEqual(['pane-loose']);

  await paneRows.first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Add to Session', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Remove from Beta', exact: true }).click();
  await expect(paneRows).toHaveCount(1);
});

test('the Add to Session picker fits the window when opened near its bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const names = Array.from({ length: 20 }, (_, index) => `Session ${String(index + 1).padStart(2, '0')}`);
  await installSessionsFixture(
    page,
    names.map((name, index) => sessionFixture(`s${index}`, name, 'Goal.', 'Context.', `2026-09-16T12:${String(index).padStart(2, '0')}:00.000Z`)),
    [paneFixture('pane-loose', 'Loose Pane')],
  );
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await expect(page.getByTestId('orchestration-session-s0')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Expand project Pane fixtures', exact: true }).click();
  // Right-click near the bottom of the window, where the short actions menu flips up.
  const pane = page.getByTestId('sidebar').getByRole('button', { name: 'Loose Pane', exact: true });
  await pane.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 740 })));
  await page.getByRole('menuitem', { name: 'Add to Session', exact: true }).click();

  const last = page.getByRole('menu', { name: 'Add Loose Pane to a Session' }).getByRole('menuitem', { name: 'Session 20', exact: true });
  const box = await last.boundingBox();
  if (!box) throw new Error('The last Session in the picker has no box');
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  await last.click();
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationRecord: (sessionId: string) => UiSessionFixture | null } };
    return mockWindow.__paneTestElectronMock.getOrchestrationRecord('s19')?.associations.map(association => association.paneId);
  })).toEqual(['pane-loose']);
});

test('Archiving a Session during a delayed chat load cannot reinstall its view', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  const alphaRow = page.getByTestId('orchestration-session-alpha');
  await expect(alphaRow).toBeVisible({ timeout: 10_000 });
  await alphaRow.click();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeAttached({ timeout: 10_000 });
  const initialViewRequestCount = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationViewRequests: () => Array<unknown> } };
    return mockWindow.__paneTestElectronMock.getOrchestrationViewRequests().length;
  });

  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setOrchestrationGetDelay: (delayMs: number) => void;
        setExternalOrchestrationAgent: (agent: 'claude' | 'codex' | 'cursor', sessionId?: string) => void;
      };
    };
    mockWindow.__paneTestElectronMock.setOrchestrationGetDelay(250);
    mockWindow.__paneTestElectronMock.setExternalOrchestrationAgent('codex', 'alpha');
  });
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationViewRequests: () => Array<unknown> } };
    return mockWindow.__paneTestElectronMock.getOrchestrationViewRequests().length;
  })).toBe(initialViewRequestCount + 1);

  await page.evaluate(async () => {
    await window.electronAPI.orchestrationSessions.update(
      { sessionId: 'alpha' },
      { archived: true },
    );
  });
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeAttached({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectedSessionId: () => string | undefined } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectedSessionId();
  })).toBe('beta');
});

test('Session overview refreshes for associated Pane activity without reacting to unrelated events', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture(
      'tracked-session',
      'Tracked Session',
      'Track the associated Pane.',
      'Tracked context.',
      '2026-09-16T12:00:00.000Z',
      [{ paneId: 'tracked-pane', panelIds: ['tracked-panel'], attachedAt: '2026-09-16T12:00:00.000Z' }],
    ),
  ], [], {
    overviewPanes: {
      'tracked-session': [{
        paneId: 'tracked-pane',
        name: 'Tracked Pane',
        branch: 'feature/tracked',
        archived: false,
        missing: false,
        panels: [{ panelId: 'tracked-panel', title: 'Tracked terminal', state: 'idle', initialized: true }],
      }],
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  const trackedSessionRow = page.getByTestId('orchestration-session-tracked-session');
  await expect(trackedSessionRow).toBeVisible({ timeout: 10_000 });
  await trackedSessionRow.click();
  await expect(page.getByRole('heading', { name: 'Tracked Session', exact: true })).toBeAttached({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  const overview = page.getByRole('complementary', { name: 'Session overview', exact: true });
  await expect(overview.getByText('Tracked Pane', { exact: true })).toBeVisible();
  await expect(overview.getByText('feature/tracked', { exact: true })).toBeVisible();
  await expect(overview.getByText('Tracked terminal', { exact: true })).toBeVisible();
  const initialOverviewCalls = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationOverviewCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationOverviewCalls();
  });

  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setOrchestrationOverviewPanes: (sessionId: string, panes: UiPaneOverviewFixture[]) => void;
        emitSessionUpdated: (session: { id: string }) => void;
        emitSessionDeleted: (sessionId: string) => void;
        emitPanelCreated: (panel: { id: string; sessionId: string; title: string }) => void;
        emitPanelUpdated: (panel: { id: string; sessionId: string; title: string }) => void;
        emitPanelDeleted: (panelId: string, sessionId: string) => void;
        emitGitStatusUpdated: (sessionId: string, gitStatus: { state: string }) => void;
        emitGitStatusUpdatedBatch: (updates: Array<{ sessionId: string; status: { state: string } }>) => void;
      };
    };
    mockWindow.__paneTestElectronMock.setOrchestrationOverviewPanes('tracked-session', [{
      paneId: 'tracked-pane',
      name: 'Renamed Tracked Pane',
      branch: 'feature/renamed',
      archived: true,
      missing: false,
      panels: [{ panelId: 'tracked-panel', title: 'Renamed terminal', state: 'working', initialized: true }],
      git: { state: 'modified', hasUncommittedChanges: true },
    }]);
    mockWindow.__paneTestElectronMock.emitSessionUpdated({ id: 'tracked-pane' });
    mockWindow.__paneTestElectronMock.emitSessionDeleted('tracked-pane');
    mockWindow.__paneTestElectronMock.emitPanelCreated({ id: 'tracked-panel', sessionId: 'tracked-pane', title: 'Renamed terminal' });
    mockWindow.__paneTestElectronMock.emitPanelUpdated({ id: 'tracked-panel', sessionId: 'tracked-pane', title: 'Renamed terminal' });
    mockWindow.__paneTestElectronMock.emitPanelDeleted('tracked-panel', 'tracked-pane');
    mockWindow.__paneTestElectronMock.emitGitStatusUpdated('tracked-pane', { state: 'modified' });
    mockWindow.__paneTestElectronMock.emitGitStatusUpdatedBatch([
      { sessionId: 'unrelated-pane', status: { state: 'clean' } },
      { sessionId: 'tracked-pane', status: { state: 'modified' } },
    ]);
  });
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationOverviewCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationOverviewCalls();
  })).toBe(initialOverviewCalls + 1);
  await expect(overview.getByText('Renamed Tracked Pane', { exact: true })).toBeVisible();
  await expect(overview.getByText('feature/renamed · archived', { exact: true })).toBeVisible();
  await expect(overview.getByText('Renamed terminal', { exact: true })).toBeVisible();
  await expect(overview.getByText('Uncommitted changes', { exact: true })).toBeVisible();

  const callsAfterAssociatedEvents = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationOverviewCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationOverviewCalls();
  });
  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setOrchestrationOverviewPanes: (sessionId: string, panes: UiPaneOverviewFixture[]) => void;
        emitSessionUpdated: (session: { id: string }) => void;
        emitSessionDeleted: (sessionId: string) => void;
        emitPanelCreated: (panel: { id: string; sessionId: string; title: string }) => void;
        emitPanelUpdated: (panel: { id: string; sessionId: string; title: string }) => void;
        emitPanelDeleted: (panelId: string, sessionId: string) => void;
        emitGitStatusUpdated: (sessionId: string, gitStatus: { state: string }) => void;
        emitGitStatusUpdatedBatch: (updates: Array<{ sessionId: string; status: { state: string } }>) => void;
      };
    };
    mockWindow.__paneTestElectronMock.setOrchestrationOverviewPanes('tracked-session', [{
      paneId: 'tracked-pane',
      name: 'Should stay visible',
      branch: 'feature/unexpected',
      archived: false,
      missing: false,
      panels: [{ panelId: 'tracked-panel', title: 'Unexpected terminal', state: 'idle', initialized: true }],
    }]);
    mockWindow.__paneTestElectronMock.emitSessionUpdated({ id: 'unrelated-pane' });
    mockWindow.__paneTestElectronMock.emitSessionDeleted('unrelated-pane');
    mockWindow.__paneTestElectronMock.emitPanelCreated({ id: 'unrelated-panel', sessionId: 'unrelated-pane', title: 'Unrelated terminal' });
    mockWindow.__paneTestElectronMock.emitPanelUpdated({ id: 'unrelated-panel', sessionId: 'unrelated-pane', title: 'Unrelated terminal' });
    mockWindow.__paneTestElectronMock.emitPanelDeleted('unrelated-panel', 'unrelated-pane');
    mockWindow.__paneTestElectronMock.emitGitStatusUpdated('unrelated-pane', { state: 'clean' });
    mockWindow.__paneTestElectronMock.emitGitStatusUpdatedBatch([{ sessionId: 'unrelated-pane', status: { state: 'clean' } }]);
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationOverviewCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationOverviewCalls();
  })).toBe(callsAfterAssociatedEvents);
  await expect(overview.getByText('Renamed Tracked Pane', { exact: true })).toBeVisible();
  await expect(overview.getByText('Should stay visible', { exact: true })).toHaveCount(0);
});


test('Session launch settings preserve custom arguments, profile, and agent across reload', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const savedCommand = 'af run orchestrator --model "large model"';
  const launchCommand = `${savedCommand} --label 'release planning'`;
  await installSessionsFixture(page, [], [], {
    defaultOrchestratorAgent: 'codex',
    initialConfig: {
      defaultSessionCommand: 'codex --model default-model',
      defaultSessionProfile: 'Discuss the goal before delegating.',
      customCommands: [{ name: 'Agent Farm', command: savedCommand }],
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  const createDialog = page.getByRole('dialog', { name: 'Create Session', exact: true });
  await page.setViewportSize({ width: 1100, height: 700 });
  await createDialog.getByLabel('Session name (optional)').fill('Launch settings');
  await createDialog.getByText('Launch command and behavior', { exact: true }).click();
  await expect(createDialog.getByRole('button', { name: 'Create Session', exact: true })).toBeInViewport();
  await expect(createDialog.getByLabel('Session behavior profile')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/pane-session-create-compact.png' });
  await expect(createDialog.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
  await expect(createDialog.getByLabel('Custom command and arguments')).toHaveValue('codex --model default-model');
  await createDialog.getByRole('button', { name: 'Edit behavior…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile')).toHaveValue('Discuss the goal before delegating.');
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile').fill('Discard this draft.');
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByRole('button', { name: 'Back', exact: true }).click();
  await createDialog.getByLabel('Launch command', { exact: true }).selectOption({ label: 'Agent Farm' });
  await expect(createDialog.getByLabel('Custom command and arguments')).toHaveValue(savedCommand);
  await createDialog.getByLabel('Custom command and arguments').fill(launchCommand);
  await createDialog.getByRole('button', { name: 'Edit behavior…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile')).toHaveValue('Discuss the goal before delegating.');
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile').fill('Use the requested workflow.\nReport blockers.');
  await expect(page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByRole('button', { name: 'Save behavior' })).toBeInViewport();
  await page.screenshot({ path: '/tmp/pane-session-behavior-editor.png' });
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByRole('button', { name: 'Save behavior', exact: true }).click();
  await createDialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Launch settings', exact: true })).toBeAttached();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('orchestration-session-created-session-1').click();
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveCount(0);
  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Session settings', exact: true });
  await expect(settings.getByLabel('Custom command and arguments')).toHaveValue(launchCommand);
  await settings.getByRole('button', { name: 'Edit behavior…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile')).toHaveValue('Use the requested workflow.\nReport blockers.');
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(settings.getByText(/Saved changes apply the next time/)).toBeVisible();
  await settings.getByLabel('Launch command', { exact: true }).selectOption('builtin');
  await expect(settings.getByLabel('Custom command and arguments')).toHaveValue('');
  await settings.getByRole('button', { name: 'Edit behavior…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile').fill('Keep implementation in associated Panes.');
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByRole('button', { name: 'Save behavior', exact: true }).click();
  await settings.getByRole('button', { name: 'Save for next launch', exact: true }).click();
  await expect(settings).not.toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('orchestration-session-created-session-1').click();
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveCount(0);
  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  await expect(settings.getByLabel('Custom command and arguments')).toHaveValue('');
  await settings.getByRole('button', { name: 'Edit behavior…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile')).toHaveValue('Keep implementation in associated Panes.');
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByRole('button', { name: 'Back', exact: true }).click();
});

test('new Sessions remember the last launch arguments and allow clearing them', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installSessionsFixture(page, []);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissStartupDialogs(page);
  const dialog = page.getByRole('dialog', { name: 'Create Session', exact: true });
  const command = 'agent-farm run coordinator --label "release planning" --quiet';
  const open = async () => {
    await page.getByTestId('new-orchestration-session').click();
    await dialog.getByText('Launch command and behavior', { exact: true }).click();
  };
  await open();
  await dialog.getByLabel('Custom command and arguments').fill(command);
  await dialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await open();
  await expect(dialog.getByLabel('Custom command and arguments')).toHaveValue(command);
  await dialog.getByLabel('Custom command and arguments').fill('discard this draft');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await open();
  await expect(dialog.getByLabel('Custom command and arguments')).toHaveValue(command);
  await dialog.getByLabel('Launch command', { exact: true }).selectOption('builtin');
  await dialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await open();
  await expect(dialog.getByLabel('Custom command and arguments')).toHaveValue('');
});

test('custom Session resume settings persist, seed the next Session, and can be disabled', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installSessionsFixture(page, []);
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  const create = page.getByRole('dialog', { name: 'Create Session', exact: true });
  await create.getByLabel('Session name (optional)').fill('Wrapper resume');
  await create.getByText('Launch command and behavior', { exact: true }).click();
  await create.getByLabel('Custom command and arguments').fill('my-launcher run profile');
  await create.getByLabel('Enable custom command resume').check();
  await create.getByLabel('Session ID source').selectOption('claude');
  await create.getByLabel('First launch template').fill('{command} -- --session-id {sessionId}');
  await create.getByLabel('Resume template', { exact: true }).fill('{command} -- --resume {sessionId}');
  await create.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(create).toBeHidden();
  await page.getByTestId('new-orchestration-session').click();
  await create.getByText('Launch command and behavior', { exact: true }).click();
  await expect(create.getByLabel('Resume template', { exact: true })).toHaveValue('{command} -- --resume {sessionId}');
  await create.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  await page.getByTestId('orchestration-session-created-session-1').click();
  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Session settings', exact: true });
  await expect(settings.getByLabel('Enable custom command resume')).toBeChecked();
  await expect(settings.getByLabel('Session ID source')).toHaveValue('claude');
  await settings.getByLabel('Enable custom command resume').uncheck();
  await settings.getByRole('button', { name: 'Save for next launch', exact: true }).click();
  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  await expect(settings.getByLabel('Enable custom command resume')).not.toBeChecked();
});

test('Session app defaults save for new Sessions without changing existing launch settings', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const existing = sessionFixture('existing', 'Existing Session', '', '', '2026-09-16T12:00:00.000Z');
  existing.launchCommand = 'codex --model existing';
  existing.profile = 'Keep this Session profile.';
  await installSessionsFixture(page, [existing]);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissStartupDialogs(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const appSettings = page.getByTestId('settings-page');
  await appSettings.getByRole('button', { name: 'AI & Agents', exact: true }).click();
  await appSettings.getByLabel('Custom command and arguments').fill('af run coordinator --quiet');
  await appSettings.getByRole('button', { name: 'Edit behavior…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile').fill('Coordinate only the requested work.');
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByRole('button', { name: 'Save behavior', exact: true }).click();
  await appSettings.getByRole('button', { name: 'Apply Session defaults', exact: true }).click();
  await expect(appSettings.getByRole('button', { name: 'Apply Session defaults', exact: true })).toBeDisabled();
  await appSettings.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(appSettings).not.toBeVisible();
  await page.getByTestId('new-orchestration-session').click();
  const createDialog = page.getByRole('dialog', { name: 'Create Session', exact: true });
  await createDialog.getByText('Launch command and behavior', { exact: true }).click();
  await expect(createDialog.getByLabel('Custom command and arguments')).toHaveValue('af run coordinator --quiet');
  await createDialog.getByRole('button', { name: 'Edit behavior…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile')).toHaveValue('Coordinate only the requested work.');
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByRole('button', { name: 'Back', exact: true }).click();
  await createDialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New chat', exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  const sessionSettings = page.getByRole('dialog', { name: 'Session settings', exact: true });
  await expect(sessionSettings.getByLabel('Custom command and arguments')).toHaveValue('af run coordinator --quiet');
  await sessionSettings.getByRole('button', { name: 'Edit behavior…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile')).toHaveValue('Coordinate only the requested work.');
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByRole('button', { name: 'Back', exact: true }).click();
  await sessionSettings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('orchestration-session-existing').click();
  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  await expect(sessionSettings.getByLabel('Custom command and arguments')).toHaveValue('codex --model existing');
  await sessionSettings.getByRole('button', { name: 'Edit behavior…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByLabel('Session behavior profile')).toHaveValue('Keep this Session profile.');
  await page.getByRole('dialog', { name: 'Edit Session behavior', exact: true }).getByRole('button', { name: 'Back', exact: true }).click();
});

test('Sessions open persistent shell and Files panels in their own workspace', async ({ page }, testInfo) => {
  // This journey asserts controls in the macOS title bar.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
  });
  await installSessionsFixture(page, [
    sessionFixture('tools', 'Tools', '', '', new Date(0).toISOString()),
    sessionFixture('other', 'Other', '', '', new Date(0).toISOString()),
  ]);
  await page.addInitScript(() => {
    const originalInvoke = window.electronAPI.invoke;
    Object.assign(window.electronAPI, {
      invoke: (channel: string, ...args: unknown[]) => {
        if (channel === 'file:list') return Promise.resolve({ success: true, files: [
          { name: 'notes.txt', path: 'notes.txt', isDirectory: false },
        ] });
        if (channel === 'file:read') return Promise.resolve({ success: true, content: 'Session notes' });
        return originalInvoke(channel, ...args);
      },
    });
  });
  await page.goto('/');
  await page.getByTestId('orchestration-session-tools').click();
  // The window title bar names the Session; its tabs are the next row.
  const workspaceTabs = page.getByTestId('session-workspace-tabs');
  const activeTab = workspaceTabs.getByRole('tab').first();
  await expect(activeTab).toBeVisible();
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  const titleBar = page.getByTestId('window-title-bar');
  await expect(titleBar.getByTestId('window-title-bar-label')).toContainText('Tools');
  const [tabBounds, titleBarBounds] = [await layoutBox(activeTab), await layoutBox(titleBar)];
  expect(tabBounds.y).toBe(titleBarBounds.y + titleBarBounds.height);
  await expect(page.getByTestId('sidebar').getByRole('button', { name: 'More', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Session settings', exact: true })).toBeVisible();
  const titleBarControls = page.getByTestId('window-title-bar-trailing-controls');
  await expect(titleBarControls.getByRole('button', { name: 'Session settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toHaveCSS('-webkit-app-region', 'no-drag');
  await expect(page.getByRole('button', { name: 'Show details', exact: true })).toHaveCSS('-webkit-app-region', 'no-drag');
  // The whole title bar drags the window; its controls opt out.
  await expect(titleBar).toHaveCSS('-webkit-app-region', 'drag');
  await page.getByRole('button', { name: 'Expand terminal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Collapse terminal', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Session changes' })).toContainText('No Panes in this Session yet.');
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Session files' })).toBeVisible();
  await expect(page.getByTestId('window-title-bar').getByRole('button', { name: 'Hide details', exact: true })).toBeVisible();
  const sessionSettingsButton = page.getByRole('button', { name: 'Session settings', exact: true });
  const [settingsBox, workspaceBox] = await Promise.all([
    sessionSettingsButton.boundingBox(), page.locator('.pane-chat-shell').boundingBox(),
  ]);
  expect(settingsBox && workspaceBox && settingsBox.x).toBeGreaterThan(workspaceBox!.x + workspaceBox!.width / 2);
  expect(settingsBox?.y).toBe(3);
  await expect(sessionSettingsButton).toHaveText('');
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveCount(0);
  await sessionSettingsButton.hover();
  await expect(page.getByRole('tooltip')).toContainText('Session settings');
  await expect(page.getByRole('complementary', { name: 'Session files' })).toBeVisible();
  const readPanels = () => page.evaluate(async () => {
    const response = await window.electronAPI.panels.getSessionPanels('__orchestration_session_toolsterminal__');
    return response.data?.map(panel => ({ id: panel.id, type: panel.type, title: panel.title }));
  });
  await expect.poll(readPanels).toEqual([
    { id: 'mock-panel-1', type: 'terminal', title: 'Terminal' },
    { id: 'mock-panel-2', type: 'explorer', title: 'Files' },
  ]);
  await page.getByRole('complementary', { name: 'Session files' }).getByText('notes.txt', { exact: true }).click();
  const fileTab = workspaceTabs.getByRole('tab', { name: 'notes.txt', exact: true });
  await expect(fileTab).toBeVisible();
  await expect(fileTab).toHaveAttribute('aria-selected', 'true');
  const closeFile = workspaceTabs.getByRole('button', { name: 'Close notes.txt' });
  await expect(closeFile).toHaveCSS('opacity', '1');
  await activeTab.click();
  await expect(fileTab).toHaveAttribute('aria-selected', 'false');
  await fileTab.click();
  await expect(fileTab).toHaveAttribute('aria-selected', 'true');
  await expect.poll(readPanels).toHaveLength(3);
  const editorLines = page.locator('.monaco-editor .view-lines').filter({ visible: true });
  await expect(editorLines).toContainText('Session notes');
  await page.evaluate(async () => {
    const originalInvoke = window.electronAPI.invoke;
    Object.assign(window.electronAPI, {
      invoke: (channel: string, ...args: unknown[]) => channel === 'file:read'
        ? Promise.resolve({ success: true, content: 'Updated Session notes' })
        : originalInvoke(channel, ...args),
    });
    const response = await window.electronAPI.panels.getSessionPanels('__orchestration_session_toolsterminal__');
    const editor = response.data?.find(panel => panel.type === 'editor');
    if (!editor) throw new Error('Expected the open notes editor');
    // SAFETY: installElectronApiMock installs the same event the desktop receives.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { emitPanelUpdated: (panel: ToolPanel) => void } };
    mockWindow.__paneTestElectronMock.emitPanelUpdated({
      ...editor,
      state: { ...editor.state, customState: { ...editor.state.customState, reopenedAt: '2026-09-28T12:00:00.000Z' } },
    });
  });
  await expect(editorLines).toContainText('Updated Session notes');
  await page.evaluate(async () => {
    const originalInvoke = window.electronAPI.invoke;
    // SAFETY: the fixture installs these event controls; this test owns the read resolver.
    const controls = window as typeof window & {
      __finishEditorRead?: () => void;
      __paneTestElectronMock: { emitPanelUpdated: (panel: ToolPanel) => void };
    };
    Object.assign(window.electronAPI, {
      invoke: (channel: string, ...args: unknown[]) => {
        if (channel === 'file:read') return new Promise(resolve => {
          controls.__finishEditorRead = () => resolve({ success: true, content: 'External replacement' });
        });
        return originalInvoke(channel, ...args);
      },
    });
    const response = await window.electronAPI.panels.getSessionPanels('__orchestration_session_toolsterminal__');
    const editor = response.data?.find(panel => panel.type === 'editor');
    if (!editor) throw new Error('Expected the open notes editor');
    controls.__paneTestElectronMock.emitPanelUpdated({
      ...editor,
      state: { ...editor.state, customState: { ...editor.state.customState, reopenedAt: '2026-09-28T12:01:00.000Z' } },
    });
  });
  await expect.poll(() => page.evaluate(() => '__finishEditorRead' in window)).toBe(true);
  const editorInput = page.locator('.monaco-editor textarea.inputarea').filter({ visible: true });
  await editorInput.focus();
  await editorInput.press('End');
  await page.keyboard.type(' local edit');
  await page.evaluate(() => {
    // SAFETY: the preceding poll confirmed that the pending file read installed this resolver.
    (window as typeof window & { __finishEditorRead: () => void }).__finishEditorRead();
  });
  await expect(editorLines).toContainText('Updated Session notes local edit');
  // Restore immediate reads for the close/reopen checks below.
  await page.evaluate(() => {
    const originalInvoke = window.electronAPI.invoke;
    Object.assign(window.electronAPI, {
      invoke: (channel: string, ...args: unknown[]) => channel === 'file:read'
        ? Promise.resolve({ success: true, content: 'Updated Session notes local edit' })
        : originalInvoke(channel, ...args),
    });
  });
  const path = testInfo.outputPath('session-tools.png');
  await page.screenshot({ path });
  await testInfo.attach('session-tools.png', { path, contentType: 'image/png' });
  await closeFile.click();
  await expect(fileTab).toHaveCount(0);
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect.poll(readPanels).toHaveLength(2);
  await page.getByRole('complementary', { name: 'Session files' }).getByText('notes.txt', { exact: true }).click();
  await expect(fileTab).toHaveAttribute('aria-selected', 'true');
  await expect.poll(readPanels).toHaveLength(3);
  await page.getByRole('button', { name: 'Collapse terminal', exact: true }).click();
  await page.getByTestId('orchestration-session-other').click();
  await expect(page.getByRole('complementary', { name: 'Session files' })).toHaveCount(0);
  await page.getByTestId('orchestration-session-tools').click();
  await page.getByRole('button', { name: 'Expand terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Session files' })).toBeVisible();
  await expect.poll(readPanels).toHaveLength(3);
  await closeFile.click();
  await expect(fileTab).toHaveCount(0);
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect.poll(readPanels).toHaveLength(2);
  await page.getByRole('complementary', { name: 'Session files' }).getByText('notes.txt', { exact: true }).click();
  await expect(fileTab).toHaveAttribute('aria-selected', 'true');
  await expect.poll(readPanels).toHaveLength(3);
});

test('Sessions can be renamed from their right-click menu', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('rename-menu', 'Original', '', '', new Date(0).toISOString())]);
  await page.goto('/');
  await page.getByTestId('orchestration-session-rename-menu').click();
  await page.getByTestId('orchestration-session-rename-menu').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename Session…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename Session', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Session name' })).toHaveValue('Original');
  await dialog.getByRole('textbox', { name: 'Session name' }).fill('New name');
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open Session New name', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New name', exact: true, level: 1 })).toBeAttached();
});

test('the Session "+" menu opens terminals and browsers as tabs, apart from the terminal dock', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('addtool', 'Add tool demo', '', '', new Date(0).toISOString())]);
  await page.goto('/');
  await page.getByTestId('orchestration-session-addtool').click();
  const workspaceTabs = page.getByTestId('session-workspace-tabs');
  await expect(workspaceTabs.getByRole('tab')).toHaveCount(1);
  const addTool = page.locator('.pane-chat-shell').getByRole('button', { name: 'Add tool', exact: true });
  await expect(addTool).toBeEnabled();

  await addTool.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Terminal' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Browser' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Browser' }).click();
  await expect(workspaceTabs.getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');

  await addTool.click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Terminal' }).click();
  await expect(workspaceTabs.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await expect(workspaceTabs.getByRole('tab')).toHaveCount(3);

  // The bottom terminal dock stays its own shell, not the new tab.
  await page.getByRole('button', { name: 'Expand terminal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Collapse terminal', exact: true })).toBeVisible();
  await expect(workspaceTabs.getByRole('tab')).toHaveCount(3);

  // Over the sidebar the title bar takes the sidebar's colour and width.
  const segment = page.getByTestId('window-title-bar-sidebar-segment');
  const sidebar = page.getByTestId('sidebar');
  const [segmentBox, sidebarBox] = [await layoutBox(segment), await layoutBox(sidebar)];
  expect(segmentBox.width).toBe(sidebarBox.width);
  const colours = await page.evaluate(() => ({
    segment: getComputedStyle(document.querySelector('[data-testid="window-title-bar-sidebar-segment"]')!).backgroundColor,
    sidebar: getComputedStyle(document.querySelector('[data-testid="sidebar"]')!).backgroundColor,
  }));
  expect(colours.segment).toBe(colours.sidebar);
});

test('agent-opened pages open as tabs in a split beside the Session conversation', async ({ page }, testInfo) => {
  await installSessionsFixture(page, [sessionFixture('plans', 'Plan demo', '', '', new Date(0).toISOString())]);
  await page.addInitScript(() => {
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = async (channel, ...args) => {
      if (channel === 'panels:checkInitialized' || channel === 'terminal:getState') {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return invoke(channel, ...args);
    };
  });
  await page.goto('/');
  await page.getByTestId('orchestration-session-plans').click();
  const workspaceTabs = page.getByTestId('session-workspace-tabs');
  await expect(workspaceTabs.getByRole('tab').first()).toBeVisible();
  await expect(page.locator('.xterm-screen')).toHaveCount(1);
  await expect(page.locator('.xterm-screen').first()).toBeVisible();
  await page.evaluate(() => {
    // SAFETY: the IPC fixture exposes the host's one-shot CLI-ready event.
    const mock = (window as typeof window & { __paneTestElectronMock: { emitTerminalCliReady: (id: string) => void } }).__paneTestElectronMock;
    mock.emitTerminalCliReady('__orchestration_panel_plans_claude');
  });
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  const openPage = (id: string, title: string, active = true, reused = false) => page.evaluate(({ id, title, active, reused }) => {
    // SAFETY: installElectronApiMock adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { emitPanelCreated: (panel: ToolPanel) => void; emitPanelUpdated: (panel: ToolPanel) => void; emitPanelActivation: (request: PanelActivationRequest) => void } };
    const mock = mockWindow.__paneTestElectronMock;
    const now = new Date(0).toISOString();
    const sessionId = '__orchestration_session_plansterminal__';
    // As the host does: the tab is created or reopened, then brought forward when the agent asked for focus.
    (reused ? mock.emitPanelUpdated : mock.emitPanelCreated)({
      id, sessionId, type: 'browser', title,
      state: { isActive: active, hasBeenViewed: false, customState: { currentUrl: 'about:blank', reopenedAt: reused ? new Date().toISOString() : undefined } },
      metadata: { createdAt: now, lastActiveAt: now, position: 5, openPlacement: 'split' },
    });
    if (active) mock.emitPanelActivation({ sessionId, panelId: id, placement: 'split' });
  }, { id, title, active, reused });

  await openPage('plan-page', 'plan.html');
  const groupStrips = page.locator('.panel-group-tab-bar');
  await expect(groupStrips).toHaveCount(2);
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  // Split, every group owns a strip: the agent tab moves into its group's strip
  // (the toolbar row goes away) and opened pages get the side strip, so all tabs
  // sit on one row under the title bar.
  await expect(workspaceTabs).toHaveCount(0);
  await expect(groupStrips.nth(0).getByRole('tab')).toHaveCount(1);
  await expect(groupStrips.nth(1).getByRole('tab', { name: 'plan.html' })).toHaveAttribute('aria-selected', 'true');
  const [agentStrip, pageStrip] = [await layoutBox(groupStrips.nth(0)), await layoutBox(groupStrips.nth(1))];
  expect(pageStrip.y).toBe(agentStrip.y);
  expect(pageStrip.height).toBe(agentStrip.height);
  // Linux uses native window decorations rather than the renderer title bar.
  const titleBar = page.getByTestId('window-title-bar');
  if (await titleBar.count()) {
    const titleBarBox = await layoutBox(titleBar);
    expect(agentStrip.y).toBe(titleBarBox.y + titleBarBox.height);
  }

  await openPage('report-page', 'report.html', false);
  await expect(groupStrips.nth(1).getByRole('tab', { name: 'plan.html' })).toHaveAttribute('aria-selected', 'true');
  await openPage('report-page', 'report.html', true, true);
  await expect(groupStrips).toHaveCount(2);
  await expect(groupStrips.nth(1).getByRole('tab')).toHaveCount(2);
  await expect(groupStrips.nth(1).getByRole('tab', { name: 'report.html' })).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => {
    // SAFETY: the fixture installs these event controls; this test owns the read resolver.
    const controls = window as typeof window & { __paneTestElectronMock: { emitPanelUpdated: (panel: ToolPanel) => void } };
    const now = new Date().toISOString();
    controls.__paneTestElectronMock.emitPanelUpdated({
      id: 'plan-page', sessionId: '__orchestration_session_plansterminal__', type: 'browser', title: 'plan.html',
      state: { isActive: true, hasBeenViewed: true, customState: { currentUrl: 'about:blank', reopenedAt: now } },
      metadata: { createdAt: now, lastActiveAt: now, position: 5, openPlacement: 'split' },
    });
  });
  await expect(groupStrips.nth(1).getByRole('tab', { name: 'report.html' })).toHaveAttribute('aria-selected', 'true');
  const screenshot = testInfo.outputPath('session-split-tabs.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('session-split-tabs.png', { path: screenshot, contentType: 'image/png' });

  await groupStrips.nth(1).getByRole('button', { name: 'Close report.html' }).click();
  await groupStrips.nth(1).getByRole('button', { name: 'Close plan.html' }).click();
  await expect(groupStrips).toHaveCount(0);
  await expect(workspaceTabs.getByRole('tab')).toHaveCount(1);
});

/**
 * Drag a Session from the sidebar onto a tile.
 *
 * HTML5 drag and drop has no Playwright primitive that carries a custom MIME
 * type, so the gesture is dispatched by hand with one DataTransfer, exactly as
 * the browser would: dragstart on the source, then dragover and drop on
 * whatever is under the cursor inside the target tile.
 */
async function dragSessionOntoTile(
  page: Page,
  sourceTestId: string,
  target: { x: number; y: number },
): Promise<void> {
  await page.evaluate((sourceId: string) => {
    const source = document.querySelector(`[data-testid="${sourceId}"]`);
    if (!source) throw new Error(`Missing drag source ${sourceId}`);
    const transfer = new DataTransfer();
    // SAFETY: only this helper reads or writes that window property, as the DataTransfer it just created.
    (window as typeof window & { __paneDragTransfer?: DataTransfer }).__paneDragTransfer = transfer;
    source.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, sourceTestId);
  // The drop targets mount only once a Session drag is in flight.
  await expect(page.locator('[data-pane-session-drop-target="true"]').first()).toBeAttached();
  const dispatchAt = async (type: 'dragover' | 'drop') => {
    await page.evaluate(({ x, y, eventType }: { x: number; y: number; eventType: string }) => {
      // SAFETY: the dragstart above parked this DataTransfer on that window property.
      const transfer = (window as typeof window & { __paneDragTransfer?: DataTransfer }).__paneDragTransfer;
      if (!transfer) throw new Error('Missing drag payload');
      const over = document.elementFromPoint(x, y);
      if (!over) throw new Error('Nothing under the drop point');
      over.dispatchEvent(new DragEvent(eventType, { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, { ...target, eventType: type });
  };
  // The hovered zone has to render before the drop reads it, exactly as a real
  // drag gives the page a frame between dragover and drop.
  await dispatchAt('dragover');
  await page.waitForTimeout(50);
  await dispatchAt('drop');
  await page.evaluate(() => {
    // SAFETY: the dragstart above parked this DataTransfer on that window property.
    const transfer = (window as typeof window & { __paneDragTransfer?: DataTransfer }).__paneDragTransfer;
    document.dispatchEvent(new DragEvent('dragend', { dataTransfer: transfer ?? null, bubbles: true }));
  });
}

test('a Session dropped on another tiles beside it, survives a reload, and closes back to one', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await page.getByTestId('orchestration-session-alpha').click();
  const tiles = page.getByTestId('session-tile-header');
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeAttached();

  // Drop Beta on the right quarter of Alpha's tile: an edge drop splits.
  const stage = await layoutBox(page.getByTestId('session-tile-layout'));
  await dragSessionOntoTile(page, 'orchestration-session-beta', {
    x: stage.x + stage.width - 20,
    y: stage.y + stage.height / 2,
  });

  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0)).toBeVisible();
  await expect(tiles.nth(1)).toBeVisible();
  await expect(tiles.nth(0)).toContainText('Alpha');
  await expect(tiles.nth(1)).toContainText('Beta');
  // Both tiles stay mounted and live; neither is a placeholder for the other.
  await expect(page.getByTestId('session-workspace-tabs')).toHaveCount(2);

  // The layout is remembered per host, so reopening Sessions brings it back
  // whole rather than dropping to the one Session that was selected. Writes are
  // debounced like every other layout write, so wait for it to land.
  await expect.poll(() => page.evaluate(
    () => window.localStorage.getItem('__pane_test_session_workspace_layouts__') !== null,
  )).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissStartupDialogs(page);
  await page.getByTestId('orchestration-session-alpha').click();
  await expect(tiles).toHaveCount(2, { timeout: 10_000 });
  await expect(tiles.nth(0)).toContainText('Alpha');
  await expect(tiles.nth(1)).toContainText('Beta');

  // Closing a tile stops tiling that Session without touching the Session.
  await page.getByRole('button', { name: 'Stop tiling Beta', exact: true }).click();
  await expect(page.getByTestId('session-workspace-tabs')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeAttached();
  await expect(page.getByTestId('orchestration-session-beta')).toBeVisible();
});

/**
 * Drag a Session workspace tab by hand, the way the browser would.
 *
 * Like dragSessionOntoTile, one DataTransfer carries the gesture: dragstart on
 * the tab, then dragover (and, unless `drop` is false, drop) on whatever is
 * under each point, then dragend back on the tab. Returns whether each
 * dragover was accepted, which is how the page tells the browser it is a drop
 * target there (an unaccepted drop is refused and the tab snaps back).
 */
async function dragTab(
  page: Page,
  tab: Locator,
  points: Array<{ x: number; y: number }>,
  { drop = true }: { drop?: boolean } = {},
): Promise<boolean[]> {
  await tab.evaluate(source => {
    const transfer = new DataTransfer();
    // SAFETY: only this helper reads or writes that window property, as the DataTransfer it just created.
    const store = window as typeof window & { __paneTabDrag?: { transfer: DataTransfer; source: Element } };
    store.__paneTabDrag = { transfer, source };
    source.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  // The page gets a frame to mount its drop targets, as a real drag gives it.
  await page.waitForTimeout(50);
  const accepted: boolean[] = [];
  const dispatchAt = (point: { x: number; y: number }, eventType: 'dragover' | 'drop') => page.evaluate(({ x, y, eventType }) => {
    // SAFETY: the dragstart above parked the gesture on that window property.
    const drag = (window as typeof window & { __paneTabDrag?: { transfer: DataTransfer } }).__paneTabDrag;
    if (!drag) throw new Error('Missing drag payload');
    const over = document.elementFromPoint(x, y);
    if (!over) throw new Error('Nothing under the drop point');
    return !over.dispatchEvent(new DragEvent(eventType, { dataTransfer: drag.transfer, bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }, { ...point, eventType });
  for (const point of points) {
    accepted.push(await dispatchAt(point, 'dragover'));
    await page.waitForTimeout(50);
  }
  if (drop) {
    const last = points[points.length - 1];
    if (accepted[accepted.length - 1]) await dispatchAt(last, 'drop');
  }
  await page.evaluate(() => {
    // SAFETY: the dragstart above parked the gesture on that window property.
    const store = window as typeof window & { __paneTabDrag?: { transfer: DataTransfer; source: Element } };
    const drag = store.__paneTabDrag;
    delete store.__paneTabDrag;
    drag?.source.dispatchEvent(new DragEvent('dragend', { dataTransfer: drag.transfer, bubbles: true }));
  });
  return accepted;
}

/** The middle of a box, or a point `inset` px in from one of its edges. */
function pointIn(box: { x: number; y: number; width: number; height: number }, edge?: 'left' | 'right') {
  const y = box.y + box.height / 2;
  if (edge === 'left') return { x: box.x + 12, y };
  if (edge === 'right') return { x: box.x + box.width - 12, y };
  return { x: box.x + box.width / 2, y };
}

test('dragging a Session tab to the stage edge opens a split beside the conversation', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('tabdrag', 'Tab drag demo', '', '', new Date(0).toISOString())]);
  await page.goto('/');
  await page.getByTestId('orchestration-session-tabdrag').click();
  const workspaceTabs = page.getByTestId('session-workspace-tabs');
  const addTool = page.locator('.pane-chat-shell').getByRole('button', { name: 'Add tool', exact: true });
  await expect(addTool).toBeEnabled();
  await addTool.click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Browser' }).click();
  await expect(workspaceTabs.getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');
  const agentTabName = await workspaceTabs.getByRole('tab').first().innerText();

  const stage = await layoutBox(page.locator('.pane-chat-shell [role="tabpanel"]:visible'));
  const accepted = await dragTab(page, workspaceTabs.getByRole('tab', { name: 'Browser' }), [pointIn(stage, 'right')]);
  expect(accepted).toEqual([true]);

  const groupStrips = page.locator('.panel-group-tab-bar');
  await expect(groupStrips).toHaveCount(2);
  await expect(workspaceTabs).toHaveCount(0);
  await expect(groupStrips.nth(0).getByRole('tab')).toHaveCount(1);
  await expect(groupStrips.nth(0).getByRole('tab')).toHaveText(agentTabName);
  await expect(groupStrips.nth(1).getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');
});

/** As the host does when an agent opens a page: the tab is created, then brought forward. */
async function openAgentPage(page: Page, sessionKey: string, id: string, title: string): Promise<void> {
  await page.evaluate(({ sessionKey, id, title }) => {
    // SAFETY: installElectronApiMock adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { emitPanelCreated: (panel: ToolPanel) => void; emitPanelActivation: (request: PanelActivationRequest) => void } };
    const mock = mockWindow.__paneTestElectronMock;
    const now = new Date(0).toISOString();
    const sessionId = `__orchestration_session_${sessionKey}terminal__`;
    mock.emitPanelCreated({
      id, sessionId, type: 'browser', title,
      state: { isActive: true, hasBeenViewed: false, customState: { currentUrl: 'about:blank' } },
      metadata: { createdAt: now, lastActiveAt: now, position: 5, openPlacement: 'split' },
    });
    mock.emitPanelActivation({ sessionId, panelId: id, placement: 'split' });
  }, { sessionKey, id, title });
}

/** Opens a Session with a Browser tab beside the conversation and an agent page split to its right. */
async function openSplitSession(page: Page, key: string, pages: string[]): Promise<{ groupStrips: Locator; stages: Locator }> {
  await page.getByTestId(`orchestration-session-${key}`).click();
  const addTool = page.locator('.pane-chat-shell').getByRole('button', { name: 'Add tool', exact: true });
  await expect(addTool).toBeEnabled();
  await addTool.click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Browser' }).click();
  await expect(page.getByTestId('session-workspace-tabs').getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');
  for (const title of pages) await openAgentPage(page, key, title.replace('.html', '-page'), title);
  const groupStrips = page.locator('.panel-group-tab-bar');
  await expect(groupStrips).toHaveCount(2);
  await expect(groupStrips.nth(1).getByRole('tab')).toHaveCount(pages.length);
  return { groupStrips, stages: page.locator('.pane-chat-shell [role="tabpanel"]:visible') };
}

async function tabNames(strip: Locator): Promise<string[]> {
  return strip.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label') ?? ''));
}

test('dragging a Session tab onto the split beside it moves it there and survives leaving the Session', async ({ page }) => {
  await installSessionsFixture(page, [
    sessionFixture('movetab', 'Move tab demo', '', '', '2026-09-16T12:00:00.000Z'),
    sessionFixture('elsewhere', 'Elsewhere', '', '', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/');
  const { groupStrips, stages } = await openSplitSession(page, 'movetab', ['plan.html']);
  await expect(groupStrips.nth(0).getByRole('tab')).toHaveCount(2);

  const rightStage = await layoutBox(stages.nth(1));
  const accepted = await dragTab(page, groupStrips.nth(0).getByRole('tab', { name: 'Browser' }), [pointIn(rightStage)]);
  expect(accepted).toEqual([true]);

  await expect(groupStrips.nth(1).getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');
  expect(await tabNames(groupStrips.nth(1))).toEqual(['plan.html', 'Browser']);
  await expect(groupStrips.nth(0).getByRole('tab')).toHaveCount(1);
  await expect(groupStrips.nth(0).getByRole('tab')).toHaveAttribute('aria-selected', 'true');

  // Leaving flushes the layout; coming back shows the tab where it was dropped.
  await page.getByTestId('orchestration-session-elsewhere').click();
  await expect(page.getByRole('heading', { name: 'Elsewhere', exact: true })).toBeAttached();
  await page.getByTestId('orchestration-session-movetab').click();
  await expect(groupStrips).toHaveCount(2);
  expect(await tabNames(groupStrips.nth(1))).toEqual(['plan.html', 'Browser']);
});

test('a Session tab dropped on a strip lands at the marked slot, and reorders within its own strip', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('striptab', 'Strip demo', '', '', new Date(0).toISOString())]);
  await page.goto('/');
  const { groupStrips } = await openSplitSession(page, 'striptab', ['one.html', 'two.html']);
  const right = groupStrips.nth(1);
  expect(await tabNames(right)).toEqual(['one.html', 'two.html']);

  // The left half of a tab inserts before it.
  const two = await layoutBox(right.getByRole('tab', { name: 'two.html' }));
  expect(await dragTab(page, groupStrips.nth(0).getByRole('tab', { name: 'Browser' }), [{ x: two.x + 6, y: two.y + two.height / 2 }])).toEqual([true]);
  expect(await tabNames(right)).toEqual(['one.html', 'Browser', 'two.html']);
  await expect(right.getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');

  // The empty space after the last tab appends.
  const last = await layoutBox(right.getByRole('tab', { name: 'two.html' }));
  expect(await dragTab(page, right.getByRole('tab', { name: 'Browser' }), [{ x: last.x + last.width + 8, y: last.y + last.height / 2 }])).toEqual([true]);
  expect(await tabNames(right)).toEqual(['one.html', 'two.html', 'Browser']);

  // Past the second tab's midpoint reorders without splitting.
  const second = await layoutBox(right.getByRole('tab', { name: 'two.html' }));
  expect(await dragTab(page, right.getByRole('tab', { name: 'one.html' }), [{ x: second.x + second.width - 6, y: second.y + second.height / 2 }])).toEqual([true]);
  expect(await tabNames(right)).toEqual(['two.html', 'one.html', 'Browser']);
  await expect(groupStrips).toHaveCount(2);
});

test('emptying a Session group by drag closes it, and an edge drop opens a new one', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('emptytab', 'Empty group demo', '', '', new Date(0).toISOString())]);
  await page.goto('/');
  const { groupStrips, stages } = await openSplitSession(page, 'emptytab', ['plan.html']);
  const workspaceTabs = page.getByTestId('session-workspace-tabs');

  // A group's only tab dropped on its own stage changes nothing.
  const planStage = await layoutBox(stages.nth(1));
  await dragTab(page, groupStrips.nth(1).getByRole('tab', { name: 'plan.html' }), [pointIn(planStage, 'left')]);
  await expect(groupStrips).toHaveCount(2);

  await dragTab(page, groupStrips.nth(1).getByRole('tab', { name: 'plan.html' }), [pointIn(await layoutBox(stages.nth(0)))]);
  await expect(groupStrips).toHaveCount(0);
  await expect(workspaceTabs.getByRole('tab')).toHaveCount(3);

  const stage = await layoutBox(stages.first());
  await dragTab(page, workspaceTabs.getByRole('tab', { name: 'plan.html' }), [pointIn(stage, 'left')]);
  await expect(groupStrips).toHaveCount(2);
  expect(await tabNames(groupStrips.nth(0))).toEqual(['plan.html']);
});

test('a cancelled Session tab drag leaves the layout and the stage as they were', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('canceltab', 'Cancel demo', '', '', new Date(0).toISOString())]);
  await page.goto('/');
  const { groupStrips, stages } = await openSplitSession(page, 'canceltab', ['plan.html']);
  const browserTab = groupStrips.nth(0).getByRole('tab', { name: 'Browser' });
  const rightStage = await layoutBox(stages.nth(1));

  // Hovered, then released without a drop: only dragend arrives.
  expect(await dragTab(page, browserTab, [pointIn(rightStage, 'right')], { drop: false })).toEqual([true]);
  expect(await tabNames(groupStrips.nth(0))).toHaveLength(2);
  expect(await tabNames(groupStrips.nth(1))).toEqual(['plan.html']);
  // No drop target is left mounted: the stage takes clicks again and refuses a stray dragover.
  const stray = await page.evaluate(({ x, y }) => {
    const over = document.elementFromPoint(x, y);
    return over ? !over.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y })) : null;
  }, pointIn(rightStage));
  expect(stray).toBe(false);
  await expect(browserTab.locator('xpath=ancestor-or-self::*[@draggable="true"][1]')).not.toHaveClass(/opacity-50/);
});

test('a tab dragged over a tiled neighbour Session is refused there and moves nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await page.getByTestId('orchestration-session-alpha').click();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeAttached();
  const tileLayout = await layoutBox(page.getByTestId('session-tile-layout'));
  await dragSessionOntoTile(page, 'orchestration-session-beta', { x: tileLayout.x + tileLayout.width - 20, y: tileLayout.y + tileLayout.height / 2 });
  const tiles = page.getByTestId('session-tile-header');
  await expect(tiles).toHaveCount(2);
  const strips = page.getByTestId('session-workspace-tabs');
  await expect(strips).toHaveCount(2);
  await expect(strips.nth(0).getByRole('tab')).toHaveCount(1);
  await expect(strips.nth(1).getByRole('tab')).toHaveCount(1);

  // The drag is live over Alpha's own stage, but Beta's stage and strip both
  // refuse Alpha's tab: no target there, and nothing moves.
  const stages = page.locator('[data-session-content-id] [role="tabpanel"]:visible');
  const [alphaStage, betaStage] = [await layoutBox(stages.nth(0)), await layoutBox(stages.nth(1))];
  const betaTab = await layoutBox(strips.nth(1).getByRole('tab'));
  const accepted = await dragTab(page, strips.nth(0).getByRole('tab'), [
    pointIn(alphaStage), pointIn(betaStage, 'right'), pointIn(betaStage), { x: betaTab.x + betaTab.width + 8, y: betaTab.y + betaTab.height / 2 },
  ]);
  expect(accepted).toEqual([true, false, false, false]);
  await expect(strips.nth(0).getByRole('tab')).toHaveCount(1);
  await expect(strips.nth(1).getByRole('tab')).toHaveCount(1);
  await expect(page.locator('.panel-group-tab-bar')).toHaveCount(0);
  await expect(tiles).toHaveCount(2);
});

test('New offers Session and Pane, keeps one dialog, and restores keyboard focus', async ({ page }) => {
  await installSessionsFixture(page, []);
  await page.goto('/');
  await dismissStartupDialogs(page);
  const newButton = page.getByRole('button', { name: 'New', exact: true });
  await newButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close modal', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(dialog.getByText('An agent that directs work across Panes.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('A workspace for one piece of work.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Create Session', exact: false }).click();
  await expect(dialog.getByLabel('Session name (optional)')).toBeFocused();
  await expect(dialog.getByLabel('Run agent in')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Create Session', exact: false })).toBeFocused();
  await dialog.getByRole('button', { name: 'Create Pane', exact: false }).click();
  await expect(dialog.getByLabel('Repository', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(newButton).toBeFocused();
  await page.getByTestId('new-project').click();
  await expect(page.getByRole('dialog').getByText('Add New Repository')).toBeVisible();
});

test('New creates a Session with its selected WSL runtime and agent', async ({ page }) => {
  await installSessionsFixture(page, [], [], { distributions: ['Ubuntu-24.04'] });
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Create Session An agent' }).click();
  await page.getByLabel('Run agent in').selectOption('Ubuntu-24.04');
  await page.getByTestId('create-session-agent-cursor').click();
  await page.getByLabel('Session name (optional)').fill('Coordinate new work');
  await page.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Coordinate new work', exact: true })).toBeAttached();
  const result = await page.evaluate(() => window.electronAPI.orchestrationSessions.list());
  expect(result.data?.sessions.find(session => session.name === 'Coordinate new work')).toMatchObject({ agent: 'cursor', runtime: 'wsl', wslDistribution: 'Ubuntu-24.04' });
});

test('New defaults to the active repository and creates a Pane from the changed repository branch', async ({ page }) => {
  await installSessionsFixture(page, [], [], { projects: [
    { id: 1, name: 'First repository', path: '/tmp/first' },
    { id: 2, name: 'Active repository', path: '/tmp/active' },
  ], activeProjectId: 2 });
  await page.addInitScript(() => {
    window.electronAPI.projects.listBranches = async projectId => ({ success: true, data: [{ name: projectId === '1' ? 'origin/other' : 'origin/main', isCurrent: true, hasWorktree: false, isRemote: true }] });
    window.electronAPI.sessions.create = async request => {
      localStorage.setItem('__newPaneRequest', JSON.stringify(request));
      return { success: true, data: [] };
    };
  });
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Create Pane A workspace' }).click();
  await expect(page.getByLabel('Repository', { exact: true })).toHaveValue('2');
  await expect(page.getByRole('combobox', { name: 'Base Branch' })).toHaveValue('origin/main');
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('switch', { name: 'Use worktree', exact: true }).click();
  await page.locator('#worktreeTemplate').fill('unified-new');
  await page.getByLabel('Repository', { exact: true }).selectOption('1');
  await expect(page.getByRole('combobox', { name: 'Base Branch' })).toHaveValue('origin/other');
  await expect(page.getByRole('switch', { name: 'Use worktree', exact: true })).not.toBeChecked();
  await expect(page.locator('#worktreeTemplate')).toHaveValue('unified-new');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const request: unknown = await page.evaluate(() => JSON.parse(localStorage.getItem('__newPaneRequest') ?? 'null'));
  expect(request).toMatchObject({ projectId: 1, baseBranch: 'origin/other', worktreeTemplate: 'unified-new', toolType: 'none', isMainRepo: true });
});

test('New explains the missing repository and remains available from the compact rail', async ({ page }) => {
  await installSessionsFixture(page, [], [], { projects: [] });
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  const newButton = page.getByRole('button', { name: 'New', exact: true });
  await newButton.click();
  await page.getByRole('button', { name: 'Create Pane A workspace' }).click();
  await expect(page.getByText('A Pane needs a repository. Add one with the + beside Projects.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Create/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create Pane A workspace' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(newButton).toBeFocused();
});

test('New can show Session settings when an older host has no Session API', async ({ page }) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Create Session An agent' }).click();
  await expect(page.getByLabel('Session name (optional)')).toBeVisible();
  await expect(page.getByLabel('Run agent in')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('This host does not support Sessions.');
});

test('New keeps a pending Session creation in its dialog and enables retry after failure', async ({ page }) => {
  await installSessionsFixture(page, []);
  await page.addInitScript(() => {
    window.electronAPI.orchestrationSessions.create = async () => {
      await new Promise<void>(resolve => document.addEventListener('test-release-create', () => resolve(), { once: true }));
      return { success: false, error: 'Creation unavailable; retry.' };
    };
  });
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Create Session An agent' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close modal', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event('test-release-create')));
  await expect(dialog.getByRole('alert')).toHaveText('Creation unavailable; retry.');
  await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
});

test('New preserves multiple-Pane options while switching repositories', async ({ page }) => {
  await installSessionsFixture(page, [], [], { projects: [
    { id: 1, name: 'First repository', path: '/tmp/first' },
    { id: 2, name: 'Second repository', path: '/tmp/second' },
  ] });
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Create Pane A workspace' }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('button', { name: 'Create multiple panes', exact: true }).click();
  await page.locator('#count').fill('3');
  await page.getByRole('switch', { name: 'Start pinned', exact: true }).click();
  await page.getByLabel('Repository', { exact: true }).selectOption('2');
  await expect(page.getByRole('combobox', { name: 'Base Branch' })).toHaveValue('origin/main');
  await expect(page.locator('#count')).toHaveValue('3');
  await expect(page.getByRole('switch', { name: 'Start pinned', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: /Create 3 Panes/ })).toBeEnabled();
});

test('first Session load uses persisted readiness when the ready event precedes the terminal', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('early-ready', 'Already ready', '', '', new Date(0).toISOString())]);
  await page.addInitScript(() => {
    const invoke = window.electronAPI.invoke;
    const panel: ToolPanel = {
      id: '__orchestration_panel_early-ready_claude',
      sessionId: '__orchestration_session_early-readyterminal__',
      type: 'terminal', title: 'Already ready · claude',
      state: { isActive: true, hasBeenViewed: true, customState: { isCliPanel: true, isCliReady: false, isInitialized: true } },
      metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 0, permanent: true },
    };
    window.electronAPI.panels.getSessionPanels = async () => ({ success: true, data: [panel] });
    window.electronAPI.invoke = async (channel, ...args) => {
      if (channel === 'panels:get-layout') {
        // The host is already running the agent while the client loads its layout.
        // SAFETY: these are the fixture's public host-event controls.
        const mock = (window as typeof window & { __paneTestElectronMock: {
          emitPanelUpdated: (panel: ToolPanel) => void;
          emitTerminalCliReady: (id: string) => void;
        } }).__paneTestElectronMock;
        mock.emitPanelUpdated({ ...panel, state: { ...panel.state, customState: { isCliPanel: true, isCliReady: true, isInitialized: true } } });
        mock.emitTerminalCliReady(panel.id);
      }
      return invoke(channel, ...args);
    };
  });
  await page.goto('/');
  await page.getByTestId('orchestration-session-early-ready').click();
  await expect(page.locator('.xterm-screen')).toHaveCount(1);
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
});

for (const failure of ['stalled', 'rejected', 'font-stalled'] as const) {
test(`a ${failure} terminal load offers Retry and recovers without switching Sessions`, async ({ page }) => {
  await page.clock.install();
  await installSessionsFixture(page, [sessionFixture('retry', 'Retry demo', '', '', new Date(0).toISOString())]);
  await page.addInitScript((failure) => {
    const invoke = window.electronAPI.invoke;
    let stall = true;
    window.addEventListener('test-host-recovered', () => { stall = false; });
    const loadFont = document.fonts.load.bind(document.fonts);
    if (failure === 'font-stalled') document.fonts.load = (...args) => stall ? new Promise(() => {}) : loadFont(...args);
    window.electronAPI.invoke = async (channel, ...args) => {
      if (channel === 'panels:checkInitialized' && stall && failure !== 'font-stalled') {
        if (failure === 'rejected') throw new Error('Host unavailable');
        return new Promise(() => {});
      }
      return invoke(channel, ...args);
    };
  }, failure);
  await page.goto('/');
  await page.getByTestId('orchestration-session-retry').click();
  if (failure !== 'rejected') {
    await expect(page.getByRole('status', { name: 'Loading terminal' })).toBeVisible();
    await page.clock.fastForward(31_000);
  }
  await expect(page.getByRole('alert').filter({ hasText: 'Terminal' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('test-host-recovered')));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toHaveCount(1);
  await expect(page.locator('.xterm-screen').first()).toBeVisible();
  await page.evaluate(() => {
    // SAFETY: the IPC fixture exposes the host's one-shot CLI-ready event.
    const mock = (window as typeof window & { __paneTestElectronMock: { emitTerminalCliReady: (id: string) => void } }).__paneTestElectronMock;
    mock.emitTerminalCliReady('__orchestration_panel_retry_claude');
  });
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
});

}

/** The group this desktop remembers as focused for a Pane or Session, as its panel ids. */
async function rememberedFocusedGroup(page: Page, paneId: string): Promise<string[] | null> {
  return page.evaluate(paneId => {
    // SAFETY: installElectronApiMock's rememberPaneLayouts keeps layouts under this key, keyed `${hostId}/${paneId}`.
    const layouts = JSON.parse(window.localStorage.getItem('__pane_test_pane_layouts__') ?? '{}') as Record<string, SessionPanelLayout>;
    const layout = Object.entries(layouts).find(([key]) => key.endsWith(`/${paneId}`))?.[1];
    if (!layout) return null;
    const find = (node: PanelLayoutNode): string[] | null => node.type === 'group'
      ? (node.id === layout.focusedGroupId ? node.panelIds : null)
      : node.children.map(find).find(Boolean) ?? null;
    return find(layout.root);
  }, paneId);
}

test('a page an agent opens while you are in another Session lands beside the conversation when you return', async ({ page }) => {
  await installSessionsFixture(page, [
    sessionFixture('away', 'Away demo', '', '', '2026-09-16T12:00:00.000Z'),
    sessionFixture('elsewhere', 'Elsewhere', '', '', '2026-09-16T12:01:00.000Z'),
  ], [], { rememberPaneLayouts: true });
  await page.goto('/');
  // Visit the Session once, so this desktop remembers its layout.
  await page.getByTestId('orchestration-session-away').click();
  const workspaceTabs = page.getByTestId('session-workspace-tabs');
  await expect(workspaceTabs.getByRole('tab')).toHaveCount(1);
  const agentTabName = await workspaceTabs.getByRole('tab').first().innerText();
  await page.getByTestId('orchestration-session-elsewhere').click();
  await expect(page.getByRole('heading', { name: 'Elsewhere', exact: true })).toBeAttached();
  await expect.poll(() => rememberedFocusedGroup(page, '__orchestration_session_awayterminal__')).not.toBeNull();

  await openAgentPage(page, 'away', 'report-page', 'report.html');
  await page.getByTestId('orchestration-session-away').click();

  const groupStrips = page.locator('.panel-group-tab-bar');
  await expect(groupStrips).toHaveCount(2);
  await expect(groupStrips.nth(0).getByRole('tab')).toHaveText(agentTabName);
  await expect(groupStrips.nth(0).getByRole('tab')).toHaveAttribute('aria-selected', 'true');
  expect(await tabNames(groupStrips.nth(1))).toEqual(['report.html']);
  // The conversation keeps the focus this desktop remembered.
  await expect.poll(() => rememberedFocusedGroup(page, '__orchestration_session_awayterminal__')).toEqual(['__orchestration_panel_away_claude']);
});

test('reopening a page that sits beside the Session conversation moves it into the split', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('reopen', 'Reopen demo', '', '', new Date(0).toISOString())]);
  await page.goto('/');
  await page.getByTestId('orchestration-session-reopen').click();
  const workspaceTabs = page.getByTestId('session-workspace-tabs');
  await expect(workspaceTabs.getByRole('tab')).toHaveCount(1);
  const agentTabName = await workspaceTabs.getByRole('tab').first().innerText();
  const open = (placement: 'split' | 'tab', reused: boolean) => page.evaluate(({ placement, reused }) => {
    // SAFETY: installElectronApiMock adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { emitPanelCreated: (panel: ToolPanel) => void; emitPanelUpdated: (panel: ToolPanel) => void; emitPanelActivation: (request: PanelActivationRequest) => void } };
    const mock = mockWindow.__paneTestElectronMock;
    const now = new Date(0).toISOString();
    const sessionId = '__orchestration_session_reopenterminal__';
    // As the host does for `panels open --file notes.html [--tab]`: create or reopen, then bring forward.
    (reused ? mock.emitPanelUpdated : mock.emitPanelCreated)({
      id: 'notes-page', sessionId, type: 'browser', title: 'notes.html',
      state: { isActive: true, hasBeenViewed: false, customState: { currentUrl: 'about:blank', reopenedAt: reused ? new Date().toISOString() : undefined } },
      metadata: { createdAt: now, lastActiveAt: now, position: 5, openPlacement: placement },
    });
    mock.emitPanelActivation({ sessionId, panelId: 'notes-page', placement });
  }, { placement, reused });

  await open('tab', false);
  await expect(workspaceTabs.getByRole('tab', { name: 'notes.html' })).toHaveAttribute('aria-selected', 'true');
  await expect(workspaceTabs.getByRole('tab')).toHaveCount(2);

  await open('split', true);
  const groupStrips = page.locator('.panel-group-tab-bar');
  await expect(groupStrips).toHaveCount(2);
  await expect(groupStrips.nth(0).getByRole('tab')).toHaveText(agentTabName);
  expect(await tabNames(groupStrips.nth(1))).toEqual(['notes.html']);
  await expect(groupStrips.nth(1).getByRole('tab', { name: 'notes.html' })).toHaveAttribute('aria-selected', 'true');

  // Already beside the conversation: it stays there and stays shown.
  await open('split', true);
  await expect(groupStrips).toHaveCount(2);
  expect(await tabNames(groupStrips.nth(1))).toEqual(['notes.html']);
  await expect(groupStrips.nth(1).getByRole('tab', { name: 'notes.html' })).toHaveAttribute('aria-selected', 'true');
});

type ReorderFixtureWindow = typeof window & {
  __paneTestElectronMock: {
    getOrchestrationReorderCalls: () => string[][];
    failNextOrchestrationReorder: (message: string, thrown?: boolean) => void;
  };
};

const fourSessions = () => [
  sessionFixture('a', 'Alpha', '', '', '2026-09-16T12:00:00.000Z'),
  sessionFixture('b', 'Bravo', '', '', '2026-09-16T12:01:00.000Z'),
  sessionFixture('c', 'Charlie', '', '', '2026-09-16T12:02:00.000Z'),
  sessionFixture('d', 'Delta', '', '', '2026-09-16T12:03:00.000Z'),
];

/** The Session names a sidebar list shows, top to bottom. */
async function listedSessions(page: Page, listId: 'orchestration-sessions-list' | 'orchestration-pinned-list'): Promise<string[]> {
  return page.locator(`#${listId} button[aria-label^="Open Session "]`).evaluateAll(nodes => (
    nodes.map(node => (node.getAttribute('aria-label') ?? '').replace('Open Session ', ''))
  ));
}

async function reorderCalls(page: Page): Promise<string[][]> {
  // SAFETY: installSessionsFixture adds this control before the app loads.
  return page.evaluate(() => (window as ReorderFixtureWindow).__paneTestElectronMock.getOrchestrationReorderCalls());
}

/**
 * Drags a Session row onto the top or bottom edge of another element, the way a real drag reaches
 * the page: dragstart, a dragover (then a frame for the drop line), the drop, and dragend.
 */
async function dragSessionOnto(
  page: Page,
  sourceTestId: string,
  target: Locator,
  edge: 'top' | 'bottom',
  whileOver?: () => Promise<void>,
): Promise<void> {
  const box = await layoutBox(target);
  const point = { x: box.x + box.width / 2, y: edge === 'top' ? box.y + 3 : box.y + box.height - 3 };
  await page.evaluate((sourceId: string) => {
    const source = document.querySelector(`[data-testid="${sourceId}"]`);
    if (!source) throw new Error(`Missing drag source ${sourceId}`);
    const transfer = new DataTransfer();
    // SAFETY: only this helper reads or writes that window property, as the DataTransfer it just created.
    (window as typeof window & { __paneDragTransfer?: DataTransfer }).__paneDragTransfer = transfer;
    source.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, sourceTestId);
  const dispatchAt = async (eventType: 'dragover' | 'drop') => {
    await page.evaluate(({ x, y, type }: { x: number; y: number; type: string }) => {
      // SAFETY: the dragstart above parked this DataTransfer on that window property.
      const transfer = (window as typeof window & { __paneDragTransfer?: DataTransfer }).__paneDragTransfer;
      const over = document.elementFromPoint(x, y);
      if (!transfer || !over) throw new Error('Missing drag payload or drop point');
      over.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, { ...point, type: eventType });
  };
  await dispatchAt('dragover');
  await page.waitForTimeout(50);
  await dispatchAt('dragover');
  if (whileOver) await whileOver();
  await dispatchAt('drop');
  await page.evaluate((sourceId: string) => {
    // SAFETY: the dragstart above parked this DataTransfer on that window property.
    const transfer = (window as typeof window & { __paneDragTransfer?: DataTransfer }).__paneDragTransfer;
    document.querySelector(`[data-testid="${sourceId}"]`)?.dispatchEvent(new DragEvent('dragend', { dataTransfer: transfer, bubbles: true }));
  }, sourceTestId);
}

test('a Session dragged in the Sessions list stays where it is dropped, across a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, fourSessions());
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await expect(page.getByTestId('orchestration-session-a')).toBeVisible({ timeout: 10_000 });
  expect(await listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);

  await dragSessionOnto(page, 'orchestration-session-d', page.getByTestId('orchestration-session-b'), 'top', async () => {
    const line = page.getByTestId('session-drop-indicator');
    await expect(line).toBeVisible();
    await page.screenshot({ path: 'tmp/verify/session-reorder/01-drop-line.png' });
    // The line sits between Alpha and Bravo without moving either row.
    const alpha = await layoutBox(page.getByTestId('orchestration-session-a'));
    const bravo = await layoutBox(page.getByTestId('orchestration-session-b'));
    const drawn = await layoutBox(line);
    expect(drawn.y).toBeGreaterThanOrEqual(alpha.y + alpha.height - 3);
    expect(drawn.y + drawn.height).toBeLessThanOrEqual(bravo.y + 3);
    expect(bravo.y - alpha.y).toBeLessThan(alpha.height + 2);
  });

  await expect.poll(() => listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);
  await expect(page.getByTestId('session-drop-indicator')).toHaveCount(0);
  expect(await reorderCalls(page)).toEqual([['a', 'd', 'b', 'c']]);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('orchestration-session-a')).toBeVisible({ timeout: 10_000 });
  expect(await listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);
});

test('Pinned Sessions reorder among themselves, and a drag across the Pinned line does nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const [alpha, bravo, charlie, delta] = fourSessions();
  await installSessionsFixture(page, [alpha, { ...delta, isPinned: true }, { ...bravo, isPinned: true }, charlie]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await expect(page.getByTestId('orchestration-pinned-session-b')).toBeVisible({ timeout: 10_000 });
  expect(await listedSessions(page, 'orchestration-pinned-list')).toEqual(['Delta', 'Bravo']);

  await dragSessionOnto(page, 'orchestration-pinned-session-b', page.getByTestId('orchestration-pinned-session-d'), 'top');

  await expect.poll(() => listedSessions(page, 'orchestration-pinned-list')).toEqual(['Bravo', 'Delta']);
  expect(await listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Bravo', 'Delta', 'Charlie']);
  expect(await reorderCalls(page)).toEqual([['b', 'd']]);

  // Across the Pinned line, either way: no drop line, no request, no pin change.
  await dragSessionOnto(page, 'orchestration-pinned-session-b', page.getByTestId('orchestration-session-c'), 'bottom', async () => {
    await expect(page.getByTestId('session-drop-indicator')).toHaveCount(0);
  });
  await dragSessionOnto(page, 'orchestration-session-c', page.getByTestId('orchestration-pinned-session-b'), 'top', async () => {
    await expect(page.getByTestId('session-drop-indicator')).toHaveCount(0);
  });
  await page.screenshot({ path: 'tmp/verify/session-reorder/02-pinned.png' });
  expect(await reorderCalls(page)).toHaveLength(1);
  expect(await listedSessions(page, 'orchestration-pinned-list')).toEqual(['Bravo', 'Delta']);
  expect(await listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Bravo', 'Delta', 'Charlie']);
});

test('a Session moves with its Panes, which stay under it as they were', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const [alpha, bravo, charlie] = fourSessions();
  await installSessionsFixture(page, [
    { ...alpha, associations: [{ paneId: 'pane-alpha-worker', panelIds: [], attachedAt: '2026-09-16T12:00:00.000Z' }] },
    bravo,
    charlie,
  ], [paneFixture('pane-alpha-worker', 'Alpha worker')]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  const worker = page.locator('#orchestration-session-panes-sessions-a').getByText('Alpha worker');
  await page.getByRole('button', { name: 'Expand Alpha Panes' }).click();
  await expect(worker).toBeVisible({ timeout: 10_000 });

  await dragSessionOnto(page, 'orchestration-session-a', page.getByTestId('orchestration-session-c'), 'bottom');

  await expect.poll(() => listedSessions(page, 'orchestration-sessions-list')).toEqual(['Bravo', 'Charlie', 'Alpha']);
  await expect(worker).toBeVisible();
  const alphaRow = await layoutBox(page.getByTestId('orchestration-session-a'));
  const workerRow = await layoutBox(worker);
  expect(workerRow.y).toBeGreaterThan(alphaRow.y);
  await expect(page.getByRole('button', { name: 'Collapse Alpha Panes' })).toHaveAttribute('aria-expanded', 'true');
});

test('the compact rail reorders Sessions by drag, and the tree shows the same order', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, fourSessions());
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await expect(page.getByTestId('orchestration-session-a')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect(page.getByTestId('compact-orchestration-session-c')).toBeVisible();

  await dragSessionOnto(page, 'compact-orchestration-session-c', page.getByTestId('compact-orchestration-session-a'), 'top', async () => {
    await page.screenshot({ path: 'tmp/verify/session-reorder/03-rail-drop.png' });
  });

  const railOrder = () => page.locator('[data-testid^="compact-orchestration-session-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('title')));
  await expect.poll(railOrder).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect.poll(() => listedSessions(page, 'orchestration-sessions-list')).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);
});

test('Alt+Up and Alt+Down move a focused Session one place and say where it went', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const [alpha, bravo, charlie, delta] = fourSessions();
  await installSessionsFixture(page, [alpha, { ...bravo, isPinned: true }, charlie, { ...delta, isPinned: true }]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  const bravoRow = page.getByTestId('orchestration-session-b');
  await expect(bravoRow).toBeVisible({ timeout: 10_000 });

  await bravoRow.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Charlie', 'Bravo', 'Delta']);
  await expect(bravoRow).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Moved Bravo to position 3 of 4' })).toBeAttached();

  // The ends do nothing.
  const alphaRow = page.getByTestId('orchestration-session-a');
  await alphaRow.focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.getByTestId('orchestration-session-d').focus();
  await page.keyboard.press('Alt+ArrowDown');
  expect(await reorderCalls(page)).toHaveLength(1);

  // In Pinned, the keys move among pinned Sessions only.
  const pinnedDelta = page.getByTestId('orchestration-pinned-session-d');
  await pinnedDelta.focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => listedSessions(page, 'orchestration-pinned-list')).toEqual(['Delta', 'Bravo']);
  await expect(pinnedDelta).toBeFocused();
  expect((await reorderCalls(page)).at(-1)).toEqual(['d', 'b']);

  // The same keys work on a focused rail item.
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  const railAlpha = page.getByTestId('compact-orchestration-session-a');
  await railAlpha.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(railAlpha).toBeFocused();
  await expect.poll(() => page.locator('[data-testid^="compact-orchestration-session-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('title'))))
    .toEqual(['Charlie', 'Alpha', 'Delta', 'Bravo']);
});

test('a reorder the host does not save snaps back and says what to do', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, fourSessions());
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await expect(page.getByTestId('orchestration-session-a')).toBeVisible({ timeout: 10_000 });

  // SAFETY: installSessionsFixture adds this control before the app loads.
  await page.evaluate(() => (window as ReorderFixtureWindow).__paneTestElectronMock.failNextOrchestrationReorder('Could not write orchestration-sessions.json: disk full.'));
  await dragSessionOnto(page, 'orchestration-session-d', page.getByTestId('orchestration-session-a'), 'top');
  const banner = page.locator('#orchestration-sessions-list [role="alert"]');
  await expect(banner).toContainText('The Session order was not saved');
  await expect(banner).toContainText('disk full');
  expect(await listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);

  // An older host refuses the request outright; the message names that host and the update.
  // SAFETY: installSessionsFixture adds this control before the app loads.
  await page.evaluate(() => (window as ReorderFixtureWindow).__paneTestElectronMock.failNextOrchestrationReorder(
    'Error invoking remote method \'daemon:invoke\': Error: Mac Mini runs an older Pane that does not have this command (orchestration-sessions:reorder). Nothing was changed. Next: Update Pane on Mac Mini (run `runpane update` there), then try again.',
    true,
  ));
  await page.getByTestId('orchestration-session-b').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(banner).toContainText('Mac Mini runs an older Pane');
  await expect(banner).toContainText('Update Pane on Mac Mini');
  await expect(banner).not.toContainText('Error invoking remote method');
  await page.screenshot({ path: 'tmp/verify/session-reorder/04-error-banner.png' });
  expect(await listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);

  // The rail shows its error marker for the same failure.
  // SAFETY: installSessionsFixture adds this control before the app loads.
  await page.evaluate(() => (window as ReorderFixtureWindow).__paneTestElectronMock.failNextOrchestrationReorder('disk full'));
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.getByTestId('compact-orchestration-session-a').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByRole('alert', { name: /The Session order was not saved/ })).toBeVisible();
});

test('an archived Session restored with Undo returns to its place, and tiling a Session leaves the order alone', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const [alpha, bravo, charlie, delta] = fourSessions();
  await installSessionsFixture(page, [alpha, delta, bravo, charlie]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await expect(page.getByTestId('orchestration-session-b')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('orchestration-session-b').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive Session', exact: true }).click();
  await expect.poll(() => listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Delta', 'Charlie']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);

  // Tiling uses the same drag; dropping on the workspace tiles and the sidebar order stays.
  await page.getByTestId('orchestration-session-a').click();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeAttached();
  const stage = await layoutBox(page.getByTestId('session-tile-layout'));
  await dragSessionOntoTile(page, 'orchestration-session-c', { x: stage.x + stage.width - 20, y: stage.y + stage.height / 2 });
  await expect(page.getByTestId('session-tile-header')).toHaveCount(2);
  expect(await listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);
  expect(await reorderCalls(page)).toEqual([]);
});

test('a real mouse drag reorders, in the tree and in the rail', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, fourSessions());
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await expect(page.getByTestId('orchestration-session-a')).toBeVisible({ timeout: 10_000 });

  // Browser-generated drag events, unlike dispatched ones, let React re-render between the
  // window's drop listener and the row's own drop handler.
  await page.getByTestId('orchestration-session-d').dragTo(page.getByTestId('orchestration-session-b'), { targetPosition: { x: 40, y: 3 } });
  await expect.poll(() => listedSessions(page, 'orchestration-sessions-list')).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);

  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.getByTestId('compact-orchestration-session-c').dragTo(page.getByTestId('compact-orchestration-session-a'), { targetPosition: { x: 18, y: 2 } });
  await expect.poll(() => page.locator('[data-testid^="compact-orchestration-session-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('title'))))
    .toEqual(['Charlie', 'Alpha', 'Delta', 'Bravo']);
});

function tailnetMachine(name: string, overrides: Partial<TailnetMachine> = {}): TailnetMachine {
  return { name, dnsName: `${name}.tail1234.ts.net`, url: `https://${name}.tail1234.ts.net:8443`, os: 'macOS', ownerLogin: 'tyler@github', mine: true, state: 'available', ...overrides };
}

/** Answers the Session agent's `runpane panels submit` and records what it was sent. */
async function recordAgentSubmissions(page: Page): Promise<() => Promise<unknown[]>> {
  await page.addInitScript(() => {
    const invoke = window.electronAPI.invoke;
    const submitted: unknown[] = [];
    Object.assign(window, { __moveSubmissions: submitted });
    window.electronAPI.invoke = async (channel, ...args) => {
      if (channel !== 'runpane:panels:submit') return invoke(channel, ...args);
      submitted.push(args[0]);
      return { ok: true, panelId: 'agent', inputBytes: 1, enter: 'cr', sequenceName: 'enter-cr', verifiedSubmitted: true, sentAt: new Date().toISOString() };
    };
  });
  return () => page.evaluate(() => {
    // SAFETY: recordAgentSubmissions' init script sets __moveSubmissions before the app loads.
    return (window as typeof window & { __moveSubmissions: unknown[] }).__moveSubmissions;
  });
}

test('Move to host… sits between Rename and Archive in the Session menu, by mouse, keyboard and in the rail', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [sessionFixture('alpha', 'Alpha', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z')]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  const row = page.getByTestId('orchestration-session-alpha');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Session actions for Alpha' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Pin Session', 'Rename Session…', 'Move to host…', 'Archive Session']);
  await page.keyboard.press('Escape');

  await row.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('menuitem', { name: 'Pin Session' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Move to host…' })).toBeFocused();
  await page.screenshot({ path: 'tmp/verify/session-move-host/01-menu-keyboard.png' });
  // Closing the dialog returns focus to the row the menu was opened from, not the page.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Move Session to another host' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Move Session to another host' })).toBeHidden();
  await expect(row).toBeFocused();

  // The same from a mouse right-click, which never focused the row.
  await page.getByRole('button', { name: 'New Session' }).first().focus();
  await row.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Move to host…' }).click();
  await expect(page.getByRole('dialog', { name: 'Move Session to another host' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Move Session to another host' })).toBeHidden();
  await expect(row).toBeFocused();

  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.getByTestId('compact-orchestration-session-alpha').click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Pin Session', 'Rename Session…', 'Move to host…', 'Archive Session']);
  await page.screenshot({ path: 'tmp/verify/session-move-host/01b-menu-rail.png' });
});

test('Move to host… lists only machines that can take the Session and asks its agent to hand off', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const session = { ...sessionFixture('alpha', 'Alpha', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z'), agent: 'codex' as const };
  await installSessionsFixture(page, [session], [], {
    tailnetMachines: { ok: true, tailnet: 'example.github', domain: 'tail1234.ts.net', machines: [
      tailnetMachine('tylers-mac-mini'),
      tailnetMachine('tylers-mac-mini-1', { state: 'offline' }),
      tailnetMachine('sams-laptop', { mine: false, ownerLogin: 'sam@github', visibility: 'tailnet' }),
      tailnetMachine('sams-desktop', { mine: false, ownerLogin: 'sam@github', state: 'refused' }),
    ] },
  });
  const submissions = await recordAgentSubmissions(page);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await page.getByTestId('orchestration-session-alpha').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to host…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Move Session to another host' });
  await expect(dialog.getByRole('radio')).toHaveCount(4);
  await expect(dialog.getByRole('radio', { name: 'tylers-mac-mini', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('radio', { name: 'tylers-mac-mini-1' })).toBeDisabled();
  await expect(dialog.getByTestId('move-session-target-tylers-mac-mini-1')).toContainText('Offline');
  // A teammate's machine that lets this login in (Everyone on tailnet) is a target, named with its owner.
  await expect(dialog.getByRole('radio', { name: 'sams-laptop' })).toBeEnabled();
  await expect(dialog.getByTestId('move-session-target-sams-laptop')).toContainText('sams-laptop · sam@github');
  await expect(dialog.getByRole('radio', { name: 'sams-desktop' })).toBeDisabled();
  await expect(dialog.getByTestId('move-session-target-sams-desktop')).toContainText('Accepts only its owner\'s Tailscale login; they can set Who can connect → Everyone on tailnet');
  // This computer runs the Session, and discovery never lists it.
  await expect(dialog.getByRole('radio', { name: 'devbox' })).toHaveCount(0);
  await page.screenshot({ path: 'tmp/verify/session-move-host/02-dialog.png' });

  await dialog.getByRole('radio', { name: 'tylers-mac-mini', exact: true }).check({ force: true });
  await dialog.getByRole('button', { name: 'Move Session' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await submissions()).toEqual([{
    panelId: '__orchestration_panel_alpha_codex',
    source: 'user',
    input: 'Hand this Session off to codex on tylers-mac-mini. Use the handoff skill: write the note from `runpane handoff --template`, '
      + 'check it with `--dry-run`, then run `runpane handoff "codex on tylers-mac-mini" --note-file <note>` from this Session\'s folder. '
      + 'Don\'t push anything. Tell me the Session it created.',
  }]);
});

test('Move to host… viewing a Tailscale host offers this computer and leaves out the host', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('alpha', 'Alpha', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z')], [], {
    initialConfig: { remoteDaemon: { host: { config: { enabled: false, listenHost: '127.0.0.1', listenPort: 42137, pairingRequired: true, allowInsecureHttpOnLoopback: true }, clients: [] },
      client: { mode: 'remote', activeProfileId: 'mini', profiles: [{ id: 'mini', label: 'tylers-mac-mini', baseUrl: 'https://tylers-mac-mini.tail1234.ts.net:8443', token: '', transport: 'http+sse', tailnetMachine: 'tylers-mac-mini', tailnetDomain: 'tail1234.ts.net' }] } } },
    tailnetMachines: { ok: true, tailnet: 'example.github', domain: 'tail1234.ts.net', machines: [tailnetMachine('tylers-mac-mini')] },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await page.getByTestId('orchestration-session-alpha').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to host…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move Session to another host' });
  await expect(dialog.getByRole('radio')).toHaveCount(1);
  await expect(dialog.getByRole('radio', { name: 'devbox' })).toBeEnabled();
});

test('Move to host… with nothing reachable says why, names the fix, and sends nothing', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('alpha', 'Alpha', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z')], [], {
    tailnetMachines: { ok: true, tailnet: 'example.github', domain: 'tail1234.ts.net', machines: [tailnetMachine('tylers-mac-mini', { state: 'offline' })] },
  });
  const submissions = await recordAgentSubmissions(page);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await page.getByTestId('orchestration-session-alpha').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to host…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move Session to another host' });
  await expect(dialog).toContainText('No other machine can take this Session right now. Open Pane on the machine you want');
  await page.screenshot({ path: 'tmp/verify/session-move-host/03-nothing-reachable.png' });
  await expect(dialog.getByRole('button', { name: 'Move Session' })).toBeDisabled();
  expect(await submissions()).toEqual([]);
});

test('Move to host… is unavailable, with the reason, on a host paired with a code', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('alpha', 'Alpha', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z')], [], {
    initialConfig: { remoteDaemon: { host: { config: { enabled: false, listenHost: '127.0.0.1', listenPort: 42137, pairingRequired: true, allowInsecureHttpOnLoopback: true }, clients: [] },
      client: { mode: 'remote', activeProfileId: 'studio', profiles: [{ id: 'studio', label: 'Studio', baseUrl: 'https://studio.example:8443', token: 'paired', transport: 'http+sse' }] } } },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await page.getByTestId('orchestration-session-alpha').click({ button: 'right' });
  const item = page.getByRole('menuitem', { name: 'Move to host…' });
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveAttribute('title', /pairing code, not over Tailscale/);
  await item.click({ force: true });
  await expect(page.getByRole('dialog', { name: 'Move Session to another host' })).toHaveCount(0);
});

test('Move to host… with Tailscale signed out passes on the reason and the fix', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('alpha', 'Alpha', 'Goal.', 'Context.', '2026-09-16T12:00:00.000Z')], [], {
    tailnetMachines: { ok: false, reason: 'Tailscale is signed out', fix: 'Sign in to Tailscale, then try again.' },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await page.getByTestId('orchestration-session-alpha').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to host…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move Session to another host' });
  await expect(dialog).toContainText('Tailscale is signed out. Sign in to Tailscale, then try again.');
  await expect(dialog.getByRole('button', { name: 'Move Session' })).toBeDisabled();
});

async function installPaneChatOfferFixture(page: Page): Promise<void> {
  await installSessionsFixture(page, [], [paneFixture('pane-copy', 'checkout-copy'), paneFixture('pane-timeouts', 'api-timeouts')]);
  await page.addInitScript(() => {
    const api = window.electronAPI;
    const record = { preferences: [] as string[], creates: [] as Array<{ name: string; openingPrompt?: string }>, failNextCreate: true };
    Object.assign(window, { __paneChatOffer: record });
    api.paneChat.introOffer = async () => ({ success: true, data: { eligible: true } });
    const setPreference = api.preferences.set;
    api.preferences.set = async (key: string, value: string) => {
      record.preferences.push(`${key}=${value}`);
      return setPreference(key, value);
    };
    const create = api.orchestrationSessions.create;
    api.orchestrationSessions.create = async input => {
      record.creates.push({ name: input.name, openingPrompt: input.openingPrompt });
      if (!record.failNextCreate) return create(input);
      record.failNextCreate = false;
      return { success: false, error: 'Session storage is busy' };
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);
  await page.getByRole('button', { name: 'Expand project Pane fixtures', exact: true }).click();
}

function paneChatOfferRecord(page: Page) {
  return page.evaluate(() => (window as Window & { __paneChatOffer: { preferences: string[]; creates: Array<{ name: string; openingPrompt?: string }> } }).__paneChatOffer);
}

test('the Pane Chat offer shows over a Pane, retries a failed start, and follows the user into the new Session', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneChatOfferFixture(page);
  const offer = page.getByRole('region', { name: 'Pane Chat offer' });
  // Never on Home.
  await expect(page.getByRole('button', { name: 'checkout-copy', exact: true })).toBeVisible();
  await expect(offer).toHaveCount(0);

  await page.getByRole('button', { name: 'checkout-copy', exact: true }).click();
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('NewLet an agent run your PanesPane Chat starts Panes, sends tasks and checks on them for you.');
  await expect.poll(async () => (await paneChatOfferRecord(page)).preferences).toContain('pane_chat_intro_offer_shown=true');

  await offer.getByRole('button', { name: 'Try it', exact: true }).click();
  await expect(offer.getByRole('alert')).toHaveText('Pane Chat could not start: Session storage is busy. No Session was opened. Try again.');
  await offer.getByRole('button', { name: 'Try it', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Pane fixtures tasks', exact: true })).toBeAttached({ timeout: 10_000 });
  await expect(offer).toBeVisible();
  await expect(offer.getByRole('button', { name: 'Try it' })).toHaveCount(0);
  const creates = (await paneChatOfferRecord(page)).creates;
  expect(creates.map(input => input.name)).toEqual(['Pane fixtures tasks', 'Pane fixtures tasks']);
  expect(creates[1].openingPrompt).toMatch(/^Pane sent this once, to introduce Pane Chat .* repository Pane fixtures \(\/tmp\/pane-fixtures\)\./);

  await offer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(offer).toHaveCount(0);
});

test('Not now hides the Pane Chat offer for the rest of the run', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installPaneChatOfferFixture(page);
  const offer = page.getByRole('region', { name: 'Pane Chat offer' });
  await page.getByRole('button', { name: 'checkout-copy', exact: true }).click();
  await offer.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(offer).toHaveCount(0);
  await page.getByRole('button', { name: 'api-timeouts', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(offer).toHaveCount(0);
  expect((await paneChatOfferRecord(page)).creates).toEqual([]);
});
