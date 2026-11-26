import { expect, test, type Page } from '@playwright/test';
import { gotoApp } from './electronApiMock';
import { dismissStartupDialogs, installSessionsFixture, sessionFixture } from './orchestrationSessionsFixture';
import { expectNoAxeViolations } from './axeTest';
import type { AgentFarmProfileEntry } from '../shared/types/agentFarmProfiles';
import type { ProfileLinkMode, ProfilePhotos, ProfilePlugin, ProfileRecovery, ProfileSubagentNode, ProfileSummary, ProfileTreeNode, ProfilesOverview } from '../shared/types/profileEditor';
import type { ProfileSyncStatus } from '../shared/types/profileSync';

/**
 * The Profiles tab (T-63 PR 5, design round 4 "Tree + preview"; T-83 P2, Agent Farm 0.3.0's
 * `profiles list --json`): every listed profile with pins, a profile's cover page and the agents it
 * links to in a tree (inside its parent, its own process, its own launch, a cycle back up), previews
 * (HTML, Markdown with front-matter, YAML) with Edit, Edit details, Restore, SVG photos, and changes
 * made outside Pane. PANE_PROFILES_SHOTS=<dir> also saves a screenshot of each screen, light and
 * dark, for review.
 */

const identity = (description: string, extra = '') => `---\ndescription: ${description}\nharness: claude\nmodel: claude-opus-5-5${extra}\n---\n\n`;
const file = (id: string, path: string, note?: string): ProfileTreeNode => (note ? { kind: 'file', id, path, label: path.split('/').pop() ?? path, note } : { kind: 'file', id, path, label: path.split('/').pop() ?? path });
const folder = (id: string, label: string, children: ProfileTreeNode[]): ProfileTreeNode => ({ kind: 'folder', id, label, children });
const skill = (base: string, name: string): ProfileTreeNode => folder(`${base}/skills/${name}`, name, [file(`${base}/skills/${name}/SKILL.md`, `skills/${name}/SKILL.md`)]);

interface LinkExtra { harness?: string; description?: string; variants?: string[]; command?: string; cycle?: boolean }

/** A linked agent of greenfield, as Agent Farm lists it: `greenfield/<alias>`, run by `mode`. */
function link(base: string, alias: string, label: string, mode: ProfileLinkMode, children: ProfileTreeNode[], extra: LinkExtra = {}): ProfileSubagentNode {
  const id = `${base}/sub:${alias}`;
  const harness = extra.harness ?? 'claude';
  const node: ProfileSubagentNode = {
    kind: 'subagent', id, alias, agent: `greenfield/${alias}`, label, mode, harness, model: harness === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5',
    identity: `agents/${alias}.md`,
    // A cycle isn't expanded again: Agent Farm lists it with no rows under it.
    children: extra.cycle ? [] : [file(`${id}/identity`, `agents/${alias}.md`, 'identity'), ...children],
  };
  if (extra.description) node.description = extra.description;
  if (extra.variants) node.variants = extra.variants;
  if (extra.command) node.command = extra.command;
  if (extra.cycle) node.cycle = true;
  return node;
}
const settings = (base: string, name: string): ProfileTreeNode => folder(`${base}/settings`, 'Settings', [file(`${base}/settings/profiles/${name}.yaml`, `profiles/${name}.yaml`)]);

function profile(plugin: string, name: string, harness: string, title: string, description: string, tree: ProfileTreeNode[], extra: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    name, ref: `${plugin}/${name}`, entry: `agents/${name}.md`, harness, model: harness === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', title, description,
    tree: tree.length ? tree : [file(`${name}/identity`, `agents/${name}.md`, 'identity'), settings(name, name)], ...extra,
  };
}

function plugin(name: string, version: string, bundled: boolean, profiles: ProfileSummary[], files: string[]): ProfilePlugin {
  return { name, version, bundled, edited: false, profiles, files: [...files].sort() };
}

const BOTH = ['claude', 'codex'];
const LAUNCH = (agent: string) => `agent-farm run greenfield/${agent} --agent-only`;

/** The Orchestrator's own agent tree in greenfield 0.1.0: launch links, native links, a process link, and implementer ↔ reviewer. */
function orchestratorTree(): ProfileTreeNode[] {
  const base = 'orchestrator';
  const implementer = `${base}/sub:implementer`;
  const reviewer = `${implementer}/sub:reviewer`;
  return [
    file(`${base}/identity`, 'agents/orchestrator.md', 'identity'),
    folder(`${base}/instructions`, 'Instructions', [file(`${base}/instructions/standing-rules.md`, 'instructions/standing-rules.md')]),
    folder(`${base}/skills`, 'Skills', [skill(base, 'plan'), skill(base, 'review')]),
    folder(`${base}/subagents`, 'Subagents', [
      link(base, 'planner', 'Planner', 'launch', [folder(`${base}/sub:planner/skills`, 'Skills', [skill(`${base}/sub:planner`, 'plan')])],
        { description: 'Turn a request into a plan.', variants: BOTH, command: LAUNCH('planner') }),
      link(base, 'implementer', 'Implementer', 'launch', [
        folder(`${implementer}/subagents`, 'Subagents', [
          link(implementer, 'reviewer', 'Reviewer', 'launch', [
            folder(`${reviewer}/subagents`, 'Subagents', [link(reviewer, 'implementer', 'Implementer', 'launch', [], { cycle: true, variants: BOTH, command: LAUNCH('implementer') })]),
          ], { harness: 'codex', variants: ['codex', 'claude'], command: LAUNCH('reviewer') }),
        ]),
      ], { description: 'Build an approved plan.', variants: BOTH, command: LAUNCH('implementer') }),
      link(base, 'qa-and-fix', 'QA and fix', 'launch', [], { variants: BOTH, command: LAUNCH('qa-and-fix') }),
      link(base, 'explorer', 'Explorer', 'native', [], { description: 'Inspect the repository and return facts.' }),
      link(base, 'cold-reader', 'Cold reader', 'native', []),
      link(base, 'advisor', 'Advisor', 'process', [], { harness: 'codex', command: 'agent-farm run greenfield/advisor' }),
      link(base, 'designer', 'Designer', 'native', [folder(`${base}/sub:designer/skills`, 'Skills', [skill(`${base}/sub:designer`, 'ui-mockup')])], { description: 'Draw three UI options on the real product.' }),
    ]),
    settings(base, 'orchestrator'),
  ];
}

/** greenfield's own SVG photo for the Orchestrator, as Agent Farm resolves it. */
const ORCHESTRATOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2f6f4f"/><circle cx="32" cy="26" r="11" fill="#e9f5ee"/></svg>';
const ORCHESTRATOR_PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent(ORCHESTRATOR_SVG)}`;

function fixture() {
  const orchestrator = profile('greenfield', 'orchestrator', 'claude', 'Orchestrator', 'Coordinate planners, implementers and reviewers for one workstream.', orchestratorTree(),
    { cover: 'covers/orchestrator.html', variants: BOTH });
  const business = profile('greenfield', 'business', 'claude', 'Business', 'Answers BloomText support tickets and escalates refunds to you.', [
    file('business/identity', 'agents/business.md', 'identity'),
    folder('business/skills', 'Skills', [skill('business', 'triage')]),
    folder('business/references', 'References', [file('business/references/tone.md', 'references/business/tone.md')]),
    settings('business', 'business'),
  ], { variants: BOTH });
  // SEO has a single agent: no variants.
  const seo = profile('greenfield', 'seo', 'claude', 'SEO', 'Draft blog posts in my voice.', []);
  const agents = ['planner', 'implementer', 'reviewer', 'qa-and-fix', 'explorer', 'cold-reader', 'advisor', 'designer'];
  const greenfield = plugin('greenfield', '0.1.0', true, [orchestrator, business, seo], [
    'plugin.yaml', 'covers/orchestrator.html', 'profiles/orchestrator.yaml', 'profiles/business.yaml', 'profiles/seo.yaml',
    'agents/orchestrator.md', 'agents/orchestrator-codex.md', 'agents/business.md', 'agents/seo.md', ...agents.map(agent => `agents/${agent}.md`),
    'instructions/standing-rules.md', 'skills/plan/SKILL.md', 'skills/review/SKILL.md', 'skills/ui-mockup/SKILL.md', 'skills/triage/SKILL.md', 'references/business/tone.md']);
  const files: Record<string, string> = {};
  for (const path of greenfield.files) files[`greenfield/${path}`] = `# ${path}\n`;
  // Each linked agent's identity, so its generated cover reads like the real one.
  for (const agent of agents) files[`greenfield/agents/${agent}.md`] = `${identity(`The ${agent} agent.`)}You are the ${agent} for one workstream. Do your part, then report back to whoever started you.\n`;
  files['greenfield/plugin.yaml'] = 'name: greenfield\nversion: 0.1.0\ncli_major: 0\n';
  for (const item of greenfield.profiles) {
    files[`greenfield/profiles/${item.name}.yaml`] = `title: ${item.title}\nagent: ${item.name}\n`;
    files[`greenfield/agents/${item.name}.md`] = `${identity(item.description ?? '')}# ${item.name}\n\n${item.description}\n`;
  }
  files['greenfield/profiles/orchestrator.yaml'] = 'title: Orchestrator\nphoto: covers/orchestrator.svg\nvariants:\n  claude: { agent: orchestrator }\n  codex: { agent: orchestrator-codex }\ndefault: claude\n';
  files['greenfield/agents/orchestrator.md'] = `${identity('Coordinate planners, implementers and reviewers for one workstream.', '\nskills: [plan, review]')}# Orchestrator\n\nYou run one workstream. Plan before building, and send every pull request to the reviewer.\n`;
  files['greenfield/agents/designer.md'] = `${identity('Draw three UI options on the real product.', '\nskills: [ui-mockup]')}# Designer\n\nCapture the real screen, then draw three options.\n`;
  files['greenfield/agents/planner.md'] = `${identity('Turn a request into a plan.', '\nskills: [plan]')}# Planner\n\nWrite the plan, then wait for the person to approve it.\n`;
  files['greenfield/covers/orchestrator.html'] = '<html><head><title>Orchestrator</title></head><body><h1>Greenfield orchestrator</h1><p>Runs one workstream from idea to merged pull request.</p><h2>How it works</h2><p>1 Plan with you · 2 Build in a Pane · 3 Review every PR · 4 Ask before merging</p><script>document.body.dataset.ran = "yes"</script></body></html>';
  files['greenfield/agents/business.md'] = `${identity('Answer BloomText support tickets.', '\nskills: [triage]\nreferences: business')}# Support\n\nAnswer new tickets in the help desk. Escalate refunds to the person through an approval.\n`;
  const overview: ProfilesOverview = { machine: 'studio-mac', plugins: [greenfield] };
  const photos: ProfilePhotos = { profiles: { 'greenfield/orchestrator': ORCHESTRATOR_PHOTO }, sources: { 'greenfield/orchestrator': 'plugin' }, titles: { 'greenfield/orchestrator': 'Orchestrator', 'greenfield/business': 'Business', 'greenfield/seo': 'SEO' } };
  return { overview, files, photos };
}

/** The same profiles as New Session reads them (chat-tab:profiles), titled by Agent Farm. */
const PALETTE_PROFILES: AgentFarmProfileEntry[] = [
  { ref: 'greenfield/orchestrator', plugin: 'greenfield', version: '0.1.0', harness: 'claude', hidden: false, title: 'Orchestrator' },
  { ref: 'greenfield/business', plugin: 'greenfield', version: '0.1.0', harness: 'claude', hidden: false, title: 'Business' },
  { ref: 'greenfield/seo', plugin: 'greenfield', version: '0.1.0', harness: 'claude', hidden: false, title: 'SEO' },
];

interface ProfilesOptions { theme?: string; saveError?: string; pins?: string[]; on?: boolean; sync?: ProfileSyncStatus; recovered?: ProfileRecovery[] }

async function installProfiles(page: Page, options: ProfilesOptions = {}): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const data = fixture();
  if (options.recovered) data.overview.recovered = options.recovered;
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

async function openProfilesTab(page: Page, options: Omit<ProfilesOptions, 'on'> = {}): Promise<void> {
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

test('the list shows every profile Agent Farm lists, by title, pinned first, and pins from a row', async ({ page }) => {
  await openProfilesTab(page, { pins: ['greenfield/business'] });
  const list = page.getByTestId('profiles-list');
  await expect(page.getByTestId('profiles-pinned-heading')).toBeVisible();
  await expect(list.getByTestId('profile-row-greenfield-business')).toContainText('Business');
  // greenfield 0.1.0's three profiles; its helpers are agents in the Orchestrator's tree, not profiles.
  await expect(list.locator('[data-profiles-item]')).toHaveCount(3);
  await expect(list.getByTestId('profile-row-greenfield-planner')).toHaveCount(0);
  await expect(page.getByTestId('profiles-all-heading')).toHaveText('All profiles· 2');
  await expect(list.getByTestId('profile-row-greenfield-orchestrator')).toContainText('Orchestrator');
  await expect(list.getByTestId('profile-row-greenfield-orchestrator')).toContainText('7 subagents · 1 Session · Claude or Codex');
  await expect(list.getByTestId('profile-row-greenfield-seo')).toContainText('SEO');
  // A single-agent profile names its one harness.
  await expect(list.getByTestId('profile-row-greenfield-seo')).toContainText(/voice\.Claude$/);
  // greenfield's own SVG photo shows on the Orchestrator's row.
  await expect(list.getByTestId('profile-row-greenfield-orchestrator').getByTestId('profile-avatar')).toHaveAttribute('data-avatar', 'picture');
  await expect(list.getByTestId('profile-row-greenfield-seo').getByTestId('profile-avatar')).toHaveAttribute('data-avatar', 'initials');
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
  await expect(page.getByTestId('profiles-title')).toHaveText('Orchestrator');
  await expect(page.getByTestId('profiles-subtitle')).toHaveText('greenfield/orchestrator · Coordinate planners, implementers and reviewers for one workstream. · ships with Pane');
  await expect(page.getByTestId('profiles-tree-cover')).toHaveAttribute('aria-selected', 'true');
});

test('pins lead Create New\'s To, which shows each profile by its title', async ({ page }) => {
  await openProfilesTab(page, { pins: ['greenfield/business'] });
  await page.getByTestId('new-orchestration-session').click();
  const dialog = page.getByTestId('create-new-dialog');
  await dialog.getByRole('combobox', { name: 'To', exact: true }).focus();
  await page.keyboard.type('green');
  const options = dialog.getByRole('listbox', { name: 'Agents and profiles' }).getByRole('option');
  await expect(options).toHaveText([/Business\s*greenfield\/business/, /Orchestrator\s*greenfield\/orchestrator/, /SEO\s*greenfield\/seo/]);
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
  await expect(cover.getByRole('heading', { name: 'Business', exact: true })).toBeVisible();
  await expect(cover).toContainText('Answers BloomText support tickets and escalates refunds to you.');
  await expect(cover).toContainText('Claude or Codex');
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
  await expect(page.getByTestId('profiles-cover-link')).toHaveText('designer · greenfield/designer · runs inside its parent');
  await expect(tree.getByTestId('profiles-file-agents/designer.md')).toBeVisible();
  // A launch link's cover says how it runs and gives the command that starts it on its own.
  await tree.getByTestId('profiles-tree-orchestrator/sub:planner').click();
  await expect(page.getByTestId('profiles-cover-link')).toHaveText('planner · greenfield/planner · runs as its own launch, in a tab or headless');
  await expect(page.getByTestId('profiles-cover-command')).toHaveText('agent-farm run greenfield/planner --agent-only');
  await expect(page.getByTestId('profiles-generated-cover')).toContainText('Claude or Codex');
  // Keyboard: ← closes a folder, → opens it.
  await tree.getByTestId('profiles-tree-orchestrator/skills').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tree.getByTestId('profiles-tree-orchestrator/skills/plan')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(tree.getByTestId('profiles-tree-orchestrator/skills/plan')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('profiles-list')).toBeVisible();
});

test('the tree says how each agent runs, and implementer ↔ reviewer stops at a cycle node', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-orchestrator').click();
  const tree = page.getByRole('tree', { name: 'greenfield/orchestrator files' });
  const note = (id: string) => tree.getByTestId(`profiles-tree-note-orchestrator/${id}`);
  await expect(note('sub:planner')).toHaveText('own launch');
  await expect(note('sub:qa-and-fix')).toHaveText('own launch');
  await expect(note('sub:explorer')).toHaveText('inside parent');
  await expect(note('sub:cold-reader')).toHaveText('inside parent');
  await expect(note('sub:advisor')).toHaveText('own process');
  await expect(tree.getByTestId('profiles-tree-orchestrator/sub:advisor')).toHaveAttribute('title', 'greenfield/advisor · Runs as its own process');
  await expect(tree.getByTestId('profiles-tree-orchestrator/sub:planner')).toHaveAttribute('title', 'greenfield/planner · Runs as its own launch, in a tab or headless · Claude or Codex');
  // Implementer → Reviewer → Implementer again: the last is a cycle, marked ↻ and not expanded.
  await tree.getByTestId('profiles-tree-orchestrator/sub:implementer').click();
  await tree.getByTestId('profiles-tree-orchestrator/sub:implementer/subagents').click();
  await tree.getByTestId('profiles-tree-orchestrator/sub:implementer/sub:reviewer').click();
  await expect(note('sub:implementer/sub:reviewer')).toHaveText('own launch');
  await tree.getByTestId('profiles-tree-orchestrator/sub:implementer/sub:reviewer/subagents').click();
  const cycleId = 'orchestrator/sub:implementer/sub:reviewer/sub:implementer';
  const cycle = tree.getByTestId(`profiles-tree-${cycleId}`);
  await expect(cycle).toBeVisible();
  await expect(cycle.getByTestId('profiles-tree-mark-cycle')).toBeVisible();
  await expect(tree.getByTestId(`profiles-tree-note-${cycleId}`)).toHaveText('already above');
  await expect(cycle).toHaveAttribute('title', 'greenfield/implementer, already above on this path · Runs as its own launch, in a tab or headless · Claude or Codex');
  await expect(cycle).not.toHaveAttribute('aria-expanded', /.+/);
  await cycle.click();
  await expect(page.getByTestId('profiles-cover-cycle')).toContainText('already above on this path');
  await expect(tree.getByTestId(`profiles-tree-${cycleId}/sub:reviewer`)).toHaveCount(0);
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

test('Edit details saves the title and description through Agent Farm, leaving greenfield\'s files and Edited alone', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-seo').click();
  await page.getByTestId('profiles-edit-details').click();
  const dialog = page.getByTestId('profiles-details-dialog');
  await expect(dialog.getByLabel('Title')).toHaveValue('SEO');
  await expect(dialog).toContainText('Agent Farm keeps the title, description and photo on this computer, apart from greenfield’s files');
  await dialog.getByLabel('Title').fill('Blog writer');
  await dialog.getByLabel('Description').fill('Drafts posts in my voice, then cuts a third.');
  await page.getByTestId('profiles-details-save').click();
  await expect(page.getByTestId('profiles-title')).toHaveText('Blog writer');
  // Still Pane's own copy: no ", edited", and nothing to restore.
  await expect(page.getByTestId('profiles-subtitle')).toHaveText('greenfield/seo · Drafts posts in my voice, then cuts a third. · ships with Pane');
  await expect(page.getByTestId('profiles-restore')).toHaveCount(0);
  await page.getByTestId('profiles-back').click();
  await expect(page.getByTestId('profile-row-greenfield-seo')).toContainText('Blog writer');
  await expect(page.getByTestId('profiles-edited-greenfield')).toHaveCount(0);
  // The agent's identity file keeps the plugin's own description.
  await page.getByTestId('profile-row-greenfield-seo').click();
  await page.getByTestId('profiles-file-agents/seo.md').click();
  await expect(page.getByTestId('profiles-front-matter')).toContainText('Draft blog posts in my voice.');
  await expect(page.getByTestId('profiles-front-matter')).not.toContainText('cuts a third');
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

test('a sample photo shows in the profile and its Session row; removing it brings the initials back, or the plugin\'s own photo', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-business').click();
  await page.getByTestId('profile-photo').click();
  await page.getByTestId('profile-photo-sample-star').click();
  const avatar = page.getByTestId('profile-photo').getByTestId('profile-avatar');
  await expect(avatar).toHaveAttribute('data-avatar', 'picture');
  await expect(avatar.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  const row = page.getByTestId('orchestration-session-s3');
  await expect(row.getByTestId('profile-avatar').first()).toHaveAttribute('data-avatar', 'picture');
  await page.getByTestId('profiles-edit-details').click();
  await page.getByTestId('profiles-details-initials').click();
  await expect(avatar).toHaveAttribute('data-avatar', 'initials');
  await expect(row.getByTestId('profile-avatar').first()).toHaveAttribute('data-avatar', 'initials');
  await page.keyboard.press('Escape');
  // The Orchestrator has greenfield's own photo: yours replaces it, and removing yours brings it back.
  await page.getByTestId('profiles-back').click();
  await page.getByTestId('profile-row-greenfield-orchestrator').click();
  await expect(avatar.locator('img')).toHaveAttribute('src', ORCHESTRATOR_PHOTO);
  await page.getByTestId('profile-photo').click();
  await expect(page.getByRole('menuitem', { name: 'Remove my photo' })).toBeDisabled();
  await page.getByTestId('profile-photo-sample-star').click();
  await expect(avatar.locator('img')).not.toHaveAttribute('src', ORCHESTRATOR_PHOTO);
  await page.getByTestId('profile-photo').click();
  await page.getByRole('menuitem', { name: 'Remove my photo' }).click();
  await expect(page.getByTestId('profiles-notice')).toContainText('Photo removed. The plugin’s own photo shows');
  await expect(avatar.locator('img')).toHaveAttribute('src', ORCHESTRATOR_PHOTO);
});

test('a photo is an SVG: a PNG is refused before it is sent, and an SVG file is set', async ({ page }) => {
  await openProfilesTab(page);
  await page.getByTestId('profile-row-greenfield-seo').click();
  await page.getByTestId('profiles-edit-details').click();
  const dialog = page.getByTestId('profiles-details-dialog');
  await expect(page.getByTestId('profiles-details-upload')).toHaveText('Upload SVG…');
  await expect(page.getByTestId('profiles-details-photo-file')).toHaveAttribute('accept', '.svg,image/svg+xml');
  await page.getByTestId('profiles-details-photo-file').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
  await expect(dialog.getByRole('alert')).toHaveText('avatar.png isn\'t an SVG. Profile photos are SVG files only: choose a .svg file, or pick a sample.');
  // SAFETY: installElectronApiMock adds this control before the app loads.
  const calls = () => page.evaluate(() => (window as typeof window & { __paneTestElectronMock: { getProfilesCalls: () => string[] } }).__paneTestElectronMock.getProfilesCalls());
  expect(await calls()).not.toContain('setPhoto');
  const avatar = dialog.getByTestId('profile-avatar');
  await expect(avatar).toHaveAttribute('data-avatar', 'initials');
  // A .svg whose text isn't an SVG: Agent Farm refuses it and says why.
  await page.getByTestId('profiles-details-photo-file').setInputFiles({ name: 'notes.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('just some text') });
  await expect(dialog.getByRole('alert')).toContainText('isn\'t an SVG image');
  await page.getByTestId('profiles-details-photo-file').setInputFiles({ name: 'seo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(ORCHESTRATOR_SVG) });
  await expect(avatar).toHaveAttribute('data-avatar', 'picture');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('profiles-details-initials')).toBeEnabled();
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

// #1740 review F-3: an edited greenfield this Agent Farm rejected was saved aside and replaced.
const RECOVERED: ProfileRecovery = {
  id: 'greenfield-0.0.46-2026-11-27T10-00-00-000Z',
  plugin: 'greenfield',
  folder: '/Users/you/.pane/agent-farm/recovered/greenfield-0.0.46-2026-11-27T10-00-00-000Z',
};

const profilesCalls = (page: Page) =>
  // SAFETY: installElectronApiMock adds this control before the app loads.
  page.evaluate(() => (window as typeof window & { __paneTestElectronMock: { getProfilesCalls: () => string[] } }).__paneTestElectronMock.getProfilesCalls());

for (const theme of ['light', 'dark']) {
  test(`a plugin Pane saved aside shows a notice once: Open folder opens it, and dismissed it stays gone (${theme})`, async ({ page }) => {
    await openProfilesTab(page, { theme, recovered: [RECOVERED] });
    const notice = page.getByTestId(`profiles-recovery-${RECOVERED.id}`);
    await expect(notice).toHaveText(`Your edits to greenfield didn't work with this version of Agent Farm. They're saved in ${RECOVERED.folder}.Open folder`);
    await shot(page, `recovery-notice-${theme}`);
    await expectNoAxeViolations(page, { include: `[data-testid="profiles-recovery-${RECOVERED.id}"]` });
    await notice.getByRole('button', { name: 'Open folder' }).click();
    await expect.poll(() => profilesCalls(page)).toContain('openRecovery');
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Dismiss the notice about greenfield' }).click();
    await expect(notice).toHaveCount(0);
    expect(await profilesCalls(page)).toContain('dismissRecovery');
    // Leaving and coming back reads the list again, and the notice doesn't return.
    await page.getByTestId('profiles-nav').click();
    await page.getByTestId('profiles-nav').click();
    await expect(page.getByTestId('profiles-view')).toBeVisible();
    await expect(page.getByTestId('profile-row-greenfield-orchestrator')).toBeVisible();
    await expect(page.getByTestId(`profiles-recovery-${RECOVERED.id}`)).toHaveCount(0);
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
    // The agent tree open down to the implementer ↔ reviewer cycle, on the launch link's cover.
    await page.getByTestId('profiles-tree-orchestrator/sub:implementer').click();
    await page.getByTestId('profiles-tree-orchestrator/sub:implementer/subagents').click();
    await page.getByTestId('profiles-tree-orchestrator/sub:implementer/sub:reviewer').click();
    await page.getByTestId('profiles-tree-orchestrator/sub:implementer/sub:reviewer/subagents').click();
    await expect(page.getByTestId('profiles-tree-mark-cycle')).toBeVisible();
    await expect(page.getByTestId('profiles-cover-command')).toBeVisible();
    await shot(page, `page-tree-links-${theme}`);
    await page.getByTestId('profiles-tree-orchestrator/sub:implementer/sub:reviewer/sub:implementer').click();
    await expect(page.getByTestId('profiles-cover-cycle')).toBeVisible();
    await shot(page, `page-tree-cycle-${theme}`);
    await page.getByTestId('profiles-tree-orchestrator/sub:designer').click();
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
    await page.getByTestId('profiles-details-photo-file').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    await expect(page.getByTestId('profiles-details-dialog').getByRole('alert')).toBeVisible();
    await shot(page, `page-details-png-refused-${theme}`);
    await page.keyboard.press('Escape');
    await page.getByTestId('profiles-file-agents/business.md').click();
    await page.getByTestId('profiles-edit').click();
    await page.getByTestId('profiles-editor').fill('# Support\n\nMy edit, not saved yet.\n');
    await writeOnDisk(page, 'greenfield', 'agents/business.md', '# Support\n\nAn agent changed this.\n');
    await expect(page.getByTestId('profiles-disk-changed')).toBeVisible({ timeout: 8000 });
    await shot(page, `page-disk-changed-${theme}`);
  });
}
