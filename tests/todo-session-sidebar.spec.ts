import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

// T-7, renderer only: a to-do's Session never shows in the Sessions sidebar, not even in the moment after it
// is created, when its record is listed and the to-dos snapshot that names it has not arrived yet. The record
// carries `todoNumber` from its first write; the snapshot here never names it and arrives late.

const TODO_SESSION = '__orchestration_session_todo26__';
const PLAIN_SESSION = '__orchestration_session_billing__';
const SHOTS = process.env.TODO_SIDEBAR_SHOTS_DIR;

const projects = [
  { id: 1, name: 'billing', path: '/tmp/billing', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
];

/** Lists a to-do's Session (with its number) and a plain one, and records any sidebar row for the to-do's Session from first paint. */
function installSessionsAndWatch({ todoSession, plainSession }: { todoSession: string; plainSession: string }) {
  const at = new Date(0).toISOString();
  const record = (id: string, name: string, todoNumber?: number) => ({
    id, name, agent: 'claude', archived: false, isPinned: true, todoNumber,
    internalSessionId: `${id}terminal__`,
    panelIds: { claude: `${id}claude`, codex: `${id}codex`, cursor: `${id}cursor` },
    goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [], activity: [],
    revision: 1, createdAt: at, updatedAt: at,
  });
  const sessions = [record(plainSession, 'Billing rewrite'), record(todoSession, 'T-26 · Invoice PDFs', 26)];
  const list = async () => ({ success: true, data: { sessions, selectedSessionId: todoSession } });
  // The to-dos snapshot arrives well after the Sessions list, and never names the Session.
  const todos = window.electronAPI.todos;
  const snapshot = todos.snapshot.bind(todos);
  const lateSnapshot = () => new Promise<Awaited<ReturnType<typeof snapshot>>>(resolve => window.setTimeout(() => resolve(snapshot()), 1500));
  Object.assign(window.electronAPI, {
    orchestrationSessions: { ...window.electronAPI.orchestrationSessions, list, select: list },
    todos: { ...todos, snapshot: lateSnapshot },
  });
  // Any moment the sidebar names the to-do's Session marks the page, from the first DOM change on.
  new MutationObserver(() => {
    const named = document.querySelector(`[data-testid*="${todoSession}"]`)
      || [...document.querySelectorAll('nav, aside')].some(node => node.textContent?.includes('T-26 · Invoice PDFs'));
    if (named) document.documentElement.dataset.todoSessionSeen = 'yes';
  }).observe(document, { childList: true, subtree: true, characterData: true });
}

async function open(page: Page, theme: 'light-rounded' | 'dark') {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: projects,
    initialSessions: [],
    initialConfig: { theme, appearanceMode: 'fixed' },
    todos: { snapshot: { rows: [], gate: { state: 'normal', enabled: true, since: 0 }, machine: 'devbox', ownSessionIds: [] }, details: {} },
  });
  await page.addInitScript(installSessionsAndWatch, { todoSession: TODO_SESSION, plainSession: PLAIN_SESSION });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

for (const theme of ['light-rounded', 'dark'] as const) {
  test(`a to-do's Session never shows in the Sessions sidebar, before or after the to-dos arrive (${theme})`, async ({ page }) => {
    await open(page, theme);
    // The plain Session lists, pinned and in Sessions; the to-do's (pinned too, and the selected one) never does.
    await expect(page.getByTestId(`orchestration-session-${PLAIN_SESSION}`)).toBeVisible();
    await expect(page.getByTestId(`orchestration-pinned-session-${PLAIN_SESSION}`)).toBeVisible();
    // Past the late to-dos snapshot, and a little more.
    await page.waitForTimeout(2500);
    await expect(page.getByTestId(`orchestration-session-${TODO_SESSION}`)).toHaveCount(0);
    await expect(page.getByTestId(`orchestration-pinned-session-${TODO_SESSION}`)).toHaveCount(0);
    expect(await page.locator('html').getAttribute('data-todo-session-seen')).toBeNull();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/T7-sidebar-${theme === 'dark' ? 'dark' : 'light'}.png` });
  });
}
