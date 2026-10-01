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

/**
 * Ctrl+C (no Shift) copies on Windows and Linux when the terminal has a selection, like Windows Terminal
 * and VS Code; without a selection it stays the interrupt key. macOS keeps Cmd+C only.
 */
export function isTerminalSelectionCopyKey(event: TerminalCopyShortcutEvent, isMac: boolean, hasSelection: boolean): boolean {
  if (isMac || !hasSelection) return false;
  return event.key.toLowerCase() === 'c' && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
}

// 1 MB of base64 (~750 KB of text) is far more than any selection a TUI copies.
const MAX_OSC52_PAYLOAD = 1024 * 1024;

/**
 * Text an app asked to copy with OSC 52 (`ESC ] 52 ; <targets> ; <base64> BEL`), the only way a program on
 * a remote host (Claude Code's fullscreen selection, tmux, vim) can reach this machine's clipboard. The
 * handler receives what follows `52;`. Queries (`?`) are refused: a remote program never reads the
 * local clipboard. Returns null for anything that is not a well-formed, non-empty copy.
 */
export function decodeOsc52Copy(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator < 0) return null;
  const payload = data.slice(separator + 1).trim();
  if (!payload || payload === '?' || payload.length > MAX_OSC52_PAYLOAD) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export async function copyTerminalText(text: string): Promise<boolean> {
  if (!text) return false;
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard access is unavailable');
  }
  await navigator.clipboard.writeText(text);
  return true;
}
