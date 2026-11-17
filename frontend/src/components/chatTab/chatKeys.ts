/** The keys that send now on this computer (D-211): Cmd+Enter on Apple devices, Ctrl+Enter elsewhere. */
export function sendNowKeys(): string {
  return /mac|iphone|ipad/i.test(navigator.platform) ? '⌘↵' : 'Ctrl+↵';
}

/** What Send now does while a turn runs (ChatTabView.sendNowSteers). */
export function sendNowEffect(steers: boolean | undefined): string {
  return steers ? 'gives your message to the agent now; its work and subagents keep running' : 'stops this turn, then sends your message';
}
