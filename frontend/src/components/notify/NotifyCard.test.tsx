import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NotifyItem } from '../../../../shared/types/notify';
import { NotifyCard, type NotifyCardProps } from './NotifyCard';
import { acceleratorFromKeys, shortcutLabel } from './notifyFormat';

const base: Omit<NotifyItem, 'ui' | 'title'> = {
  id: 'q1',
  source: { paneId: 'pane-1', panelId: 'panel-1', name: 'auth-refactor', agent: 'Claude' },
  state: 'waiting',
  createdAt: Date.now(),
};

function render(item: NotifyItem, props: Partial<NotifyCardProps> = {}): string {
  return renderToStaticMarkup(<NotifyCard item={item} view="question" form="strip" onCommand={vi.fn()} {...props} />);
}

/** Visible text, without tags, so assertions read like the card does. */
function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

describe('NotifyCard', () => {
  it("names the host machine on its question, and says an answer can't be sent while it is out of reach", () => {
    const visible = text(render({ ...base, ui: 'approve', title: 'Apply migration 0042 to staging?', machine: 'parsa-devbox', unreachable: true }));
    expect(visible).toContain('auth-refactor · Claude · parsa-devbox');
    expect(visible).toContain("Not sent: can't reach parsa-devbox. Try again when it reconnects.");
    expect(visible).toContain('Approve');
  });

  it("names another machine's question with its mark in the inbox, and offers Open in Pane only on the machine the app is on", () => {
    const item: NotifyItem = { ...base, id: 'studio:q1', ui: 'approve', title: 'Ship the hotfix tonight?', machine: 'mac-studio', machineId: 'studio' };
    const away = render({ ...item, elsewhere: true }, { form: 'inbox', machineMark: <span data-mark="studio" /> });
    expect(text(away)).toContain('auth-refactor · Claude · mac-studio');
    expect(away).toMatch(/data-testid="notify-card-machine">· <span data-mark="studio"><\/span>/);
    expect(text(away)).not.toContain('Open in Pane');
    expect(text(render({ ...item, elsewhere: true }))).not.toContain('Open in Pane');
    expect(text(render(item, { form: 'inbox' }))).toContain('Open in Pane');
  });

  it('says which device answered when another screen did, with Undo', () => {
    const answered = { ...base, ui: 'approve' as const, title: 'Apply migration?', state: 'sent' as const, answerSummary: 'Approved' };
    expect(text(render({ ...answered, answeredOn: 'Parsa’s iPhone' }, { view: 'sent' }))).toBe('Answered on Parsa’s iPhone · Approved Undo');
    expect(text(render(answered, { view: 'sent' }))).toBe('Sent to Claude · Approved Undo');
  });

  it('shows a choice question as four chips, then More, with the recommended one called out', () => {
    const markup = render({
      ...base,
      ui: 'options',
      title: 'Which session store should the refactor use?',
      choices: ['Postgres table', 'Keep Redis', 'Stateless JWT', 'SQLite', 'Memcached'].map((label, index) => ({ label, recommended: index === 1 })),
    });
    const visible = text(markup);
    expect(visible).toContain('Needs a choice');
    expect(visible).toContain('Which session store should the refactor use?');
    expect(visible).toContain('Postgres table');
    expect(visible).toContain('SQLite');
    expect(visible).not.toContain('Memcached');
    expect(visible).toContain('More');
    expect(visible).toContain('2 is recommended');
    expect(visible).toContain('Details');
    expect(visible).toContain('Open in Pane');
  });

  it('shows an approval as Deny and Approve with the detail behind a disclosure', () => {
    const visible = text(render({
      ...base,
      ui: 'approve',
      title: 'Apply migration 0042 to staging?',
      context: 'Adds one nullable column. Staging only.',
      detail: 'ALTER TABLE sessions ADD COLUMN revoked_at timestamptz;',
      detailLabel: 'Show the SQL',
    }));
    expect(visible).toContain('Needs approval');
    expect(visible).toContain('Adds one nullable column. Staging only.');
    expect(visible).toMatch(/N Deny Y Approve/);
    expect(visible).toContain('Show the SQL');
    expect(visible).not.toContain('ALTER TABLE');
  });

  it('labels the disclosure Show details when the agent gives no label', () => {
    const visible = text(render({ ...base, ui: 'approve', title: 'Deploy?', detail: 'fly deploy --app web' }));
    expect(visible).toContain('Show details');
  });

  it('opens a pop-up card with details shown when the person last left them shown', () => {
    const choiceCard = text(render({ ...base, ui: 'options', title: 'Which store?', choices: [{ label: 'Postgres' }] }, { showDetails: true }));
    expect(choiceCard).toContain('Click a choice, then Send');
    expect(choiceCard).toContain('Hide details');
    const approval = text(render({ ...base, ui: 'approve', title: 'Deploy?', detail: 'fly deploy --app web' }, { showDetails: true }));
    expect(approval).toContain('fly deploy --app web');
    expect(approval).toContain('Hide details');
  });

  it('shows a free-text question as a field, with the agent’s suggestions above it', () => {
    const markup = render({
      ...base,
      ui: 'ask',
      title: 'What should the 2.5 release headline say?',
      suggestions: ['Answer agents from anywhere'],
    });
    expect(text(markup)).toContain('Needs an answer');
    expect(text(markup)).toContain('Answer agents from anywhere');
    expect(markup).toContain('placeholder="Click to type your answer"');
    expect(markup).toContain('aria-label="Send to Claude"');
  });

  it('shows an update as one line with its action', () => {
    const visible = text(render(
      { ...base, ui: 'info', state: 'info', title: 'PR #812 checks passed', action: { label: 'Open PR', url: 'https://example.com/pr/812' } },
      { view: 'info', hideAt: Date.now() + 6000, hideAfterMs: 6000 },
    ));
    expect(visible).toBe('Update PR #812 checks passed · auth-refactor Open PR');
  });

  it('confirms a sent answer with Undo', () => {
    const visible = text(render(
      { ...base, ui: 'options', state: 'sent', title: 'Which store?', answerSummary: 'Postgres table' },
      { view: 'sent' },
    ));
    expect(visible).toBe('Sent to Claude · Postgres table Undo');
  });

  it('says plainly when the agent stopped waiting', () => {
    const visible = text(render({ ...base, ui: 'options', state: 'expired', title: 'Which store?' }, { view: 'expired' }));
    expect(visible).toContain('Claude stopped waiting. Nothing to answer.');
    expect(visible).not.toContain('is recommended');
  });

  it('puts the queue in the footer and leaves out Open in Pane for callers outside Pane', () => {
    const next: NotifyItem = { ...base, id: 'q2', ui: 'approve', title: 'Apply migration 0042 to staging?', source: { name: 'billing-migration', agent: 'Codex' } };
    const visible = text(render(
      { ...base, ui: 'options', title: 'Which store?', choices: [{ label: 'Postgres' }], source: { name: 'scratch', agent: 'Claude' } },
      { queue: { index: 1, total: 3, next } },
    ));
    expect(visible).toContain('1 of 3');
    expect(visible).toContain('Next: Apply migration 0042 to staging? · billing-migration');
    expect(visible).not.toContain('Open in Pane');
  });

  it('offers Snooze on a pop-up card, and says when a snoozed question comes back on the Notify page', () => {
    const question: NotifyItem = { ...base, ui: 'approve', title: 'Apply migration 0042 to staging?' };
    expect(render(question)).toContain('aria-label="Snooze"');
    expect(render(question, { form: 'docked' })).not.toContain('aria-label="Snooze"');

    const snoozed = text(render({ ...question, snoozedUntil: new Date(2026, 9, 30, 15, 42).getTime() }, { form: 'inbox' }));
    expect(snoozed).toMatch(/Back at 3:42\sPM/);
  });

  it('carries the first-run hint with the answer-all shortcut', () => {
    const visible = text(render({ ...base, ui: 'options', title: 'Which store?', choices: [{ label: 'Postgres' }] }, { shortcutHint: 'Ctrl+Shift+Space' }));
    expect(visible).toContain('Click to answer · Ctrl+Shift+Space to use keys');
  });
});

describe('Notify shortcuts', () => {
  it('spells the default accelerator the way each platform writes it', () => {
    expect(shortcutLabel('Control+Shift+Space', true)).toBe('⌃⇧Space');
    expect(shortcutLabel('Control+Shift+Space', false)).toBe('Ctrl+Shift+Space');
    expect(shortcutLabel('CommandOrControl+Alt+K', false)).toBe('Ctrl+Alt+K');
  });

  it('records an accelerator only once a modifier and an ordinary key are held', () => {
    const chord = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(acceleratorFromKeys({ ...chord, code: 'Space', ctrlKey: true, shiftKey: true }, true)).toBe('Control+Shift+Space');
    expect(acceleratorFromKeys({ ...chord, code: 'KeyN', metaKey: true }, true)).toBe('Command+N');
    expect(acceleratorFromKeys({ ...chord, code: 'KeyN', metaKey: true }, false)).toBe('Super+N');
    expect(acceleratorFromKeys({ ...chord, code: 'KeyN' }, true)).toBeNull();
    expect(acceleratorFromKeys({ ...chord, code: 'ShiftLeft', shiftKey: true }, true)).toBeNull();
  });
});
