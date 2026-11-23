import { promises as fs } from 'fs';
import path from 'path';
import { MAX_CLOCK_AHEAD_MS, type PaneSecretStore } from './paneSecrets';
import { githubCliToken } from './githubWatchClient';
import { PaneError } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { paneSecretKey, type PaneSecretSummary } from '../../../shared/types/paneSecrets';
import type { SharedCredentials } from '../../../shared/types/sharedCredentials';
import {
  CLOUD_SIGN_IN_ENVS,
  CLOUD_SIGN_IN_PROJECT,
  CLOUD_TOKEN_AGENTS,
  GITHUB_SIGN_IN_ENV,
  cloudSecretRecords,
  type PaneCloudSecretChoice,
  type PaneCloudSecretItem,
  type PaneCloudSecrets,
} from '../../../shared/types/paneCloudSecrets';

export const GITHUB_SIGN_IN_KEY = paneSecretKey(CLOUD_SIGN_IN_PROJECT, GITHUB_SIGN_IN_ENV);

/** What a sign-in is for, as the chooser labels it in place of the secret's project. */
function signInLabel(key: string): string | null {
  if (key === GITHUB_SIGN_IN_KEY) return 'GitHub';
  return CLOUD_TOKEN_AGENTS.find((agent) => paneSecretKey(CLOUD_SIGN_IN_PROJECT, agent.env) === key)?.title ?? null;
}

/** The person's GitHub token from the GitHub CLI on this computer, or null when gh is missing or signed out. */
export function readGithubToken(): Promise<string | null> {
  return githubCliToken().then((token) => token || null, () => null);
}

/** What "Choose what to send" lists: live secrets by name, grouped by the machine each was last set on, this one first. */
export function describeCloudSecrets(secrets: readonly PaneSecretSummary[], choice: PaneCloudSecretChoice, thisComputer: string): PaneCloudSecrets {
  const machines = new Map<string, PaneCloudSecretItem[]>([[thisComputer, []]]);
  for (const secret of secrets) {
    const key = paneSecretKey(secret.project, secret.name);
    const items = machines.get(secret.machine) ?? [];
    items.push({ key, name: secret.name, label: signInLabel(key) ?? secret.project });
    machines.set(secret.machine, items);
  }
  const saved = new Set(secrets.map((secret) => paneSecretKey(secret.project, secret.name)));
  return {
    machines: [...machines]
      .filter(([, items]) => items.length > 0)
      .map(([name, items]) => ({ name, thisComputer: name === thisComputer, secrets: items.sort((a, b) => a.name.localeCompare(b.name) || a.label.localeCompare(b.label)) })),
    choice,
    missingTokens: CLOUD_TOKEN_AGENTS.filter((agent) => !saved.has(paneSecretKey(CLOUD_SIGN_IN_PROJECT, agent.env))),
  };
}

/**
 * On a cloud VM, puts the sign-ins it holds into `env`, which agent panels inherit, and takes out
 * any that were removed. Git uses the GitHub token through the GitHub CLI.
 */
async function exportCloudSignIns(secrets: Pick<PaneSecretStore, 'has' | 'read'>, env: NodeJS.ProcessEnv): Promise<void> {
  for (const name of CLOUD_SIGN_IN_ENVS) {
    const value = secrets.has(CLOUD_SIGN_IN_PROJECT, name) ? await secrets.read(CLOUD_SIGN_IN_PROJECT, name).catch(() => null) : null;
    if (value) env[name] = value;
    else delete env[name];
  }
  if (env[GITHUB_SIGN_IN_ENV] && env.GIT_CONFIG_COUNT === undefined) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
    env.GIT_CONFIG_VALUE_0 = '!gh auth git-credential';
  }
}

/** The token file a cloud VM's unseal unit leaves on its secrets volume before the daemon starts (D-107). */
const TOKEN_DROP = path.join('incoming', 'github-token.json');

const tokenDropSchema = boundary.object({
  token: boundary.nonEmptyString,
  source: boundary.nonEmptyString,
  updatedAt: boundary.nonEmptyString,
});

function invalidTokenDrop(): PaneError {
  // Never the file's text or a parser's message: either can quote the token.
  return new PaneError(
    'ERR_CLOUD_TOKEN_DROP_INVALID',
    'The GitHub token this cloud machine was given at creation was not readable, so Pane deleted it and this machine has no GitHub sign-in yet.',
    'It arrives with the next sync from a computer signed in to gh; or create the cloud Session again.',
  );
}

/**
 * At daemon start on a machine with a secrets volume: imports the GitHub token the guest left in
 * `incoming/github-token.json`, through the same path as a sync (newest wins, the person's choice
 * applied), deletes the file whatever happened to it, then puts the sign-ins in the agents' environment.
 * A file that isn't a small regular file, can't be read or doesn't decode is deleted and reported with a
 * PaneError that never quotes it, and the sign-ins the machine holds are still exported.
 */
export async function startCloudSignIns(secrets: Pick<PaneSecretStore, 'applyFromSync' | 'cloudChoice' | 'has' | 'read'>, volume: string | undefined, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    if (volume !== undefined) await importTokenDrop(secrets, path.join(volume, TOKEN_DROP));
  } finally {
    await exportCloudSignIns(secrets, env);
  }
}

/** The most a token file holds: a token, a host label and a time. */
const MAX_TOKEN_DROP_BYTES = 64 * 1024;

async function importTokenDrop(secrets: Pick<PaneSecretStore, 'applyFromSync' | 'cloudChoice'>, drop: string): Promise<void> {
  let text: string;
  try {
    // Only a small regular file is read: a directory, a link, a pipe or an oversized file is deleted unread.
    const info = await fs.lstat(drop);
    if (!info.isFile() || info.size > MAX_TOKEN_DROP_BYTES) throw invalidTokenDrop();
    text = await fs.readFile(drop, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
    if (code === 'ENOENT') return;
    await fs.rm(drop, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof PaneError) throw error;
    throw new PaneError(
      'ERR_CLOUD_TOKEN_DROP_UNREADABLE',
      `Pane could not read the GitHub token this cloud machine was given at creation (${code ?? 'unknown error'}), so it deleted it and this machine has no GitHub sign-in yet.`,
      'It arrives with the next sync from a computer signed in to gh; or create the cloud Session again.',
    );
  }
  await fs.rm(drop, { force: true });
  let parsed: { token: string; source: string; updatedAt: string };
  try {
    parsed = decodeBoundary(JSON.parse(text), tokenDropSchema);
  } catch {
    throw invalidTokenDrop();
  }
  const time = Date.parse(parsed.updatedAt);
  if (Number.isNaN(time)) throw invalidTokenDrop();
  // A time far ahead of this clock would outrank every later token; take it as now.
  const updatedAt = time > Date.now() + MAX_CLOCK_AHEAD_MS ? new Date().toISOString() : parsed.updatedAt;
  const record = { [GITHUB_SIGN_IN_KEY]: { value: parsed.token, updatedAt, source: parsed.source } };
  await secrets.applyFromSync(cloudSecretRecords(record, secrets.cloudChoice()));
}

type CloudSecretStore = Pick<PaneSecretStore, 'applyCloudChoiceFromSync' | 'cloudChoice' | 'forgetExcluded' | 'applyFromSync' | 'secretRecord' | 'has' | 'read'>;

/**
 * A cloud VM taking secrets from any of the person's devices. The VM, not the sender, applies the
 * person's choice: it keeps the newest choice it has heard, removes what that choice turns off,
 * and stores only what it allows. So a second computer, or a phone from before choices, can't put
 * back a secret the person turned off. Throws when an allowed value could not be stored, so the
 * sender knows the Session would start without it.
 */
export async function receiveCloudSecrets(secrets: CloudSecretStore, incoming: SharedCredentials, env: NodeJS.ProcessEnv): Promise<string[]> {
  if (incoming.paneCloudSecretChoice) await secrets.applyCloudChoiceFromSync(incoming.paneCloudSecretChoice);
  const removed = await secrets.forgetExcluded();
  const allowed = cloudSecretRecords(incoming.paneSecrets ?? {}, secrets.cloudChoice());
  const changed = await secrets.applyFromSync(allowed);
  if (removed.length + changed.length > 0) await exportCloudSignIns(secrets, env);
  const missing = Object.entries(allowed).filter(([key, record]) => {
    if (record.value === null) return false;
    const stored = secrets.secretRecord(key);
    return !stored || stored.deleted || Date.parse(stored.updatedAt) < Date.parse(record.updatedAt);
  });
  if (missing.length > 0) {
    throw new PaneError(
      'ERR_CLOUD_SECRETS_NOT_STORED',
      `This cloud machine could not store ${missing.length === 1 ? 'a secret' : `${missing.length} secrets`} on its secrets volume, so its agents would start without them.`,
      'Delete this cloud Session and create a new one. If it happens again, write to Pane Cloud support: the machine\'s secrets volume may be missing or full.',
    );
  }
  return [...removed, ...changed];
}
