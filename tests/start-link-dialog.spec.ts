import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { boot, openSearch } from './commandPaletteFixture';

const SHOTS = process.env.PANE_START_LINK_SHOTS;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const LONG_PROMPT = [
  'Fix the flaky login test in tests/auth/login.spec.ts.',
  '',
  'It fails about one run in ten on CI with "element not attached to the DOM" after the redirect.',
  'Steps:',
  '1. Run the spec 20 times with --repeat-each to reproduce it.',
  '2. Find the race between the redirect and the form submit.',
  '3. Wait on the navigation, not on a timeout.',
  '4. Keep the test under 5 seconds.',
  'Open a pull request when it passes 50 runs in a row.',
].join('\n');

const AGENTS: JsonObject[] = [
  { id: 'claude', label: 'Claude', installed: true },
  { id: 'codex', label: 'Codex', installed: true },
  { id: 'cursor', label: 'Cursor', installed: false },
  { id: 'opencode', label: 'OpenCode', installed: false },
];

function request(overrides: JsonObject = {}): JsonObject {
  return {
    requestId: 'r-1',
    prompt: LONG_PROMPT,
    agents: AGENTS,
    agent: 'claude',
    linkAgent: null,
    targets: [
      { kind: 'repo', repoId: 3, repoName: 'acme-app', identity: 'github.com/acme/app' },
      { kind: 'new-session' },
    ],
    ...overrides,
  };
}

async function emitRequest(page: Page, value: JsonObject) {
  await page.evaluate((payload) => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    (window as typeof window & { __paneTestElectronMock: { emitStartLinkRequest: (request: JsonObject) => void } })
      .__paneTestElectronMock.emitStartLinkRequest(payload);
  }, value);
  return page.getByTestId('start-link-dialog');
}

async function answers(page: Page) {
  return page.evaluate(() => {
    // SAFETY: as above.
    const mock = (window as typeof window & { __paneTestElectronMock: { getInvokeCalls: (channel: string) => Array<{ args: JsonObject[] }> } }).__paneTestElectronMock;
    return mock.getInvokeCalls('pane:start-link-answer').map((call) => call.args[0]);
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`screenshots the start link dialog and the link builder (${theme})`, async ({ page }) => {
    test.skip(!SHOTS, 'Set PANE_START_LINK_SHOTS to a folder to take these screenshots.');
    await page.setViewportSize({ width: 1280, height: 860 });
    await boot(page, { activePaneId: '', initialConfig: { theme, appearanceMode: 'fixed' } });

    let dialog = await emitRequest(page, request());
    await expect(dialog.getByRole('button', { name: 'Start' })).toBeEnabled();
    await shoot(page, `01-default-${theme}`);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    dialog = await emitRequest(page, request({ requestId: 'r-2', linkAgent: 'cursor' }));
    await dialog.getByRole('button', { name: 'Options' }).click();
    await shoot(page, `02-options-${theme}`);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    dialog = await emitRequest(page, request({
      requestId: 'r-3',
      prompt: 'Summarize what changed in the release branch since Monday.',
      targets: [{ kind: 'session', sessionId: 's-1', sessionName: 'Build fixes', agent: 'codex' }, { kind: 'new-session' }],
    }));
    await dialog.getByRole('button', { name: 'Options' }).click();
    await shoot(page, `03-session-${theme}`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    const search = await openSearch(page);
    await search.fill('Open in Pane link');
    await page.keyboard.press('Enter');
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    await expect(prompt).toBeFocused();
    await shoot(page, `04-builder-empty-${theme}`);
    await prompt.fill('Fix the flaky login test in tests/auth/login.spec.ts.\nOpen a pull request when it passes 50 runs in a row.');
    await page.getByRole('combobox', { name: 'Runs in' }).click();
    await page.getByRole('option', { name: 'A repository' }).click();
    await page.getByRole('textbox', { name: 'Repository' }).fill('acme/app');
    await shoot(page, `05-builder-${theme}`);
    await prompt.fill('x'.repeat(2_100));
    await shoot(page, `06-builder-too-long-${theme}`);
    await prompt.fill('-rf everything');
    await shoot(page, `07-builder-problem-${theme}`);
  });
}

test('Cancel has focus and Enter answers Cancel; Start waits before it can be pressed', async ({ page }) => {
  await boot(page, { activePaneId: '' });
  const dialog = await emitRequest(page, request());
  await expect(dialog.getByRole('heading', { name: 'Start Claude on this prompt?' })).toBeVisible();
  await expect(dialog.getByText('Runs in a new Pane in acme-app.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  const start = dialog.getByRole('button', { name: 'Start' });
  await expect(start).toBeDisabled();
  await expect(start).toBeEnabled();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  expect(await answers(page)).toEqual([{ requestId: 'r-1', start: false }]);
});

test('Escape answers Cancel', async ({ page }) => {
  await boot(page, { activePaneId: '' });
  const dialog = await emitRequest(page, request());
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await answers(page)).toEqual([{ requestId: 'r-1', start: false }]);
});

test('Show all reveals the whole prompt', async ({ page }) => {
  await boot(page, { activePaneId: '' });
  const dialog = await emitRequest(page, request());
  const prompt = dialog.getByLabel('Prompt');
  await expect(prompt).not.toContainText('50 runs in a row');
  await dialog.getByRole('button', { name: 'Show all' }).click();
  await expect(prompt).toContainText('50 runs in a row');
  await dialog.getByRole('button', { name: 'Show less' }).click();
  await expect(prompt).not.toContainText('50 runs in a row');
});

test('Start sends the agent and target chosen under Options', async ({ page }) => {
  await boot(page, { activePaneId: '' });
  const dialog = await emitRequest(page, request({ linkAgent: 'cursor' }));
  // Shown before Options opens: a different agent runs than the link asked for.
  await expect(dialog.getByText("The link asks for Cursor, which isn't installed on this computer")).toBeVisible();
  await dialog.getByRole('button', { name: 'Options' }).click();
  await expect(dialog.getByRole('radio', { name: 'Cursor' })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'Codex' }).check();
  await dialog.getByRole('radio', { name: 'A new Session' }).check();
  await expect(dialog.getByRole('heading', { name: 'Start Codex on this prompt?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect(dialog).toBeHidden();
  expect(await answers(page)).toEqual([{ requestId: 'r-1', start: true, agent: 'codex', target: 1 }]);
});
