/** The two questions the check asks of the focused element. */
export interface FocusedElement {
  matches(selector: string): boolean;
  closest(selector: string): FocusedElement | null;
}

/**
 * Whether a terminal's activation refresh leaves focus where it is instead of taking it for xterm.
 * The sidebar cursor is DOM focus: a replay may finish after the user has moved that cursor, and
 * focusing xterm would send their next key there. With Profiles on (T-63), neither does it take
 * focus from an open dialog (Create New, Search), where the person is typing; off, as before.
 */
export function keepsFocusOnActivation(active: FocusedElement | null, profilesOn: boolean): boolean {
  if (!active) return false;
  if (active.matches('[data-sidebar-item]:focus-visible')) return true;
  return profilesOn && active.closest('[aria-modal="true"]') !== null;
}
