/** Transport-owned messages survive Electron's text-only error boundary. */
export function remoteFailureKind(message: string): 'interrupted' | 'unknown' | null {
  if (message.includes('Delivery unknown:')) return 'unknown';
  if (message.includes('Remote connection interrupted:')) return 'interrupted';
  return null;
}

export function reportUnknownRemoteDelivery(message: string): void {
  if (remoteFailureKind(message) === 'unknown') window.dispatchEvent(new CustomEvent('remote-delivery-unknown', { detail: message }));
}
