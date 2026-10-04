import type { SettingsTarget } from '../types/settings';

const OPEN_SETTINGS_AT_EVENT = 'pane:open-settings-at';

/** Open Settings at a field from anywhere, including from inside Settings (it focuses the field). */
export function openSettingsAt(target: SettingsTarget): void {
  window.dispatchEvent(new CustomEvent<SettingsTarget>(OPEN_SETTINGS_AT_EVENT, { detail: target }));
}

/** Call `open` with each requested target; returns the unsubscribe. */
export function onOpenSettingsAt(open: (target: SettingsTarget) => void): () => void {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent) open(event.detail);
  };
  window.addEventListener(OPEN_SETTINGS_AT_EVENT, listener);
  return () => window.removeEventListener(OPEN_SETTINGS_AT_EVENT, listener);
}
