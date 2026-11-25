import { expect, test, type Page } from '@playwright/test';
import { gotoApp } from './electronApiMock';
import { dismissStartupDialogs, installSessionsFixture, sessionFixture } from './orchestrationSessionsFixture';
import { expectNoAxeViolations } from './axeTest';
import type { ProfilePlugin, ProfilesOverview } from '../shared/types/profileEditor';

/**
 * The Profiles tab (T-63 PR 5): the list, a profile's files with the open file beside them, Back,
 * Save, New profile / subagent / skill / reference, Restore for an edited Pane plugin, and photos.
 * PANE_PROFILES_SHOTS=<dir> also saves a screenshot of each screen, light and dark, for review.
 */

const identity = (description: string, extra = '') => `---\nharness: claude\nmodel: claude-opus-5-5\ndescription: ${description}${extra}\n---\n\n`;

function plugin(name: string, version: string, bundled: boolean, profiles: Array<[string, string, string]>, files: string[]): ProfilePlugin {
  return {
    name, version, bundled, edited: false, files: [...files].sort(),
    profiles: profiles.map(([profile, harness, description]) => ({
      name: profile, ref: `${name}/${profile}`, entry: `agents/${profile}.md`, harness, model: harness === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', description,
      uses: ['plugin.yaml', `profiles/${profile}.yaml`, `agents/${profile}.md`].sort(),
    })),
  };
}

function fixture() {
  const greenfield = plugin('greenfield', '0.0.46', true, [
    ['orchestrator', 'claude', 'Plans, builds and reviews with subagents'],
    ['planner', 'claude', 'Turns a request into a plan'],
    ['implementer', 'claude', 'Builds an approved plan'],
    ['reviewer', 'codex', 'Reviews a pull request'],
  ], ['plugin.yaml', 'profiles/orchestrator.yaml', 'profiles/planner.yaml', 'profiles/implementer.yaml', 'profiles/reviewer.yaml', 'agents/orchestrator.md', 'agents/planner.md', 'agents/implementer.md', 'agents/reviewer.md', 'instructions/standing-rules.md', 'skills/plan/SKILL.md', 'skills/review/SKILL.md', 'references/cover-sheet/cover-sheet.md']);
  greenfield.profiles[0].uses = ['agents/implementer.md', 'agents/orchestrator.md', 'agents/planner.md', 'agents/reviewer.md', 'instructions/standing-rules.md', 'plugin.yaml', 'profiles/orchestrator.yaml', 'skills/plan/SKILL.md', 'skills/review/SKILL.md'];
  const dcouple = plugin('dcouple', '0.1.27', true, [['business', 'claude', 'Keeps the sprint tracker up to date'], ['implementer', 'codex', 'Ticket to reviewed pull request']],
    ['plugin.yaml', 'profiles/business.yaml', 'profiles/implementer.yaml', 'agents/business.md', 'agents/implementer.md']);
  const bloomtext = plugin('bloomtext', '0.1.0', false, [['support', 'claude', 'Answers support tickets'], ['ops', 'codex', 'Keeps servers healthy']],
    ['plugin.yaml', 'profiles/support.yaml', 'profiles/ops.yaml', 'agents/support.md', 'agents/ops.md', 'skills/triage/SKILL.md']);
  const writer = plugin('writer', '0.0.3', false, [['writer', 'claude', 'Drafts blog posts']], ['plugin.yaml', 'profiles/writer.yaml', 'agents/writer.md']);
  const files: Record<string, string> = {};
  for (const entry of [greenfield, dcouple, bloomtext, writer]) {
    for (const file of entry.files) files[`${entry.name}/${file}`] = `# ${file}\n`;
    files[`${entry.name}/plugin.yaml`] = `name: ${entry.name}\nversion: ${entry.version}\ncli_major: 0\n`;
  }
  files['greenfield/agents/orchestrator.md'] = `${identity('Coordinate planners, implementers and reviewers for one workstream.', '\nsubagents:\n  planner: { agent: planner, mode: native }\nskills: [plan, review]\ninstructions_files: [../instructions/standing-rules.md]')}# Orchestrator\n\nYou run one workstream. Plan before building: send planning to the planner, building to the\nimplementer, and every pull request to the reviewer.\n\nKeep one map of the work. Ask the person only for decisions that are theirs.\n`;
  const overview: ProfilesOverview = { machine: 'studio-mac', plugins: [greenfield, dcouple, bloomtext, writer] };
  return { overview, files };
}

async function openProfilesTab(page: Page, options: { theme?: string; saveError?: string } = {}): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const data = fixture();
  await installSessionsFixture(page, [
    { ...sessionFixture('s1', 'Session profiles plan', '', '', '2026-11-25T08:00:00.000Z'), agentProfile: { ref: 'greenfield/orchestrator', hash: 'h1' } },
    { ...sessionFixture('s2', 'Weekend blog post', '', '', '2026-11-25T08:01:00.000Z'), agentProfile: { ref: 'pane/claude', hash: 'h' } },
    { ...sessionFixture('s3', 'Sprint tracker upkeep', '', '', '2026-11-25T08:02:00.000Z'), agentProfile: { ref: 'dcouple/business', hash: 'h2' } },
  ], [], { initialConfig: { theme: options.theme ?? 'light' }, profileEditor: { ...data, saveError: options.saveError } });
  await gotoApp(page);
  await dismissStartupDialogs(page);
  await page.getByTestId('profiles-nav').click();
  await expect(page.getByTestId('profiles-view')).toBeVisible();
}

/** Changes a profile file "on disk" behind the tab's back, as an agent, the CLI or sync would. Null removes it. */
const writeOnDisk = (page: Page, plugin: string, path: string, content: string | null) => page.evaluate(({ plugin, path, content }) => {
  // SAFETY: installElectronApiMock adds this control before the app loads.
  const mockWindow = window as typeof window & { __paneTestElectronMock: { writeProfileFile: (plugin: string, path: string, content: string | null) => void } };
  mockWindow.__paneTestElectronMock.writeProfileFile(plugin, path, content);
}, { plugin, path, content });

const shotsDir = process.env.PANE_PROFILES_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  // Menus and dialogs finish their entrance first.
  await page.waitForTimeout(400);
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/${name}.png` });
}

test('the list shows every profile by plugin, with no computer filters, and opens one with Enter', async ({ page }) => {
  await openProfilesTab(page);
  const view = page.getByTestId('profiles-view');
  await expect(view.getByRole('heading', { name: 'Profiles' })).toBeVisible();
  await expect(page.getByTestId('profiles-machine')).toHaveText('on studio-mac');
  await expect(page.getByTestId('profiles-plugin-greenfield')).toContainText('Ships with Pane');
  await expect(page.getByTestId('profile-row-greenfield-orchestrator')).toContainText('1 Session · Claude');
  await expect(page.getByTestId('profile-row-greenfield-reviewer')).toContainText('Codex');
  // Sync comes with the next update (PR 6); its button says so and does nothing yet.
  await expect(page.getByTestId('profiles-sync')).toBeDisabled();
  await expect(page.getByTestId('profiles-footer')).toContainText('4 plugins · 9 profiles · 2 Sessions use one');
  await expect(page.getByTestId('profiles-footer')).toContainText('arrives in the next update');
  await expect(view.getByRole('button', { name: /computer/i })).toHaveCount(0);
  // Keyboard: the first profile has focus; ↓ moves, Enter opens.
  await expect(page.getByTestId('profile-row-greenfield-orchestrator')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('profile-row-greenfield-planner')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('profiles-title')).toHaveText('Greenfield orchestrator');
  await expectNoAxeViolations(page, { include: '[data-testid="profiles-view"]' });
});

test('a profile shows its files beside the open identity file; Esc and Back return to the list', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-orchestrator').click();
  await expect(page.getByTestId('profiles-path')).toHaveText('greenfield/agents/orchestrator.md');
  await expect(page.getByTestId('profiles-editor')).toHaveValue(/# Orchestrator/);
  await expect(page.getByTestId('profiles-file-agents/orchestrator.md')).toContainText('identity');
  await expect(page.getByTestId('profiles-file-skills/plan/SKILL.md')).toBeVisible();
  await expect(page.getByTestId('profiles-editor-status')).toHaveText('Ships with Pane. Saving makes it yours on this computer');
  await page.getByTestId('profiles-file-plugin.yaml').click();
  await expect(page.getByTestId('profiles-editor')).toHaveValue(/name: greenfield/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('profile-row-greenfield-orchestrator')).toBeVisible();
  await page.getByTestId('profile-row-writer-writer').click();
  await page.getByTestId('profiles-back').click();
  await expect(page.getByTestId('profiles-list')).toBeVisible();
});

test('editing and ⌘S saves; Pane\'s own plugin becomes Edited and Restore brings its version back', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-orchestrator').click();
  const editor = page.getByTestId('profiles-editor');
  await expect(page.getByTestId('profiles-save')).toBeDisabled();
  await editor.click();
  await page.keyboard.press('End');
  await editor.pressSequentially('\nMarker: KUMQUAT');
  await expect(page.getByTestId('profiles-editor-status')).toHaveText('Unsaved changes');
  await expect(page.getByTestId('profiles-file-dirty')).toHaveCount(1);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect(page.getByTestId('profiles-notice')).toContainText('Saved greenfield/agents/orchestrator.md. 1 Session can reload it.');
  await expect(page.getByTestId('profiles-file-dirty')).toHaveCount(0);
  await expect(page.getByTestId('profiles-restore')).toBeVisible();
  await expect(page.getByTestId('profiles-editor-status')).toHaveText('Edited: Pane updates won’t replace your copy');
  await page.getByTestId('profiles-back').click();
  await expect(page.getByTestId('profiles-edited-greenfield')).toHaveText('Edited');
  await page.getByTestId('profile-row-greenfield-orchestrator').click();
  await expect(editor).toHaveValue(/Marker: KUMQUAT/);
  await page.getByTestId('profiles-restore').click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByTestId('profiles-restore')).toHaveCount(0);
  await expect(editor).not.toHaveValue(/KUMQUAT/);
});

test('a save Agent Farm refuses shows why, and keeps the edit', async ({ page }) => {
  await openProfilesTab(page, { saveError: 'writer wasn\'t saved: Agent Farm says Missing skill writer/nope. Fix the file, then save again. Nothing was changed.' });
  await page.getByTestId('profile-row-writer-writer').click();
  await page.getByTestId('profiles-editor').fill('---\nskills: [nope]\n---\n');
  await page.getByTestId('profiles-save').click();
  await expect(page.getByTestId('profiles-save-error')).toContainText('Missing skill writer/nope');
  await expect(page.getByTestId('profiles-editor-status')).toHaveText('Unsaved changes');
});

test('New subagent, skill and reference create a file and open it; New profile opens the new one', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-writer-writer').click();
  for (const [kind, name, path] of [['subagent', 'researcher', 'agents/researcher.md'], ['skill', 'weekly-recap', 'skills/weekly-recap/SKILL.md'], ['reference', 'style-guide', 'references/writer/style-guide.md']]) {
    await page.getByTestId('profiles-add').click();
    await page.getByRole('menuitem', { name: new RegExp(`New ${kind}`) }).click();
    const dialog = page.getByTestId('profiles-new-file-dialog');
    await dialog.getByLabel('Name').fill(name);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('profiles-path')).toHaveText(`writer/${path}`);
    await expect(page.getByTestId(`profiles-file-${path}`)).toBeVisible();
  }
  await page.getByTestId('profiles-back').click();
  await page.getByTestId('profiles-new').click();
  const dialog = page.getByTestId('profiles-new-dialog');
  await dialog.getByLabel('Name').fill('Bad Name');
  await expect(page.getByTestId('profiles-new-create')).toBeDisabled();
  await dialog.getByLabel('Name').fill('researcher');
  await page.getByTestId('profiles-new-create').click();
  await expect(page.getByTestId('profiles-title')).toHaveText('Researcher');
  await expect(page.getByTestId('profiles-path')).toHaveText('researcher/agents/researcher.md');
});

test('a sample photo shows in the profile, the list and its Session row; removing it brings the initials back', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-dcouple-business').click();
  await page.getByTestId('profile-photo').click();
  await expect(page.getByRole('menu', { name: 'Profile photo' })).toContainText('Generated from the name');
  await page.getByTestId('profile-photo-sample-star').click();
  await expect(page.getByTestId('profiles-notice')).toContainText('Photo set for this computer.');
  await expect(page.getByTestId('profile-photo').getByTestId('profile-avatar')).toHaveAttribute('data-avatar', 'picture');
  const row = page.getByTestId('orchestration-session-s3');
  await expect(row.getByTestId('profile-avatar').first()).toHaveAttribute('data-avatar', 'picture');
  await page.getByTestId('profile-photo').click();
  await expect(page.getByRole('menu', { name: 'Profile photo' })).toContainText('Your photo');
  await page.getByRole('menuitem', { name: 'Remove my photo' }).click();
  await expect(page.getByTestId('profile-photo').getByTestId('profile-avatar')).toHaveAttribute('data-avatar', 'initials');
  await expect(row.getByTestId('profile-avatar').first()).toHaveAttribute('data-avatar', 'initials');
});

test('Enter on the sidebar\'s Profiles row puts keyboard focus on the first profile (QA bug 2)', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profiles-nav').click();
  await expect(page.getByTestId('profiles-view')).toHaveCount(0);
  await page.getByTestId('profiles-nav').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('profile-row-greenfield-orchestrator')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('profile-row-greenfield-planner')).toBeFocused();
});

test('after Restore, a file you added and Restore removed gives way to the identity file (QA bug 3)', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-planner').click();
  await page.getByTestId('profiles-add').click();
  await page.getByRole('menuitem', { name: /New subagent/ }).click();
  await page.getByTestId('profiles-new-file-dialog').getByLabel('Name').fill('helper');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('profiles-path')).toHaveText('greenfield/agents/helper.md');
  await page.getByTestId('profiles-restore').click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByTestId('profiles-path')).toHaveText('greenfield/agents/planner.md');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a change made outside Pane shows in the open file, the file tree and the list', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-writer-writer').click();
  const editor = page.getByTestId('profiles-editor');
  await expect(editor).toHaveValue('# agents/writer.md\n');
  await writeOnDisk(page, 'writer', 'agents/writer.md', '# Writer\n\nMarker: KUMQUAT\n');
  await writeOnDisk(page, 'writer', 'skills/recap/SKILL.md', '# recap\n');
  // No unsaved edits: the new content just shows, and the new file joins the tree.
  await expect(editor).toHaveValue(/Marker: KUMQUAT/, { timeout: 8000 });
  await expect(page.getByTestId('profiles-file-skills/recap/SKILL.md')).toBeVisible();
  await expect(page.getByTestId('profiles-disk-changed')).toHaveCount(0);
  await writeOnDisk(page, 'writer', 'skills/recap/SKILL.md', null);
  await expect(page.getByTestId('profiles-file-skills/recap/SKILL.md')).toHaveCount(0, { timeout: 8000 });
  await page.getByTestId('profiles-back').click();
  // The list picks up a profile added outside Pane.
  await writeOnDisk(page, 'writer', 'profiles/editor.yaml', 'agent: writer\n');
  await expect(page.getByTestId('profile-row-writer-editor')).toBeVisible({ timeout: 8000 });
});

test('with unsaved edits, a change on disk keeps them and asks: reload, or keep mine', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-writer-writer').click();
  const editor = page.getByTestId('profiles-editor');
  await editor.fill('# Mine\n');
  await writeOnDisk(page, 'writer', 'agents/writer.md', '# Theirs\n');
  const notice = page.getByTestId('profiles-disk-changed');
  await expect(notice).toContainText('changed outside Pane', { timeout: 8000 });
  await expect(editor).toHaveValue('# Mine\n');
  await page.getByTestId('profiles-disk-keep').click();
  await expect(notice).toHaveCount(0);
  await expect(editor).toHaveValue('# Mine\n');
  await expect(page.getByTestId('profiles-editor-status')).toHaveText('Unsaved changes');
  // Another change on disk asks again; this time take it.
  await writeOnDisk(page, 'writer', 'agents/writer.md', '# Theirs again\n');
  await expect(notice).toBeVisible({ timeout: 8000 });
  await page.getByTestId('profiles-disk-reload').click();
  await expect(notice).toHaveCount(0);
  await expect(editor).toHaveValue('# Theirs again\n');
  await expect(page.getByTestId('profiles-save')).toBeDisabled();
  // Removed on disk while edited: the edit stays and Save would put it back.
  await editor.fill('# Mine again\n');
  await writeOnDisk(page, 'writer', 'agents/writer.md', null);
  await expect(notice).toContainText('removed outside Pane', { timeout: 8000 });
  await expect(editor).toHaveValue('# Mine again\n');
});

test('the Profiles row opens Profiles and, clicked again, returns to where you were', async ({ page }) => {
  await openProfilesTab(page);
  await expect(page.getByTestId('profiles-nav')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('profiles-nav').click();
  await expect(page.getByTestId('profiles-view')).toHaveCount(0);
});

for (const theme of ['light', 'dark']) {
  test(`screens (${theme})`, async ({ page }) => {
    test.skip(!shotsDir, 'Set PANE_PROFILES_SHOTS to save the review screenshots.');
    await openProfilesTab(page, { theme });
    await shot(page, `list-${theme}`);
    await page.getByTestId('profile-row-greenfield-orchestrator').click();
    await expect(page.getByTestId('profiles-editor')).toHaveValue(/Orchestrator/);
    await shot(page, `files-${theme}`);
    await page.getByTestId('profile-photo').click();
    await shot(page, `photo-menu-${theme}`);
    await page.keyboard.press('Escape');
    await page.getByTestId('profiles-add').click();
    await shot(page, `new-menu-${theme}`);
    await page.keyboard.press('Escape');
    await page.getByTestId('profiles-editor').click();
    await page.keyboard.press('End');
    await page.getByTestId('profiles-editor').pressSequentially('\nMarker: X');
    await shot(page, `unsaved-${theme}`);
    await page.getByTestId('profiles-save').click();
    await expect(page.getByTestId('profiles-notice')).toBeVisible();
    await shot(page, `saved-edited-${theme}`);
    await page.getByTestId('profiles-restore').click();
    await shot(page, `restore-confirm-${theme}`);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByTestId('profiles-add').click();
    await page.getByRole('menuitem', { name: /New skill/ }).click();
    await page.getByTestId('profiles-new-file-dialog').getByLabel('Name').fill('weekly-recap');
    await shot(page, `new-skill-${theme}`);
    await page.keyboard.press('Escape');
    await page.getByTestId('profiles-back').click();
    await page.getByTestId('profile-row-bloomtext-support').click();
    await page.getByTestId('profile-photo').click();
    await page.getByTestId('profile-photo-sample-fringe').click();
    await expect(page.getByTestId('profiles-notice')).toBeVisible();
    await page.getByTestId('profiles-back').click();
    await shot(page, `list-edited-photo-${theme}`);
    await page.getByTestId('profiles-new').click();
    await shot(page, `new-profile-${theme}`);
    await page.keyboard.press('Escape');
    await page.getByTestId('profiles-sync').hover({ force: true });
    await shot(page, `sync-later-${theme}`);
    await page.getByTestId('profile-row-writer-writer').click();
    await page.getByTestId('profiles-editor').fill('# Writer\n\nMy edit, not saved yet.\n');
    await writeOnDisk(page, 'writer', 'agents/writer.md', '# Writer\n\nAn agent changed this.\n');
    await expect(page.getByTestId('profiles-disk-changed')).toBeVisible({ timeout: 8000 });
    await shot(page, `disk-changed-${theme}`);
    await writeOnDisk(page, 'writer', 'agents/writer.md', null);
    await expect(page.getByTestId('profiles-disk-changed')).toContainText('removed', { timeout: 8000 });
    await shot(page, `disk-removed-${theme}`);
  });
}
