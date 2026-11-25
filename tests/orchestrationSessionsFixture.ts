// The orchestration Sessions fixture shared by orchestration-sessions.spec.ts and
// orchestration-sessions.known-bug.spec.ts: Session and Pane records, a mocked
// orchestration host, and the gestures the specs share.
import { expect, type Locator, type Page } from '@playwright/test';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import type { TailnetMachineList } from '../shared/types/workspaceAccess';
import type { NotifySnapshot } from '../shared/types/notify';
import type { CustomCommandResume } from '../shared/types/customCommandResume';

export type UiAssociationFixture = {
  paneId: string;
  panelIds: string[];
  attachedAt: string;
};

export type UiPaneOverviewFixture = {
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

export type UiSessionFixture = {
  runtime?: 'windows' | 'wsl';
  wslDistribution?: string;
  id: string;
  name: string;
  agent: 'claude' | 'codex' | 'cursor';
  /** The Agent Farm profile the Session runs (T-63); the row shows its avatar. */
  agentProfile?: { ref: string; hash: string };
  agentProfileChanged?: true;
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

export type SessionFixtureOptions = {
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
  notifySnapshot?: NotifySnapshot;
  initialPanels?: JsonObject[];
  initialLayout?: JsonObject;
  /** Machines for All machines (T-45): the other machines, their reads, and this computer's name. */
  machines?: Pick<NonNullable<Parameters<typeof installElectronApiMock>[1]>, 'initialPreferences' | 'machineConnections' | 'workspaceAccess' | 'platform' | 'machineRunAnswers'>;
  /** To-dos and saved machines, for a Session whose to-dos meet another machine's (T-51). */
  todos?: ElectronApiMockOptions['todos'];
  machineConnections?: ElectronApiMockOptions['machineConnections'];
  computers?: ElectronApiMockOptions['computers'];
  /** The host's Session activity baseline (orchestration-sessions:activity-list); absent, the host has none. */
  sessionActivity?: Array<{ sessionId: string; state: 'working' | 'idle'; workingPanes: number }>;
  /** This computer's Agent Farm profiles, for the New Session palette (T-63). */
  agentFarmProfiles?: ElectronApiMockOptions['agentFarmProfiles'];
};

export function sessionFixture(
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

export function paneFixture(
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

export async function installSessionsFixture(
  page: Page,
  initialSessions: UiSessionFixture[],
  paneSessions: JsonObject[] = [],
  fixtureOptions: SessionFixtureOptions = {},
): Promise<void> {
  await installElectronApiMock(page, {
    // Session layouts as they are with To-dos on (T-39); a spec that checks To-dos off passes todosEnabled: false.
    initialConfig: { defaultOrchestratorAgent: fixtureOptions.defaultOrchestratorAgent ?? 'claude', todosEnabled: true, ...fixtureOptions.initialConfig },
    initialProjects: fixtureOptions.projects ?? [{ id: 1, name: 'Pane fixtures', path: '/tmp/pane-fixtures', active: true }],
    activeProjectId: fixtureOptions.activeProjectId,
    initialSessions: paneSessions,
    rememberPaneLayouts: fixtureOptions.rememberPaneLayouts,
    tailnetMachines: fixtureOptions.tailnetMachines,
    notifySnapshot: fixtureOptions.notifySnapshot,
    initialPanels: fixtureOptions.initialPanels,
    initialLayout: fixtureOptions.initialLayout,
    todos: fixtureOptions.todos,
    machineConnections: fixtureOptions.machineConnections,
    computers: fixtureOptions.computers,
    agentFarmProfiles: fixtureOptions.agentFarmProfiles,
    ...fixtureOptions.machines,
  });
  await page.addInitScript(({ seed, listDelayMs, getDelayMs, overviewPanes, distributions, sessionActivity }: { seed: UiSessionFixture[]; listDelayMs: number; getDelayMs: number; overviewPanes: Record<string, UiPaneOverviewFixture[]>; distributions: string[]; sessionActivity: Array<{ sessionId: string; state: 'working' | 'idle'; workingPanes: number }> | null }) => {
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
    const createInputs: JsonObject[] = [];
    const profileCalls: Array<{ action: 'switch' | 'reload'; sessionId: string; ref?: string }> = [];
    let overviewCalls = 0;
    let nextOrchestrationUpdateError: string | null = null;
    type ArchiveSelection = { archivePaneIds: string[]; forcePaneIds: string[] };
    const archiveSelections: ArchiveSelection[] = [];
    // The block code the preview reports for a Pane; by default every Pane is safe.
    const archiveBlocks: Record<string, string> = {};
    // Panes the host finds busy at archive time although the preview found them safe.
    const busyAtArchive = new Set<string>();
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
      activityList: sessionActivity ? async () => success(clone(sessionActivity)) : undefined,
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
      create: async (input: { name: string; goal?: string; context?: string; agent?: SessionRecord['agent']; agentProfile?: string; launchCommand?: string; profile?: string; customResume?: CustomCommandResume | null; runtime?: 'windows' | 'wsl'; wslDistribution?: string; isPinned?: boolean }) => {
        createInputs.push(clone(input));
        // As main does: a field the caller leaves out takes the app's Session default.
        const config = (await window.electronAPI.config.get()).data;
        const launchCommand = input.launchCommand ?? config?.defaultSessionCommand ?? '';
        const profile = input.profile ?? config?.defaultSessionProfile;
        const customResume = input.customResume !== undefined ? input.customResume : config?.defaultSessionResume ?? undefined;
        const id = `created-session-${nextId++}`;
        const record: SessionRecord = {
          id,
          name: input.name,
          runtime: input.runtime,
          wslDistribution: input.wslDistribution,
          agent: input.agent ?? 'claude',
          launchCommand,
          customResume,
          profile,
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
        // As main does (T-63): a named profile, else Claude or Codex on its own; other agents start directly.
        if (input.agentProfile) record.agentProfile = { ref: input.agentProfile, hash: 'fixture' };
        else if (record.agent === 'claude' || record.agent === 'codex') record.agentProfile = { ref: `pane/${record.agent}`, hash: 'fixture' };
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
      // T-63: Switch profile and Reload profile, as the host answers them.
      switchProfile: async (selector: Selector, ref: string) => {
        const record = find(selector);
        profileCalls.push({ action: 'switch', sessionId: record.id, ref });
        const list = await window.electronAPI.chatTab.profiles();
        const agent = ref.startsWith('pane/') ? ref.slice('pane/'.length) : list.profiles.find(entry => entry.ref === ref)?.harness ?? record.agent;
        const previous = { agent: record.agent, ref: record.agentProfile?.ref };
        const effect = previous.ref === ref ? 'current' : agent !== record.agent || agent === 'codex' ? 'new-conversation' : 'kept';
        // SAFETY: the fixture's profiles run the configured agents.
        record.agent = agent as SessionRecord['agent'];
        record.agentProfile = { ref, hash: 'fixture' };
        delete record.agentProfileChanged;
        record.revision += 1;
        persistState();
        changed('updated');
        return success({ session: clone(record), previous, effect });
      },
      reloadProfile: async (selector: Selector) => {
        const record = find(selector);
        profileCalls.push({ action: 'reload', sessionId: record.id });
        delete record.agentProfileChanged;
        record.revision += 1;
        persistState();
        changed('updated');
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
      archivePreview: async (selector: Selector) => {
        const record = find(selector);
        return success({
          sessionId: record.id,
          panes: record.associations.map(({ paneId }) => ({ paneId, name: paneId, blocked: archiveBlocks[paneId] })),
        });
      },
      // Like the host: archives the approved Panes, keeping a safe one that turned busy.
      archive: async (selector: Selector, selection: ArchiveSelection) => {
        archiveSelections.push(clone(selection));
        await api.update(selector, { archived: true });
        const kept = selection.archivePaneIds.filter(paneId => busyAtArchive.has(paneId));
        return success({
          session: clone(find(selector)),
          archivedPaneIds: [...selection.archivePaneIds.filter(paneId => !busyAtArchive.has(paneId)), ...selection.forcePaneIds],
          keptPanes: kept.map(paneId => ({ paneId, name: paneId, code: 'agent-busy' })),
          failedPanes: [],
        });
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
      getOrchestrationCreateInputs: () => clone(createInputs),
      getProfileCalls: () => clone(profileCalls),
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
      getOrchestrationArchiveSelections: () => clone(archiveSelections),
      blockPaneArchive: (paneId: string, code: string) => { archiveBlocks[paneId] = code; },
      makePaneBusyAtArchive: (paneId: string) => { busyAtArchive.add(paneId); },
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
  }, { seed: initialSessions, listDelayMs: fixtureOptions.listDelayMs ?? 0, getDelayMs: fixtureOptions.getDelayMs ?? 0, overviewPanes: fixtureOptions.overviewPanes ?? {}, distributions: fixtureOptions.distributions ?? [], sessionActivity: fixtureOptions.sessionActivity ?? null });
}

export async function dismissStartupDialogs(page: Page): Promise<void> {
  const analyticsDecline = page.getByRole('button', { name: 'No thanks' });
  if (await analyticsDecline.isVisible({ timeout: 3000 }).catch(() => false)) await analyticsDecline.click();
  const getStarted = page.getByRole('button', { name: 'Get Started' });
  if (await getStarted.isVisible({ timeout: 2000 }).catch(() => false)) await getStarted.click();
}

export async function layoutBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Expected layout target to be visible');
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/**
 * Drag a Session from the sidebar onto a tile.
 *
 * HTML5 drag and drop has no Playwright primitive that carries a custom MIME
 * type, so the gesture is dispatched by hand with one DataTransfer, exactly as
 * the browser would: dragstart on the source, then dragover and drop on
 * whatever is under the cursor inside the target tile.
 */
export async function dragSessionOntoTile(
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
