/** Phone access through a relay (QR pairing), as Remote Access shows it. */
export interface RelayStatus {
  enabled: boolean;
  /** off; connecting to the relay; getting the certificate; ready to pair; or stuck with `lastError`. */
  phase: 'off' | 'connecting' | 'certificate' | 'ready' | 'error';
  /** This computer's id under the relay domain. */
  id: string | null;
  domain: string | null;
  /** `https://<id>.<domain>` */
  address: string | null;
  /** The relay host this computer is connected to. */
  relay: string | null;
  region: string | null;
  /** Same-network addresses phones try first. */
  localAddresses: string[];
  certificate: { notBefore: string; notAfter: string; renewAt: string } | null;
  lastError: string | null;
}

/** A one-time QR: `https://<domain>/pair#s=<secret>&c=<id>&n=<name>`, good for 10 minutes and one scan. */
export interface RelayPairingInfo {
  url: string;
  expiresAt: string;
}
