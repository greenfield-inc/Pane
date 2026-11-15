import { DEFAULT_RELAY_DOMAIN } from '../../../shared/remoteClient/relay';

/** Who carries a device's connection off the computer's network: a self-hosted relay by its domain, or Pane's servers. */
export function relayCarrier(domain: string | null): string {
  return domain && domain !== DEFAULT_RELAY_DOMAIN ? `your relay at ${domain} carries the connection` : "Pane's servers carry the connection";
}
