import { boundary, decodeBoundary } from '../boundaryDecoder';

/** The payload inside a `pane-remote://` code (shared/types/remoteDaemon.ts PaneRemoteConnectionImportPayload). */
export interface PaneRemotePairing {
  v: 1;
  label: string;
  baseUrl: string;
  token: string;
  transport: 'http+sse';
  tunnel?: {
    kind: 'ssh' | 'tailscale' | 'manual';
    command?: string;
    note?: string;
    selected: boolean;
    tailscaleIp?: string;
  };
}

const pairingSchema = boundary.object({
  v: boundary.literal(1),
  label: boundary.nonEmptyString,
  baseUrl: boundary.nonEmptyString,
  token: boundary.nonEmptyString,
  transport: boundary.literal('http+sse'),
  tunnel: boundary.optional(boundary.object({
    kind: boundary.enumeration('ssh', 'tailscale', 'manual'),
    command: boundary.optional(boundary.nonEmptyString),
    note: boundary.optional(boundary.nonEmptyString),
    selected: boundary.boolean,
    tailscaleIp: boundary.optional(boundary.nonEmptyString),
  })),
});

const PREFIX = 'pane-remote://';

/** Decodes a pane-remote:// code. Errors never quote the code, which carries the client token. */
export function decodePairingCode(code: string): PaneRemotePairing {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error('Expected a pane-remote:// connection code.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('The pane-remote:// connection code is not valid.');
  }
  return decodeBoundary(parsed, pairingSchema);
}
