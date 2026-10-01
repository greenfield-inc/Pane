import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { JsonValue } from '../../boundaryDecoder';
import { DEFAULT_CONNECT_TIMEOUT_MS, nodeHttpTransport, type RemoteHttpHeaders } from '../../remote/remoteDaemonClient';

// The laptop side of the coordinator API. `$RUNPANE_CLOUD_DIR/coordinator.json` (0600) holds
// `{baseUrl, token}` for a `user:<name>` caller; the same shape remote/coordinatorClient.ts reads.

const clientConfigSchema = boundary.object({ baseUrl: boundary.nonEmptyString, token: boundary.nonEmptyString });

export interface CoordinatorClientConfig {
  baseUrl: string;
  token: string;
}

export function defaultClientConfigPath(): string {
  const cloudDir = process.env.RUNPANE_CLOUD_DIR ?? path.join(os.homedir(), '.config', 'runpane-cloud');
  return path.join(cloudDir, 'coordinator.json');
}

export function readClientConfig(file: string): CoordinatorClientConfig | null {
  if (!fs.existsSync(file)) return null;
  const decoded = decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), clientConfigSchema);
  return { baseUrl: decoded.baseUrl.replace(/\/+$/, ''), token: decoded.token };
}

export interface CoordinatorCallResult {
  status: number;
  body: JsonValue;
}

export async function callCoordinator(
  config: CoordinatorClientConfig,
  method: 'GET' | 'POST' | 'PUT',
  pathAndQuery: string,
  body: JsonValue | undefined,
  timeoutMs: number,
): Promise<CoordinatorCallResult> {
  // The coordinator's API is plain HTTP on its tailnet address: the transport refuses to send the
  // caller token (and a pushed directory's Session tokens) unless the route stays on the tailnet.
  const headers: RemoteHttpHeaders = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
  const response = await nodeHttpTransport({
    url: `${config.baseUrl}${pathAndQuery}`,
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    connectTimeoutMs: Math.min(DEFAULT_CONNECT_TIMEOUT_MS, timeoutMs),
    timeoutMs,
  });
  let parsed: JsonValue = response.body;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    parsed = response.body;
  }
  return { status: response.status, body: parsed };
}
