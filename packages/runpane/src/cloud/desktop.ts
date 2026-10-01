import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../boundaryDecoder';
import { isNotFound, type CloudHostProfile } from './store';

/**
 * Puts cloud host profiles into the desktop Pane's saved remote hosts, so the host switcher (#853)
 * lists them. This reuses the existing import path, on disk: the desktop
 * keeps profiles in `<desktop dir>/config.json` under `remoteDaemon.client.profiles`, and its
 * ConfigManager watches that file and reloads outside edits. The desktop never creates or manages
 * machines (#695); it only sees profiles.
 *
 * The desktop dir is `--desktop-dir`, then `$RUNPANE_CLOUD_DESKTOP_DIR`, then `~/.pane`. `$PANE_DIR` is
 * ignored on purpose: inside a Pane terminal it names the daemon hosting that terminal, which may be a
 * remote daemon, not the desktop.
 */

export function defaultDesktopDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RUNPANE_CLOUD_DESKTOP_DIR) return path.resolve(env.RUNPANE_CLOUD_DESKTOP_DIR);
  return path.join(os.homedir(), '.pane');
}

export interface DesktopImportResult {
  configPath: string;
  added: string[];
  updated: string[];
  removed: string[];
}

/** The parts of a saved profile this module matches on; everything else is carried through as-is. */
const profileKeysSchema = boundary.object({
  id: boundary.optional(boundary.string),
  baseUrl: boundary.optional(boundary.string),
  cloud: boundary.optional(boundary.object({ sessionId: boundary.optional(boundary.string) })),
});

const clientSchema = boundary.object({
  profiles: boundary.optional(boundary.array(boundary.json)),
  activeProfileId: boundary.optional(boundary.nullable(boundary.string)),
  mode: boundary.optional(boundary.string),
});

interface SavedProfile {
  raw: JsonObject;
  id?: string;
  baseUrl?: string;
  sessionId?: string;
}

export async function syncDesktopProfiles(options: {
  desktopDir: string;
  upsert?: readonly CloudHostProfile[];
  /** Cloud Session ids whose profiles should be removed (after `destroy`). */
  removeSessionIds?: readonly string[];
}): Promise<DesktopImportResult> {
  const configPath = path.join(options.desktopDir, 'config.json');
  const result: DesktopImportResult = { configPath, added: [], updated: [], removed: [] };
  let config: JsonObject = {};
  let mode = 0o600;
  try {
    config = decodeBoundary(JSON.parse(await fs.readFile(configPath, 'utf8')), boundary.jsonObject);
    mode = (await fs.stat(configPath)).mode & 0o777;
  } catch (error) {
    if (!isNotFound(error)) throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const remoteDaemon = asObject(config.remoteDaemon);
  const clientRaw = asObject(remoteDaemon.client);
  const client = decodeBoundary(clientRaw, clientSchema);
  let profiles = (client.profiles ?? []).flatMap(toSavedProfile);
  let activeProfileId = client.activeProfileId ?? null;
  let clientMode = client.mode === 'remote' ? 'remote' : 'local';

  for (const sessionId of options.removeSessionIds ?? []) {
    const removed = profiles.filter((profile) => profile.sessionId === sessionId);
    if (removed.length === 0) continue;
    profiles = profiles.filter((profile) => profile.sessionId !== sessionId);
    result.removed.push(sessionId);
    if (activeProfileId && removed.some((profile) => profile.id === activeProfileId)) {
      activeProfileId = null;
      clientMode = 'local';
    }
  }

  for (const profile of options.upsert ?? []) {
    const index = profiles.findIndex((existing) =>
      existing.sessionId === profile.cloud.sessionId || existing.baseUrl === profile.baseUrl);
    if (index === -1) {
      profiles.push({ raw: profileJson(profile, profile.id), id: profile.id, baseUrl: profile.baseUrl, sessionId: profile.cloud.sessionId });
      result.added.push(profile.cloud.hostname);
    } else {
      // Keep the desktop's profile id so an active connection and any references survive.
      const id = profiles[index].id ?? profile.id;
      profiles[index] = { raw: profileJson(profile, id), id, baseUrl: profile.baseUrl, sessionId: profile.cloud.sessionId };
      result.updated.push(profile.cloud.hostname);
    }
  }

  const nextClient: JsonObject = {
    ...clientRaw,
    profiles: profiles.map((profile) => profile.raw),
    activeProfileId,
    mode: activeProfileId ? clientMode : 'local',
  };
  const next: JsonObject = { ...config, remoteDaemon: { ...remoteDaemon, client: nextClient } };

  await fs.mkdir(options.desktopDir, { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.runpane-cloud.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode });
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, configPath);
  return result;
}

function toSavedProfile(raw: JsonValue): SavedProfile[] {
  if (raw === null || Array.isArray(raw) || !isJsonObject(raw)) return [];
  try {
    const keys = decodeBoundary(raw, profileKeysSchema);
    return [{ raw, id: keys.id, baseUrl: keys.baseUrl, sessionId: keys.cloud?.sessionId }];
  } catch {
    // A profile this module cannot read is still the desktop's; keep it untouched.
    return [{ raw }];
  }
}

function profileJson(profile: CloudHostProfile, id: string): JsonObject {
  const json: JsonObject = {
    id,
    label: profile.label,
    baseUrl: profile.baseUrl,
    token: profile.token,
    transport: profile.transport,
    cloud: {
      provider: profile.cloud.provider,
      sandboxId: profile.cloud.sandboxId,
      sessionId: profile.cloud.sessionId,
      nodeId: profile.cloud.nodeId,
      hostname: profile.cloud.hostname,
      version: profile.cloud.version,
    },
  };
  if (profile.tunnel) {
    const tunnel: JsonObject = { kind: profile.tunnel.kind, selected: profile.tunnel.selected };
    if (profile.tunnel.note) tunnel.note = profile.tunnel.note;
    json.tunnel = tunnel;
  }
  return json;
}

function asObject(value: JsonValue | undefined): JsonObject {
  return value !== undefined && isJsonObject(value) ? value : {};
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && value instanceof Object;
}
