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
  return markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('NotifyCard', () => {
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
