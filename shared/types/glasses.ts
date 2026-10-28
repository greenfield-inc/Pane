import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from '../validation/boundaryDecoder';
import { base64UrlDecode, base64UrlEncode } from './remoteDaemon';

/** A glasses device token: sent only in the Authorization header, or the voice WebSocket's subprotocol. */
export const GLASSES_TOKEN_PREFIX = 'pgt_';
/** A single-use pairing secret, traded once for a device token within 10 minutes. */
export const GLASSES_PAIRING_SECRET_PREFIX = 'pgs_';
const PAIRING_CODE_SCHEME = 'pane-glasses://';
/** The voice WebSocket's subprotocol: `['pane-glasses', token]`, since a browser WebSocket can't set headers. */
export const GLASSES_WEBSOCKET_PROTOCOL = 'pane-glasses';

/** Workspace-listener commands that manage glasses. Only the owner's own devices, without a glasses token, may call them. */
export const GLASSES_COMMANDS = {
  createPairingSecret: 'runpane:glasses:create-pairing-secret',
  list: 'runpane:glasses:list',
  revoke: 'runpane:glasses:revoke',
  /** Devices, allowed origins and recently refused ones, for Settings on this machine. */
  state: 'runpane:glasses:state',
  /** Allows or removes one exact origin. Refused from any remote caller. */
  setOrigin: 'runpane:glasses:set-origin',
  /** Called by the glasses app itself, with a pairing secret instead of a token. */
  pair: 'runpane:glasses:pair',
} as const;

export interface GlassesDevice {
  id: string;
  /** Who the glasses are, such as "Even G2 · Parsa's iPhone"; shown on every list and Notify answer. */
  label: string;
  /** The install id of the phone that paired them, which finds them again however the phone is named. */
  phoneId?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface GlassesAccessState {
  devices: GlassesDevice[];
  /** Origins allowed on this machine: the ones Pane ships with and the owner's. */
  allowedOrigins: { origin: string; source: 'pane' | 'owner' | 'environment' }[];
  /** Browser origins this machine refused since Pane started, newest first. */
  refusedOrigins: { origin: string; at: string }[];
}

export interface GlassesListResult {
  devices: GlassesDevice[];
}

export interface GlassesRevokeResult {
  revoked: boolean;
}

export interface GlassesPairingSecretResult {
  secret: string;
  expiresAt: string;
}

export interface GlassesPairResult {
  token: string;
  device: GlassesDevice;
}

export interface GlassesPairingComputer {
  /** The computer's Tailscale machine name. */
  name: string;
  /** Its workspace URL, `https://<dnsName>:8443`. */
  url: string;
  secret: string;
}

/** What the phone copies and the glasses app pastes: one pairing secret per computer, never a device token. */
export interface GlassesPairingCode {
  v: 1;
  expiresAt: string;
  computers: GlassesPairingComputer[];
}

const pairingCodeSchema: BoundarySchema<GlassesPairingCode> = boundary.object({
  v: boundary.literal(1),
  expiresAt: boundary.nonEmptyString,
  computers: boundary.array(boundary.object({
    name: boundary.nonEmptyString,
    url: boundary.nonEmptyString,
    secret: boundary.nonEmptyString,
  })),
});

export function encodeGlassesPairingCode(code: GlassesPairingCode): string {
  return `${PAIRING_CODE_SCHEME}${base64UrlEncode(JSON.stringify(code))}`;
}

/** Reads a pasted pairing code; throws with a sentence a person can act on. */
export function decodeGlassesPairingCode(input: string): GlassesPairingCode {
  const trimmed = input.trim();
  if (!trimmed.startsWith(PAIRING_CODE_SCHEME)) {
    throw new Error('This is not a Pane glasses code. Copy it again from the Pane app: Settings › Glasses › Pair glasses.');
  }
  let parsed: JsonValue;
  try {
    parsed = decodeBoundary(JSON.parse(base64UrlDecode(trimmed.slice(PAIRING_CODE_SCHEME.length))), boundary.json);
  } catch {
    throw new Error('This glasses code is cut off or damaged. Copy it again from the Pane app.');
  }
  const code = decodeBoundary(parsed, pairingCodeSchema);
  for (const computer of code.computers) {
    const url = new URL(computer.url);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net')) {
      throw new Error(`The code names ${computer.url}, which is not a Tailscale address. Copy it again from the Pane app.`);
    }
    if (!computer.secret.startsWith(GLASSES_PAIRING_SECRET_PREFIX)) {
      throw new Error('This glasses code holds something other than pairing secrets. Copy it again from the Pane app.');
    }
  }
  return code;
}
