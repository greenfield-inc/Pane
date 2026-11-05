import { describe, expect, it } from 'vitest';

import { pausedLabel } from './paused';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');

describe('pausedLabel', () => {
  it('says how long ago the tab paused', () => {
    expect(pausedLabel({ at: '2026-11-02T11:00:00.000Z', by: 'manual' }, NOW)).toBe('Paused 2 days ago');
    expect(pausedLabel({ at: '2026-11-04T09:00:00.000Z', by: 'manual' }, NOW)).toBe('Paused 3 hours ago');
    expect(pausedLabel({ at: '2026-11-04T11:59:00.000Z', by: 'manual' }, NOW)).toBe('Paused 1 minute ago');
    expect(pausedLabel({ at: '2026-11-04T11:59:30.000Z', by: 'manual' }, NOW)).toBe('Paused just now');
  });

  it('falls back to a bare label for an unreadable time', () => {
    expect(pausedLabel({ at: 'soon', by: 'manual' }, NOW)).toBe('Paused');
  });
});
