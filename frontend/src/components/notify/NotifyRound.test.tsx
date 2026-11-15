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
  it('opens with nothing chosen, keeps the Recommended mark, and Send waits for a pick (D-385)', () => {
    const markup = render(item);
    expect(markup).not.toContain('aria-selected="true"');
    expect(markup).toContain('Recommended');
    expect(markup).toContain('Pick a choice');
  });

  it('an approval starts with neither Approve nor Deny', () => {
    const markup = render({ ...item, ui: 'approve', choices: undefined });
    expect(markup).not.toContain('aria-selected="true"');
    expect(markup).toContain('Press Y or N');
  });
});
