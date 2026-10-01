// Tailscale admin API client for `runpane cloud`, authenticated with an OAuth client
// (client-credentials grant). It mints single-use tagged auth keys for new cloud sandboxes
// and lists or deletes their devices. Secrets (client secret, access token, auth keys) never
// appear in errors or logs.

import { boundary, decodeBoundary, type BoundarySchema } from '../boundaryDecoder';
import type { TailnetPort } from './ports';

const DEFAULT_API_BASE = 'https://api.tailscale.com/api/v2';

export const CLOUD_SESSION_TAG = 'tag:rp-session';

interface DeviceIdentity {
  nodeId: string;
  hostname: string;
  name?: string;
  tags?: string[];
}

/**
 * The node ids runpane may delete, given the devices listed under a hostname it manages: the node it
 * recorded for that host, and any listed device carrying every tag runpane's own auth keys put on its
 * nodes. A member's own machine (untagged) or a device tagged differently is never deleted, even when
 * its hostname matches; those come back in `foreign` for the caller to refuse or report.
 */
export function deletableNodeIds<Device extends DeviceIdentity>(
  devices: Device[],
  tags: string[] = [CLOUD_SESSION_TAG],
  recordedNodeId?: string,
): { nodeIds: string[]; foreign: Device[] } {
  const foreign = devices.filter((device) => tags.length === 0 || !tags.every((tag) => (device.tags ?? []).includes(tag)));
  const isForeign = (nodeId: string) => foreign.some((device) => device.nodeId === nodeId);
  const nodeIds = new Set<string>();
  if (recordedNodeId && !isForeign(recordedNodeId)) nodeIds.add(recordedNodeId);
  for (const device of devices) if (!isForeign(device.nodeId)) nodeIds.add(device.nodeId);
  return { nodeIds: [...nodeIds], foreign };
}

/** "name (nodeId, tags a,b | untagged)" for a refusal or warning about a device runpane does not own. */
export function describeForeignDevice(device: DeviceIdentity): string {
  const tags = device.tags && device.tags.length > 0 ? `tags ${device.tags.join(',')}` : 'untagged';
  return `${device.name || device.hostname} (${device.nodeId}, ${tags})`;
}

/**
 * Deletes the recorded node and the devices under `hostname` tagged like runpane's own nodes. Any other
 * device under that name (a member's machine, say) is left alone and named through `warn`. Returns the
 * ids it deleted.
 */
export async function deleteOwnedDevices(
  tailnet: TailnetPort,
  hostname: string,
  recordedNodeId: string | undefined,
  warn: (line: string) => void,
): Promise<string[]> {
  const { nodeIds, foreign } = deletableNodeIds(await tailnet.findDevicesByHostname(hostname), [CLOUD_SESSION_TAG], recordedNodeId);
  if (foreign.length > 0) {
    warn(`runpane cloud: left ${foreign.map(describeForeignDevice).join(', ')} alone: it is named ${hostname} but runpane did not create it (not tagged ${CLOUD_SESSION_TAG}).`);
  }
  for (const nodeId of nodeIds) await tailnet.deleteDevice(nodeId);
  return nodeIds;
}

interface TailscaleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  /** Tailnet name; "-" (the default) means the OAuth client's own tailnet. */
  tailnet?: string;
}

export interface MintAuthKeyOptions {
  tags?: string[];
  reusable?: boolean;
  ephemeral?: boolean;
  preauthorized?: boolean;
  expirySeconds?: number;
  description?: string;
}

export interface TailscaleDevice {
  /** Stable node id ("n…CNTRL"). */
  nodeId: string;
  /** Legacy numeric id. */
  id: string;
  hostname: string;
  /** MagicDNS FQDN without the trailing dot. */
  name: string;
  addresses: string[];
  tags: string[];
  lastSeen?: string;
}

export interface TailscaleApi {
  /** The returned `key` is secret: hand it to the sandbox through a 0600 file and never print it. */
  mintAuthKey(options?: MintAuthKeyOptions): Promise<{ id: string; key: string; expires?: string }>;
  listDevices(): Promise<TailscaleDevice[]>;
  /** Devices whose OS hostname or MagicDNS short name equals `hostname`. */
  findDevicesByHostname(hostname: string): Promise<TailscaleDevice[]>;
  /** Deletes a device by node id. Resolves false when it was already gone (404). */
  deleteDevice(nodeId: string): Promise<boolean>;
}

export class TailscaleApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TailscaleApiError';
  }
}

type FetchLike = typeof fetch;

interface CachedToken {
  header: string;
  expiresAt: number;
}

export function createTailscaleApi(
  credentials: TailscaleOAuthCredentials,
  fetchImpl: FetchLike = fetch,
  apiBase = DEFAULT_API_BASE,
): TailscaleApi {
  const tailnet = encodeURIComponent(credentials.tailnet ?? '-');
  let cached: CachedToken | undefined;

  async function authorization(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.header;
    }
    const body = new URLSearchParams({
      client_id: credentials.clientId.trim(),
      client_secret: credentials.clientSecret.trim(),
      grant_type: 'client_credentials',
    });
    const response = await fetchImpl(`${apiBase}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new TailscaleApiError(`Tailscale OAuth token request failed (HTTP ${response.status})`, response.status);
    }
    const payload = await decodeResponse(response, tokenSchema, 'Tailscale OAuth token response');
    cached = { header: `Bearer ${payload.access_token}`, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 };
    return cached.header;
  }

  async function request(method: string, path: string, body?: MintKeyRequestBody): Promise<Response> {
    const headers = new Headers({ Authorization: await authorization() });
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    return fetchImpl(`${apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function failure(response: Response, what: string): Promise<TailscaleApiError> {
    let detail = '';
    try {
      const payload = decodeBoundary(await response.json(), errorSchema);
      detail = payload.message ? `: ${payload.message}` : '';
    } catch {
      // Error bodies are informational only.
    }
    return new TailscaleApiError(`${what} failed (HTTP ${response.status})${detail}`, response.status);
  }

  async function listDevices(): Promise<TailscaleDevice[]> {
    const response = await request('GET', `/tailnet/${tailnet}/devices`);
    if (!response.ok) {
      throw await failure(response, 'Tailscale device list');
    }
    const payload = await decodeResponse(response, deviceListSchema, 'Tailscale device list');
    return (payload.devices ?? []).map((device) => ({
      nodeId: device.nodeId ?? '',
      id: device.id ?? '',
      hostname: device.hostname ?? '',
      name: (device.name ?? '').replace(/\.$/, ''),
      addresses: device.addresses ?? [],
      tags: device.tags ?? [],
      lastSeen: device.lastSeen,
    }));
  }

  return {
    async mintAuthKey(options: MintAuthKeyOptions = {}) {
      const tags = options.tags ?? [CLOUD_SESSION_TAG];
      if (tags.length === 0) {
        throw new TailscaleApiError('Cloud auth keys must carry at least one tag');
      }
      const response = await request('POST', `/tailnet/${tailnet}/keys`, {
        capabilities: {
          devices: {
            create: {
              reusable: options.reusable ?? false,
              ephemeral: options.ephemeral ?? false,
              preauthorized: options.preauthorized ?? true,
              tags,
            },
          },
        },
        expirySeconds: options.expirySeconds ?? 600,
        description: (options.description ?? 'runpane cloud').slice(0, 50),
      });
      if (!response.ok) {
        throw await failure(response, 'Tailscale auth key mint');
      }
      return decodeResponse(response, authKeySchema, 'Tailscale auth key response');
    },

    listDevices,

    async findDevicesByHostname(hostname: string): Promise<TailscaleDevice[]> {
      const wanted = hostname.toLowerCase();
      return (await listDevices()).filter((device) =>
        device.hostname.toLowerCase() === wanted || device.name.toLowerCase().split('.')[0] === wanted);
    },

    async deleteDevice(nodeId: string): Promise<boolean> {
      const response = await request('DELETE', `/device/${encodeURIComponent(nodeId)}`);
      if (response.status === 404) {
        return false;
      }
      if (!response.ok) {
        throw await failure(response, `Tailscale device delete ${nodeId}`);
      }
      return true;
    },
  };
}

interface MintKeyRequestBody {
  capabilities: { devices: { create: { reusable: boolean; ephemeral: boolean; preauthorized: boolean; tags: string[] } } };
  expirySeconds: number;
  description: string;
}

const tokenSchema = boundary.object({
  access_token: boundary.nonEmptyString,
  expires_in: boundary.optional(boundary.number),
});

const errorSchema = boundary.object({ message: boundary.optional(boundary.string) });

const authKeySchema = boundary.object({
  id: boundary.nonEmptyString,
  key: boundary.nonEmptyString,
  expires: boundary.optional(boundary.string),
});

const optionalString = boundary.optional(boundary.string);
const deviceListSchema = boundary.object({
  devices: boundary.optional(boundary.array(boundary.object({
    nodeId: optionalString,
    id: optionalString,
    hostname: optionalString,
    name: optionalString,
    addresses: boundary.optional(boundary.array(boundary.string)),
    tags: boundary.optional(boundary.array(boundary.string)),
    lastSeen: optionalString,
  }))),
});

async function decodeResponse<Value>(
  response: Response,
  schema: BoundarySchema<Value>,
  what: string,
): Promise<Value> {
  try {
    return decodeBoundary(await response.json(), schema);
  } catch (error) {
    throw new TailscaleApiError(`${what} was malformed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}
