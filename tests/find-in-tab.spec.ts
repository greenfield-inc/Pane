import { expect, test, type Page } from '@playwright/test';
import { gotoApp, installElectronApiMock } from './electronApiMock';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';

// Cmd+F (Ctrl+F off macOS) opens Pane's find bar in the focused tab: J1
// (terminal) and J7 (markdown preview) from the cmd-f-find plan.

const project = {
  id: 912, name: 'Find fixture', path: '/tmp/find-fixture',
  active: true, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
};
const session = {
  id: 'find-session', name: 'Find pane', worktreePath: project.path,
  prompt: '', status: 'stopped', createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(), output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false,
  toolType: 'none', archived: false,
};

interface PanelCustomState {
  isInitialized?: boolean;
  filePath?: string;
  /** A chat tab's agent and launch. */
  agent?: string;
  launch?: { kind: string };
  cwd?: string;
  status?: string;
}

function panel(id: string, type: string, title: string, position: number, active: boolean, customState: PanelCustomState, permanent = false) {
  return {
    id, sessionId: session.id, type, title,
    state: { isActive: active, hasBeenViewed: true, customState },
    metadata: { createdAt: new Date(position).toISOString(), lastActiveAt: new Date(position).toISOString(), position, permanent },
  };
}

// 40 lines, 12 of which contain "needle".
const scrollback = Array.from({ length: 40 }, (_, index) => (index % 10 < 3 ? `line ${index} has a needle` : `line ${index} is hay`)).join('\r\n');

const markdown = '# Install\n\nRun the install step first.\n\n```sh\npnpm install\n```\n';

async function openPane(page: Page) {
  await gotoApp(page);
  await page.getByRole('button', { name: `Expand project ${project.name}`, exact: true }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
}

const findBar = (page: Page) => page.getByRole('search', { name: 'Find in tab' });

test('terminal: Cmd+F finds every match in scrollback and Esc gives the keys back to the shell', async ({ page }) => {
  // The mock workspace needs its permanent bottom terminal to render tabs.
  const bottom = panel('find-bottom-terminal', 'terminal', 'Bottom Terminal', 0, false, { isInitialized: true }, true);
  const terminal = panel('find-terminal', 'terminal', 'Terminal', 1, true, { isInitialized: true });
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [bottom, terminal],
    initialTerminalStates: { [terminal.id]: { scrollbackBuffer: scrollback } },
    activeProjectId: project.id,
  });
  await openPane(page);
  const tab = page.getByRole('tabpanel');
  await expect(tab.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  // Ready: a terminal still restoring its scrollback can move focus, so wait
  // until focus put in it stays there. Find is then pressed once.
  const xterm = tab.locator('.xterm-helper-textarea').first();
  await expect(async () => {
    await xterm.focus();
    await page.waitForTimeout(300);
    await expect(xterm).toBeFocused({ timeout: 100 });
  }).toPass();

  await page.keyboard.press('ControlOrMeta+f');
  const input = findBar(page).getByRole('textbox', { name: 'Find' });
  await expect(input).toBeFocused();
  await page.keyboard.type('needle');
  const counter = findBar(page).locator('[aria-live="polite"]');
  await expect(counter).toHaveText(/^\d+ of 12$/);
  // The search addon re-runs 200 ms after output is parsed; wait until the
  // restored scrollback's re-search has landed (the count holds for 600 ms).
  await expect(async () => {
    const before = await counter.textContent();
    await page.waitForTimeout(600);
    expect(await counter.textContent()).toBe(before);
  }).toPass();
  const ordinal = async () => Number((await counter.textContent())?.split(' of ')[0]);
  const first = await ordinal();
  const after = (steps: number) => `${((first - 1 + steps + 12 * 4) % 12) + 1} of 12`;

  await page.keyboard.press('Enter');
  await expect(counter).toHaveText(after(1));
  await page.keyboard.press('ControlOrMeta+g');
  await expect(counter).toHaveText(after(2));
  await page.keyboard.press('Shift+Enter');
  await expect(counter).toHaveText(after(1));
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(counter).toHaveText(after(0));
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(counter).toHaveText(after(-1));

  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
  await expect(xterm).toBeFocused();
});

async function openMarkdownPreview(page: Page, content: string) {
  const filePath = `${project.path}/README.md`;
  const editor = panel('find-readme', 'editor', 'README.md', 0, true, { filePath });
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [editor],
    activeProjectId: project.id,
  });
  // Same origin as the app, so the Range fetch needs no CORS preflight.
  await page.route('**/__find-preview/**', route => route.fulfill({
    status: 206,
    body: content,
    contentType: 'text/markdown',
    headers: { 'Content-Range': `bytes 0-${Buffer.byteLength(content) - 1}/${Buffer.byteLength(content)}` },
  }));
  await page.addInitScript(() => {
    const wrap = () => {
      const api = window.electronAPI;
      if (!api) return false;
      const invoke = api.invoke;
      api.invoke = (channel: string, ...args: unknown[]) => {
        if (channel === 'file:preview-url') return Promise.resolve(`${location.origin}/__find-preview/README.md`);
        if (channel === 'file:release-preview') return Promise.resolve();
        return invoke(channel, ...args);
      };
      return true;
    };
    if (!wrap()) document.addEventListener('DOMContentLoaded', wrap, { once: true });
  });
  await openPane(page);
  return page.getByRole('tabpanel');
}

test('markdown preview: Cmd+F highlights a heading, a paragraph and a code block', async ({ page }) => {
  const tab = await openMarkdownPreview(page, markdown);
  await expect(tab.getByRole('heading', { name: 'Install' })).toBeVisible();
  await tab.getByText('Run the install step first.').click();

  await page.keyboard.press('ControlOrMeta+f');
  const input = findBar(page).getByRole('textbox', { name: 'Find' });
  await expect(input).toBeFocused();
  await input.fill('install');
  await expect(findBar(page)).toContainText('1 of 3');
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('pane-find-match')?.size ?? 0)).toBe(3);
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('pane-find-current')?.size ?? 0)).toBe(1);

  await page.keyboard.press('Enter');
  await expect(findBar(page)).toContainText('2 of 3');
  await page.keyboard.press('ControlOrMeta+g');
  await expect(findBar(page)).toContainText('3 of 3');
  await page.keyboard.press('ControlOrMeta+g');
  await expect(findBar(page)).toContainText('1 of 3');

  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.has('pane-find-match'))).toBe(false);

  // With the bar closed, Shift+Cmd+G reopens on the last query and moves back
  // from the first match; Cmd+G moves forward.
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(findBar(page)).toContainText('3 of 3');
  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+g');
  await expect(findBar(page)).toContainText('2 of 3');

  // Esc closes the bar from its buttons too, not only from the input.
  await findBar(page).getByRole('button', { name: 'Next match' }).click();
  await expect(findBar(page)).toContainText('3 of 3');
  await expect(findBar(page).getByRole('button', { name: 'Next match' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
});

test('markdown preview: matches scrolled into view by hand are highlighted', async ({ page }) => {
  // 1,100 matches: more than the 500 painted either side of the current one.
  const many = Array.from({ length: 1100 }, (_, index) => `Paragraph ${index} has a kiwi.`).join('\n\n');
  const tab = await openMarkdownPreview(page, many);
  const last = tab.getByText('Paragraph 1099 has a kiwi.');
  await expect(last).toBeAttached();
  await tab.getByText('Paragraph 0 has a kiwi.').click();

  await page.keyboard.press('ControlOrMeta+f');
  await findBar(page).getByRole('textbox', { name: 'Find' }).fill('kiwi');
  await expect(findBar(page)).toContainText('1 of 1100');

  // The preview can re-render its paragraphs once more after loading; retry the scroll.
  await expect(async () => {
    await last.scrollIntoViewIfNeeded({ timeout: 1000 });
    await expect(last).toBeInViewport({ timeout: 500 });
  }).toPass();
  await expect.poll(() => page.evaluate(() => {
    const target = Array.from(document.querySelectorAll('p')).find(p => p.textContent === 'Paragraph 1099 has a kiwi.');
    const highlight = CSS.highlights.get('pane-find-match');
    if (!target || !highlight) return false;
    return Array.from(highlight.keys()).some(range => range instanceof Range && target.contains(range.startContainer));
  })).toBe(true);
  await expect(findBar(page)).toContainText('1 of 1100');
});

// ⌘F on approvals, the Approvals screen, the Summary and chats (keyboard-approvals C2, C3).

const asker = { paneId: 'worker-pane', panelId: 'worker-panel', name: 'planner', agent: 'Claude', session: { id: 'plans', name: 'Pane UI/UX improvements', paneId: 'find-session' } };
const approvals: NotifyItem[] = [
  {
    id: 'q12', ui: 'options', title: 'Q-12: Which key opens the keyboard shortcut sheet?', state: 'waiting', createdAt: Date.now() - 3 * 60_000, originKind: 'worker',
    context: 'It must not clash with typing; the keyboard is the point.', source: asker,
    choices: [{ label: 'Command slash everywhere', detail: 'The file editor keeps it for comments.', recommended: true }, { label: 'Question mark outside fields' }],
  },
  {
    id: 'q11', ui: 'options', title: 'Q-11: Merge #1352 now that CI is green?', state: 'waiting', createdAt: Date.now() - 11 * 60_000, originKind: 'worker',
    context: 'Merging unblocks the follow-up.', source: asker,
    choices: [{ label: 'Merge it', detail: 'Merge commit on main.', recommended: true }, { label: 'Wait for QA' }],
  },
];

function notifySnapshot(items: NotifyItem[]): NotifySnapshot {
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items, queue: items.map(item => item.id), hidden: [], strip: null, stripSurface: null,
    pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
  };
}

const summaryHtml = '<!doctype html><html><head><title>Summary</title></head><body><h1>What is decided</h1><p>The sheet opens with one key.</p><p>The key works while typing.</p></body></html>';

async function openApprovals(page: Page) {
  const terminal = panel('find-terminal', 'terminal', 'Terminal', 0, true, { isInitialized: true }, true);
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [terminal], activeProjectId: project.id,
    notifySnapshot: notifySnapshot(approvals),
    machineConnections: {
      machines: [{ id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null }],
      reads: { local: { 'notify:summary-page': { kind: 'template', html: summaryHtml } } },
    },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPane(page);
  await page.getByTestId('approvals-nav').click();
  await expect(page.getByTestId('approval-title')).toHaveText(approvals[0].title);
}

const matchCount = (page: Page) => page.evaluate(() => CSS.highlights.get('pane-find-match')?.size ?? 0);

test('Approvals screen: Cmd+F searches the list and the open approval, and follows paging', async ({ page }) => {
  await openApprovals(page);
  await page.getByTestId('approval-subtitle').click();
  await page.keyboard.press('ControlOrMeta+f');
  const input = findBar(page).getByRole('textbox', { name: 'Find' });
  await expect(input).toBeFocused();
  // "keyboard" is in the list row's title, the approval's title and its subtitle.
  await input.fill('keyboard');
  await expect(findBar(page)).toContainText('1 of 3');
  await expect.poll(() => matchCount(page)).toBe(3);
  await page.keyboard.press('ControlOrMeta+g');
  await expect(findBar(page)).toContainText('2 of 3');

  // Paging to the other approval searches again: its text has no "keyboard", the list still does.
  await page.getByTestId('approval-column').getByRole('button', { name: /next/i }).first().click();
  await expect(page.getByTestId('approval-title')).toHaveText(approvals[1].title);
  await expect(findBar(page)).toContainText(/of 1$/);

  await input.focus();
  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
  await expect.poll(() => matchCount(page)).toBe(0);
  // Esc in the bar closes only the bar: Approvals stays open.
  await expect(page.getByTestId('approvals-queue')).toBeVisible();
});

test('Approvals screen: Cmd+F from the reply box searches the approval and keeps the draft', async ({ page }) => {
  await openApprovals(page);
  const reply = page.getByTestId('approval-reply-box');
  await reply.click();
  await page.keyboard.type('a draft answer');
  await page.keyboard.press('ControlOrMeta+f');
  await expect(findBar(page).getByRole('textbox', { name: 'Find' })).toBeFocused();
  await page.keyboard.type('clash');
  await expect(findBar(page)).toContainText('1 of 1');
  await expect(reply).toHaveValue('a draft answer');
});

test('Summary: Cmd+F finds text inside the sandboxed page, also with focus inside it', async ({ page }) => {
  await openApprovals(page);
  await page.getByRole('tab', { name: /Summary/ }).click();
  const frame = page.frameLocator('[data-testid="approval-summary-frame"]');
  await expect(frame.getByRole('heading', { name: 'What is decided' })).toBeVisible();
  const frameMatches = () => page.locator('[data-testid="approval-summary-frame"]').evaluate((element) => {
    // SAFETY: the test reads the frame Pane renders; it is same-origin by design.
    const view = (element as HTMLIFrameElement).contentWindow as (Window & typeof globalThis) | null;
    return view?.CSS.highlights.get('pane-find-match')?.size ?? -1;
  });

  // Focus inside the frame: its keys still reach Pane.
  await frame.getByText('The sheet opens with one key.').click();
  await page.keyboard.press('ControlOrMeta+f');
  const input = findBar(page).getByRole('textbox', { name: 'Find' });
  await expect(input).toBeFocused();
  await input.fill('key');
  await expect(findBar(page)).toContainText('1 of 2');
  await expect.poll(frameMatches).toBe(2);
  // Nothing outside the frame is highlighted for it.
  await expect.poll(() => matchCount(page)).toBe(0);

  // The frame never runs scripts, whatever else it is allowed.
  const sandbox = await page.getByTestId('approval-summary-frame').getAttribute('sandbox');
  expect(sandbox?.split(/\s+/)).not.toContain('allow-scripts');

  // Back on Decide, the same query searches the approval again.
  await page.getByRole('tab', { name: /Decide/ }).click();
  // "key" twice in the list row, twice in the title, once in the subtitle.
  await expect(page.getByTestId('approval-summary-frame')).toHaveCount(0);
  await expect(findBar(page)).toContainText('1 of 5');
  await expect.poll(() => matchCount(page)).toBe(5);
});

test('chat: Cmd+F from the composer searches the whole conversation', async ({ page }) => {
  const chat = panel('find-chat', 'chat', 'Claude', 0, true, { agent: 'claude', launch: { kind: 'new' }, cwd: project.path, status: 'idle' });
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [chat], activeProjectId: project.id,
    chatMessages: {
      [chat.id]: [
        { id: 'm1', role: 'user', text: 'Plan the keyboard shortcut sheet and approvals keys.' },
        { id: 'm2', role: 'assistant', text: 'I have drawn three sheet layouts and the approvals key map.' },
        { id: 'm3', role: 'user', text: 'Use the rail layout.' },
      ],
    },
  });
  await openPane(page);
  const composer = page.getByRole('textbox', { name: 'Message Claude' });
  await expect(page.getByText('Use the rail layout.')).toBeVisible();
  await composer.click();
  await page.keyboard.type('draft');
  await page.keyboard.press('ControlOrMeta+f');
  const input = findBar(page).getByRole('textbox', { name: 'Find' });
  await expect(input).toBeFocused();
  await input.fill('approvals');
  await expect(findBar(page)).toContainText('1 of 2');
  await expect.poll(() => matchCount(page)).toBe(2);
  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
  await expect(composer).toHaveText('draft');
});

test('chat: Cmd+F finds a message far above the turns on screen in a long chat, and shows it', async ({ page }) => {
  const chat = panel('find-chat', 'chat', 'Claude', 0, true, { agent: 'claude', launch: { kind: 'new' }, cwd: project.path, status: 'idle' });
  // 150 turns: only the newest render until find opens (T-87 Phase 2).
  const messages = Array.from({ length: 150 }, (_, turn) => [
    { id: `u${turn}`, role: 'user' as const, text: `Request ${turn}: check module ${turn % 7}.` },
    { id: `a${turn}`, role: 'assistant' as const, text: `Reply ${turn}: the module is fine.\n\n- one\n- two\n\nShort.` },
  ]).flat();
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [chat], activeProjectId: project.id,
    chatMessages: { [chat.id]: messages },
  });
  await openPane(page);
  await expect(page.getByText('Reply 149:', { exact: false })).toBeVisible();
  await expect(page.getByText('Request 3:', { exact: false })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Message Claude' }).click();
  await page.keyboard.press('ControlOrMeta+f');
  const input = findBar(page).getByRole('textbox', { name: 'Find' });
  await expect(input).toBeFocused();
  await input.fill('Request 3:');
  await expect(findBar(page)).toContainText('1 of 1');
  await expect(page.getByText('Request 3:', { exact: false })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
  await expect(async () => expect(await page.locator('.chat-turn-row').count()).toBeLessThan(60)).toPass();
});

test('chat: the count keeps up while the conversation streams, not only once it pauses', async ({ page }) => {
  const chat = panel('find-chat', 'chat', 'Claude', 0, true, { agent: 'claude', launch: { kind: 'new' }, cwd: project.path, status: 'idle' });
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [chat], activeProjectId: project.id,
    chatMessages: { [chat.id]: [{ id: 'm1', role: 'assistant', text: 'Streaming the needle report.' }] },
  });
  await openPane(page);
  const message = page.getByText('Streaming the needle report.');
  await message.click();
  await page.keyboard.press('ControlOrMeta+f');
  await findBar(page).getByRole('textbox', { name: 'Find' }).fill('needle');
  await expect(findBar(page)).toContainText('1 of 1');
  // A chunk every 60 ms for 2 seconds: the stream never pauses long enough for a quiet-period search.
  const { counts, chunks } = await message.evaluate(async (host) => {
    const seen = new Set<string>();
    const bar = () => document.querySelector('search[aria-label="Find in tab"]')?.textContent?.match(/of (\d+)/)?.[1] ?? '';
    const started = performance.now();
    while (performance.now() - started < 2000) {
      const chunk = document.createElement('span');
      chunk.textContent = ' another needle';
      host.appendChild(chunk);
      seen.add(bar());
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return { counts: [...seen], chunks: host.querySelectorAll('span').length };
  });
  expect(counts.length).toBeGreaterThan(1);
  // Once it stops, the count covers every chunk.
  await expect(findBar(page)).toContainText(`of ${chunks + 1}`);
});
