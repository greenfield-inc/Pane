import type { AnalyticsManager } from './analyticsManager';

/** What paired: a phone (the Pane app), another computer, or glasses. */
export type PairingDevice = 'phone' | 'computer' | 'glasses';
/**
 * How the pairing request reached this computer: through Pane relay, over a direct path the relay
 * set up, from the same network, or over Tailscale.
 */
export type PairingRouteKind = 'relay' | 'direct' | 'lan' | 'tailscale';

type Sink = Pick<AnalyticsManager, 'track'>;

let sink: Sink | null = null;

/** Set once at startup; analytics opt-out is checked by the sink on every event. */
export function setPairingAnalytics(next: Sink | null): void {
  sink = next;
}

export function trackPairingCompleted(device: PairingDevice, route: PairingRouteKind): void {
  sink?.track('pairing_completed', { device, route });
}

/** The CAs Pane orders from, by the organization their certificates name. Any other CA sends nothing. */
const CERTIFICATE_AUTHORITIES: Array<[string, 'letsencrypt' | 'google']> = [
  ["Let's Encrypt", 'letsencrypt'],
  ['Google Trust Services', 'google'],
];

export function trackCertificateIssued(issuer: string, renewal: boolean): void {
  const ca = CERTIFICATE_AUTHORITIES.find(([name]) => issuer.includes(name))?.[1];
  if (ca) sink?.track('certificate_issued', { ca, renewal });
}
