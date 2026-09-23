import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { installElectronApiMock } from './electronApiMock';

/**
 * Evidence screenshots for the 15 batch themes (neon, editorial, retro,
 * atmosphere and accessibility families).
 *
 * Writes `screenshots/themes/batch/<theme-id>.png` (the same view for every
 * theme: sidebar + a session with the terminal dock and the diff/review panel
 * visible), `<theme-id>-high-contrast.png` for one light and one dark theme,
 * colour-vision-deficiency simulations for the colorblind-safe theme, and the
 * Appearance picker showing the full grouped list.
 *
 * Run: `pnpm theme:screenshots` (uses playwright.themes.config.ts, which sets
 * PANE_THEME_SCREENSHOTS=1 so the files land in screenshots/themes/batch/).
 * Under a plain `pnpm test` the same assertions run but screenshots go to the
 * Playwright output directory. A Vite dev server is enough — the electron API
 * is mocked.
 */

// Committed evidence lives in screenshots/themes/batch/. Only the dedicated
// `pnpm theme:screenshots` config (playwright.themes.config.ts) sets
// PANE_THEME_SCREENSHOTS, so a plain `pnpm test` never rewrites tracked PNGs.
const WRITE_TO_REPO = process.env.PANE_THEME_SCREENSHOTS === '1';
const OUTPUT_DIR = path.resolve(__dirname, '..', 'screenshots', 'themes', 'batch');
// Family order matches THEME_OPTIONS (frontend/src/utils/themeOptions.ts).
const BATCH_THEMES = [
  'synthwave', 'acid', 'tokyo-rain',
  'folio', 'newsprint', 'walnut',
  'amber-crt', 'teletype', 'dot-matrix',
  'haar', 'abyss', 'understory',
  'colorblind-safe', 'low-fatigue', 'high-legibility',
] as const;
type BatchTheme = (typeof BATCH_THEMES)[number];
const CVD_THEME: BatchTheme = 'colorblind-safe';
// High-contrast mode is asserted for every theme; captured for one light and one dark theme.
const HIGH_CONTRAST_CAPTURES: readonly BatchTheme[] = ['folio', 'synthwave'];
const PICKER_LABELS = [
  'Synthwave', 'Acid Terminal', 'Tokyo Rain',
  'Folio', 'Newsprint', 'Walnut',
  'Amber CRT', 'Teletype', 'Dot Matrix',
  'Haar', 'Abyss', 'Understory',
  'Colorblind Safe', 'Low Fatigue', 'High Legibility',
];
const PICKER_GROUPS = ['Standard', 'Neon', 'Editorial', 'Retro', 'Atmosphere', 'Accessibility'];

// Machado, Oliveira & Fernandes (2009) severity-1.0 matrices — the same ones
// scripts/check-theme-contrast.mjs uses, applied here as an SVG feColorMatrix
// (which operates in linearRGB by default, matching the script).
const CVD_MATRICES = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
} satisfies Record<string, number[][]>;
type CvdKind = keyof typeof CVD_MATRICES;
// SAFETY: CVD_MATRICES is a closed object literal, so its runtime keys are exactly CvdKind.
const CVD_KINDS = Object.keys(CVD_MATRICES) as CvdKind[];

const project = {
  id: 610,
  name: 'pane',
  path: '/tmp/theme-fixture/pane',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'theme-session',
  name: 'themes-batch-15',
  worktreePath: '/tmp/theme-fixture/pane/worktrees/themes-batch-15',
  prompt: 'Add 15 themes: neon, editorial, retro, atmosphere, and accessibility families',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder: 0,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  gitStatus: {
    state: 'ahead',
    ahead: 2,
    behind: 0,
    hasUncommittedChanges: true,
    hasUntrackedFiles: true,
    filesChanged: 3,
    additions: 41,
    deletions: 6,
    totalCommits: 2,
  },
};

const secondSession = {
  ...session,
  id: 'theme-session-2',
  name: 'issue-402-sidebar-focus',
  worktreePath: '/tmp/theme-fixture/pane/worktrees/issue-402',
  status: 'running',
  isRunning: true,
  displayOrder: 1,
  gitStatus: { ...session.gitStatus, state: 'clean', hasUncommittedChanges: false, hasUntrackedFiles: false },
};

const panels = [
  {
    id: 'theme-terminal',
    sessionId: session.id,
    type: 'terminal',
    title: 'Terminal',
    state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: true } },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 0, permanent: true },
  },
  {
    id: 'theme-explorer',
    sessionId: session.id,
    type: 'explorer',
    title: 'Explorer',
    state: { isActive: false, hasBeenViewed: true },
    metadata: { createdAt: new Date(1).toISOString(), lastActiveAt: new Date(1).toISOString(), position: 1, permanent: true },
  },
  {
    id: 'theme-diff',
    sessionId: session.id,
    type: 'diff',
    title: 'Diff',
    state: { isActive: true, hasBeenViewed: true },
    metadata: { createdAt: new Date(2).toISOString(), lastActiveAt: new Date(2).toISOString(), position: 2, permanent: true },
  },
];

const executions = [{
  id: 1,
  session_id: session.id,
  execution_sequence: 1,
  after_commit_hash: 'ba7c415e5c',
  commit_message: 'Add 15 themes across five families',
  timestamp: '2026-08-18T12:00:00.000Z',
  stats_additions: 41,
  stats_deletions: 6,
  stats_files_changed: 3,
  author: 'Pane',
  comparison_branch: 'origin/main',
  history_source: 'branch',
}];

const combinedDiff = {
  diff: [
    'diff --git a/frontend/src/contexts/themeContextValue.ts b/frontend/src/contexts/themeContextValue.ts',
    'index 1111111..2222222 100644',
    '--- a/frontend/src/contexts/themeContextValue.ts',
    '+++ b/frontend/src/contexts/themeContextValue.ts',
    '@@ -1,6 +1,14 @@',
    ' import { createContext } from \'react\';',
    ' ',
    '-export type Theme = \'light\' | \'light-rounded\' | \'dark\' | \'terracotta\';',
    '+export type Theme =',
    '+  | \'light\'',
    '+  | \'light-rounded\'',
    '+  | \'dark\'',
    '+  | \'terracotta\'',
    '+  | \'synthwave\'',
    '+  | \'folio\'',
    '+  | \'amber-crt\'',
    '+  | \'haar\'',
    '+  | \'colorblind-safe\';',
    '+',
    '+export const isLightTheme = (theme: Theme): boolean => THEME_CLASSES[theme][0] === \'light\';',
    ' ',
    ' export interface ThemeContextType {',
    '   theme: Theme;',
    '@@ -12,4 +20,3 @@ export interface ThemeContextType {',
    '   highContrast: boolean;',
    ' }',
    ' ',
    '-export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);',
    '-',
    '+export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);',
  ].join('\n'),
  stats: { additions: 41, deletions: 6, filesChanged: 3 },
  changedFiles: ['frontend/src/contexts/themeContextValue.ts'],
};

// A realistic slice of terminal output: prompt, git status, a test summary and
// a full 16-colour ANSI swatch so every terminal token is visible in the shot.
const ESC = '\u001b[';
const ansi = (code: string, text: string) => `${ESC}${code}m${text}${ESC}0m`;
const swatchRow = (label: string, base: number) => {
  const names = ['blk', 'red', 'grn', 'ylw', 'blu', 'mag', 'cyn', 'wht'];
  const cells = names.map((name, i) => ansi(String(base + i), ` ${name} `)).join(' ');
  return `${label} ${cells}`;
};
const terminalScrollback = [
  `${ansi('1;32', '➜')} ${ansi('1;36', 'pane')} ${ansi('1;34', 'git:(')}${ansi('1;31', 'themes-batch-15')}${ansi('1;34', ')')} ${ansi('33', '✗')} git status --short`,
  ` ${ansi('32', 'M')} frontend/src/styles/tokens/colors.css`,
  ` ${ansi('32', 'M')} frontend/src/index.css`,
  `${ansi('31', '??')} scripts/check-theme-contrast.mjs`,
  '',
  `${ansi('1;32', '➜')} ${ansi('1;36', 'pane')} pnpm theme:contrast`,
  `${ansi('1', '== synthwave (gated: text ≥ 4.5:1, UI ≥ 3:1, terminal ≥ 4.5:1) ==')}`,
  `  ${ansi('2', '138/138 checks pass')}`,
  `${ansi('1', '== colorblind-safe (gated: text ≥ 4.5:1, UI ≥ 3:1, terminal ≥ 4.5:1, hairlines gated) ==')}`,
  `  ${ansi('32', 'ok')}   status       deuteranopia  ΔE  18.38  min 5.00:1`,
  `  ${ansi('2', '148/148 checks pass')}`,
  '',
  `${ansi('1;32', '➜')} ${ansi('1;36', 'pane')} ${ansi('2', '# sample status lines (theme swatch, not a real run)')}`,
  `  ${ansi('32', 'ok  ')} success   ${ansi('2', 'sample line in the success colour')}`,
  `  ${ansi('33', 'warn')} warning   ${ansi('2', 'sample line in the warning colour')}`,
  `  ${ansi('31', 'FAIL')} error     ${ansi('2', 'sample line in the error colour')}`,
  `  ${ansi('1;32', 'bold green')} ${ansi('2', '·')} ${ansi('1;33', 'bold yellow')} ${ansi('2', '·')} ${ansi('1;31', 'bold red')} ${ansi('2', '·')} ${ansi('1;34', 'bold blue')}`,
  '',
  swatchRow('normal', 30),
  swatchRow('bright', 90),
  swatchRow('bg    ', 40),
  '',
  `${ansi('1;32', '➜')} ${ansi('1;36', 'pane')} ${ansi('2', 'claude')} `,
].join('\r\n');

async function openSession(page: Page, theme: string, opts: { highContrast?: boolean } = {}): Promise<void> {
  const highContrast = opts.highContrast === true;
  await page.addInitScript(({ themeId, hc }) => {
    window.localStorage.setItem('theme', themeId);
    if (hc) window.localStorage.setItem('high-contrast', 'true');
  }, { themeId: theme, hc: highContrast });
  await installElectronApiMock(page, {
    initialConfig: { theme, appearanceMode: 'fixed', highContrast },
    initialProjects: [project],
    initialSessions: [session, secondSession],
    initialPanels: panels,
    initialExecutions: executions,
    diffManifests: {
      session: {
        scope: { kind: 'session' },
        files: [{ path: 'frontend/src/contexts/themeContextValue.ts', kind: 'modified', additions: 41, deletions: 6, isBinary: false }],
        resolvedBase: { kind: 'comparison-base', ref: 'origin/main', hash: '1111111111111111111111111111111111111111' },
        resolvedTarget: { kind: 'working-tree' },
        stats: combinedDiff.stats,
      },
    },
    fileDiffs: {
      'session:frontend/src/contexts/themeContextValue.ts': { file: { path: 'frontend/src/contexts/themeContextValue.ts', kind: 'modified', additions: 41, deletions: 6, isBinary: false }, patch: combinedDiff.diff, status: 'changed' },
    },
    initialTerminalStates: { 'theme-terminal': { scrollbackBuffer: terminalScrollback } },
    initialUiState: { expandedProjects: [project.id] },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
  if (highContrast) await expect(page.locator('html')).toHaveClass(/\bhigh-contrast\b/);

  const expandRepo = page.getByRole('button', { name: /^Expand repository pane$/ });
  if (await expandRepo.isVisible().catch(() => false)) await expandRepo.click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Changes', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();

  const expandTerminal = page.getByRole('button', { name: 'Expand terminal', exact: true });
  if (await expandTerminal.isVisible().catch(() => false)) await expandTerminal.click();
  await expect(page.locator('.pane-terminal-shell-body .xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  // Open the single changed file as a diff tab so the add/remove tints are visible.
  const openFile = page.getByRole('option', {
    name: /^Open diff for frontend\/src\/contexts\/themeContextValue\.ts, Modified, \+41 −6$/,
  });
  await expect(openFile).toBeVisible({ timeout: 15_000 });
  await openFile.click();
  await expect(page.locator('.diff-tailwindcss-wrapper').first()).toBeVisible({ timeout: 15_000 });
  // Let xterm replay + shiki highlighting settle before capturing.
  await page.mouse.move(4, 4);
  await page.waitForTimeout(600);
}

async function applyCvdFilter(page: Page, kind: CvdKind | null): Promise<void> {
  await page.evaluate(({ id, matrix }) => {
    document.getElementById('pane-cvd-filter')?.remove();
    document.getElementById('pane-cvd-style')?.remove();
    if (!id || !matrix) return;
    const values = matrix.map((row) => [...row, 0, 0].join(' ')).join(' ') + ' 0 0 0 1 0';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'pane-cvd-filter';
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = `<filter id="pane-cvd" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${values}"/></filter>`;
    document.body.appendChild(svg);
    const style = document.createElement('style');
    style.id = 'pane-cvd-style';
    style.textContent = 'html { filter: url(#pane-cvd); }';
    document.head.appendChild(style);
  }, { id: kind, matrix: kind ? CVD_MATRICES[kind] : null });
  await page.waitForTimeout(150);
}

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(() => {
  if (WRITE_TO_REPO) mkdirSync(OUTPUT_DIR, { recursive: true });
});

const outputFile = (testInfo: TestInfo, name: string): string => (
  WRITE_TO_REPO ? path.join(OUTPUT_DIR, name) : testInfo.outputPath(name)
);

for (const theme of BATCH_THEMES) {
  test(`${theme}: main view screenshot`, async ({ page }, testInfo) => {
    await openSession(page, theme);
    const file = outputFile(testInfo, `${theme}.png`);
    await page.screenshot({ path: file });
    await testInfo.attach(`${theme}.png`, { path: file, contentType: 'image/png' });

    if (theme === CVD_THEME) {
      for (const kind of CVD_KINDS) {
        await applyCvdFilter(page, kind);
        const simFile = outputFile(testInfo, `${theme}-${kind}.png`);
        await page.screenshot({ path: simFile });
        await testInfo.attach(`${theme}-${kind}.png`, { path: simFile, contentType: 'image/png' });
      }
      await applyCvdFilter(page, null);
    }
  });

  test(`${theme}: high-contrast mode composes on top`, async ({ page }, testInfo) => {
    await openSession(page, theme, { highContrast: true });
    // The high-contrast block must actually change the muted token for this theme:
    // read it with the class on, then with the class removed, and require a difference.
    const [withHc, withoutHc] = await page.evaluate(() => {
      const read = () => getComputedStyle(document.documentElement).getPropertyValue('--color-text-muted').trim();
      const on = read();
      document.documentElement.classList.remove('high-contrast');
      const off = read();
      document.documentElement.classList.add('high-contrast');
      return [on, off];
    });
    expect(withHc).not.toBe('');
    expect(withHc).not.toBe(withoutHc);
    testInfo.annotations.push({ type: 'muted-token', description: `${theme}: ${withoutHc} → ${withHc} with high-contrast` });

    if (HIGH_CONTRAST_CAPTURES.includes(theme)) {
      const file = outputFile(testInfo, `${theme}-high-contrast.png`);
      await page.screenshot({ path: file });
      await testInfo.attach(`${theme}-high-contrast.png`, { path: file, contentType: 'image/png' });
    }
  });
}

test('appearance picker shows all 15 themes, grouped by family', async ({ page }, testInfo) => {
  // Tall viewport so the whole grouped list is on screen for the capture.
  await page.setViewportSize({ width: 1440, height: 1700 });
  await page.addInitScript(() => { window.localStorage.setItem('theme', 'colorblind-safe'); });
  await installElectronApiMock(page, {
    initialConfig: { theme: 'colorblind-safe', appearanceMode: 'fixed' },
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 15_000 });
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Pane Settings' });
  await expect(dialog).toBeVisible();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();

  const trigger = page.getByRole('combobox', { name: 'Theme' });
  await expect(trigger).toHaveText('Colorblind Safe');
  await trigger.click();
  for (const label of PICKER_LABELS) {
    await expect(page.getByRole('option', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
  for (const group of PICKER_GROUPS) {
    await expect(page.getByRole('group', { name: group })).toBeVisible();
  }
  // As the user sees it: the popover is a scroll box (SelectContent caps at max-h-96), opened
  // at the current selection. Scroll to the top so the first groups are in frame.
  await page.locator('[data-radix-select-viewport]').evaluate((el) => { el.scrollTop = 0; });
  await page.getByRole('option', { name: /^Synthwave/ }).hover();
  await page.waitForTimeout(200);
  const file = outputFile(testInfo, 'appearance-picker.png');
  await page.screenshot({ path: file });
  await testInfo.attach('appearance-picker.png', { path: file, contentType: 'image/png' });

  // Capture-only: lift the popover height cap and pin the popper near the top of a tall
  // viewport so every group and entry is in one frame. (In the app the list scrolls;
  // nothing here changes shipped styles — the override is removed again below.)
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 2400 });
  await trigger.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]');
    const left = wrapper ? Math.round(wrapper.getBoundingClientRect().left) : 0;
    const style = document.createElement('style');
    style.id = 'pane-picker-unroll';
    style.textContent = [
      '[data-radix-popper-content-wrapper], [data-radix-popper-content-wrapper] > *, [data-radix-select-viewport] { max-height: none !important; height: auto !important; }',
      `[data-radix-popper-content-wrapper] { transform: translate(${left}px, 24px) !important; }`,
    ].join('\n');
    document.head.appendChild(style);
  });
  await expect(page.getByRole('option', { name: /^High Legibility/ })).toBeInViewport();
  await page.waitForTimeout(400);
  const fullFile = outputFile(testInfo, 'appearance-picker-full-list.png');
  await page.screenshot({ path: fullFile });
  await testInfo.attach('appearance-picker-full-list.png', { path: fullFile, contentType: 'image/png' });
  await page.evaluate(() => document.getElementById('pane-picker-unroll')?.remove());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1700 });
  await trigger.click();
  await expect(page.getByRole('listbox')).toBeVisible();

  // Selecting through the picker persists the id to config.
  await page.getByRole('option', { name: /^High Legibility/ }).click();
  await expect(trigger).toHaveText('High Legibility');
  await expect(page.locator('html')).toHaveClass(/\bhigh-legibility\b/);
  await expect(page.locator('html')).toHaveClass(/\blight\b/);
});
