import { expect, test, type Locator, type Page } from '@playwright/test';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';
import type { MachineState } from '../shared/types/machineConnections';
import type { TailnetMachine, TailnetMachineList } from '../shared/types/workspaceAccess';
import type { SessionMoveMark, SessionMovePreflight, SessionMoveProgress } from '../shared/types/sessionMove';
import type { RemoteComputer } from '../shared/types/remoteComputers';

/**
 * Move to machine… moving a whole Session (states 1–7 of the move dialog sketch), against a
 * mocked host: the move channels answer from `window.__move`, which each step changes.
 */

type Theme = 'light' | 'dark';
type Surface = 'sidebar' | 'all-machines';

const iso = '2026-11-14T09:00:00.000Z';
const SHOTS = 'test-results/session-move';

function sessionRecord(id: string, name: string, extra: JsonObject = {}): JsonObject {
  return {
    id, name, agent: 'claude', internalSessionId: `__orchestration_session_${id}terminal__`,
    panelIds: { claude: `__orchestration_panel_${id}_claude`, codex: `__orchestration_panel_${id}_codex`, cursor: `__orchestration_panel_${id}_cursor` },
    goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [],
    activity: [], revision: 1, createdAt: iso, updatedAt: iso, archived: false, isPinned: false, ...extra,
  };
}

const mark = (state: SessionMoveMark['state'], machine: string): JsonObject => ({ state, machine, moveId: 'move-1', at: '2026-11-14T12:00:00.000Z' });

function tailnetMachine(name: string, overrides: Partial<TailnetMachine> = {}): TailnetMachine {
  return { name, dnsName: `${name}.tail1234.ts.net`, url: `https://${name}.tail1234.ts.net:8443`, os: 'macOS', ownerLogin: 'me@github', mine: true, state: 'available', ...overrides };
}

const tailnetMachines: TailnetMachineList = {
  ok: true, tailnet: 'example.github', domain: 'tail1234.ts.net', machines: [
    tailnetMachine('build-box', { os: 'Linux' }),
    tailnetMachine('studio-b'),
    tailnetMachine('studio-c'),
    tailnetMachine('studio-d', { state: 'unreachable' }),
    tailnetMachine('sam-mbp', { mine: false, ownerLogin: 'sam@github' }),
  ],
};

const readyPreflight = (target: string): SessionMovePreflight => ({
  target, ready: true, paneCount: 6, tabCount: 11, bytes: 140_000_000, checks: [
    { id: 'repos', level: 'ok', title: 'Repositories: example/pane, example/agent-farm found' },
    { id: 'agents', level: 'ok', title: 'Agents: Claude Code, Codex' },
    { id: 'env', level: 'warning', title: `2 env vars aren’t set on ${target}`, detail: 'STRIPE_TEST_KEY, SENTRY_DSN (project pane). Tabs that need them will see them missing.' },
  ],
});

const blockedPreflight: SessionMovePreflight = {
  target: 'studio-c', ready: false, paneCount: 6, tabCount: 11, bytes: 140_000_000, checks: [
    { id: 'repo-agent-farm', level: 'block', title: 'example/agent-farm isn’t on studio-c', detail: 'Pane “af-release” uses it. Clone it to ~/repos/agent-farm, the same place as here?', fix: { kind: 'clone', label: 'Clone', remote: 'git@github.com:example/agent-farm.git', path: '~/repos/agent-farm' } },
    { id: 'trust', level: 'block', title: 'Agent Farm doesn’t trust this repository there', detail: 'Agent Farm stops untrusted workspaces. Trusting runs agent-farm workspace trust on studio-c.', fix: { kind: 'trust', label: 'Trust', path: '~/repos/agent-farm' } },
    { id: 'profile', level: 'warning', title: 'greenfield profile is 0.0.51 there, 0.0.52 here', detail: 'Tabs resume with 0.0.51. Update Agent Farm on studio-c to match.' },
  ],
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function progress(phase: SessionMoveProgress['phase'], extra: Partial<SessionMoveProgress> = {}): SessionMoveProgress {
  return {
    moveId: 'move-1', sessionId: 'alpha', sessionName: 'Pane UI/UX improvements', target: 'studio-b', phase,
    waiting: [], stoppedTabs: 11, totalTabs: 11, steps: [], frozen: false, updatedAt: new Date().toISOString(), ...extra,
  };
}

const waitingProgress = () => progress('waiting', {
  stoppedTabs: 9,
  waiting: [
    { panelId: 'p1', title: 'implementer', paneName: 'fix-login', since: minutesAgo(4) },
    { panelId: 'p2', title: 'reviewer', paneName: 'review-1301', since: new Date(Date.now() - 40_000).toISOString() },
  ],
});

const movingProgress = (phase: 'moving' | 'confirming' = 'moving') => progress(phase, {
  frozen: phase === 'confirming',
  steps: [
    { id: 'stop', state: 'done', title: 'Stopped 11 tabs, 2 dev servers, 1 watch' },
    { id: 'pack', state: 'done', title: 'Packed 6 Panes, 11 conversations, the Session folder' },
    { id: 'send', state: 'done', title: 'Sent 138 MB' },
    { id: 'build', state: phase === 'moving' ? 'running' : 'done', title: 'Setting up on studio-b · 4 of 6 Panes', detail: phase === 'moving' ? 'fix-login: pnpm install' : undefined },
    { id: 'start', state: phase === 'moving' ? 'pending' : 'running', title: 'Resume tabs' },
  ],
});

const doneProgress = () => progress('done', {
  frozen: true,
  summary: { panes: 6, tabs: 11, resumed: 11, failedTabs: [], approvals: 3, leftBehind: ['tmp/capture.mov', 'tmp/trace.zip'], missingEnv: [] },
});

const failedProgress = () => progress('failed', {
  error: {
    message: 'studio-b couldn’t create the worktree for Pane “spike-x”: branch spike-x already exists there with 2 commits this machine doesn’t have. studio-b removed everything it had set up. The Session is running here again, unchanged.',
    next: 'push or delete branch spike-x on studio-b, then try again.',
  },
});

type MoveState = {
  peers: string[];
  preflights: Record<string, SessionMovePreflight>;
  afterFix: Record<string, SessionMovePreflight>;
  startWith: SessionMoveProgress | null;
  afterStop: SessionMoveProgress | null;
  progress: SessionMoveProgress | null;
  /** Clone and Trust wait for `window.__releaseFix()` before they answer. */
  holdFix?: boolean;
  /** Set once a held fix has answered. */
  fixAnswered?: boolean;
  calls: Array<{ channel: string; request: JsonValue; machineId?: string }>;
};

/** The move host: every move channel answers from `window.__move`, on this computer or through machines.run. */
async function installMoveHost(page: Page, initial: Pick<MoveState, 'preflights' | 'afterFix'>) {
  await page.addInitScript((seed) => {
    // SAFETY: the seed fills preflights and afterFix; the rest starts empty, as MoveState allows.
    const state = { peers: ['loop-b'], startWith: null, afterStop: null, progress: null, calls: [], ...seed } as MoveState;
    Object.assign(window, { __move: state });
    const answer = (channel: string, request: { target?: string; recheck?: boolean }) => {
      switch (channel) {
        case 'runpane:sessions:move-peers': return { peers: state.peers };
        case 'runpane:sessions:move-check': return state.preflights[request.target ?? ''] ?? null;
        case 'runpane:sessions:move-fix': {
          const next = state.afterFix[request.target ?? ''];
          state.preflights[request.target ?? ''] = next;
          return next;
        }
        case 'runpane:sessions:move': state.progress = state.startWith; return state.progress;
        case 'runpane:sessions:move-status': return state.progress;
        case 'runpane:sessions:move-stop-now': state.progress = state.afterStop ?? state.progress; return state.progress;
        case 'runpane:sessions:move-cancel': state.progress = state.progress && { ...state.progress, phase: 'cancelled' }; return state.progress;
        default: return { success: false, error: `No mock for ${channel}` };
      }
    };
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = async (channel: string, ...args: unknown[]) => {
      if (!channel.startsWith('runpane:sessions:move')) return invoke(channel, ...args);
      // SAFETY: the dialog sends the move channels one JSON object argument.
      const request = args[0] as { target?: string; recheck?: boolean };
      // SAFETY: the request is the plain JSON object the dialog built.
      state.calls.push({ channel, request: structuredClone(request) as JsonValue });
      if (channel === 'runpane:sessions:move-fix' && state.holdFix) {
        await new Promise<void>(resolve => { Object.assign(window, { __releaseFix: resolve }); });
        const held = structuredClone(answer(channel, request));
        state.fixAnswered = true;
        return held;
      }
      return structuredClone(answer(channel, request));
    };
    const run = window.electronAPI.machines.run;
    // SAFETY: the move-session command (P6) is not in MachineCommand yet; the mock reads only these fields.
    window.electronAPI.machines.run = (async (machineId: string, command: { type: string; channel: string; request: { target?: string } }) => {
      if (command.type !== 'move-session') {
        // SAFETY: any other command is the MachineCommand the app sent, passed on unchanged.
        return run(machineId, command as Parameters<typeof run>[1]);
      }
      // SAFETY: the request is the plain JSON object the dialog built.
      state.calls.push({ machineId, channel: command.channel, request: structuredClone(command.request) as JsonValue });
      return { machineId, data: structuredClone(answer(command.channel, command.request)) };
    }) as typeof run;
  }, initial);
}

/** The host's Sessions, served the way the Sessions sidebar reads them. */
async function installSessions(page: Page, seed: JsonObject[]) {
  await page.addInitScript((records) => {
    type SessionRecord = { id: string; name: string; archived: boolean; agent: 'claude'; panelIds: Record<string, string>; internalSessionId: string; createdAt: string; updatedAt: string; revision: number };
    // SAFETY: every seed record is built by sessionRecord above, with these fields.
    const sessions = structuredClone(records) as SessionRecord[];
    const success = <Value>(data: Value) => ({ success: true as const, data: structuredClone(data) });
    let selectedSessionId = sessions.find(session => !session.archived)?.id;
    const find = (selector: { sessionId?: string }) => {
      const record = sessions.find(session => session.id === selector.sessionId);
      if (!record) throw new Error(`Session ${selector.sessionId} not found`);
      return record;
    };
    const updates: unknown[] = [];
    const view = (record: SessionRecord) => ({
      session: record,
      internalSession: { id: record.internalSessionId, name: record.name, worktreePath: '/tmp/session-move', prompt: '', status: 'stopped', createdAt: record.createdAt, lastActivity: record.updatedAt, output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', toolType: 'none', archived: false, isHidden: true },
      panel: { id: record.panelIds[record.agent], sessionId: record.internalSessionId, type: 'terminal', title: record.name, state: { isActive: true, hasBeenViewed: true, customState: { agentType: record.agent, isCliPanel: true, isInitialized: false } }, metadata: { createdAt: record.createdAt, lastActiveAt: record.updatedAt, position: 0, permanent: true } },
      agent: record.agent, cwd: '/tmp/session-move', guidePath: '/tmp/session-move/guide.md', started: false,
    });
    const changed = () => window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { sessionId: selectedSessionId, kind: 'updated' } }));
    Object.assign(window, { __sessionUpdates: updates });
    Object.assign(window.electronAPI, {
      orchestrationSessions: {
        runtimes: async () => success({ distributions: [] }),
        list: async () => success({ sessions, selectedSessionId }),
        select: async (selector: { sessionId?: string }) => {
          const record = find(selector);
          if (record.archived) return { success: false, error: 'Archived Sessions cannot be opened' };
          selectedSessionId = record.id;
          return success({ sessions, selectedSessionId });
        },
        get: async (selector: { sessionId?: string }) => success(view(find(selector))),
        update: async (selector: { sessionId?: string }, input: { archived?: boolean }) => {
          const record = find(selector);
          updates.push(structuredClone({ sessionId: record.id, ...input }));
          Object.assign(record, input, { revision: record.revision + 1 });
          changed();
          return success(record);
        },
        reorder: async () => success({ sessions, selectedSessionId }),
        overview: async (selector: { sessionId?: string }) => success({ session: find(selector), status: 'unassociated', panes: [], activity: [], refreshedAt: new Date().toISOString() }),
        archivePreview: async (selector: { sessionId?: string }) => success({ sessionId: find(selector).id, panes: [] }),
      },
    });
  }, seed);
}

const moveState = (page: Page) => page.evaluate(() => {
  // SAFETY: installMoveHost's init script sets __move before the app loads.
  return (window as typeof window & { __move: MoveState }).__move;
});

async function setMove(page: Page, patch: Partial<MoveState>) {
  await page.evaluate((next) => {
    // SAFETY: installMoveHost's init script sets __move before the app loads.
    Object.assign((window as typeof window & { __move: MoveState }).__move, next);
  }, patch);
}

async function dismissStartupDialogs(page: Page): Promise<void> {
  const analyticsDecline = page.getByRole('button', { name: 'No thanks' });
  if (await analyticsDecline.isVisible({ timeout: 3000 }).catch(() => false)) await analyticsDecline.click();
  const getStarted = page.getByRole('button', { name: 'Get Started' });
  if (await getStarted.isVisible({ timeout: 2000 }).catch(() => false)) await getStarted.click();
}

const project = { id: 1, name: 'pane', path: '/tmp/pane', active: true, created_at: iso, updated_at: iso };
const pane = (id: string, name: string): JsonObject => ({
  id, name, worktreePath: `/tmp/pane/${name}`, prompt: '', status: 'stopped', createdAt: iso, lastActivity: iso,
  output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: 1, displayOrder: 0,
  isFavorite: false, toolType: 'none', archived: false, isHidden: false,
});
const movedTab = (id: string, paneId: string, title: string, position: number, paused: JsonObject): JsonObject => ({
  id, sessionId: paneId, type: 'terminal', title,
  state: { isActive: position === 0, hasBeenViewed: true, customState: { isInitialized: false, initialCommand: 'claude', paused } },
  metadata: { createdAt: iso, lastActiveAt: iso, position },
});

/** This computer is studio-a, a Mac on Tailscale; `sessions` are its own. */
async function openSidebar(page: Page, theme: Theme, sessions: JsonObject[], extra: Partial<ElectronApiMockOptions> = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: theme });
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialConfig: { appearanceMode: 'system' },
    initialProjects: [project],
    activeProjectId: 1,
    workspaceAccess: { machineName: 'studio-a' },
    tailnetMachines,
    ...extra,
  });
  await installSessions(page, sessions);
  await installMoveHost(page, {
    preflights: { 'studio-a': readyPreflight('studio-a'), 'build-box': readyPreflight('build-box'), 'studio-b': readyPreflight('studio-b'), 'loop-b': readyPreflight('loop-b'), 'studio-c': blockedPreflight },
    afterFix: { 'studio-c': readyPreflight('studio-c') },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissStartupDialogs(page);
}

const allMachinesList = (sessions: JsonValue[]) => ({
  'sessions:get-all-with-projects': { success: true, data: [] },
  'orchestration-sessions:list': { success: true, data: { sessions } },
  'panels:agent-statuses': { success: true, data: [] },
  'permission:getPending': { success: true, data: [] },
  'notify:remote-snapshot': null,
});

/** All machines on studio-a, with a saved machine build-box whose Sessions are `remote`. */
async function openAllMachines(page: Page, theme: Theme, remote: JsonObject[], local: JsonObject[] = []) {
  const machines: MachineState[] = [
    { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
    { id: 'build', label: 'build-box', kind: 'remote', status: 'online', offlineSince: null },
  ];
  // Saved before the app loads its config, so the Session's machine is known when its menu opens.
  const computers: RemoteComputer[] = [{ id: 'build', name: 'build-box' }, { id: 'studio-b', name: 'studio-b' }].map(machine => ({
    id: machine.id, label: machine.name,
    routes: [{ id: `tailscale:https://${machine.name}.tail1234.ts.net:8443`, kind: 'tailscale', source: 'found', baseUrl: `https://${machine.name}.tail1234.ts.net:8443`, token: '', tailnetMachine: machine.name, tailnetDomain: 'tail1234.ts.net' }],
  }));
  await openSidebar(page, theme, local, {
    machineConnections: { machines, reads: { local: allMachinesList(local), build: allMachinesList(remote) } },
    computers,
  });
  await page.getByRole('button', { name: 'Agents run on studio-a. Switch machine' }).click();
  await page.getByRole('menuitemradio', { name: /All machines/ }).click();
  await expect(page.getByTestId('all-machines-sidebar')).toBeVisible();
  const sessionsSection = page.getByRole('button', { name: 'Sessions', exact: true });
  if (await sessionsSection.getAttribute('aria-expanded') === 'false') await sessionsSection.click();
}

const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Move Session to another machine' });

async function shot(page: Page, locator: Locator, state: string, theme: Theme, surface: Surface) {
  await page.mouse.move(0, 0);
  await locator.screenshot({ path: `${SHOTS}/${state}-${theme}-${surface}.png`, animations: 'disabled' });
}

/** States 1 to 6, from opening the dialog to a failed move and Try again. */
async function runMoveFlow(page: Page, theme: Theme, surface: Surface, openDialog: () => Promise<void>, onMachine: string | null) {
  // Six states, each waiting on the one-second status poll.
  test.setTimeout(60_000);
  const dialog = dialogOf(page);
  await openDialog();

  // 1 · Choose: a machine is checked as soon as it is selected; teammates are listed but can't take a whole move.
  await expect(dialog.getByRole('heading', { name: 'Move “Pane UI/UX improvements”' })).toBeVisible();
  await dialog.getByRole('radio', { name: 'studio-b', exact: true }).check({ force: true });
  await expect(dialog).toContainText('Moves the whole Session, with its 6 Panes and 11 tabs, to another of your machines. It carries on there from where it is now.');
  await expect(dialog.getByTestId('move-session-target-studio-b')).toContainText('ready · ~140 MB');
  await expect(dialog.getByRole('radio', { name: 'sam-mbp' })).toBeDisabled();
  await expect(dialog.getByTestId('move-session-target-sam-mbp')).toContainText('a teammate’s machine: hand off with a note instead');
  await expect(dialog.getByTestId('move-session-target-studio-d')).toContainText('Pane is not open there');
  await expect(dialog.getByRole('radio', { name: 'loop-b' })).toBeEnabled();
  await expect(dialog.getByTestId('move-check-env')).toContainText('2 env vars aren’t set on studio-b');
  await expect(dialog).toContainText('Agents still working will finish their turn first. Nothing changes here until studio-b confirms.');
  await expect(dialog.getByRole('button', { name: 'Hand off with a note…' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
  await shot(page, dialog, '1-choose', theme, surface);

  // 2 · Needs a fix: blocking checks offer their fix; Move waits until they pass.
  await dialog.getByRole('radio', { name: 'studio-c' }).check({ force: true });
  await expect(dialog).toContainText('studio-c needs two things before the Session can move.');
  await expect(dialog).toContainText('Nothing has been paused yet.');
  await expect(dialog.getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Clone' })).toBeVisible();
  await shot(page, dialog, '2-needs-fix', theme, surface);
  await dialog.getByRole('button', { name: 'Clone' }).click();
  await expect(dialog.getByTestId('move-session-target-studio-c')).toContainText('ready');
  await expect(dialog.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
  expect((await moveState(page)).calls.filter(call => call.channel === 'runpane:sessions:move-fix').map(call => call.request))
    .toEqual([{ sessionId: 'alpha', target: 'studio-c', fix: blockedPreflight.checks[0].fix }]);

  // 3 · Waiting for turns.
  await dialog.getByRole('radio', { name: 'studio-b', exact: true }).check({ force: true });
  await expect(dialog.getByTestId('move-session-target-studio-b')).toContainText('ready');
  await setMove(page, { startWith: waitingProgress(), afterStop: movingProgress() });
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Waiting for 2 agents to finish their turn' })).toBeVisible();
  await expect(dialog).toContainText('9 of 11 tabs have stopped.');
  await expect(dialog).toContainText('implementer · Pane fix-login');
  await expect(dialog).toContainText('working 4 min');
  await expect(dialog).toContainText('Stop now interrupts them; they pick up the interrupted turn on studio-b.');
  await shot(page, dialog, '3-waiting', theme, surface);

  // Closing only hides it; opening it again shows the move where it is.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await openDialog();
  await expect(dialog.getByRole('heading', { name: 'Waiting for 2 agents to finish their turn' })).toBeVisible();

  // 4 · Moving: steps tick off; Cancel move stays until the freeze.
  await dialog.getByRole('button', { name: 'Stop now' }).click();
  await expect(dialog.getByRole('heading', { name: 'Moving to studio-b' })).toBeVisible();
  await expect(dialog).toContainText('The Session is paused here. Don’t close Pane on either machine.');
  await expect(dialog.getByTestId('move-step-build')).toContainText('fix-login: pnpm install');
  await expect(dialog.getByRole('button', { name: 'Cancel move' })).toBeVisible();
  await shot(page, dialog, '4-moving', theme, surface);

  // 4 · Confirming: frozen, the target went quiet; Check again asks it.
  await setMove(page, { progress: movingProgress('confirming') });
  await expect(dialog.getByRole('heading', { name: 'Waiting for studio-b to confirm' })).toBeVisible();
  await expect(dialog).toContainText('so two copies never run');
  await expect(dialog.getByRole('button', { name: 'Cancel move' })).toHaveCount(0);
  await shot(page, dialog, '4-confirming', theme, surface);
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(async () => (await moveState(page)).calls.some(call => call.channel === 'runpane:sessions:move-status' && JSON.stringify(call.request) === JSON.stringify({ sessionId: 'alpha', recheck: true }))).toBe(true);

  // 5 · Done.
  await setMove(page, { progress: doneProgress() });
  await expect(dialog.getByRole('heading', { name: 'Moved to studio-b' })).toBeVisible();
  await expect(dialog).toContainText('All 11 tabs resumed their conversations there.');
  await expect(dialog).toContainText('6 Panes on the same branches, uncommitted work included');
  await expect(dialog).toContainText('3 open approvals are waiting on studio-b');
  await expect(dialog).toContainText('Left behind: 2 ignored files');
  await expect(dialog).toContainText('This machine keeps the Session archived as “Moved to studio-b”.');
  await expect(dialog.getByRole('button', { name: 'Open on studio-b' })).toBeVisible();
  await shot(page, dialog, '5-done', theme, surface);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();

  // 6 · Failed, then Try again goes back to the chooser and checks again.
  await setMove(page, { progress: null, startWith: failedProgress() });
  await openDialog();
  await dialog.getByRole('radio', { name: 'studio-b', exact: true }).check({ force: true });
  await expect(dialog.getByTestId('move-session-target-studio-b')).toContainText('ready');
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Couldn’t move the Session' })).toBeVisible();
  await expect(dialog).toContainText('branch spike-x already exists there');
  await expect(dialog).toContainText('Next: push or delete branch spike-x on studio-b, then try again.');
  await shot(page, dialog, '6-failed', theme, surface);
  const checksBefore = (await moveState(page)).calls.filter(call => call.channel === 'runpane:sessions:move-check').length;
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('heading', { name: 'Move “Pane UI/UX improvements”' })).toBeVisible();
  await expect.poll(async () => (await moveState(page)).calls.filter(call => call.channel === 'runpane:sessions:move-check').length).toBeGreaterThan(checksBefore);

  // Every call went to the Session's own host.
  const calls = (await moveState(page)).calls;
  expect(calls.every(call => (call.machineId ?? null) === onMachine)).toBe(true);
  expect(calls.find(call => call.channel === 'runpane:sessions:move')?.request).toEqual({ sessionId: 'alpha', target: 'studio-b' });
}

test(`the Sessions sidebar moves a whole Session: states 1 to 6`, async ({ page }) => {
  await openSidebar(page, 'light', [sessionRecord('alpha', 'Pane UI/UX improvements')]);
  const row = page.getByTestId('orchestration-session-alpha');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await runMoveFlow(page, 'light', 'sidebar', async () => {
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to machine…' }).click();
  }, null);
});

test(`All machines moves a whole Session on its own machine: states 1 to 6`, async ({ page }) => {
  await openAllMachines(page, 'light', [sessionRecord('alpha', 'Pane UI/UX improvements')]);
  const row = page.getByTestId('all-machines-session-row').filter({ hasText: 'Pane UI/UX improvements' });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await runMoveFlow(page, 'light', 'all-machines', async () => {
    await row.click({ button: 'right' });
    // The item is disabled until that machine reads as online; the row can show first.
    const move = page.getByRole('menuitem', { name: 'Move to machine…' });
    await expect.poll(() => move.getAttribute('title')).toBeNull();
    await move.click();
  }, 'build');
});

test(`the machine a Session left shows it moved, moving and arriving, with a read-only banner`, async ({ page }) => {
  await openSidebar(page, 'light', [
    sessionRecord('onboarding', 'Onboarding'),
    sessionRecord('release', 'Release train', { move: mark('moving', 'studio-b') }),
    sessionRecord('incoming', 'Docs refresh', { move: mark('arriving', 'build-box') }),
    sessionRecord('alpha', 'Pane UI/UX improvements', { archived: true, move: mark('moved', 'studio-b') }),
  ], {
    initialSessions: [pane('p-move', 'fix-login')],
    initialPanels: [movedTab('t-move', 'p-move', 'implementer', 0, { at: iso, by: 'move', machine: 'studio-b' })],
    initialUiState: { expandedProjects: [1] },
  });
  await expect(page.getByTestId('orchestration-session-release')).toContainText('Moving to studio-b');
  const arriving = page.getByTestId('orchestration-session-incoming');
  await expect(arriving).toContainText('Arriving from build-box');
  await expect(arriving).toHaveAttribute('aria-disabled', 'true');

  const archived = page.getByRole('button', { name: 'Archived' });
  if (await archived.getAttribute('aria-expanded') === 'false') await archived.click();
  const moved = page.getByTestId('archived-orchestration-session-alpha');
  await expect(moved).toContainText('Moved to studio-b');
  await moved.getByRole('button', { name: /Pane UI\/UX improvements/ }).click();
  const banner = page.getByTestId('moved-session-banner');
  await expect(banner).toContainText(/This Session moved to studio-b on .*14.*\. It is read-only here\./);
  await expect(banner.getByRole('button', { name: 'Open it there' })).toBeVisible();
  await shot(page, page.locator('[data-testid="sidebar"], aside, nav').first(), '7-old-machine', 'light', 'sidebar');
  await banner.getByRole('button', { name: 'Restore here' }).click();
  await expect(banner).toContainText('Restore it here only if studio-b no longer runs it');
  await shot(page, banner, '7-restore', 'light', 'sidebar');
  await banner.getByRole('button', { name: 'Restore here' }).click();
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessions' init script sets __sessionUpdates before the app loads.
    return (window as typeof window & { __sessionUpdates: unknown[] }).__sessionUpdates;
  })).toEqual([{ sessionId: 'alpha', archived: false }]);

  // A tab the move stopped says where the Session is going, with no Resume.
  await page.getByRole('button', { name: 'fix-login', exact: true }).click();
  const paused = page.getByTestId('paused-terminal-view');
  await expect(paused).toContainText('Moving to studio-b');
  await expect(paused.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await shot(page, paused, '7-tab', 'light', 'sidebar');
});

test(`All machines shows a Session moving and one arriving on their own machine`, async ({ page }) => {
  await openAllMachines(page, 'light', [
    sessionRecord('release', 'Release train', { move: mark('moving', 'studio-b') }),
    sessionRecord('incoming', 'Docs refresh', { move: mark('arriving', 'studio-a') }),
  ], [sessionRecord('alpha', 'Pane UI/UX improvements', { archived: true, move: mark('moved', 'studio-b') })]);
  const rows = page.getByTestId('all-machines-session-row');
  await expect(rows.filter({ hasText: 'Release train' })).toContainText('Moving to studio-b');
  await expect(rows.filter({ hasText: 'Docs refresh' })).toContainText('Arriving from studio-a');
  await expect(page.getByRole('button', { name: 'Session Docs refresh on build-box (Arriving from studio-a)' })).toHaveAttribute('aria-disabled', 'true');
  const archived = page.getByRole('button', { name: 'Archived' });
  if (await archived.getAttribute('aria-expanded') === 'false') await archived.click();
  await expect(page.getByTestId('archived-orchestration-session-alpha')).toContainText('Moved to studio-b');
  await page.getByTestId('archived-orchestration-session-alpha').getByRole('button', { name: /Pane UI\/UX improvements/ }).click();
  await expect(page.getByTestId('moved-session-banner')).toContainText('This Session moved to studio-b on');
  await shot(page, page.locator('[data-testid="sidebar"], aside, nav').first(), '7-old-machine', 'light', 'all-machines');
});

test('a Clone still running locks the destination, and its answer never lands on another check', async ({ page }) => {
  await openSidebar(page, 'light', [sessionRecord('alpha', 'Pane UI/UX improvements')]);
  const row = page.getByTestId('orchestration-session-alpha');
  await expect(row).toBeVisible({ timeout: 10_000 });
  const openDialog = async () => {
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to machine…' }).click();
  };
  const dialog = dialogOf(page);
  await openDialog();
  await dialog.getByRole('radio', { name: 'studio-c' }).check({ force: true });
  await expect(dialog.getByRole('button', { name: 'Clone' })).toBeVisible();
  await setMove(page, { holdFix: true });
  await dialog.getByRole('button', { name: 'Clone' }).click();

  // While Clone runs, the destination and the mode stay put.
  await expect(dialog.getByRole('radio', { name: 'studio-b', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: 'studio-c' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Hand off with a note…' })).toBeDisabled();

  // Closing and opening again starts a new check; studio-c's late answer must not replace it.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await openDialog();
  await dialog.getByRole('radio', { name: 'studio-b', exact: true }).check({ force: true });
  await expect(dialog.getByTestId('move-session-target-studio-b')).toContainText('ready · ~140 MB');
  await page.evaluate(() => {
    // SAFETY: the held move-fix call above set __releaseFix and is waiting on it.
    (window as typeof window & { __releaseFix: () => void }).__releaseFix();
  });
  await expect.poll(async () => (await moveState(page)).fixAnswered).toBe(true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(dialog.getByRole('list', { name: 'Checks on studio-b' })).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Checks on studio-c' })).toHaveCount(0);
  await expect(dialog.getByTestId('move-session-target-studio-b')).toContainText('ready · ~140 MB');
  await expect(dialog.getByRole('radio', { name: 'studio-c' })).toBeEnabled();
});

test('Hand off with a note… keeps the agent handoff, teammates’ machines included', async ({ page }) => {
  await openSidebar(page, 'light', [sessionRecord('alpha', 'Pane UI/UX improvements')]);
  await page.evaluate(() => {
    const invoke = window.electronAPI.invoke;
    const submitted: unknown[] = [];
    Object.assign(window, { __submitted: submitted });
    window.electronAPI.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel !== 'runpane:panels:submit') return invoke(channel, ...args);
      submitted.push(args[0]);
      return { ok: true };
    };
  });
  await page.getByTestId('orchestration-session-alpha').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to machine…' }).click();
  const dialog = dialogOf(page);
  await dialog.getByRole('button', { name: 'Hand off with a note…' }).click();
  await expect(dialog.getByRole('heading', { name: 'Hand off “Pane UI/UX improvements” with a note' })).toBeVisible();
  await expect(dialog).toContainText('runpane handoff');
  await expect(dialog.getByRole('radio', { name: 'sam-mbp' })).toBeEnabled();
  await dialog.getByRole('radio', { name: 'studio-b', exact: true }).check({ force: true });
  await dialog.getByRole('button', { name: 'Ask the agent to hand off' }).click();
  await expect(dialog).toBeHidden();
  const submitted = await page.evaluate(() => {
    // SAFETY: the evaluate above sets __submitted before the dialog sends anything.
    return (window as typeof window & { __submitted: Array<{ panelId: string; input: string }> }).__submitted;
  });
  expect(submitted).toHaveLength(1);
  expect(submitted[0].panelId).toBe('__orchestration_panel_alpha_claude');
  expect(submitted[0].input).toContain('runpane handoff "claude on studio-b"');
});
