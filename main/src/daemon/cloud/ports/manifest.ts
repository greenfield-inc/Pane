import fs from 'fs';
import path from 'path';
import { boundary, BoundaryDecodeError, decodeBoundary, type JsonObject } from '../../../../../shared/validation/boundaryDecoder';

/** Where a repository declares the services its Sessions publish (beside `.runpane/secrets.json`). */
const PORTS_MANIFEST_PATH = path.join('.runpane', 'ports.json');
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_PORTS = 20;

export const PORT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u;

interface ManifestPort {
  name: string;
  port: number;
  httpsPort?: number;
  path: string;
}

export type ManifestRead =
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string }
  | { kind: 'ok'; ports: ManifestPort[] };

const TOP_LEVEL_KEYS = new Set(['version', 'ports']);
const ENTRY_KEYS = new Set(['name', 'port', 'https_port', 'path']);

const manifestSchema = boundary.object({
  version: boundary.literal(1),
  ports: boundary.array(boundary.jsonObject),
});

const entrySchema = boundary.object({
  name: boundary.string,
  port: boundary.number,
  https_port: boundary.optional(boundary.number),
  path: boundary.optional(boundary.string),
});

export function isTcpPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function isUrlPath(value: string): boolean {
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/u.test(value) && value.length <= 512;
}

function unknownKeys(object: JsonObject, allowed: Set<string>): string[] {
  return Object.keys(object).filter(key => !allowed.has(key));
}

/**
 * Strict v1 schema: `{"version": 1, "ports": [{"name", "port", "https_port"?, "path"?}]}`. Unknown keys,
 * duplicate names or ports, and out-of-range ports make the whole manifest invalid, so a typo never
 * publishes something half-understood.
 */
export function parsePortsManifest(text: string): ManifestRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { kind: 'invalid', error: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const manifest = decodeBoundary(raw, manifestSchema);
    const extraTop = unknownKeys(decodeBoundary(raw, boundary.jsonObject), TOP_LEVEL_KEYS);
    if (extraTop.length > 0) return { kind: 'invalid', error: `unknown key ${extraTop.join(', ')} (expected version, ports)` };
    if (manifest.ports.length > MAX_MANIFEST_PORTS) return { kind: 'invalid', error: `at most ${MAX_MANIFEST_PORTS} ports` };
    const ports: ManifestPort[] = [];
    for (const [index, object] of manifest.ports.entries()) {
      const where = `ports[${index}]`;
      const extra = unknownKeys(object, ENTRY_KEYS);
      if (extra.length > 0) return { kind: 'invalid', error: `${where}: unknown key ${extra.join(', ')} (expected name, port, https_port, path)` };
      const entry = decodeBoundary(object, entrySchema);
      if (!PORT_NAME_PATTERN.test(entry.name)) return { kind: 'invalid', error: `${where}.name must be lowercase letters, digits and hyphens (at most 40)` };
      if (!isTcpPort(entry.port)) return { kind: 'invalid', error: `${where}.port must be an integer 1-65535` };
      if (entry.https_port !== undefined && (!isTcpPort(entry.https_port) || entry.https_port === 443)) {
        return { kind: 'invalid', error: `${where}.https_port must be an integer 1-65535 other than 443 (Pane's own)` };
      }
      const urlPath = entry.path ?? '/';
      if (!isUrlPath(urlPath)) return { kind: 'invalid', error: `${where}.path must start with / and hold URL characters only` };
      if (ports.some(port => port.name === entry.name)) return { kind: 'invalid', error: `${where}: duplicate name ${entry.name}` };
      if (ports.some(port => port.port === entry.port)) return { kind: 'invalid', error: `${where}: duplicate port ${entry.port}` };
      ports.push({ name: entry.name, port: entry.port, httpsPort: entry.https_port, path: urlPath });
    }
    return { kind: 'ok', ports };
  } catch (error) {
    if (error instanceof BoundaryDecodeError) return { kind: 'invalid', error: error.message };
    throw error;
  }
}

export function readPortsManifest(repoPath: string): ManifestRead {
  const file = path.join(repoPath, PORTS_MANIFEST_PATH);
  if (!fs.existsSync(file)) return { kind: 'absent' };
  let text: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { kind: 'invalid', error: `${PORTS_MANIFEST_PATH} is not a file` };
    if (stat.size > MAX_MANIFEST_BYTES) return { kind: 'invalid', error: `${PORTS_MANIFEST_PATH} is larger than 64 KiB` };
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { kind: 'invalid', error: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  return parsePortsManifest(text);
}
