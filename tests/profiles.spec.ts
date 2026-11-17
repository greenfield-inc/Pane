import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { expect, test, type Page } from '@playwright/test';
import { flowEdges } from '../shared/profiles/flowGraph';
import type { LibraryProfile, ProfileLibraryView } from '../shared/types/profiles';
import { loadProfiles, type ProfileSource } from '../main/src/services/profiles/profileLoader';
import { installElectronApiMock } from './electronApiMock';

const REPO = path.join(__dirname, '..');
const BUNDLED = path.join(REPO, 'main/src/services/profiles/bundled');
const INVALID = path.join(REPO, 'shared/profiles/fixtures/invalid');
const PLUGINS = path.join(path.dirname(require.resolve('@greenfieldco/agent-farm/package.json', { paths: [path.join(REPO, 'main')] })), 'plugins');
const SCREENSHOTS = process.env.PROFILES_SCREENSHOT_DIR;

const projects = [{ id: 1, name: 'Pane', path: '/tmp/pane', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }];

/** What the mock serves: the library and each profile's file text. */
interface MockLibrary {
  view: ProfileLibraryView;
  yaml: Record<string, string>;
}

/** The library as main builds it: the shipped profiles (reads in the bundled plugin) and three broken ones of yours. */
function library(): MockLibrary {
  const sources: ProfileSource[] = readdirSync(BUNDLED).filter((file) => file.endsWith('.profile.yaml')).map((file) => ({ file: path.join(BUNDLED, file), origin: 'bundled', filesRoot: path.join(PLUGINS, file.replace('.profile.yaml', '')) }));
  for (const name of ['one-sample', 'missing-step', 'unreachable']) sources.push({ file: path.join(INVALID, `${name}.profile.yaml`), origin: 'yours' });
  const profiles: LibraryProfile[] = loadProfiles(sources).map((profile) => ({ ...profile, enabled: profile.origin === 'yours' || profile.name === 'greenfield' }));
  return { view: { profiles }, yaml: Object.fromEntries(profiles.map((profile) => [profile.name, readFileSync(profile.file, 'utf8')])) };
}

async function openProfiles(page: Page, width = 1_440, theme = 'dark') {
  const { view, yaml } = library();
  await page.setViewportSize({ width, height: 900 });
  await installElectronApiMock(page, { initialProjects: projects, initialSessions: [], initialConfig: { theme, appearanceMode: 'fixed' }, profileLibrary: view, profileYaml: yaml });
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
  await expect(page.getByTestId('profile-flow-step')).toHaveCount(flow.steps.length);
  await expect(page.getByTestId('profile-flow-edge')).toHaveCount(flowEdges(flow).length);
  for (const step of flow.steps) await expect(page.locator(`[data-testid="profile-flow-step"][data-step="${step.id}"]`)).toHaveAttribute('data-kind', step.kind);
  for (const edge of flowEdges(flow)) await expect(page.locator(`[data-testid="profile-flow-edge"][data-from="${edge.from}"][data-label="${edge.label}"]`)).toHaveCount(1);
  await shoot(page, 'j3-graph');

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

test('J8: team-only and invalid profiles are listed with Launch disabled and the exact error', async ({ page }) => {
  await openProfiles(page);
  await page.locator('[data-testid="profile-list-item"][data-profile="orchestra"]').click();
  await expect(page.getByTestId('profile-viewer')).toHaveAttribute('data-profile', 'orchestra');
  await expect(page.getByTestId('profile-badge').last()).toHaveText('team only');
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

test('launch dialog: a CLI per agent, and "Other…" marks the run baseline only', async ({ page }) => {
  await openProfiles(page);
  await page.getByTestId('profile-launch').click();
  const dialog = page.getByTestId('launch-profile-dialog');
  await expect(dialog.getByTestId('launch-agent-row')).toHaveCount(5);
  await expect(dialog.getByTestId('launch-baseline-note')).toHaveCount(0);
  await dialog.getByLabel('CLI for implementer').selectOption({ label: 'Other…' });
  await dialog.getByLabel('Command for implementer').fill('node ./stub-agent.js');
  await expect(dialog.getByTestId('launch-baseline-note')).toContainText('implementer');
  await dialog.getByLabel('Task').fill('Export invoices as CSV');
  await shoot(page, 'launch-dialog');
  await page.getByTestId('launch-profile-submit').click();
  await expect(page.getByRole('alert')).toContainText('not available in this preview');
});

for (const theme of ['dark', 'light-rounded']) {
  for (const width of [1_440, 900, 700]) {
    test(`J12: the Profiles page at ${width}px (${theme}) has no horizontal page scroll and no text under 11px`, async ({ page }) => {
      await openProfiles(page, width, theme);
      await expect(page.getByTestId('profile-flow-svg')).toBeVisible();
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
