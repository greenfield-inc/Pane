import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { expect, test, type Page } from '@playwright/test';
import { flowEdges } from '../shared/profiles/flowGraph';
import type { LibraryProfile, ProfileLaunchInput, ProfileLibraryView } from '../shared/types/profiles';
import { loadProfiles, type ProfileSource } from '../main/src/services/profiles/profileLoader';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';

type MockWindow = Window & { __paneTestElectronMock: { getInvokeCalls(channel: string): Array<{ args: unknown[] }> } };

const REPO = path.join(__dirname, '..');
const BUNDLED = path.join(REPO, 'main/src/services/profiles/bundled');
const FIXTURES = path.join(REPO, 'shared/profiles/fixtures');
const INVALID = path.join(FIXTURES, 'invalid');
const PLUGINS = path.join(path.dirname(require.resolve('@greenfieldco/agent-farm/package.json', { paths: [path.join(REPO, 'main')] })), 'plugins');
const SCREENSHOTS = process.env.PROFILES_SCREENSHOT_DIR;

const projects = [{ id: 1, name: 'Pane', path: '/tmp/pane', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }];

/** What the mock serves: the library and each profile's file text. */
interface MockLibrary {
  view: ProfileLibraryView;
  yaml: Record<string, string>;
}

/** The library as main builds it: the shipped profiles (reads in the bundled plugin), one of yours with no flow and three broken ones. */
function library(): MockLibrary {
  const sources: ProfileSource[] = readdirSync(BUNDLED).filter((file) => file.endsWith('.profile.yaml')).map((file) => ({ file: path.join(BUNDLED, file), origin: 'bundled', filesRoot: path.join(PLUGINS, file.split('.')[0]) }));
  sources.push({ file: path.join(FIXTURES, 'team-only.profile.yaml'), origin: 'yours' });
  for (const name of ['one-sample', 'missing-step', 'unreachable']) sources.push({ file: path.join(INVALID, `${name}.profile.yaml`), origin: 'yours' });
  const profiles: LibraryProfile[] = loadProfiles(sources).map((profile) => ({ ...profile, enabled: profile.origin === 'yours' || profile.name === 'greenfield' }));
  return { view: { profiles }, yaml: Object.fromEntries(profiles.map((profile) => [profile.name, readFileSync(profile.file, 'utf8')])) };
}

async function openProfiles(page: Page, width = 1_440, theme = 'dark') {
  const { view, yaml } = library();
  await page.setViewportSize({ width, height: 900 });
  const options: ElectronApiMockOptions = { initialProjects: projects, initialSessions: [], initialConfig: { theme, appearanceMode: 'fixed', profilesEnabled: true }, profileLibrary: view, profileYaml: yaml };
  await installElectronApiMock(page, options);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('profiles-nav').click();
  await expect(page.getByTestId('profiles-view')).toBeVisible();
}

async function shoot(page: Page, name: string) {
  if (SCREENSHOTS) await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`), fullPage: true });
}

test('J3: greenfield\'s flow has one box per step and one labelled arrow per outcome, choice or next', async ({ page }) => {
  await openProfiles(page);
  const greenfield = library().view.profiles.find((profile) => profile.name === 'greenfield');
  const flow = greenfield?.profile?.flow;
  if (!flow) throw new Error('greenfield has no flow');
  await expect(page.getByTestId('profile-viewer')).toHaveAttribute('data-profile', 'greenfield');
  // greenfield.profile.yaml: 11 steps; 18 ways out (2 per agent step × 5, 2 for checks, 2 per choice ask × 2, 1 per next ask × 2).
  await expect(page.getByTestId('profile-flow-step')).toHaveCount(11);
  await expect(page.getByTestId('profile-flow-edge')).toHaveCount(18);
  for (const step of flow.steps) await expect(page.locator(`[data-testid="profile-flow-step"][data-step="${step.id}"]`)).toHaveAttribute('data-kind', step.kind);
  for (const edge of flowEdges(flow)) await expect(page.locator(`[data-testid="profile-flow-edge"][data-from="${edge.from}"][data-label="${edge.label}"]`)).toHaveCount(1);
  // The page opens on the graph alone: samples, example runs and Team sit under Details (D-109).
  await expect(page.getByTestId('profile-sample-button')).toHaveCount(0);
  await expect(page.getByTestId('profile-tab-team')).toHaveCount(0);
  await expect(page.getByTestId('profile-launch-sentence')).toHaveText('Launch runs this flow in a new Pane, one tab per step, and asks you at each of its questions.');
  await shoot(page, 'j3-graph');
  await page.getByTestId('profile-details-toggle').click();

  // Example runs light different paths over the same boxes.
  await page.getByTestId('profile-run-toggle-A').click();
  await expect(page.getByTestId('profile-flow-step')).toHaveCount(flow.steps.length);
  await expect(page.getByTestId('profile-run-story').locator('li')).toHaveCount(greenfield?.profile?.runs.A.length ?? 0);
  const fadedA = await page.locator('[data-testid="profile-flow-step"].opacity-40').count();
  await shoot(page, 'j3-run-a');
  await page.getByTestId('profile-run-toggle-B').click();
  await expect(page.getByTestId('profile-run-story').locator('li')).toHaveCount(greenfield?.profile?.runs.B.length ?? 0);
  const fadedB = await page.locator('[data-testid="profile-flow-step"].opacity-40').count();
  expect(fadedA).toBeGreaterThan(fadedB);

  // A sample opens on click.
  await page.getByRole('button', { name: 'Samples for plan › needs you' }).click();
  await expect(page.getByTestId('profile-sample-popover')).toContainText('Q-1: Should the CSV include refunded invoices?');
  await shoot(page, 'j3-sample');

  // Team and YAML show the same agents as the file.
  await page.getByTestId('profile-tab-team').click();
  await expect(page.getByTestId('profile-team-agent')).toHaveCount(greenfield?.profile?.agents.length ?? 0);
  for (const agent of greenfield?.profile?.agents ?? []) await expect(page.getByTestId('profile-team')).toContainText(agent.id);
  await page.getByTestId('profile-tab-yaml').click();
  await expect(page.getByTestId('profile-yaml')).toContainText('format: pane-profile/1');
  await expect(page.getByTestId('profile-yaml')).toContainText('qa-lead:');
});

test('J8: a profile with no flow and invalid ones are listed with Launch disabled and the exact error', async ({ page }) => {
  await openProfiles(page);
  await page.locator('[data-testid="profile-list-item"][data-profile="team-only"]').click();
  await expect(page.getByTestId('profile-viewer')).toHaveAttribute('data-profile', 'team-only');
  await expect(page.getByTestId('profile-badge').last()).toHaveText('no flow');
  await expect(page.getByTestId('profile-flow-team-only')).toBeVisible();
  await expect(page.getByTestId('profile-launch')).toBeDisabled();

  await page.locator('[data-testid="profile-list-item"][data-profile="one-sample"]').click();
  await expect(page.getByTestId('profile-errors')).toContainText('Step draft, outcome stuck has 1 sample. Every outcome of an agent step needs at least 2, so its picture can show how results vary.');
  await expect(page.getByTestId('profile-launch')).toBeDisabled();
  await page.locator('[data-testid="profile-list-item"][data-profile="missing-step"]').click();
  await expect(page.getByTestId('profile-errors')).toContainText('EDGE_TARGET_MISSING');
  await page.locator('[data-testid="profile-list-item"][data-profile="unreachable"]').click();
  await expect(page.getByTestId('profile-errors')).toContainText('STEP_UNREACHABLE');
  await expect(page.getByTestId('profile-launch')).toBeDisabled();
  await shoot(page, 'j8-invalid');
});

test('the library lists greenfield under On and every dcouple profile under Ready to add, each launchable once added', async ({ page }) => {
  await openProfiles(page);
  await expect(page.getByRole('heading', { name: 'On', exact: true })).toBeVisible();
  const ready = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Ready to add' }) });
  await expect(ready.getByTestId('profile-list-item')).toHaveCount(9);
  await expect(page.getByText('team only')).toHaveCount(0);
  await ready.locator('[data-profile="dcouple-raw"]').click();
  await expect(page.getByTestId('profile-flow-step')).toHaveCount(1);
  await expect(page.getByTestId('profile-launch-sentence')).toHaveText('Launch runs this agent on your request in a new Pane.');
  await expect(page.getByTestId('profile-toggle-enabled')).toHaveText('Add');
  await expect(page.getByTestId('profile-launch')).toBeDisabled();
  await shoot(page, 'library-dcouple');
});

test('Profiles is hidden until Settings turns it on, and appears without a restart', async ({ page }) => {
  await installElectronApiMock(page, { initialProjects: projects, initialSessions: [], initialConfig: { theme: 'dark', appearanceMode: 'fixed' }, profileLibrary: library().view });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Settings' }).first()).toBeVisible();
  await expect(page.getByTestId('profiles-nav')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Profiles' });
  await expect(toggle).not.toBeChecked();
  await shoot(page, 'settings-off');
  await toggle.click();
  await expect(toggle).toBeChecked();
  await shoot(page, 'settings-on');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByTestId('profiles-nav')).toBeVisible();
});

test('launch dialog: a CLI per agent, and "Other…" marks the run baseline only', async ({ page }) => {
  await openProfiles(page);
  await page.getByTestId('profile-launch').click();
  const dialog = page.getByTestId('launch-profile-dialog');
  await expect(dialog.getByTestId('launch-agent-row')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Close modal' })).toHaveCount(1);
  await expect(dialog.getByTestId('launch-baseline-note')).toHaveCount(0);
  await dialog.getByLabel('CLI for implementer').selectOption({ label: 'Other…' });
  await dialog.getByLabel('Command for implementer').fill('node ./stub-agent.js');
  await expect(dialog.getByTestId('launch-baseline-note')).toContainText('implementer');
  // The commands the profile runs on its own are listed before anything starts.
  await expect(dialog.getByTestId('launch-commands')).toContainText('gh pr checks --watch');
  await expect(dialog.getByTestId('launch-commands')).toContainText('gh pr merge --merge');
  await dialog.getByLabel('Task').fill('Export invoices as CSV');
  await shoot(page, 'launch-dialog');
  await page.getByTestId('launch-profile-submit').click();
  await expect(page.getByRole('alert')).toContainText('not available in this preview');
  // SAFETY: installElectronApiMock installs __paneTestElectronMock before navigation.
  const [[sent]] = await page.evaluate(() => (window as MockWindow).__paneTestElectronMock.getInvokeCalls('profiles:launch').map((call) => call.args));
  expect(sent).toMatchObject<Partial<ProfileLaunchInput>>({ profile: 'greenfield', prompt: 'Export invoices as CSV', harness: { implementer: 'other-implementer' }, commands: { 'other-implementer': 'node ./stub-agent.js' } });
});

for (const theme of ['dark', 'light-rounded']) {
  for (const width of [1_440, 900, 700]) {
    test(`J12: the Profiles page at ${width}px (${theme}) has no horizontal page scroll and no text under 11px`, async ({ page }) => {
      await openProfiles(page, width, theme);
      await expect(page.getByTestId('profile-flow-svg')).toBeVisible();
      // A drawing wider than its column scrolls from its left edge: none of it is cut off out of reach.
      const clipped = await page.getByTestId('profile-flow-svg').evaluate((svg) => {
        const scroller = svg.closest('[data-testid="profile-flow-scroll"]');
        if (!scroller) return 'no scroller';
        scroller.scrollLeft = 0;
        return svg.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
      });
      expect(clipped).toBeGreaterThanOrEqual(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const tooSmall = await page.getByTestId('profiles-view').evaluate((root) => [...root.querySelectorAll<HTMLElement | SVGElement>('*')]
        .filter((element) => element.childNodes.length > 0 && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
        .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 11)
        .map((element) => `${element.tagName}:${element.textContent?.trim().slice(0, 30)}`));
      expect(tooSmall).toEqual([]);
      await shoot(page, `j12-${theme}-${width}`);
    });
  }
}
