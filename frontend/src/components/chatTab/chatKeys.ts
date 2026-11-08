/** The keys that send now on this computer (D-211): Cmd+Enter on Apple devices, Ctrl+Enter elsewhere. */
export function sendNowKeys(): string {
  return /mac|iphone|ipad/i.test(navigator.platform) ? '⌘↵' : 'Ctrl+↵';
}
