import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
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

async function openChat(page: Page, items: NotifyItem[]): Promise<void> {
  await installElectronApiMock(page, { initialProjects: [project], initialSessions: [pane], initialPanels: panels, activeProjectId: project.id, notifySnapshot: snapshot(items) });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand project Approvals fixture', exact: true }).click();
  await page.getByRole('button', { name: 'orgs-orchestrator', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Claude' })).toBeVisible();
}

test('J6, P5: the chat shows one compact card with a pager and no options, leaving out its own question', async ({ page }, testInfo) => {
  await openChat(page, [q42, q44, q45, ownQuestion]);
  const cards = page.getByTestId('session-approval-card');
  await expect(cards).toHaveCount(1);
  // Oldest first, as the column's pager walks them; the chat's own AskUserQuestion isn't one of them.
  await expect(page.getByTestId('session-approval-card-pager')).toHaveText('1 of 3');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q45.title);
  await expect(page.getByTestId('session-approval-card-subtitle')).toHaveText(q45.context ?? '');
  await expect(page.getByTestId('session-approval-card-choice')).toHaveCount(0);
  await page.getByTestId('session-approval-card-next').click();
  await page.getByTestId('session-approval-card-next').click();
  await expect(page.getByTestId('session-approval-card-pager')).toHaveText('3 of 3');
  await expect(page.getByTestId('session-approval-card-title')).toHaveText(q42.title);
  await expect(cards).toContainText('2 questions');
  await expect(cards).toContainText('3 references');
  await page.screenshot({ path: testInfo.outputPath('08-compact-card.png') });
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
