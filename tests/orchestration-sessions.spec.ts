import type { CustomCommandResume } from '../shared/types/customCommandResume';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';

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
  listDelayMs?: number;
  getDelayMs?: number;
  overviewPanes?: Record<string, UiPaneOverviewFixture[]>;
  defaultOrchestratorAgent?: UiSessionFixture['agent'];
  initialConfig?: JsonObject;
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
    initialProjects: [{ id: 1, name: 'Pane fixtures', path: '/tmp/pane-fixtures', active: true }],
    initialSessions: paneSessions,
  });
  await page.addInitScript(({ seed, listDelayMs, getDelayMs, overviewPanes }: { seed: UiSessionFixture[]; listDelayMs: number; getDelayMs: number; overviewPanes: Record<string, UiPaneOverviewFixture[]> }) => {
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
    let selectCalls = 0;
    let overviewCalls = 0;
    let nextOrchestrationUpdateError: string | null = null;
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
      list: async () => {
        const selected = selectedSessionId && sessions.find(session => session.id === selectedSessionId && !session.archived)
          ? selectedSessionId
          : undefined;
        const snapshot = { sessions: clone(sessions), selectedSessionId: selected };
        if (currentListDelayMs > 0) await new Promise(resolve => setTimeout(resolve, currentListDelayMs));
        return success(snapshot);
      },
      select: async (selector: Selector) => {
        selectCalls += 1;
        const record = find(selector);
        if (record.archived) return { success: false, error: 'Archived Sessions cannot be opened' };
        selectedSessionId = record.id;
        persistState();
        changed('selected');
        return success({ sessions: clone(sessions), selectedSessionId });
      },
      create: async (input: { name: string; goal?: string; context?: string; agent?: SessionRecord['agent']; launchCommand?: string; profile?: string; customResume?: CustomCommandResume | null }) => {
        const id = `created-session-${nextId++}`;
        const record: SessionRecord = {
          id,
          name: input.name,
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
          isPinned: false,
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
      setAgent: async (selector: Selector, agent: SessionRecord['agent']) => {
        const record = find(selector);
        record.agent = agent;
        record.revision += 1;
        persistState();
        return success(view(record));
      },
      associate: async (selector: Selector, association: { paneId: string; panelIds?: string[] }) => {
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
      getOrchestrationSelectCalls: () => selectCalls,
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
    });
  }, { seed: initialSessions, listDelayMs: fixtureOptions.listDelayMs ?? 0, getDelayMs: fixtureOptions.getDelayMs ?? 0, overviewPanes: fixtureOptions.overviewPanes ?? {} });
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
  for (const label of ['Goal', 'Context', 'Decisions', 'Blockers', 'Next action', 'Evidence and outputs']) {
    await expect(roadmapOverview.getByText(label, { exact: true })).toHaveCount(0);
  }

  await page.getByTestId('new-orchestration-session').click();
  const createDialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  await expect(createDialog.getByRole('heading', { name: 'Create Session', exact: true })).toBeVisible();
  await expect(createDialog.getByLabel('Name your chat (optional)', { exact: true })).toHaveValue('');
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
  await namedCreateDialog.getByLabel('Name your chat (optional)', { exact: true }).fill('  Custom named chat  ');
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
  const loadingStatus = page.getByRole('status', { name: 'Loading Sessions', exact: true });
  await expect(loadingStatus).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Pane/pane chat to session', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pane/managed pane sidebar', exact: true })).toBeVisible();
  await expect(page.getByText('missing-pane', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Pinned pane', { exact: true })).toBeVisible();

  const evolutionRow = page.getByTestId('orchestration-session-evolution');
  const childrenToggle = page.getByRole('button', { name: 'Collapse Pane evolution children' });
  await expect(childrenToggle).toHaveAttribute('aria-expanded', 'true');
  await evolutionRow.click();
  await expect(childrenToggle).toHaveAttribute('aria-expanded', 'true');
  await childrenToggle.click();
  await expect(page.getByRole('button', { name: 'Expand Pane evolution children' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Pane/pane chat to session', exact: true })).toBeHidden();
  await evolutionRow.click();
  await expect(page.getByRole('button', { name: 'Expand Pane evolution children' })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Expand Pane evolution children' }).press('Enter');
  await expect(childrenToggle).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Collapse Doozy fixes children' }).click();

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
  await page.getByRole('button', { name: 'Expand Doozy fixes children' }).click();
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
  await expect(page.getByRole('button', { name: 'Pinned pane', exact: true })).toBeVisible();

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
  const emptyChildren = page.locator('#orchestration-session-panes-sessions-alpha');
  await expect(page.getByRole('button', { name: 'Expand Alpha children' })).toHaveAttribute('aria-expanded', 'false');
  await expect(emptyChildren).toBeHidden();
  await page.getByRole('button', { name: 'Expand Alpha children' }).click();
  const collapseChildren = page.getByRole('button', { name: 'Collapse Alpha children' });
  await expect(collapseChildren).toHaveAttribute('aria-expanded', 'true');
  await expect(emptyChildren.getByText('No child sessions')).toBeVisible();
  await collapseChildren.click();
  await expect(page.getByRole('button', { name: 'Expand Alpha children' })).toHaveAttribute('aria-expanded', 'false');
  await expect(emptyChildren).toBeHidden();
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
  await alphaRow.click();
  await expect(page.getByRole('button', { name: 'Associated Alpha Pane', exact: true })).toBeVisible();

  await alphaRow.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Archive Session', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Archive Session', exact: true }).click();

  await expect(alphaRow).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeAttached();
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds this control before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectedSessionId: () => string | undefined } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectedSessionId();
  })).toBe('beta');

  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  const archivedAlpha = page.getByTestId('archived-orchestration-session-alpha');
  await expect(archivedAlpha).toBeVisible();
  await expect(page.getByText('Worktrees', { exact: true })).toBeVisible();
  await expect(page.getByText('No archived worktrees', { exact: true })).toBeVisible();
  await archivedAlpha.getByRole('button', { name: 'Restore Session Alpha', exact: true }).click();
  await expect(archivedAlpha).toHaveCount(0);
  await expect(page.getByText('No archived Sessions', { exact: true })).toBeVisible();
  await expect(page.getByTestId('orchestration-session-alpha')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeAttached();
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
  await createDialog.getByLabel('Name your chat (optional)').fill('Launch settings');
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
  await create.getByLabel('Name your chat (optional)').fill('Wrapper resume');
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
  const titleBarTabs = page.getByTestId('window-title-bar-session-tabs');
  const activeTab = titleBarTabs.getByRole('tab').first();
  await expect(activeTab).toBeVisible();
  await expect(activeTab).toHaveCSS('border-top-left-radius', '6px');
  const tabBounds = await activeTab.boundingBox();
  const tabSlotBounds = await titleBarTabs.boundingBox();
  expect(tabBounds?.y).toBe(0);
  expect(tabBounds?.height).toBe(38);
  expect(tabBounds && tabSlotBounds && tabBounds.x - tabSlotBounds.x).toBe(0);
  await expect(page.getByTestId('sidebar').getByRole('button', { name: 'Home menu' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Session settings', exact: true })).toBeVisible();
  const titleBarControls = page.getByTestId('window-title-bar-trailing-controls');
  await expect(titleBarControls.getByRole('button', { name: 'Session settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toHaveCSS('-webkit-app-region', 'no-drag');
  await expect(page.getByRole('button', { name: 'Show details', exact: true })).toHaveCSS('-webkit-app-region', 'no-drag');
  const leftToggle = await page.getByRole('button', { name: 'Collapse sidebar' }).boundingBox();
  const leftDragArea = await page.locator('[data-testid="sidebar"] .pane-drag-area').boundingBox();
  const rightToggle = await page.getByRole('button', { name: 'Show details', exact: true }).boundingBox();
  const rightDragArea = await page.locator('.pane-chat-shell > div > .pane-drag-area').boundingBox();
  expect(leftToggle && leftDragArea && leftDragArea.x).toBeGreaterThanOrEqual(leftToggle!.x + leftToggle!.width);
  expect(rightToggle && rightDragArea && rightDragArea.x + rightDragArea.width).toBeLessThanOrEqual(rightToggle!.x);
  await page.getByRole('button', { name: 'Expand terminal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Collapse terminal', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Session changes' })).toContainText('No linked worktrees.');
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
  const fileTab = titleBarTabs.getByRole('tab', { name: 'notes.txt', exact: true });
  await expect(fileTab).toBeVisible();
  await expect(fileTab).toHaveAttribute('aria-selected', 'true');
  const closeFile = titleBarTabs.getByRole('button', { name: 'Close notes.txt' });
  await expect(closeFile).toHaveCSS('opacity', '1');
  await activeTab.click();
  await expect(fileTab).toHaveAttribute('aria-selected', 'false');
  await fileTab.click();
  await expect(fileTab).toHaveAttribute('aria-selected', 'true');
  await expect.poll(readPanels).toHaveLength(3);
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
