import { DEFAULT_RELAY_DOMAIN } from '../../../shared/remoteClient/relay';

/**
 * Who carries a device's connection off the computer's network, from the relay this computer is set
 * to use (`relay.example.com`, `host:port`, or empty or null for Pane's): Pane's servers, or a
 * self-hosted relay by its host name.
 */
export function relayCarrier(relay: string | null | undefined): string {
  const host = relay?.trim().toLowerCase().replace(/:\d+$/u, '') ?? '';
  const pane = !host || host === DEFAULT_RELAY_DOMAIN || host.endsWith(`.${DEFAULT_RELAY_DOMAIN}`);
  return pane ? "Pane's servers carry the connection" : `your relay at ${host} carries the connection`;
}
