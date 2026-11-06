import { DEFAULT_NOTIFY_SETTINGS, type NotifySnapshot } from '../../shared/types/notify';

const MINUTE = 60_000;

/**
 * Three waiting questions (one of each look, the first from a worker in the Launch Session, with
 * related links), one update and today's history, as main would send them.
 */
export function notifyFixture(now = Date.now()): NotifySnapshot {
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS },
    items: [
      {
        id: 'q-options',
        ui: 'options',
        title: 'Which session store should the refactor use?',
        context: 'The current Redis store logs everyone out on each deploy. All three pass the auth tests.',
        choices: [
          { label: 'Postgres table', detail: 'No new infrastructure. One migration.', recommended: true },
          { label: 'Keep Redis', detail: 'Persistence in each environment.' },
          { label: 'Stateless JWT', detail: 'No server-side sign-out.' },
        ],
        links: [{ label: 'plan.html', path: '/tmp/auth-refactor/plan.html' }, { label: 'PR #812', url: 'https://github.com/example/repo/pull/812' }],
        source: { paneId: 'pane-auth', panelId: 'panel-auth', name: 'auth-refactor', agent: 'Claude', session: { id: 'session-launch', name: 'Launch', paneId: 'session-launch-pane' } },
        state: 'waiting',
        createdAt: now - 2 * MINUTE,
      },
      {
        id: 'q-approve',
        ui: 'approve',
        title: 'Apply migration 0042 to staging?',
        context: 'Adds one nullable column. Staging only.',
        detail: 'ALTER TABLE sessions ADD COLUMN revoked_at timestamptz NULL;',
        detailLabel: 'Show the SQL',
        source: { paneId: 'pane-billing', panelId: 'panel-billing', name: 'billing-migration', agent: 'Codex' },
        state: 'waiting',
        createdAt: now - 6 * MINUTE,
      },
      {
        id: 'q-ask',
        ui: 'ask',
        title: 'What should the 2.5 release headline say?',
        suggestions: ['Answer your agents from anywhere', 'Notify is here'],
        source: { name: 'docs-changelog', agent: 'Cursor' },
        state: 'waiting',
        createdAt: now - 11 * MINUTE,
      },
      {
        id: 'u-checks',
        ui: 'info',
        title: 'PR #812 checks passed',
        action: { label: 'Open PR', url: 'https://github.com/example/repo/pull/812' },
        source: { paneId: 'pane-sms', name: 'sms-retry', agent: 'Claude' },
        state: 'info',
        createdAt: now - MINUTE,
      },
      {
        id: 'h-backoff',
        ui: 'options',
        title: 'Retry backoff',
        source: { paneId: 'pane-sms', name: 'sms-retry', agent: 'Claude' },
        state: 'answered',
        answerSummary: 'Exponential',
        createdAt: now - 25 * MINUTE,
        resolvedAt: now - 20 * MINUTE,
      },
      {
        id: 'h-push',
        ui: 'approve',
        title: 'Push tray-icon',
        source: { name: 'tray-icon', agent: 'Codex' },
        state: 'answered',
        answerSummary: 'Approved',
        createdAt: now - 40 * MINUTE,
        resolvedAt: now - 34 * MINUTE,
      },
      {
        id: 'h-lint',
        ui: 'ask',
        title: 'Lint rule question',
        source: { name: 'tray-icon', agent: 'Cursor' },
        state: 'expired',
        createdAt: now - 70 * MINUTE,
        resolvedAt: now - 60 * MINUTE,
      },
    ],
    queue: ['q-options', 'q-approve', 'q-ask'],
    hidden: [],
    strip: { kind: 'question', itemId: 'q-options' },
    stripSurface: 'pane',
    pausedUntil: null,
    shortcutRegistered: true,
    showOutsideSupported: true,
    instructionFiles: [
      { agent: 'Claude Code', file: '~/.claude/CLAUDE.md', state: 'written' },
      { agent: 'Codex', file: '~/.codex/AGENTS.md', state: 'not-found' },
    ],
    firstRun: true,
  };
}

/** The fixture with a secret request first on the strip. */
export function secretFixture(replaces = false): NotifySnapshot {
  const snapshot = notifyFixture();
  snapshot.items.unshift({
    id: 'q-secret',
    ui: 'secret',
    title: 'Stripe test secret key',
    context: "Run the webhook integration tests against Stripe's test mode.",
    secret: { project: 'stripe', name: 'STRIPE_SECRET_KEY', replaces },
    source: { paneId: 'pane-auth', panelId: 'panel-auth', name: 'auth-refactor', agent: 'Claude' },
    state: 'waiting',
    createdAt: Date.now() - MINUTE,
  });
  snapshot.queue.unshift('q-secret');
  snapshot.strip = { kind: 'question', itemId: 'q-secret' };
  snapshot.firstRun = false;
  return snapshot;
}
