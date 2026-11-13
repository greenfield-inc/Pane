import type { SettingsTarget } from '../types/settings';

const OPEN_SETTINGS_EVENT = 'pane:open-settings';

/** Opens Settings at a category or setting from anywhere in the window; App owns Settings. */
export function requestOpenSettings(target: SettingsTarget): void {
  window.dispatchEvent(new CustomEvent<SettingsTarget>(OPEN_SETTINGS_EVENT, { detail: target }));
}

/** App's side of requestOpenSettings; returns the unsubscribe. */
export function onOpenSettingsRequest(open: (target: SettingsTarget) => void): () => void {
  // SAFETY: Only requestOpenSettings dispatches this event, always with a SettingsTarget.
  const listener = (event: Event) => open((event as CustomEvent<SettingsTarget>).detail);
  window.addEventListener(OPEN_SETTINGS_EVENT, listener);
  return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
}
