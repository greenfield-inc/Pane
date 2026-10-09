import { describe, expect, it } from 'vitest';
import { nextHistoryAction } from './remoteBrowserHistory';

describe('nextHistoryAction', () => {
  it('claims the landing entry instead of adding one', () => {
    expect(nextHistoryAction(null, { view: null, overlay: false }, undefined)).toBe('replace');
  });

  it('pushes a Pane or Session the person opened', () => {
    expect(nextHistoryAction({ view: 'pane:a', overlay: false }, { view: 'session:s', overlay: false }, 'session:s')).toBe('push');
  });

  it('replaces the entry when the app picks a Pane on its own', () => {
    expect(nextHistoryAction({ view: null, overlay: false }, { view: 'pane:a', overlay: false }, undefined)).toBe('replace');
    expect(nextHistoryAction({ view: 'session:s', overlay: false }, { view: 'pane:a', overlay: false }, undefined)).toBe('replace');
  });

  it('pushes once when a drawer or sheet opens', () => {
    expect(nextHistoryAction({ view: 'pane:a', overlay: false }, { view: 'pane:a', overlay: true }, undefined)).toBe('push');
    expect(nextHistoryAction({ view: 'pane:a', overlay: true }, { view: 'pane:a', overlay: true }, undefined)).toBeNull();
  });

  it('drops the overlay entry when the drawer closes without navigating', () => {
    expect(nextHistoryAction({ view: 'pane:a', overlay: true }, { view: 'pane:a', overlay: false }, undefined)).toBe('back');
  });

  it('turns the overlay entry into the Pane picked from the drawer', () => {
    expect(nextHistoryAction({ view: 'pane:a', overlay: true }, { view: 'pane:b', overlay: false }, 'pane:b')).toBe('replace');
  });

  it('keeps the overlay entry while a Session picked from the drawer is still opening', () => {
    expect(nextHistoryAction({ view: 'pane:a', overlay: true }, { view: 'pane:a', overlay: false }, 'session:s')).toBeNull();
    expect(nextHistoryAction({ view: 'pane:a', overlay: true }, { view: 'session:s', overlay: false }, 'session:s')).toBe('replace');
  });

  it('does nothing when the view did not change', () => {
    expect(nextHistoryAction({ view: 'pane:a', overlay: false }, { view: 'pane:a', overlay: false }, undefined)).toBeNull();
  });
});
