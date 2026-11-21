/** When the CA takes new computers again, in this computer's clock: "4:47 PM", or "Sat 4:47 PM" on another day. */
export function relayLimitTime(until: string, now = new Date()): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** The full reason Pane relay pairs no new devices (`RelayStatus.certificateLimit`), for tooltips and labels. */
export function relayLimitSentence(until: string): string {
  return `Not accepting new phone pairings through Pane relay right now: both certificate services are turning away new computers. Try again after ${relayLimitTime(until)}, or connect with Tailscale instead.`;
}
