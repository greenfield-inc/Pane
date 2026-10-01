import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { JsonValue } from '../../boundaryDecoder';

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
  const response = await fetch(`${config.baseUrl}${pathAndQuery}`, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed: JsonValue = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}
