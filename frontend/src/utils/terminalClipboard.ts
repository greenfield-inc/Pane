interface TerminalCopyShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function isTerminalCopyShortcut(event: TerminalCopyShortcutEvent, isMac: boolean): boolean {
  if (event.key.toLowerCase() !== 'c' || event.altKey) return false;
  if (isMac) return event.metaKey && !event.ctrlKey && !event.shiftKey;
  return event.ctrlKey && event.shiftKey && !event.metaKey;
}

export async function copyTerminalText(text: string): Promise<boolean> {
  if (!text) return false;
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard access is unavailable');
  }
  await navigator.clipboard.writeText(text);
  return true;
}

/**
 * Decodes the text of an OSC 52 clipboard write (`ESC ] 52 ; <targets> ; <base64> BEL`).
 * Returns null for clipboard reads (`?`), which Pane refuses so host programs cannot
 * see the client's clipboard, and for empty or malformed payloads.
 */
export function decodeOsc52Write(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator === -1) return null;
  const payload = data.slice(separator + 1);
  if (!payload || payload === '?') return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) || null;
  } catch {
    return null;
  }
}
