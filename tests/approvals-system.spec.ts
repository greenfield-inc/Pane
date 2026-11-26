import { expect, test, type Page } from '@playwright/test';
import { gotoApp, installElectronApiMock } from './electronApiMock';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';

// The approvals system's chat surfaces (P5, P6, P7): one compact card with a pager above a
// Session chat's composer, no copy of the chat's own question, and a status line naming the
// agent reading a reply. Rendered from a Notify snapshot; no app, no agent.

const now = new Date(0).toISOString();
const project = { id: 81, name: 'Approvals fixture', path: '/tmp/approvals-fixture', active: true, created_at: now, updated_at: now };
const session = { id: 's1', name: 'Orgs, Workspaces, Versioning', paneId: 'session-pane' };
const pane = {
  id: 'session-pane', name: 'orgs-orchestrator', worktreePath: '/tmp/approvals-fixture/session-pane', prompt: '', status: 'stopped', createdAt: now, lastActivity: now,
  output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder: 0,
  isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};
const panels = [
  { id: 'dock', sessionId: 'session-pane', type: 'terminal', title: 'Terminal', state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: false } }, metadata: { createdAt: now, lastActiveAt: now, position: 0 } },
  {
    id: 'chat', sessionId: 'session-pane', type: 'chat', title: 'Claude',
    state: { isActive: true, hasBeenViewed: true, customState: { agent: 'claude', launch: { kind: 'new' }, cwd: pane.worktreePath, status: 'idle', orchestrationSessionId: session.id } },
    metadata: { createdAt: now, lastActiveAt: now, position: 1 },
  },
];

function approval(id: string, title: string, minutesAgo: number, extra: Partial<NotifyItem> = {}): NotifyItem {
  return {
    id, ui: 'options', title, state: 'waiting', createdAt: Date.now() - minutesAgo * 60_000, originKind: 'worker',
    source: { paneId: 'worker-pane', panelId: 'worker-panel', name: 'okta-sso-account', agent: 'Claude', session },
    choices: [{ label: 'Keep it', detail: 'They lose only this account’s orgs.', recommended: true }, { label: 'Sign them out everywhere' }],
    ...extra,
  };
}

const q42 = approval('q42', 'Okta sign-out rework: two choices before the cover sheet is approved', 2, {
  context: 'The one-day check passed: option A holds (5 of 5 checks, 2 with caveats the plan absorbs). Cover sheet r1 is ready, and approving it needs these two answers.',
  choices: undefined,
  questions: [
    { title: 'With Require SSO off, does someone Okta removes keep their password session for their other orgs?', choices: [{ label: 'Keep it', recommended: true }, { label: 'Sign them out everywhere' }] },
    { title: 'When Require SSO is on, whose password sessions end?', why: 'Same rule as SSO sign-in.', choices: [{ label: 'Everyone on the domain', recommended: true }, { label: 'Only the account’s members' }] },
  ],
  links: [{ label: 'Cover sheet r1', path: '/tmp/okta/cover-sheet.html' }, { label: 'Decision log § Q-42', path: '/tmp/okta/decisions.html#q-42' }, { label: 'okta-sso-account status', path: '/tmp/okta/status.json' }],
});
const q44 = approval('q44', 'Q-44: Merge #1521 once the follow-up review passes?', 9, { context: 'The follow-up review checks only the fix commit. CI is green; merging unblocks P3.', source: { ...q42.source, name: 'p2-review' } });
const q45 = approval('q45', 'Q-45: Show the version badge in the web footer too?', 21, { context: 'The badge ships in the app header today.' });
/** The chat's own AskUserQuestion, copied to Approvals: the chat already shows Claude's card. */
const ownQuestion = approval('own', 'Update the snapshot too, or leave it?', 1, { replyIsAnswer: true, source: { paneId: 'session-pane', panelId: 'chat', name: 'orgs-orchestrator', agent: 'Claude', session: { ...session, orchestrator: true } } });

function snapshot(items: NotifyItem[]): NotifySnapshot {
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items, queue: items.filter(item => item.state === 'waiting').map(item => item.id), hidden: [], strip: null, stripSurface: null,
    pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
  };
}

type MockWindow = typeof window & { __paneTestElectronMock: { getNotifyCommands(): unknown[]; emitNotifySnapshot(snapshot: NotifySnapshot): void } };
// SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
const notifyCommands = (page: Page) => page.evaluate(() => (window as MockWindow).__paneTestElectronMock.getNotifyCommands());
// SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
const emitSnapshot = (page: Page, next: NotifySnapshot) => page.evaluate((value) => (window as MockWindow).__paneTestElectronMock.emitNotifySnapshot(value), next);

async function openChat(page: Page, items: NotifyItem[]): Promise<void> {
  await installElectronApiMock(page, { initialProjects: [project], initialSessions: [pane], initialPanels: panels, activeProjectId: project.id, notifySnapshot: snapshot(items) });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.getByRole('button', { name: 'Expand project Approvals fixture', exact: true }).click();
  await page.getByRole('button', { name: 'orgs-orchestrator', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Claude' })).toBeVisible();
}

test('J6, P5: the chat shows one compact card with a pager and no options, leaving out its own question', async ({ page }, testInfo) => {
  await openChat(page, [q42, q44, q45, ownQuestion]);
  const cards = page.getByTestId('session-approval-card');
  await expect(cards).toHaveCount(1);
  // Newest first, as the column's pager walks them (T-88); the chat's own AskUserQuestion isn't one of them.
  await expect(page.getByTestId('session-approval-card-pager')).toHaveText('1 of 3');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q42.title);
  await expect(cards).toContainText('2 questions');
  await expect(cards).toContainText('3 references');
  await expect(page.getByTestId('session-approval-card-choice')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('08-compact-card.png') });
  await page.getByTestId('session-approval-card-next').click();
  await page.getByTestId('session-approval-card-next').click();
  await expect(page.getByTestId('session-approval-card-pager')).toHaveText('3 of 3');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q45.title);
  await expect(page.getByTestId('session-approval-card-subtitle')).toHaveText(q45.context ?? '');
});

test('J8: after a send, a status line names the agent reading the reply, and the next approval takes the card', async ({ page }, testInfo) => {
  const sent = { ...q42, title: `Q-42: ${q42.title}`, reply: { id: 'r1', text: 'Keep it, but say so in the docs', picks: ['Keep it', 'Everyone on the domain'], at: Date.now(), state: 'reading' as const, reader: { kind: 'asker' as const, name: 'okta-sso-account' }, deliveredAt: Date.now() } };
  await openChat(page, [sent, q44]);
  const line = page.getByTestId('session-approval-status');
  await expect(line).toHaveText(/okta-sso-account is reading your reply to Q-42…\s*Reopen/u);
  await expect(page.getByTestId('session-approval-card-pager')).toHaveText('1 of 1');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q44.title);
  await page.screenshot({ path: testInfo.outputPath('10-reading.png') });
});

test('Q-389: Dismiss on the chat\'s card closes it without answering; it stays in Approvals and comes back only when it changes', async ({ page }, testInfo) => {
  await openChat(page, [q44, q45]);
  await expect(page.getByTestId('session-approval-card-pager')).toHaveText('1 of 2');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q44.title);
  await page.screenshot({ path: testInfo.outputPath('q389-chat-card-with-dismiss.png') });

  await page.getByTestId('session-approval-card-dismiss').click();
  // No answer: only the strip's dismiss, which keeps the item waiting in Approvals.
  await expect.poll(() => notifyCommands(page)).toEqual([{ type: 'dismiss', id: 'q44' }]);
  await expect(page.getByTestId('session-approval-card-pager')).toHaveText('1 of 1');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q45.title);
  await page.screenshot({ path: testInfo.outputPath('q389-after-dismiss.png') });

  // A new version of the dismissed item brings it back to this chat, on top as the newest (T-88).
  await emitSnapshot(page, snapshot([{ ...q44, version: 2, revision: { asked: '', whatChanged: ['Reworded'], by: 'p2-review', at: Date.now() } }, q45]));
  await expect(page.getByTestId('session-approval-card-pager')).toHaveText('1 of 2');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q44.title);
});

test("T-11: Dismiss with the keyboard moves focus to the chat's next card, the one before when it was last, then the message box", async ({ page }) => {
  await openChat(page, [q42, q44, q45]);
  const card = page.getByTestId('session-approval-card');
  const pager = page.getByTestId('session-approval-card-pager');
  await page.getByTestId('session-approval-card-next').click();
  await expect(pager).toHaveText('2 of 3');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q44.title);

  // The middle card: the next one takes its place, and the focus.
  await page.getByTestId('session-approval-card-dismiss').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q45.title);
  await expect(pager).toHaveText('2 of 2');
  await expect(card).toBeFocused();

  // The last card: the one before it.
  await page.getByTestId('session-approval-card-dismiss').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q42.title);
  await expect(card).toBeFocused();

  // None left: the chat's message box.
  await page.getByTestId('session-approval-card-dismiss').focus();
  await page.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message Claude' })).toBeFocused();
  await expect.poll(() => notifyCommands(page)).toEqual([{ type: 'dismiss', id: 'q44' }, { type: 'dismiss', id: 'q45' }, { type: 'dismiss', id: 'q42' }]);
});
