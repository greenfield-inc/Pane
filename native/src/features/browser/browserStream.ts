import type { BrowserInput, BrowserTabView } from '@shared/types/browserStream';
import type { DeviceDriver } from '@shared/types/devices';

/**
 * The phone's side of a browser tab streamed from its host (docs/BROWSER_AGENTS.md): who it is,
 * the lines it shows, when a touch only takes control, and how the keyboard's edits become input.
 */

/** This app launch, as one of the screens watching browser tabs. */
export const VIEWER_ID = `pane-phone-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Why the stream shows no live frames: the host can't be reached, has no stream, or the tab sleeps or went. */
export type StreamStop = 'unreachable' | 'older' | 'asleep' | 'gone';

/** Whether a failed call means the host has no such channel: an older Pane, which streams nothing. */
export function isOlderHost(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code === 'ERR_UNKNOWN_CHANNEL' || code === 'ERR_HOST_OUTDATED' || /ERR_UNKNOWN_CHANNEL|ERR_HOST_OUTDATED|No Pane daemon command registered|runs an older Pane/i.test(error.message);
}

/** The one line a stopped stream shows over its last frame. */
export function stopLine(stop: StreamStop, host: string): string {
  switch (stop) {
    case 'unreachable': return `${host} can't be reached (asleep or offline). The page resumes when it's back.`;
    case 'asleep': return 'This tab is asleep. Tap to wake it.';
    case 'gone': return `This tab closed on ${host}.`;
    case 'older': return `${host} is on an older Pane. Showing your own copy.`;
  }
}

/** The driver chip's words and its button, as on the desktop's chip. */
export function driverChip(driver: DeviceDriver, agentName: string | undefined): { label: string; action: string; to: 'person' | 'agent' } {
  if (driver.by === 'agent') return { label: `${driver.agent} is driving`, action: 'Take over', to: 'person' };
  const agent = driver.agentWaiting ?? agentName ?? 'agent';
  return { label: driver.agentWaiting ? `You're driving · ${driver.agentWaiting} is waiting` : "You're driving", action: `Hand to ${agent}`, to: 'agent' };
}


/**
 * What the hidden keyboard field holds when empty: one zero-width space, so Backspace on an empty
 * field still changes the text and is heard.
 */
export const KEYBOARD_EMPTY = '​';

/**
 * The page input for one edit of the keyboard field, from its text `before` to `after`: removed
 * characters as Backspaces and added ones as text, so autocorrect and dictation replacements land
 * too. `next` is what the field holds afterwards. A `secure` (password) field keeps nothing
 * between edits: iOS empties a secure field when typing resumes, which must not read as deletions.
 */
export function keyboardEdit(before: string, after: string, secure = false): { input: BrowserInput[]; next: string } {
  const was = [...before.replaceAll(KEYBOARD_EMPTY, '')];
  const now = [...after.replaceAll(KEYBOARD_EMPTY, '')];
  const next = secure ? KEYBOARD_EMPTY : KEYBOARD_EMPTY + now.join('');
  // The marker itself went: Backspace in an empty field.
  if (was.length === 0 && now.length === 0) {
    return { input: after.includes(KEYBOARD_EMPTY) ? [] : [{ kind: 'key', key: 'Backspace', modifiers: 0 }], next };
  }
  let same = 0;
  while (same < was.length && same < now.length && was[same] === now[same]) same += 1;
  const input: BrowserInput[] = [];
  for (let index = same; index < was.length; index += 1) input.push({ kind: 'key', key: 'Backspace', modifiers: 0 });
  const added = now.slice(same).join('');
  if (added) input.push({ kind: 'text', text: added });
  return { input, next };
}
