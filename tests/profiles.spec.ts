import { expect, test, type Page } from '@playwright/test';
import { gotoApp } from './electronApiMock';
import { dismissStartupDialogs, installSessionsFixture, sessionFixture } from './orchestrationSessionsFixture';
import { expectNoAxeViolations } from './axeTest';
import type { AgentFarmProfileEntry } from '../shared/types/agentFarmProfiles';
import type { ProfilePlugin, ProfileSubagentNode, ProfileSummary, ProfileTreeNode, ProfilesOverview } from '../shared/types/profileEditor';
import type { ProfileSyncStatus } from '../shared/types/profileSync';

/**
 * The Profiles tab (T-63 PR 5, design round 4 "Tree + preview"): top-level profiles with pins, a
 * profile's cover page and its own files in a tree, previews (HTML, Markdown with front-matter,
 * YAML) with Edit, Edit details, Restore, photos, and changes made outside Pane.
 * PANE_PROFILES_SHOTS=<dir> also saves a screenshot of each screen, light and dark, for review.
 */

const identity = (description: string, extra = '') => `---\ndescription: ${description}\nharness: claude\nmodel: claude-opus-5-5${extra}\n---\n\n`;
const file = (id: string, path: string, note?: string): ProfileTreeNode => (note ? { kind: 'file', id, path, label: path.split('/').pop() ?? path, note } : { kind: 'file', id, path, label: path.split('/').pop() ?? path });
const folder = (id: string, label: string, children: ProfileTreeNode[]): ProfileTreeNode => ({ kind: 'folder', id, label, children });
const skill = (base: string, name: string): ProfileTreeNode => folder(`${base}/skills/${name}`, name, [file(`${base}/skills/${name}/SKILL.md`, `skills/${name}/SKILL.md`)]);
function subagent(base: string, alias: string, label: string, children: ProfileTreeNode[], extra: { profile?: string; harness?: string; description?: string } = {}): ProfileTreeNode {
  const node: ProfileSubagentNode = {
    kind: 'subagent', id: `${base}/sub:${alias}`, alias, agent: alias, label, harness: extra.harness ?? 'claude', model: extra.harness === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5',
    identity: `agents/${alias}.md`, children: [file(`${base}/sub:${alias}/identity`, `agents/${alias}.md`, 'identity'), ...children],
  };
  if (extra.profile) node.profile = extra.profile;
  if (extra.description) node.description = extra.description;
  return node;
}
const settings = (base: string, name: string, pane = false): ProfileTreeNode => folder(`${base}/settings`, 'Settings', [file(`${base}/settings/profiles/${name}.yaml`, `profiles/${name}.yaml`), ...(pane ? [file(`${base}/settings/pane.yaml`, 'pane.yaml')] : [])]);

function profile(plugin: string, name: string, harness: string, description: string, tree: ProfileTreeNode[], extra: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    name, ref: `${plugin}/${name}`, entry: `agents/${name}.md`, harness, model: harness === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', description, listed: true,
    uses: [], tree: tree.length ? tree : [file(`${name}/identity`, `agents/${name}.md`, 'identity'), settings(name, name)], ...extra,
  };
}

function plugin(name: string, version: string, bundled: boolean, profiles: ProfileSummary[], files: string[]): ProfilePlugin {
  return { name, version, bundled, edited: false, profiles, files: [...files].sort() };
}

function fixture() {
  const orchestrator = profile('greenfield', 'orchestrator', 'claude', 'Coordinate planners, implementers and reviewers for one workstream.', [
    file('orchestrator/identity', 'agents/orchestrator.md', 'identity'),
    folder('orchestrator/instructions', 'Instructions', [file('orchestrator/instructions/standing-rules.md', 'instructions/standing-rules.md')]),
    folder('orchestrator/skills', 'Skills', [skill('orchestrator', 'plan'), skill('orchestrator', 'review')]),
    folder('orchestrator/subagents', 'Subagents', [
      subagent('orchestrator', 'planner', 'Greenfield planner', [folder('orchestrator/sub:planner/skills', 'Skills', [skill('orchestrator/sub:planner', 'plan')])], { profile: 'greenfield/planner', description: 'Turn a request into a plan.' }),
      subagent('orchestrator', 'implementer', 'Greenfield implementer', [], { profile: 'greenfield/implementer' }),
      subagent('orchestrator', 'reviewer', 'Greenfield reviewer', [], { profile: 'greenfield/reviewer', harness: 'codex' }),
      subagent('orchestrator', 'designer', 'Designer', [folder('orchestrator/sub:designer/skills', 'Skills', [skill('orchestrator/sub:designer', 'ui-mockup')])], { description: 'Draw three UI options on the real product.' }),
      subagent('orchestrator', 'verifier', 'Front End Verifier', []),
    ]),
    settings('orchestrator', 'orchestrator', true),
  ], { cover: 'covers/orchestrator.html' });
  const business = profile('greenfield', 'business', 'claude', 'Answers BloomText support tickets and escalates refunds to you.', [
    file('business/identity', 'agents/business.md', 'identity'),
    folder('business/skills', 'Skills', [skill('business', 'triage')]),
    folder('business/references', 'References', [file('business/references/tone.md', 'references/business/tone.md')]),
    settings('business', 'business'),
  ], { title: 'Support desk' });
  const greenfield = plugin('greenfield', '0.0.46', true, [
    orchestrator,
    business,
    profile('greenfield', 'seo', 'claude', 'Draft blog posts in my voice.', []),
    profile('greenfield', 'planner', 'claude', 'Turn a request into a plan.', [], { listed: false }),
    profile('greenfield', 'implementer', 'claude', 'Build an approved plan.', [], { listed: false }),
    profile('greenfield', 'reviewer', 'codex', 'Review a pull request.', [], { listed: false }),
  ], ['plugin.yaml', 'pane.yaml', 'covers/orchestrator.html', 'profiles/orchestrator.yaml', 'profiles/business.yaml', 'profiles/seo.yaml', 'profiles/planner.yaml', 'profiles/implementer.yaml', 'profiles/reviewer.yaml',
    'agents/orchestrator.md', 'agents/business.md', 'agents/seo.md', 'agents/planner.md', 'agents/implementer.md', 'agents/reviewer.md', 'agents/designer.md', 'agents/verifier.md',
    'instructions/standing-rules.md', 'skills/plan/SKILL.md', 'skills/review/SKILL.md', 'skills/ui-mockup/SKILL.md', 'skills/triage/SKILL.md', 'references/business/tone.md']);
  // Installed but not on the TEMPORARY short list: not shown in the list (T-83).
  const dcouple = plugin('dcouple', '0.1.27', true, [profile('dcouple', 'business', 'claude', 'Run BloomText business tasks.', [])], ['plugin.yaml', 'profiles/business.yaml', 'agents/business.md']);
  const files: Record<string, string> = {};
  for (const entry of [greenfield, dcouple]) {
    for (const path of entry.files) files[`${entry.name}/${path}`] = `# ${path}\n`;
    files[`${entry.name}/plugin.yaml`] = `name: ${entry.name}\nversion: ${entry.version}\ncli_major: 0\n`;
    for (const item of entry.profiles) {
      files[`${entry.name}/profiles/${item.name}.yaml`] = `agent: ${item.name}\n`;
      files[`${entry.name}/agents/${item.name}.md`] = `${identity(item.description ?? '')}# ${item.name}\n\n${item.description}\n`;
    }
  }
  files['greenfield/profiles/orchestrator.yaml'] = 'variants:\n  claude: { agent: orchestrator }\n  codex: { agent: orchestrator-codex }\ndefault: claude\n';
  files['greenfield/agents/orchestrator.md'] = `${identity('Coordinate planners, implementers and reviewers for one workstream.', '\nskills: [plan, review]')}# Orchestrator\n\nYou run one workstream. Plan before building, and send every pull request to the reviewer.\n`;
  files['greenfield/agents/designer.md'] = `${identity('Draw three UI options on the real product.', '\nskills: [ui-mockup]')}# Designer\n\nCapture the real screen, then draw three options.\n`;
  files['greenfield/covers/orchestrator.html'] = '<html><head><title>Orchestrator</title></head><body><h1>Greenfield orchestrator</h1><p>Runs one workstream from idea to merged pull request.</p><h2>How it works</h2><p>1 Plan with you · 2 Build in a Pane · 3 Review every PR · 4 Ask before merging</p><script>document.body.dataset.ran = "yes"</script></body></html>';
  // TEMPORARY (T-83): the title lives in pane.yaml for the test build.
  files['greenfield/pane.yaml'] = 'profiles:\n  orchestrator:\n    title: Greenfield orchestrator\n';
  files['greenfield/agents/business.md'] = `${identity('Answer BloomText support tickets.', '\nskills: [triage]\nreferences: business')}# Support\n\nAnswer new tickets in the help desk. Escalate refunds to the person through an approval.\n`;
  const overview: ProfilesOverview = { machine: 'studio-mac', plugins: [greenfield, dcouple] };
  return { overview, files };
}

/** The same profiles as New Session reads them (chat-tab:profiles). */
const PALETTE_PROFILES: AgentFarmProfileEntry[] = [
  { ref: 'greenfield/orchestrator', plugin: 'greenfield', version: '0.0.46', harness: 'claude', hidden: false },
  { ref: 'greenfield/planner', plugin: 'greenfield', version: '0.0.46', harness: 'claude', hidden: false, listed: false },
  { ref: 'greenfield/business', plugin: 'greenfield', version: '0.0.46', harness: 'claude', hidden: false },
  { ref: 'greenfield/seo', plugin: 'greenfield', version: '0.0.46', harness: 'claude', hidden: false },
];

async function installProfiles(page: Page, options: { theme?: string; saveError?: string; pins?: string[]; on?: boolean; sync?: ProfileSyncStatus } = {}): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const data = fixture();
  await installSessionsFixture(page, [
    { ...sessionFixture('s1', 'Session profiles plan', '', '', '2026-11-25T08:00:00.000Z'), agentProfile: { ref: 'greenfield/orchestrator', hash: 'h1' } },
    { ...sessionFixture('s2', 'Weekend blog post', '', '', '2026-11-25T08:01:00.000Z'), agentProfile: { ref: 'pane/claude', hash: 'h' } },
    { ...sessionFixture('s3', 'Sprint tracker upkeep', '', '', '2026-11-25T08:02:00.000Z'), agentProfile: { ref: 'greenfield/business', hash: 'h2' } },
  ], [], {
    initialConfig: { theme: options.theme ?? 'light', chatTabsEnabled: true, pinnedProfiles: options.pins ?? [], sessionProfilesEnabled: options.on ?? true },
    profileEditor: { ...data, saveError: options.saveError, sync: options.sync },
    agentFarmProfiles: { profiles: PALETTE_PROFILES },
  });
  await gotoApp(page);
  await dismissStartupDialogs(page);
}

async function openProfilesTab(page: Page, options: { theme?: string; saveError?: string; pins?: string[]; sync?: ProfileSyncStatus } = {}): Promise<void> {
  await installProfiles(page, options);
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

test('the list shows only top-level profiles, pinned first, and pins from a row', async ({ page }) => {
  await openProfilesTab(page, { pins: ['greenfield/business'] });
  const list = page.getByTestId('profiles-list');
  await expect(page.getByTestId('profiles-pinned-heading')).toBeVisible();
  await expect(list.getByTestId('profile-row-greenfield-business')).toContainText('Support desk');
  // The orchestrator's subagent profiles live inside it, not in the list; TEMPORARY (T-83): neither
  // does a profile off the short list (dcouple/business).
  await expect(list.getByTestId('profile-row-greenfield-planner')).toHaveCount(0);
  await expect(list.getByTestId('profile-row-dcouple-business')).toHaveCount(0);
  await expect(list.locator('[data-profiles-item]')).toHaveCount(3);
  await expect(page.getByTestId('profiles-all-heading')).toContainText('· 2 · subagents appear inside the profile that uses them');
  await expect(list.getByTestId('profile-row-greenfield-orchestrator')).toContainText('5 subagents · 1 Session · Claude');
  const rows = list.locator('[data-profiles-item]');
  await expect(rows.first()).toHaveAttribute('data-testid', 'profile-row-greenfield-business');
  await page.getByTestId('profile-pin-greenfield/orchestrator').click();
  await expect(page.getByTestId('profile-pin-greenfield/orchestrator')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'profile-row-greenfield-orchestrator');
  await expect(page.getByTestId('profiles-footer')).toContainText('3 profiles · 2 Sessions use one');
  // Sync (PR 6) is live while the Profiles switch is on.
  await expect(page.getByTestId('profiles-sync')).toBeEnabled();
  await expectNoAxeViolations(page, { include: '[data-testid="profiles-view"]' });
  // Keyboard: the first profile has focus; ↓ moves, Enter opens on the cover page.
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('profiles-title')).toHaveText('Greenfield orchestrator');
  await expect(page.getByTestId('profiles-tree-cover')).toHaveAttribute('aria-selected', 'true');
});

test('pins lead Create New\'s To, and a profile Agent Farm doesn\'t list is left out', async ({ page }) => {
  await openProfilesTab(page, { pins: ['greenfield/business'] });
  await page.getByTestId('new-orchestration-session').click();
  const dialog = page.getByTestId('create-new-dialog');
  await dialog.getByRole('combobox', { name: 'To', exact: true }).focus();
  await page.keyboard.type('green');
  const options = dialog.getByRole('listbox', { name: 'Agents and profiles' }).getByRole('option');
  await expect(options).toHaveText([/Greenfield business/, /Greenfield orchestrator/, /Greenfield seo/]);
});

test('a profile opens on its cover page: its own HTML in a sandbox, or one Pane makes', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-orchestrator').click();
  const frame = page.getByTestId('profiles-html-preview');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(page.getByTestId('profiles-cover-note')).toHaveText('From the profile: covers/orchestrator.html');
  const content = page.frameLocator('[data-testid="profiles-html-preview"]');
  await expect(content.getByRole('heading', { name: 'Greenfield orchestrator' })).toBeVisible();
  // Scripts don't run in the cover.
  // SAFETY: the locator is the preview's <iframe>; its sandbox has no same-origin, so contentDocument stays out of reach.
  expect(await frame.evaluate(element => (element as HTMLIFrameElement).contentDocument?.body?.dataset.ran ?? null).catch(() => null)).toBeNull();
  await page.getByTestId('profiles-back').click();
  await page.getByTestId('profile-row-greenfield-business').click();
  const cover = page.getByTestId('profiles-generated-cover');
  await expect(cover).toContainText('Support desk');
  await expect(cover).toContainText('Answers BloomText support tickets and escalates refunds to you.');
  await expect(cover).toContainText('Escalate refunds to the person through an approval.');
  await expect(cover).toContainText('Add covers/business.html to replace it.');
  await expect(cover.getByText('triage', { exact: true })).toBeVisible();
  await expect(cover.getByText('tone.md', { exact: true })).toBeVisible();
  // The page without a sandboxed frame (axe can't enter one) meets WCAG AA.
  await expectNoAxeViolations(page, { include: '[data-testid="profiles-view"]' });
});

test('the tree holds only the profile\'s files; folders open and close; a subagent shows its own cover', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-orchestrator').click();
  const tree = page.getByRole('tree', { name: 'greenfield/orchestrator files' });
  // Skills and Subagents start open, Instructions closed; nothing of the plugin's other profiles shows.
  await expect(tree.getByTestId('profiles-tree-orchestrator/sub:designer')).toBeVisible();
  await expect(tree.getByTestId('profiles-file-instructions/standing-rules.md')).toHaveCount(0);
  await expect(tree.getByTestId('profiles-file-agents/business.md')).toHaveCount(0);
  await tree.getByTestId('profiles-tree-orchestrator/instructions').click();
  await expect(tree.getByTestId('profiles-file-instructions/standing-rules.md')).toBeVisible();
  await tree.getByTestId('profiles-tree-orchestrator/instructions').click();
  await expect(tree.getByTestId('profiles-file-instructions/standing-rules.md')).toHaveCount(0);
  // Clicking a subagent opens it and shows its own cover.
  await tree.getByTestId('profiles-tree-orchestrator/sub:designer').click();
  await expect(page.getByTestId('profiles-path')).toHaveText('Designer');
  await expect(page.getByTestId('profiles-generated-cover')).toContainText('Capture the real screen, then draw three options.');
  await expect(tree.getByTestId('profiles-file-agents/designer.md')).toBeVisible();
  // A subagent that is a profile offers its own page.
  await tree.getByTestId('profiles-tree-orchestrator/sub:planner').click();
  await page.getByTestId('profiles-open-subagent-profile').click();
  await expect(page.getByTestId('profiles-title')).toHaveText('Greenfield planner');
  await page.getByTestId('profiles-back').click();
  // Keyboard: ← closes a folder, → opens it.
  await page.getByTestId('profile-row-greenfield-orchestrator').click();
  await tree.getByTestId('profiles-tree-orchestrator/skills').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tree.getByTestId('profiles-tree-orchestrator/skills/plan')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(tree.getByTestId('profiles-tree-orchestrator/skills/plan')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('profiles-list')).toBeVisible();
});

test('files preview first: Markdown under a metadata header, YAML as key/value; Edit, ⌘S and Cancel', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-orchestrator').click();
  await page.getByTestId('profiles-tree-orchestrator/sub:designer').click();
  await page.getByTestId('profiles-file-agents/designer.md').click();
  const meta = page.getByTestId('profiles-front-matter');
  await expect(meta).toContainText('Draw three UI options on the real product.');
  await expect(meta).toContainText('ui-mockup');
  await expect(page.getByTestId('profiles-markdown-preview').getByRole('heading', { name: 'Designer' })).toBeVisible();
  await page.getByTestId('profiles-tree-orchestrator/settings').click();
  await page.getByTestId('profiles-file-profiles/orchestrator.yaml').click();
  const yaml = page.getByTestId('profiles-yaml-preview');
  await expect(yaml).toContainText('variants');
  await expect(yaml).toContainText('agent: orchestrator-codex');
  await expect(yaml).toContainText('default');
  await expect(page.getByTestId('profiles-editor')).toHaveCount(0);
  // Edit, then ⌘S saves and returns to the preview; Pane's own plugin becomes Edited.
  await page.getByTestId('profiles-edit').click();
  const editor = page.getByTestId('profiles-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.press('End');
  await editor.pressSequentially('\nmarker: KUMQUAT');
  await expect(page.getByTestId('profiles-editor-status')).toHaveText('Unsaved changes');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect(page.getByTestId('profiles-notice')).toContainText('Saved greenfield/profiles/orchestrator.yaml. 2 Sessions can reload it.');
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId('profiles-restore')).toBeVisible();
  // Cancel with edits asks first; Esc in the editor does the same.
  await page.getByTestId('profiles-edit').click();
  await page.getByTestId('profiles-editor').fill('changed: yes\n');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Discard your edits?' })).toBeVisible();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByTestId('profiles-editor')).toHaveCount(0);
  await expect(yaml).toContainText('KUMQUAT');
  // Restore brings Pane's version back.
  await page.getByTestId('profiles-restore').click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByTestId('profiles-restore')).toHaveCount(0);
});

test('Edit details writes the description into the identity, and the title (for now) beside it', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-seo').click();
  await page.getByTestId('profiles-edit-details').click();
  const dialog = page.getByTestId('profiles-details-dialog');
  await dialog.getByLabel('Title').fill('Blog writer');
  await dialog.getByLabel('Description').fill('Drafts posts in my voice, then cuts a third.');
  await page.getByTestId('profiles-details-save').click();
  await expect(page.getByTestId('profiles-title')).toHaveText('Blog writer');
  await expect(page.getByTestId('profiles-subtitle')).toContainText('Drafts posts in my voice, then cuts a third.');
  await page.getByTestId('profiles-back').click();
  await expect(page.getByTestId('profile-row-greenfield-seo')).toContainText('Blog writer');
  // The description is written in the agent's own identity file.
  await page.getByTestId('profile-row-greenfield-seo').click();
  await page.getByTestId('profiles-file-agents/seo.md').click();
  await expect(page.getByTestId('profiles-front-matter')).toContainText('Drafts posts in my voice, then cuts a third.');
});

test('a save Agent Farm refuses shows why, and keeps the edit', async ({ page }) => {
  await openProfilesTab(page, { saveError: 'greenfield wasn\'t saved: Agent Farm says Missing skill greenfield/nope. Fix the file, then save again. Nothing was changed.' });
  await page.getByTestId('profile-row-greenfield-seo').click();
  await page.getByTestId('profiles-file-agents/seo.md').click();
  await page.getByTestId('profiles-edit').click();
  await page.getByTestId('profiles-editor').fill('---\nskills: [nope]\n---\n');
  await page.getByTestId('profiles-save').click();
  await expect(page.getByTestId('profiles-save-error')).toContainText('Missing skill greenfield/nope');
  await expect(page.getByTestId('profiles-editor-status')).toHaveText('Unsaved changes');
});

test('New subagent, skill and reference add a file to the tree and open it; New profile opens on its cover', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-seo').click();
  for (const [kind, name, path] of [['subagent', 'researcher', 'agents/researcher.md'], ['skill', 'weekly-recap', 'skills/weekly-recap/SKILL.md'], ['reference', 'style-guide', 'references/seo/style-guide.md']]) {
    await page.getByTestId('profiles-add').click();
    await page.getByRole('menuitem', { name: new RegExp(`New ${kind}`) }).click();
    await page.getByTestId('profiles-new-file-dialog').getByLabel('Name').fill(name);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('profiles-path')).toHaveText(path);
    await expect(page.getByTestId(`profiles-file-${path}`).first()).toBeVisible();
  }
  await page.getByTestId('profiles-back').click();
  await page.getByTestId('profiles-new').click();
  await page.getByTestId('profiles-new-dialog').getByLabel('Name').fill('researcher');
  await page.getByTestId('profiles-new-create').click();
  await expect(page.getByTestId('profiles-title')).toHaveText('Researcher');
  await expect(page.getByTestId('profiles-tree-cover')).toHaveAttribute('aria-selected', 'true');
});

test('a sample photo shows in the profile and its Session row; removing it brings the initials back', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-business').click();
  await page.getByTestId('profile-photo').click();
  await page.getByTestId('profile-photo-sample-star').click();
  await expect(page.getByTestId('profile-photo').getByTestId('profile-avatar')).toHaveAttribute('data-avatar', 'picture');
  const row = page.getByTestId('orchestration-session-s3');
  await expect(row.getByTestId('profile-avatar').first()).toHaveAttribute('data-avatar', 'picture');
  await page.getByTestId('profiles-edit-details').click();
  await page.getByTestId('profiles-details-initials').click();
  await expect(page.getByTestId('profile-photo').getByTestId('profile-avatar')).toHaveAttribute('data-avatar', 'initials');
  await expect(row.getByTestId('profile-avatar').first()).toHaveAttribute('data-avatar', 'initials');
});

test('Enter on the sidebar\'s Profiles row puts keyboard focus on the first profile', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profiles-nav').click();
  await expect(page.getByTestId('profiles-view')).toHaveCount(0);
  await page.getByTestId('profiles-nav').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('profile-row-greenfield-orchestrator')).toBeFocused();
});

test('a change made outside Pane shows in the open file and the tree', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-business').click();
  await page.getByTestId('profiles-file-agents/business.md').click();
  const preview = page.getByTestId('profiles-markdown-preview');
  await expect(preview).toContainText('Answer new tickets');
  await writeOnDisk(page, 'greenfield', 'agents/business.md', '---\nharness: claude\n---\n\n# Support\n\nMarker: KUMQUAT\n');
  await expect(preview).toContainText('Marker: KUMQUAT', { timeout: 8000 });
  await expect(page.getByTestId('profiles-disk-changed')).toHaveCount(0);
  // A reference removed on disk leaves the tree.
  await page.getByTestId('profiles-tree-business/references').click();
  await expect(page.getByTestId('profiles-file-references/business/tone.md')).toBeVisible();
  await writeOnDisk(page, 'greenfield', 'references/business/tone.md', null);
  await expect(page.getByTestId('profiles-file-references/business/tone.md')).toHaveCount(0, { timeout: 8000 });
});

test('with unsaved edits, a change on disk keeps them and asks: reload, or keep mine', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-seo').click();
  await page.getByTestId('profiles-file-agents/seo.md').click();
  await page.getByTestId('profiles-edit').click();
  const editor = page.getByTestId('profiles-editor');
  await editor.fill('# Mine\n');
  await writeOnDisk(page, 'greenfield', 'agents/seo.md', '# Theirs\n');
  const notice = page.getByTestId('profiles-disk-changed');
  await expect(notice).toContainText('changed outside Pane', { timeout: 8000 });
  await expect(editor).toHaveValue('# Mine\n');
  await page.getByTestId('profiles-disk-keep').click();
  await expect(notice).toHaveCount(0);
  await expect(editor).toHaveValue('# Mine\n');
  await writeOnDisk(page, 'greenfield', 'agents/seo.md', '# Theirs again\n');
  await expect(notice).toBeVisible({ timeout: 8000 });
  await page.getByTestId('profiles-disk-reload').click();
  await expect(notice).toHaveCount(0);
  await expect(editor).toHaveValue('# Theirs again\n');
});

/** build-box has every save; travel-laptop is offline and gets one when it reconnects (PR 6). */
const SYNC: ProfileSyncStatus = { running: false, lastSyncAt: 1, computers: [
  { key: 'build', id: 'b', name: 'build-box', state: 'up-to-date', waiting: [] },
  { key: 'travel', id: 't', name: 'travel-laptop', state: 'offline', waiting: ['business'] },
] };

for (const theme of ['light', 'dark']) {
  test(`Sync shows each computer's state and sends every profile again; a save says where it goes (PR 6, ${theme})`, async ({ page }) => {
    await openProfilesTab(page, { theme, sync: SYNC });
    await expect(page.getByTestId('profiles-sync-status')).toHaveText('Synced to build-box · travel-laptop gets 1 change when it reconnects');
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/sync7-footer-${theme}.png` });
    await page.getByTestId('profiles-sync').click();
    const sheet = page.getByTestId('profiles-sync-sheet');
    await expect(sheet.getByRole('heading', { name: 'Sync profiles now' })).toBeVisible();
    await expect(page.getByTestId('profiles-sync-row-build-box')).toContainText('Up to date (every save is pushed)');
    await expect(page.getByTestId('profiles-sync-row-travel-laptop')).toContainText('Offline: gets 1 change when it reconnects');
    await expect(page.getByTestId('profiles-sync-now')).toBeFocused();
    await expectNoAxeViolations(page, { include: '[data-testid="profiles-sync-sheet"]' });
    await shot(page, `sync7-sheet-${theme}`);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('profiles-notice')).toHaveText('Sent all profiles to build-box; travel-laptop gets them when it reconnects.');
    await expect(sheet).toHaveCount(0);

    await page.getByTestId('profile-row-greenfield-business').click();
    await page.getByTestId('profiles-file-agents/business.md').click();
    await page.getByTestId('profiles-edit').click();
    await page.keyboard.press('End');
    await page.getByTestId('profiles-editor').pressSequentially('\nMarker: X');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect(page.getByTestId('profiles-notice')).toHaveText('Saved greenfield/agents/business.md. Sending it to build-box; travel-laptop gets it when it reconnects. 2 Sessions can reload it.');
    await shot(page, `sync7-saved-${theme}`);
  });
}

test('with Profiles off, there is no Profiles row or page, and nothing reads profiles', async ({ page }) => {
  await installProfiles(page, { on: false });
  await expect(page.getByTestId('sessions-section-header')).toBeVisible();
  await expect(page.getByTestId('profiles-nav')).toHaveCount(0);
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect(page.getByTestId('compact-profiles')).toHaveCount(0);
  // SAFETY: installElectronApiMock adds this control before the app loads.
  const calls = await page.evaluate(() => (window as typeof window & { __paneTestElectronMock: { getProfilesCalls: () => string[] } }).__paneTestElectronMock.getProfilesCalls());
  expect(calls).toEqual([]);
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
    await openProfilesTab(page, { theme, pins: ['greenfield/orchestrator', 'greenfield/business'] });
    await shot(page, `page-list-${theme}`);
    await page.getByTestId('profile-row-greenfield-orchestrator').click();
    await expect(page.getByTestId('profiles-html-preview')).toBeVisible();
    await shot(page, `page-cover-custom-${theme}`);
    await page.getByTestId('profiles-tree-orchestrator/sub:designer').click();
    await shot(page, `page-tree-subagent-${theme}`);
    await page.getByTestId('profiles-file-agents/designer.md').click();
    await expect(page.getByTestId('profiles-front-matter')).toContainText('ui-mockup');
    await shot(page, `page-md-preview-${theme}`);
    await page.getByTestId('profiles-tree-orchestrator/settings').click();
    await page.getByTestId('profiles-file-profiles/orchestrator.yaml').click();
    await expect(page.getByTestId('profiles-yaml-preview')).toContainText('variants');
    await shot(page, `page-yaml-preview-${theme}`);
    await page.getByTestId('profiles-edit').click();
    await shot(page, `page-edit-${theme}`);
    await page.getByTestId('profiles-cancel').click();
    await page.getByTestId('profiles-back').click();
    await page.getByTestId('profile-row-greenfield-business').click();
    await expect(page.getByTestId('profiles-generated-cover')).toBeVisible();
    await shot(page, `page-cover-generated-${theme}`);
    await page.getByTestId('profiles-edit-details').click();
    await shot(page, `page-details-${theme}`);
    await page.keyboard.press('Escape');
    await page.getByTestId('profiles-file-agents/business.md').click();
    await page.getByTestId('profiles-edit').click();
    await page.getByTestId('profiles-editor').fill('# Support\n\nMy edit, not saved yet.\n');
    await writeOnDisk(page, 'greenfield', 'agents/business.md', '# Support\n\nAn agent changed this.\n');
    await expect(page.getByTestId('profiles-disk-changed')).toBeVisible({ timeout: 8000 });
    await shot(page, `page-disk-changed-${theme}`);
  });
}
