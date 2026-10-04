import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../boundaryDecoder';
import { isNotFound, type CloudHostProfile } from './store';

/**
 * The desktop's saved remote hosts: where a cloud sandbox's profile goes so the host switcher lists it.
 * The desktop main process passes its own implementation (through its ConfigManager); the CLI uses
 * `createDesktopConfigHosts`, which edits the desktop's config.json on disk.
 */
export interface SavedRemoteHosts {
  /** Adds the profile, or replaces the one with the same `cloud.sessionId` (keeping that profile's id). */
  upsert(profile: CloudHostProfile): Promise<void>;
  /** Removes the profile with this `cloud.sessionId`; when it was the active host, the desktop goes back to local. */
  remove(sessionId: string): Promise<void>;
}

/**
 * The desktop dir is `$RUNPANE_CLOUD_DESKTOP_DIR`, else `~/.pane`. `$PANE_DIR` is ignored on purpose:
 * inside a Pane terminal it names the daemon hosting that terminal, which may be a remote daemon.
 */
export function defaultDesktopDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RUNPANE_CLOUD_DESKTOP_DIR) return path.resolve(env.RUNPANE_CLOUD_DESKTOP_DIR);
  return path.join(os.homedir(), '.pane');
}

/**
 * Saved hosts in `<desktopDir>/config.json` under `remoteDaemon.client.profiles`, the file the desktop's
 * ConfigManager watches and reloads. Profiles and fields this module does not own are carried through as-is.
 */
export function createDesktopConfigHosts(desktopDir: string = defaultDesktopDir()): SavedRemoteHosts {
  const configPath = path.join(desktopDir, 'config.json');
  return {
    async upsert(profile) {
      await editProfiles(configPath, (client) => {
        const profiles = readProfiles(client);
        const index = profiles.findIndex((existing) => existing.sessionId === profile.cloud.sessionId);
        if (index === -1) {
          profiles.push({ raw: profileJson(profile, profile.id), id: profile.id, sessionId: profile.cloud.sessionId });
        } else {
          // Keep the desktop's profile id so an active connection and its references survive.
          const id = profiles[index].id ?? profile.id;
          profiles[index] = { raw: profileJson(profile, id), id, sessionId: profile.cloud.sessionId };
        }
        return { ...client, profiles: profiles.map((saved) => saved.raw) };
      });
    },
    async remove(sessionId) {
      await editProfiles(configPath, (client) => {
        const profiles = readProfiles(client);
        const removed = profiles.filter((saved) => saved.sessionId === sessionId);
        const next: JsonObject = { ...client, profiles: profiles.filter((saved) => saved.sessionId !== sessionId).map((saved) => saved.raw) };
        if (removed.some((saved) => saved.id !== undefined && saved.id === client.activeProfileId)) {
          next.activeProfileId = null;
          next.mode = 'local';
        }
        return next;
      });
    },
  };
}

/** The parts of a saved profile this module matches on. */
const profileKeysSchema = boundary.object({
  id: boundary.optional(boundary.string),
  cloud: boundary.optional(boundary.object({ sessionId: boundary.optional(boundary.string) })),
});

interface SavedProfile {
  raw: JsonValue;
  id?: string;
  sessionId?: string;
}

function readProfiles(client: JsonObject): SavedProfile[] {
  const profiles = Array.isArray(client.profiles) ? client.profiles : [];
  return profiles.map((raw) => {
    try {
      const keys = decodeBoundary(raw, profileKeysSchema);
      return { raw, id: keys.id, sessionId: keys.cloud?.sessionId };
    } catch {
      // A profile this module cannot read is still the desktop's; keep it untouched.
      return { raw };
    }
  });
}

async function editProfiles(configPath: string, edit: (client: JsonObject) => JsonObject): Promise<void> {
  let config: JsonObject = {};
  let mode = 0o600;
  try {
    config = decodeBoundary(JSON.parse(await fs.readFile(configPath, 'utf8')), boundary.jsonObject);
    mode = (await fs.stat(configPath)).mode & 0o777;
  } catch (error) {
    if (!isNotFound(error)) throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const remoteDaemon = asObject(config.remoteDaemon);
  const client = edit(asObject(remoteDaemon.client));
  const next: JsonObject = { ...config, remoteDaemon: { ...remoteDaemon, client } };

  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.runpane-cloud.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode });
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, configPath);
}

function profileJson(profile: CloudHostProfile, id: string): JsonObject {
  const json: JsonObject = {
    id,
    label: profile.label,
    baseUrl: profile.baseUrl,
    token: profile.token,
    transport: profile.transport,
    cloud: { ...profile.cloud },
    // The desktop names and draws saved hosts from this (shared/types/remoteDaemon.ts RemoteHostKind).
    hostKind: { label: 'cloud sandbox', icon: 'cloud' },
    // Nobody is at a sandbox's screen: tools in its host terminal (gh, codex login) print their
    // sign-in URL instead of opening a browser on the sandbox. Same list as shared/types/remoteDaemon.ts.
    hostTerminalEnv: [{ name: 'BROWSER', value: 'false' }, { name: 'GH_BROWSER', value: 'false' }],
    // Its GitHub token is set in the desktop's Settings > Cloud sandboxes; a clone that needs a sign-in points there.
    githubSignIn: 'settings',
    // Its keyring can't be unlocked without someone at its screen, so gh keeps the token Pane
    // signs it in with in ~/.config/gh/hosts.yml (owner-only) instead.
    ghInsecureStorage: true,
  };
  if (profile.tunnel) {
    const tunnel: JsonObject = { kind: profile.tunnel.kind, selected: profile.tunnel.selected };
    if (profile.tunnel.note) tunnel.note = profile.tunnel.note;
    json.tunnel = tunnel;
  }
  return json;
}

function asObject(value: JsonValue | undefined): JsonObject {
  if (value === undefined) return {};
  try {
    return decodeBoundary(value, boundary.jsonObject);
  } catch {
    return {};
  }
}
