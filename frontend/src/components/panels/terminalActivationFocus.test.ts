import { describe, expect, it } from 'vitest';
import { keepsFocusOnActivation, type FocusedElement } from './terminalActivationFocus';

/** The two DOM questions the check asks, answered as a focused element would. */
function focused({ sidebarCursor = false, inDialog = false }: { sidebarCursor?: boolean; inDialog?: boolean }): FocusedElement {
  const element: FocusedElement = {
    matches: (selector: string) => sidebarCursor && selector === '[data-sidebar-item]:focus-visible',
    closest: (selector: string) => (inDialog && selector === '[aria-modal="true"]' ? element : null),
  };
  return element;
}

describe('terminal activation focus', () => {
  it('takes focus from an open dialog with Profiles off, as main does (T-63, F-3)', () => {
    expect(keepsFocusOnActivation(focused({ inDialog: true }), false)).toBe(false);
  });

  it('leaves an open dialog focused with Profiles on', () => {
    expect(keepsFocusOnActivation(focused({ inDialog: true }), true)).toBe(true);
  });

  it('never takes the sidebar cursor, and takes anything else', () => {
    for (const profilesOn of [false, true]) {
      expect(keepsFocusOnActivation(focused({ sidebarCursor: true }), profilesOn)).toBe(true);
      expect(keepsFocusOnActivation(focused({}), profilesOn)).toBe(false);
      expect(keepsFocusOnActivation(null, profilesOn)).toBe(false);
    }
  });
});
