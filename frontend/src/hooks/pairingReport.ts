import type { PairingView } from './useRelayPairing';

export type PairingFailure = 'certificate_limit' | 'relay_unreachable' | 'timeout' | 'other';
type Send = (event: string, properties: Record<string, string>) => void;

/** Why a view has no code to scan, or null while it shows one or is still on its way. */
function failureOf(view: PairingView): PairingFailure | null {
  switch (view.step) {
    case 'limited': return 'certificate_limit';
    case 'error': return view.cause === 'code' ? 'other' : 'relay_unreachable';
    case 'renewing': return 'timeout';
    default: return null;
  }
}

/**
 * What one opening of Add a device › Phone reports: `pairing_opened` once, with whether the QR code
 * showed or why it was paused, and `pairing_failed` once per reason. Enum values only.
 */
export class PairingReport {
  private opened = false;
  private readonly failed = new Set<PairingFailure>();

  constructor(private readonly send: Send) {}

  observe(view: PairingView): void {
    const failure = failureOf(view);
    if (!this.opened && (view.step === 'code' || failure)) {
      this.opened = true;
      this.send('pairing_opened', failure ? { qr: 'paused', paused_reason: failure } : { qr: 'shown' });
    }
    if (failure && !this.failed.has(failure)) {
      this.failed.add(failure);
      this.send('pairing_failed', { reason: failure });
    }
  }

  /** The dialog closed. Closed before a code or a failure: paused, not ready yet. */
  close(): void {
    if (!this.opened) this.send('pairing_opened', { qr: 'paused', paused_reason: 'not_ready' });
    this.opened = true;
  }
}
