import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NotifyItem, NotifySnapshot } from '../../../../shared/types/notify';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../../shared/types/notify';
import { NotifyRound } from './NotifyRound';

const item: NotifyItem = {
  id: 'r1',
  ui: 'options',
  title: 'Which store?',
  choices: [{ label: 'Postgres' }, { label: 'Redis', recommended: true }],
  source: { name: 'auth-refactor', agent: 'Claude' },
  state: 'waiting',
  createdAt: Date.now(),
};

function render(shown: NotifyItem): string {
  const snapshot: NotifySnapshot = {
    settings: DEFAULT_NOTIFY_SETTINGS, items: [shown], queue: [shown.id], hidden: [], strip: null, stripSurface: null, pausedUntil: null,
    shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [], cardsOn: { kind: 'any' }, thisMachine: null,
  };
  return renderToStaticMarkup(<NotifyRound snapshot={snapshot} onCommand={vi.fn()} />);
}

describe('NotifyRound', () => {
  it('opens with nothing chosen (D-385), the highlight on the recommended choice, and Enter sends it (T-113)', () => {
    const markup = render(item);
    expect(markup).not.toContain('aria-selected="true"');
    expect(markup).toContain('Recommended');
    // A highlight, not a pick: J/K move it and Enter sends it.
    expect(markup.match(/<button[^>]*data-highlighted="true"[^>]*>/)?.[0]).toContain('aria-selected="false"');
    expect(markup).toContain('Send to Claude');
    expect(markup).toContain('data-testid="notify-round-jk"');
  });

  it('an approval starts with neither Approve nor Deny', () => {
    const markup = render({ ...item, ui: 'approve', choices: undefined });
    expect(markup).not.toContain('aria-selected="true"');
    expect(markup).toContain('Press Y or N');
  });
});
