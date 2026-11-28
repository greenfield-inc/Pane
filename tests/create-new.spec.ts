import { expect, test, type Page } from '@playwright/test';
import { gotoApp } from './electronApiMock';
import { dismissStartupDialogs, installSessionsFixture, layoutBox, paneFixture, sessionFixture, type SessionFixtureOptions } from './orchestrationSessionsFixture';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { DEFAULT_NOTIFY_SETTINGS } from '../shared/types/notify';

/**
 * T-63 PR 3 behind the Profiles switch (sessionProfilesEnabled): Create New (To → Session name →
 * message → Run on, Create's Session/Pane menu, More options) and the Session rows' avatars.
 * Off, New and the rows are as before; orchestration-sessions.spec.ts covers those.
 */

const PROFILES_ON = { sessionProfilesEnabled: true, chatTabsEnabled: true };
/** Resume templates kept in Settings (Session defaults, and a saved custom command), never in Create New. */
const SETTINGS_RESUME = { mode: 'reported' as const, initialTemplate: '{command}', resumeTemplate: '{command} --resume {sessionId}' };
const SAVED_RESUME = { mode: 'reported' as const, initialTemplate: '{command}', resumeTemplate: '{command} --continue {sessionId}' };
const profile = (ref: string, harness = 'claude', extra: JsonObject = {}) => ({ ref, plugin: ref.split('/')[0], version: '1.0.0', harness, hidden: ref.startsWith('pane/'), ...extra });
const PROFILES = { profiles: [
  profile('pane/claude'), profile('pane/codex', 'codex'),
  // greenfield 0.1.0 (T-83): three profiles, titled by Agent Farm; every listed profile is offered.
  profile('greenfield/orchestrator', 'claude', { title: 'Orchestrator', description: 'Run one workstream from idea to merged pull request.' }),
  profile('greenfield/business', 'claude', { title: 'Business' }),
  profile('greenfield/seo', 'codex', { title: 'SEO' }),
  // Another plugin's profile with no title: To shows the name Pane makes from its ref.
  profile('acme/support'),
] };

const createInputs = (page: Page) => page.evaluate(() => {
  // SAFETY: installSessionsFixture adds this control before the app loads.
  const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationCreateInputs: () => JsonObject[] } };
  return mockWindow.__paneTestElectronMock.getOrchestrationCreateInputs();
});

async function openApp(page: Page, options: SessionFixtureOptions = {}) {
  await installSessionsFixture(page, [], [], { agentFarmProfiles: PROFILES, ...options, initialConfig: { ...PROFILES_ON, ...options.initialConfig } });
  await gotoApp(page);
  await dismissStartupDialogs(page);
}

const dialog = (page: Page) => page.getByTestId('create-new-dialog');
const to = (page: Page) => dialog(page).getByRole('combobox', { name: 'To', exact: true });

test('with Profiles off, New and the + beside Sessions open the dialogs they always did', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('s1', 'Before', '', '', '2026-09-16T12:00:00.000Z')], [], { agentFarmProfiles: PROFILES });
  await gotoApp(page);
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  await expect(page.getByRole('dialog', { name: 'Create Session', exact: true })).toBeVisible();
  await expect(page.getByTestId('create-new-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar').getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('radio', { name: 'Session', exact: true })).toBeChecked();
  await expect(page.getByTestId('create-new-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const row = page.getByTestId('orchestration-session-s1');
  await expect(row.getByTestId('profile-avatar')).toHaveCount(0);
  await expect(row.getByTestId('session-activity-icon')).toHaveAttribute('data-state', 'idle');
});

test('Create New by keyboard: To filters profiles by title or ref, Return picks and moves on through Name and the message, and Return creates', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('new-orchestration-session').click();
  await expect(dialog(page)).toHaveAttribute('data-mode', 'session');
  await expect(dialog(page).getByRole('heading', { name: 'New Session', exact: true })).toBeVisible();
  await expect(to(page)).toBeFocused();
  // To starts on the default agent; there is no Session/Pane toggle and no hotkey hint.
  await expect(to(page)).toHaveValue('Claude');
  await expect(dialog(page).getByRole('radio')).toHaveCount(0);
  await expect(dialog(page).locator('kbd')).toHaveCount(0);
  await expect(dialog(page)).not.toContainText('↵');
  await page.keyboard.type('green');
  const options = dialog(page).getByRole('listbox', { name: 'Agents and profiles' }).getByRole('option');
  // "green" matches the refs; each shows its Agent Farm title, with its description (or its ref) beside it.
  await expect(options).toHaveText([/Orchestrator\s*Run one workstream/, /Business\s*greenfield\/business/, /SEO\s*greenfield\/seo/]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  const name = dialog(page).getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toBeFocused();
  await expect(to(page)).toHaveValue('Orchestrator');
  await page.keyboard.type('Refund tickets');
  await page.keyboard.press('Enter');
  const message = dialog(page).getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeFocused();
  await page.keyboard.type('Draft replies for the open refund tickets.');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Keep them short.');
  await expect(dialog(page).getByTestId('create-new-submit')).toHaveText('Create session');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  const [input] = await createInputs(page);
  expect(input).toMatchObject({ agent: 'claude', agentProfile: 'greenfield/orchestrator', name: 'Refund tickets', nameFromFirstMessage: false, isPinned: false });
  // The first message goes once, as a one-time opening prompt.
  expect(input.openingPrompt).toBe('Pane sent this once, with the person\'s first message from New Session:\n\nDraft replies for the open refund tickets.\nKeep them short.');
});

test('To offers every profile Agent Farm lists, by title, and a profile with no title by its ref\'s name', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('new-orchestration-session').click();
  await page.keyboard.type('support');
  const options = dialog(page).getByRole('listbox', { name: 'Agents and profiles' }).getByRole('option');
  await expect(options).toHaveText([/Acme support\s*acme\/support/]);
  await page.keyboard.press('Enter');
  await expect(to(page)).toHaveValue('Acme support');
  await to(page).fill('seo');
  await expect(options).toHaveText([/SEO\s*greenfield\/seo/]);
});

test('Create New skips the optional name and message: the Session is named from its first message, and Esc closes the To list before the dialog', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('new-orchestration-session').click();
  await page.keyboard.type('seo');
  await expect(dialog(page).getByRole('listbox', { name: 'Agents and profiles' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page).getByRole('listbox', { name: 'Agents and profiles' })).toBeHidden();
  await expect(dialog(page)).toBeVisible();
  await expect(to(page)).toHaveValue('Claude');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(dialog(page).getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const [input] = await createInputs(page);
  expect(input).toMatchObject({ agent: 'claude', name: 'New chat', nameFromFirstMessage: true });
  expect(input).not.toHaveProperty('agentProfile');
  expect(input).not.toHaveProperty('openingPrompt');
  // The last To is what Create New starts on next time.
  await page.getByTestId('new-orchestration-session').click();
  await expect(to(page)).toHaveValue('Claude');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});

test('a remembered profile in To stays selected when the profiles arrive, so typing replaces it (QA)', async ({ page }) => {
  await openApp(page);
  await page.addInitScript(() => {
    // The profiles answer late, as a real Agent Farm listing does.
    const list = window.electronAPI.chatTab.profiles;
    window.electronAPI.chatTab.profiles = () => new Promise(resolve => { setTimeout(() => resolve(list()), 400); });
    localStorage.setItem('pane.new.to', 'profile:greenfield/orchestrator');
  });
  await page.reload();
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  await expect(to(page)).toBeFocused();
  await expect(to(page)).toHaveValue('Orchestrator');
  await page.keyboard.type('codex');
  await expect(to(page)).toHaveValue('codex');
  await expect(dialog(page).getByRole('listbox', { name: 'Agents and profiles' }).getByRole('option')).toHaveText([/^Codex/]);
});

test('Run on has a default, lists the other machines, and Create names no machine; another machine creates there', async ({ page }) => {
  await openApp(page, {
    machineConnections: {
      machines: [
        { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
        { id: 'build', label: 'build-box', kind: 'remote', status: 'online', offlineSince: null },
        { id: 'travel', label: 'travel-laptop', kind: 'remote', status: 'offline', offlineSince: '2026-10-30T09:14:00' },
      ],
      reads: { build: {
        'chat-tab:profiles': { success: true, data: { profiles: [profile('pane/claude'), profile('greenfield/business')] } },
        'orchestration-sessions:list': { success: true, data: { sessions: [{ name: 'New chat' }] } },
      } },
    },
    machines: { machineRunAnswers: { build: { 'create-session': { success: true, data: { session: { id: 'remote-session' } } } } } },
  });
  await page.getByTestId('new-orchestration-session').click();
  const runOn = dialog(page).getByRole('combobox', { name: 'Run on', exact: true });
  await expect(runOn.locator('option')).toHaveText([/\(this computer\)$/, 'build-box', 'travel-laptop (offline)']);
  await expect(runOn.locator('option', { hasText: 'travel-laptop' })).toHaveJSProperty('disabled', true);
  await expect(runOn).toHaveValue('local');
  await runOn.selectOption({ label: 'build-box' });
  // Create says what it makes, never where; no "Runs on" line.
  await expect(dialog(page).getByTestId('create-new-submit')).toHaveText('Create session');
  await expect(dialog(page)).not.toContainText('Runs on');
  // build-box's own profiles.
  await to(page).focus();
  await page.keyboard.type('business');
  await page.keyboard.press('Enter');
  await expect(to(page)).toHaveValue('Greenfield business');
  // Attaching images needs the Session on this computer.
  await expect(dialog(page).getByRole('button', { name: 'Attach' })).toBeDisabled();
  await runOn.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  const runs = await page.evaluate(() => {
    // SAFETY: installElectronApiMock installs this controller before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getMachineRuns: () => Array<{ machineId: string; command: JsonObject }> } };
    return mockWindow.__paneTestElectronMock.getMachineRuns();
  });
  expect(runs).toContainEqual({ machineId: 'build', command: { type: 'create-session', input: expect.objectContaining({ agent: 'claude', agentProfile: 'greenfield/business', name: 'New chat 2', nameFromFirstMessage: true }) } });
  expect(await createInputs(page)).toEqual([]);
});

test('More options holds the old Create Session settings, Back returns, and they reach the create', async ({ page }) => {
  await openApp(page, { distributions: ['Ubuntu-24.04'] });
  await page.getByTestId('new-orchestration-session').click();
  await dialog(page).getByRole('button', { name: 'More options', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Session options', exact: true })).toBeVisible();
  await dialog(page).getByLabel('What is this Session for?').fill('Close the refund backlog.');
  await dialog(page).getByRole('switch', { name: 'Start pinned', exact: true }).click();
  await expect(dialog(page).getByLabel('Launch command', { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Edit behavior…', exact: true })).toBeVisible();
  await dialog(page).getByLabel('Run agent in').selectOption('Ubuntu-24.04');
  await dialog(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'New Session', exact: true })).toBeVisible();
  // Start pinned applies to this Session only, and the main screen says so (QA).
  await expect(dialog(page)).toContainText('Starts pinned. Change it in More options.');
  // In WSL, profiles can't start and images can't be attached.
  await to(page).focus();
  await page.keyboard.type('orch');
  await expect(dialog(page).getByTestId('to-choice-profile:greenfield/orchestrator')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await dialog(page).getByTestId('create-new-submit').click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await createInputs(page))[0]).toMatchObject({ goal: 'Close the refund backlog.', isPinned: true, runtime: 'wsl', wslDistribution: 'Ubuntu-24.04' });
  const configUpdates = await page.evaluate(() => {
    // SAFETY: installElectronApiMock installs this controller before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getConfigUpdates: () => JsonObject[] } };
    return mockWindow.__paneTestElectronMock.getConfigUpdates();
  });
  expect(configUpdates.some(update => 'defaultSessionPinned' in update)).toBe(false);
});

test('Create\'s menu switches to a Pane and is remembered; a Pane\'s More options holds its advanced options', async ({ page }) => {
  await openApp(page);
  await page.addInitScript(() => {
    window.electronAPI.projects.listBranches = async () => ({ success: true, data: [{ name: 'origin/main', isCurrent: true, hasWorktree: false, isRemote: true }] });
    window.electronAPI.sessions.create = async request => {
      localStorage.setItem('__newPaneRequest', JSON.stringify(request));
      return { success: true, data: [] };
    };
  });
  await page.reload();
  await dismissStartupDialogs(page);
  await page.getByTestId('sidebar').getByRole('button', { name: 'New', exact: true }).click();
  await expect(dialog(page)).toHaveAttribute('data-mode', 'session');
  await dialog(page).getByRole('button', { name: 'Create a Session or a Pane', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Create pane' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'New Pane', exact: true })).toBeVisible();
  await expect(dialog(page).getByTestId('create-new-submit')).toHaveText('Create pane');
  await expect(dialog(page).getByLabel('Project', { exact: true })).toHaveValue('1');
  await expect(dialog(page).getByRole('combobox', { name: 'To', exact: true })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  // Remembered: New opens as a Pane next time.
  await page.getByTestId('sidebar').getByRole('button', { name: 'New', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'New Pane', exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'More options', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Pane options', exact: true })).toBeVisible();
  await dialog(page).getByRole('switch', { name: 'Use worktree', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Back', exact: true }).click();
  await dialog(page).locator('#worktreeTemplate').fill('refund-fixes');
  await dialog(page).getByTestId('create-new-submit').click();
  await expect(dialog(page)).toHaveCount(0);
  const request: unknown = await page.evaluate(() => JSON.parse(localStorage.getItem('__newPaneRequest') ?? 'null'));
  expect(request).toMatchObject({ projectId: 1, worktreeTemplate: 'refund-fixes', isMainRepo: true, baseBranch: 'origin/main' });
  // The + beside Sessions still opens a Session.
  await page.getByTestId('new-orchestration-session').click();
  await expect(dialog(page).getByRole('heading', { name: 'New Session', exact: true })).toBeVisible();
});

test('an image attached to the first message is sent through the new Session\'s chat; other files are refused', async ({ page }) => {
  await openApp(page);
  await page.addInitScript(() => {
    const api = window.electronAPI.orchestrationSessions;
    const create = api.create;
    api.create = async input => {
      const result = await create(input);
      if (result.success && result.data) result.data.panel.type = 'chat';
      return result;
    };
    window.electronAPI.chatTab.send = async (panelId, request) => {
      localStorage.setItem('__firstSend', JSON.stringify({ panelId, request }));
      return { operationId: request.operationId, generation: 1, fingerprint: 'x', state: 'accepted' };
    };
  });
  await page.reload();
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fileInput = dialog(page).locator('input[type="file"]');
  await fileInput.setInputFiles([{ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') }]);
  await expect(dialog(page).getByRole('alert')).toContainText('notes.pdf isn\'t attached');
  await fileInput.setInputFiles([{ name: 'screenshot.png', mimeType: 'image/png', buffer: png }]);
  await expect(dialog(page).getByRole('list', { name: 'Attachments' })).toContainText('screenshot.png');
  await dialog(page).getByRole('textbox', { name: 'Message', exact: true }).fill('What is wrong here?');
  await dialog(page).getByTestId('create-new-submit').click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await createInputs(page))[0]).not.toHaveProperty('openingPrompt');
  const sent: unknown = await page.evaluate(() => JSON.parse(localStorage.getItem('__firstSend') ?? 'null'));
  expect(sent).toMatchObject({ request: { text: 'What is wrong here?', images: [{ mimeType: 'image/png', data: png.toString('base64') }] } });
});

test('a Session row shows its profile\'s avatar at the row\'s padding, and a spinner before its badge only while it works (T-63, J18)', async ({ page }, testInfo) => {
  await installSessionsFixture(page, [
    { ...sessionFixture('profiled', 'Profiled', '', '', '2026-09-16T12:00:00.000Z'), agentProfile: { ref: 'greenfield/orchestrator', hash: 'h' } },
    { ...sessionFixture('plain', 'Plain', '', '', '2026-09-16T12:01:00.000Z'), agent: 'codex', agentProfile: { ref: 'pane/codex', hash: 'h' } },
    sessionFixture('older', 'Older', '', '', '2026-09-16T12:02:00.000Z'),
  ], [], {
    initialConfig: PROFILES_ON,
    sessionActivity: [{ sessionId: 'profiled', state: 'working', workingPanes: 0 }, { sessionId: 'older', state: 'working', workingPanes: 0 }],
    notifySnapshot: { settings: { ...DEFAULT_NOTIFY_SETTINGS }, history: [], items: [
      { id: 'q-row', ui: 'approve', title: 'Apply migration?', source: { name: 'checkout', agent: 'Claude', session: { id: 'older', name: 'Older' } }, state: 'waiting', createdAt: Date.now() },
    ] },
  });
  await gotoApp(page);
  await dismissStartupDialogs(page);
  const row = (id: string) => page.getByTestId(`orchestration-session-${id}`);
  await expect(row('profiled').getByTestId('profile-avatar')).toHaveAttribute('aria-label', 'Profile Greenfield orchestrator');
  await expect(row('profiled').getByTestId('profile-avatar')).toHaveText('GO');
  await expect(row('plain').getByTestId('profile-avatar')).toHaveAttribute('aria-label', 'Codex, no profile');
  // A Session from before profiles shows its agent's logo.
  await expect(row('older').getByTestId('profile-avatar')).toHaveAttribute('aria-label', 'Claude, no profile');
  // No reserved left slot: the avatar starts at the row's 8px padding and the name 8px after it.
  for (const id of ['profiled', 'plain', 'older']) {
    const button = await layoutBox(row(id));
    const name = await layoutBox(row(id).locator('span.truncate').first());
    const avatar = await layoutBox(row(id).getByTestId('profile-avatar'));
    expect(avatar.x - button.x).toBe(8);
    expect(avatar.width).toBe(16);
    expect(name.x - button.x).toBe(8 + 16 + 8);
  }
  await expect(row('profiled').getByTestId('session-activity-icon')).toHaveAttribute('data-state', 'working');
  await expect(row('plain').getByTestId('session-activity-icon')).toHaveCount(0);
  // The right side reads spinner, then the approvals badge.
  await expect(row('older').getByTestId('session-approvals-count')).toHaveText('1');
  const spinner = await layoutBox(row('older').getByTestId('session-activity-icon'));
  const badge = await layoutBox(row('older').getByTestId('session-approvals-count'));
  expect(spinner.x + spinner.width).toBeLessThanOrEqual(badge.x);
  const button = await layoutBox(row('older'));
  expect(button.x + button.width - (badge.x + badge.width)).toBeLessThanOrEqual(8);
  await page.screenshot({ path: testInfo.outputPath('j18-session-rows.png') });
});

test('a Session with Panes shows its expand chevron in the avatar\'s place on hover and keyboard focus (T-63)', async ({ page }) => {
  const at = '2026-09-16T12:00:00.000Z';
  await installSessionsFixture(page, [
    { ...sessionFixture('parent', 'Parent', '', '', at, [{ paneId: 'child', panelIds: [], attachedAt: at }]), agentProfile: { ref: 'greenfield/orchestrator', hash: 'h' } },
    { ...sessionFixture('lone', 'Lone', '', '', at), agentProfile: { ref: 'pane/claude', hash: 'h' } },
  ], [paneFixture('child', 'feature/child')], { initialConfig: PROFILES_ON });
  await gotoApp(page);
  await dismissStartupDialogs(page);
  const parent = page.getByTestId('orchestration-session-parent');
  const toggle = page.getByRole('button', { name: 'Expand Parent Panes', exact: true });
  await expect(page.getByRole('button', { name: /Lone Panes/ })).toHaveCount(0);
  // The chevron sits exactly over the avatar, hidden until wanted.
  expect(await layoutBox(toggle)).toEqual(await layoutBox(parent.getByTestId('profile-avatar')));
  await page.mouse.move(900, 600);
  await expect(toggle).toHaveCSS('opacity', '0');
  await expect(parent.getByTestId('profile-avatar')).toBeVisible();
  await parent.focus();
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveCSS('opacity', '1');
  await expect(toggle).toHaveCSS('box-shadow', /rgb/);
  await expect(parent.getByTestId('profile-avatar')).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Collapse Parent Panes', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#orchestration-session-panes-sessions-parent')).toBeVisible();
});

// Codex review of #1695 (F-1 to F-8).

const machineRuns = (page: Page) => page.evaluate(() => {
  // SAFETY: installElectronApiMock installs this controller before the app loads.
  const mockWindow = window as typeof window & { __paneTestElectronMock: { getMachineRuns: () => Array<{ machineId: string; command: JsonObject }> } };
  return mockWindow.__paneTestElectronMock.getMachineRuns();
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const BUILD_ONLINE = { id: 'build', label: 'build-box', kind: 'remote', status: 'online', offlineSince: null } as const;

test('Run on stays on the machine the draft was shown with: one that drops offline holds Create until it is back (F-1)', async ({ page }) => {
  await openApp(page, {
    machineConnections: {
      machines: [{ id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null }, BUILD_ONLINE],
      reads: { build: { 'orchestration-sessions:list': { success: true, data: { sessions: [] } } } },
    },
    machines: { machineRunAnswers: { build: { 'create-session': { success: true, data: { session: { id: 'remote-session' } } } } } },
  });
  await page.getByTestId('new-orchestration-session').click();
  const runOn = dialog(page).getByRole('combobox', { name: 'Run on', exact: true });
  await runOn.selectOption({ label: 'build-box' });
  await dialog(page).getByRole('textbox', { name: 'Message', exact: true }).fill('Rebuild the cache.');
  const setBuild = (status: 'online' | 'offline') => page.evaluate(state => {
    // SAFETY: installElectronApiMock installs this controller before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { emitMachineEvent: (event: JsonObject) => void } };
    mockWindow.__paneTestElectronMock.emitMachineEvent({ type: 'machines', machines: [
      { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
      { id: 'build', label: 'build-box', kind: 'remote', status: state, offlineSince: state === 'offline' ? '2026-11-27T10:00:00' : null },
    ] });
  }, status);
  await setBuild('offline');
  // Run on doesn't fall back to this computer, and Return sends nothing anywhere.
  await expect(runOn).toHaveValue('build');
  await expect(dialog(page).getByTestId('create-new-submit')).toBeDisabled();
  await expect(dialog(page).getByTestId('create-new-blocked')).toHaveText('build-box is offline. Create waits for it, or pick another machine in Run on.');
  await dialog(page).getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Rebuild the cache.');
  expect(await createInputs(page)).toEqual([]);
  expect((await machineRuns(page)).filter(run => run.command.type === 'create-session')).toEqual([]);
  await setBuild('online');
  await expect(dialog(page).getByTestId('create-new-submit')).toBeEnabled();
  await dialog(page).getByTestId('create-new-submit').click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await machineRuns(page)).filter(run => run.command.type === 'create-session')).toHaveLength(1);
});

test('attached images hold Create while the Session can\'t take them, and a too-large image is refused before it is read (F-2)', async ({ page }, testInfo) => {
  await openApp(page, { distributions: ['Ubuntu-24.04'] });
  await page.getByTestId('new-orchestration-session').click();
  const fileInput = dialog(page).locator('input[type="file"]');
  await fileInput.setInputFiles([{ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }]);
  await expect(dialog(page).getByRole('alert')).toContainText('huge.png isn\'t attached: larger than 5.0 MB');
  await expect(dialog(page).getByRole('list', { name: 'Attachments' })).toHaveCount(0);
  await fileInput.setInputFiles([{ name: 'screenshot.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(dialog(page).getByRole('list', { name: 'Attachments' })).toContainText('screenshot.png');
  await dialog(page).getByRole('textbox', { name: 'Message', exact: true }).fill('What is wrong here?');
  await expect(dialog(page).getByTestId('create-new-submit')).toBeEnabled();
  // WSL runs a terminal: the image stays listed and Create waits.
  await dialog(page).getByRole('button', { name: 'More options', exact: true }).click();
  await dialog(page).getByLabel('Run agent in').selectOption('Ubuntu-24.04');
  await dialog(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(dialog(page).getByRole('list', { name: 'Attachments' })).toContainText('screenshot.png');
  await expect(dialog(page).getByTestId('create-new-submit')).toBeDisabled();
  await expect(dialog(page).getByTestId('create-new-blocked')).toContainText('A Session in WSL runs in a terminal');
  await dialog(page).screenshot({ path: testInfo.outputPath('f2-images-held-in-wsl.png') });
  await dialog(page).getByRole('button', { name: 'More options', exact: true }).click();
  await dialog(page).getByLabel('Run agent in').selectOption('');
  await dialog(page).getByRole('button', { name: 'Back', exact: true }).click();
  // Pi has no chat, so it can't take them either.
  await to(page).focus();
  await page.keyboard.type('pi');
  await page.keyboard.press('Enter');
  await expect(to(page)).toHaveValue('Pi');
  await expect(dialog(page).getByTestId('create-new-blocked')).toContainText('Pi runs in a terminal');
  await dialog(page).getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  await expect(dialog(page)).toBeVisible();
  expect(await createInputs(page)).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Remove screenshot.png', exact: true }).click();
  await expect(dialog(page).getByTestId('create-new-submit')).toBeEnabled();
});

test('a first message a PowerShell or cmd terminal can\'t take holds Create and stays editable (F-4)', async ({ page }, testInfo) => {
  await openApp(page, { initialConfig: { chatTabsEnabled: false } });
  await page.addInitScript(() => {
    window.electronAPI.orchestrationSessions.runtimes = async () => ({ success: true, data: { distributions: [], promptAtLaunch: false, chatTabs: false } });
  });
  await page.reload();
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  const message = dialog(page).getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Draft the release notes.');
  await expect(dialog(page).getByTestId('create-new-blocked')).toContainText('PowerShell or cmd');
  await dialog(page).screenshot({ path: testInfo.outputPath('f4-message-held-for-powershell.png') });
  await message.press('Enter');
  await expect(dialog(page).getByRole('alert')).toContainText('PowerShell or cmd');
  await expect(message).toHaveValue('Draft the release notes.');
  expect(await createInputs(page)).toEqual([]);
  // Without a message it creates as before.
  await message.fill('');
  await dialog(page).getByTestId('create-new-submit').click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await createInputs(page)).toHaveLength(1);
});

test('launch settings follow the chosen agent: unedited defaults are main\'s, a profile sends none, and an edited resume says it can\'t take a message (F-5)', async ({ page }) => {
  const resume = { mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} -- --resume {sessionId}' };
  // A saved custom command brings its own resume template (build 8: Create New has no resume options).
  await openApp(page, { initialConfig: { defaultSessionResume: resume, customCommands: [{ name: 'Verbose Claude', command: 'claude --verbose', resume }] } });
  await page.getByTestId('new-orchestration-session').click();
  // Codex, unedited, with a message: main picks the launch; the default custom resume doesn't come along.
  await page.keyboard.type('codex');
  await page.keyboard.press('Enter');
  await dialog(page).getByRole('textbox', { name: 'Message', exact: true }).fill('Tidy the README.');
  await dialog(page).getByTestId('create-new-submit').click();
  await expect(dialog(page)).toHaveCount(0);
  const [plain] = await createInputs(page);
  expect(plain).toMatchObject({ agent: 'codex', customResume: null });
  expect(plain).not.toHaveProperty('launchCommand');
  // A profile with a message: no launch fields that main would validate before the profile replaces them.
  await page.getByTestId('sidebar').getByRole('button', { name: 'New', exact: true }).click();
  await page.keyboard.type('orch');
  await page.keyboard.press('Enter');
  await dialog(page).getByRole('textbox', { name: 'Message', exact: true }).fill('Plan the week.');
  await dialog(page).getByTestId('create-new-submit').click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await createInputs(page))[1]).toMatchObject({ agentProfile: 'greenfield/orchestrator', launchCommand: '', customResume: null });
  // An edited launch with a custom resume and a message: Create says why before anything is created.
  await page.getByTestId('sidebar').getByRole('button', { name: 'New', exact: true }).click();
  await page.keyboard.type('claude');
  await page.keyboard.press('Enter');
  await dialog(page).getByRole('button', { name: 'More options', exact: true }).click();
  await dialog(page).getByLabel('Custom command and arguments', { exact: true }).fill('claude --verbose');
  await dialog(page).getByRole('button', { name: 'Back', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: 'Message', exact: true }).fill('Continue.');
  await expect(dialog(page).getByTestId('create-new-blocked')).toContainText('can\'t take a first message. Its resume template comes from Settings');
  expect(await createInputs(page)).toHaveLength(2);
});

test('Create is only on the main screen; Back returns to it (F-6)', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('new-orchestration-session').click();
  await dialog(page).getByRole('button', { name: 'More options', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Session options', exact: true })).toBeVisible();
  await expect(dialog(page).getByTestId('create-new-submit')).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(dialog(page).getByTestId('create-new-submit')).toBeVisible();
});

test('a Windows machine\'s WSL distributions are offered in More options and reach its create (F-7)', async ({ page }) => {
  await openApp(page, {
    machineConnections: {
      machines: [{ id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null }, BUILD_ONLINE],
      reads: { build: {
        'orchestration-sessions:runtimes': { success: true, data: { distributions: ['Ubuntu-22.04'], promptAtLaunch: true, chatTabs: true } },
        'orchestration-sessions:list': { success: true, data: { sessions: [] } },
      } },
    },
    machines: { machineRunAnswers: { build: { 'create-session': { success: true, data: { session: { id: 'remote-session' } } } } } },
  });
  await page.getByTestId('new-orchestration-session').click();
  await dialog(page).getByRole('combobox', { name: 'Run on', exact: true }).selectOption({ label: 'build-box' });
  await dialog(page).getByRole('button', { name: 'More options', exact: true }).click();
  await dialog(page).getByLabel('Run agent in').selectOption('Ubuntu-22.04');
  await dialog(page).getByRole('button', { name: 'Back', exact: true }).click();
  await dialog(page).getByTestId('create-new-submit').click();
  await expect(dialog(page)).toHaveCount(0);
  const [run] = (await machineRuns(page)).filter(entry => entry.command.type === 'create-session');
  expect(run).toMatchObject({ machineId: 'build', command: { input: { runtime: 'wsl', wslDistribution: 'Ubuntu-22.04' } } });
});

test('a project\'s + opens Create New as a Pane in that project, on this computer (F-8)', async ({ page }) => {
  await openApp(page, { projects: [
    { id: 1, name: 'Pane fixtures', path: '/tmp/pane-fixtures', active: true },
    { id: 2, name: 'Refunds', path: '/tmp/refunds', active: false },
  ] });
  await page.getByRole('button', { name: 'New pane in Refunds', exact: true }).click();
  await expect(dialog(page)).toHaveAttribute('data-mode', 'pane');
  await expect(dialog(page).getByRole('heading', { name: 'New Pane', exact: true })).toBeVisible();
  await expect(dialog(page).getByLabel('Project', { exact: true })).toHaveValue('2');
  await expect(page.getByRole('dialog', { name: 'Create Pane' })).toHaveCount(0);
});

// PANE_PROFILES_SHOTS=<dir> saves To's profile list, light and dark, for review (T-83 P2).
test('To lists profiles by title and description, light and dark', async ({ page }) => {
  const folder = process.env.PANE_PROFILES_SHOTS;
  test.skip(!folder, 'Set PANE_PROFILES_SHOTS to save the screenshots.');
  for (const theme of ['light', 'dark']) {
    await openApp(page, { initialConfig: { theme } });
    await page.getByTestId('new-orchestration-session').click();
    await page.keyboard.type('green');
    await expect(dialog(page).getByRole('listbox', { name: 'Agents and profiles' }).getByRole('option')).toHaveCount(3);
    await page.screenshot({ path: `${folder}/create-new-to-${theme}.png` });
  }
});

test('New Session: To and Name sit 8 px apart, closer than the message box below them (build 9 feedback 5)', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('new-orchestration-session').click();
  // The To box, around its input.
  const toBox = await to(page).locator('..').boundingBox();
  const name = await dialog(page).getByLabel('Name', { exact: true }).boundingBox();
  const message = await dialog(page).getByLabel('Message', { exact: true }).locator('..').boundingBox();
  if (!toBox || !name || !message) throw new Error('The fields are not on screen.');
  // 8 px between the two header fields (was 12), 12 px from Name down to the message box.
  expect(Math.round(name.y - (toBox.y + toBox.height))).toBe(8);
  expect(Math.round(message.y - (name.y + name.height))).toBe(12);
});

// PANE_PROFILES_SHOTS=<dir> saves the New Session dialog, light and dark (build 9 feedback 5).
test('New Session dialog screenshots, light and dark', async ({ page }) => {
  const folder = process.env.PANE_PROFILES_SHOTS;
  test.skip(!folder, 'Set PANE_PROFILES_SHOTS to save the screenshots.');
  for (const theme of ['light', 'dark']) {
    await openApp(page, { initialConfig: { theme } });
    await page.getByTestId('new-orchestration-session').click();
    await page.waitForTimeout(400);
    await dialog(page).screenshot({ path: `${folder}/r5-new-session-${theme}.png` });
  }
});

// PANE_PROFILES_SHOTS=<dir> saves More options, light and dark, scrolled to its launch fields (build 8: no resume options).
test('More options screenshots, light and dark', async ({ page }) => {
  const folder = process.env.PANE_PROFILES_SHOTS;
  test.skip(!folder, 'Set PANE_PROFILES_SHOTS to save the screenshots.');
  for (const theme of ['light', 'dark']) {
    await openApp(page, { initialConfig: { theme, defaultSessionCommand: 'my-agent --chat', defaultSessionResume: SETTINGS_RESUME } });
    await page.getByTestId('new-orchestration-session').click();
    await dialog(page).getByRole('button', { name: 'More options', exact: true }).click();
    await dialog(page).getByLabel('Launch command', { exact: true }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${folder}/new-more-options-${theme}.png` });
  }
});

test('Create New has no resume options: Pane resumes chat Sessions itself, and a custom command\'s resume comes from Settings (build 8)', async ({ page }) => {
  await openApp(page, { initialConfig: { defaultSessionCommand: 'my-agent --chat', defaultSessionResume: SETTINGS_RESUME, customCommands: [{ name: 'Saved agent', command: 'saved-agent', resume: SAVED_RESUME }] } });
  await page.getByTestId('new-orchestration-session').click();
  await dialog(page).getByRole('button', { name: 'More options', exact: true }).click();
  await expect(dialog(page).getByLabel('Launch command', { exact: true })).toBeVisible();
  await expect(dialog(page).getByText('Enable custom command resume')).toHaveCount(0);
  await expect(dialog(page).getByLabel('Resume template')).toHaveCount(0);
  await expect(dialog(page).getByTestId('create-new-resume-note')).toContainText('Settings');
  // A saved command brings its own resume; the Settings default command brings the Settings template.
  await dialog(page).getByLabel('Launch command', { exact: true }).selectOption({ label: 'Saved agent' });
  await dialog(page).getByRole('button', { name: 'Back', exact: true }).click();
  await dialog(page).getByTestId('create-new-submit').click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await createInputs(page))[0]).toMatchObject({ launchCommand: 'saved-agent', customResume: SAVED_RESUME });
  // A command typed here, which Settings doesn't know, gets no resume template.
  await page.getByTestId('new-orchestration-session').click();
  await dialog(page).getByRole('button', { name: 'More options', exact: true }).click();
  await dialog(page).getByLabel('Custom command and arguments').fill('typed-agent --x');
  await dialog(page).getByRole('button', { name: 'Back', exact: true }).click();
  await dialog(page).getByTestId('create-new-submit').click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await createInputs(page))[1]).toMatchObject({ launchCommand: 'typed-agent --x', customResume: null });
  // A command is remembered with its own template (#1762 F-1): the Settings template is never written alone.
  const configUpdates = await page.evaluate(() => {
    // SAFETY: installElectronApiMock installs this controller before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getConfigUpdates: () => JsonObject[] } };
    return mockWindow.__paneTestElectronMock.getConfigUpdates();
  });
  expect(configUpdates.filter(update => 'defaultSessionResume' in update)).toEqual([
    expect.objectContaining({ defaultSessionCommand: 'saved-agent', defaultSessionResume: SAVED_RESUME }),
    expect.objectContaining({ defaultSessionCommand: 'typed-agent --x', defaultSessionResume: null }),
  ]);
});

test('with Profiles off, the Create Session dialog keeps its resume options', async ({ page }) => {
  await installSessionsFixture(page, [], [], { agentFarmProfiles: PROFILES });
  await gotoApp(page);
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  const classic = page.getByRole('dialog', { name: 'Create Session', exact: true });
  await classic.getByText('Launch command and behavior').click();
  await expect(classic.getByText('Enable custom command resume')).toBeVisible();
});
