import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { JsonValue } from '../../boundaryDecoder';
import { BrokerError } from './brokerClient';
import { lastValue, parseAgentFlags, UnsupportedFlagError, type FlagSpec, type ParsedFlags } from './flags';
import { sessionBroker, type AgentDeps } from './session';

/**
 * A `doppler` stand-in for cloud Sessions (installed as ~/.local/bin/doppler): the commands agent
 * skills commonly use (`doppler run [-p P -c C] -- cmd`, `doppler secrets get NAME --plain`, `doppler secrets
 * download --no-file --format json`), answered from values the coordinator delivered for this
 * Session's repository manifest (`.runpane/secrets.json`). No Doppler credential exists in the Session.
 *
 * The values live in one 0600 file (~/.runpane-cloud/doppler/secrets.json, 0700 dir), refreshed at
 * every boot or wake (a user unit runs `doppler refresh --boot`), on `doppler refresh`, and before a
 * command when the copy is over an hour old. They reach a process only as the environment of the child
 * of `doppler run`, or on stdout when an agent asks for one with `doppler secrets get` or for a whole
 * config with `doppler secrets download --no-file` (programs that load a set). Listing, status, refresh,
 * configs, help and every error print names and counts only, and no value goes into a shell rc file,
 * the daemon's environment or a log.
 */

const REFRESH_AFTER_MS = 60 * 60_000;
const BOOT_RETRY_FOR_MS = 180_000;
const FETCH_TIMEOUT_MS = 30_000;
const REFUSED = 'not available in a runpane cloud Session (the doppler stand-in serves run, secrets get/download, refresh and status)';

const DOPPLER_USAGE = `doppler (runpane cloud stand-in): Doppler secrets for this Session, delivered by the runpane cloud coordinator.
  doppler run [-p <project>] [-c <config>] [--preserve-env] -- <command> [args...]
  doppler run [-p <project>] [-c <config>] --command "<shell command>"
  doppler secrets [--only-names] [--json]              names only
  doppler secrets get NAME [NAME...] [--plain | --json] [-p <project>] [-c <config>]       prints the values
  doppler secrets download --no-file [--format json|env|env-no-quotes|docker] [-p <project>] [-c <config>]
                                                       prints every value of the config (for programs only)
  doppler refresh [--json]                             fetch the current set from the coordinator now
  doppler status [--json]                              where the set came from, name counts, the store's mode
Which secrets: the repository's .runpane/secrets.json (names or "all" per Doppler config), filtered by
your coordinator's secrets policy. Without -p/-c, the manifest's first config is used. The set refreshes
at every wake and on doppler refresh; doppler login/setup are not needed here.`;

// ---------------------------------------------------------------- the cached set

interface CachedConfig {
  project: string;
  config: string;
  values: Map<string, string>;
  withheld: Array<{ name: string; reason: string }>;
  missing: string[];
  refused: string | null;
}

interface SecretsCache {
  fetchedAt: string;
  /** When this Session stored it (its own clock). */
  storedAt: string;
  manifest: { repo: string; ref: string | null; path: string; sha: string | null } | null;
  reason: string | null;
  policy: string | null;
  version: string | null;
  configs: CachedConfig[];
}

const configSchema = boundary.object({
  project: boundary.nonEmptyString,
  config: boundary.nonEmptyString,
  values: boundary.jsonObject,
  withheld: boundary.optional(boundary.array(boundary.object({ name: boundary.string, reason: boundary.string }))),
  missing: boundary.optional(boundary.array(boundary.string)),
  refused: boundary.optional(boundary.nullable(boundary.string)),
});

const fetchSchema = boundary.object({
  fetchedAt: boundary.nonEmptyString,
  storedAt: boundary.optional(boundary.string),
  manifest: boundary.optional(boundary.nullable(boundary.object({
    repo: boundary.nonEmptyString,
    ref: boundary.optional(boundary.nullable(boundary.string)),
    path: boundary.optional(boundary.string),
    sha: boundary.optional(boundary.nullable(boundary.string)),
  }))),
  reason: boundary.optional(boundary.nullable(boundary.string)),
  policy: boundary.optional(boundary.nullable(boundary.string)),
  version: boundary.optional(boundary.nullable(boundary.string)),
  configs: boundary.array(configSchema),
});

/** The coordinator's answer (or the cache file, which has the same shape plus storedAt). */
function decodeSecrets(value: JsonValue, storedAt: string): SecretsCache {
  const body = decodeBoundary(value, fetchSchema);
  return {
    fetchedAt: body.fetchedAt,
    storedAt: body.storedAt ?? storedAt,
    manifest: body.manifest
      ? { repo: body.manifest.repo, ref: body.manifest.ref ?? null, path: body.manifest.path ?? '.runpane/secrets.json', sha: body.manifest.sha ?? null }
      : null,
    reason: body.reason ?? null,
    policy: body.policy ?? null,
    version: body.version ?? null,
    configs: body.configs.map((config) => ({
      project: config.project,
      config: config.config,
      values: new Map(Object.entries(config.values).map(([name, raw]) => [name, decodeBoundary(raw, boundary.string)])),
      withheld: config.withheld ?? [],
      missing: config.missing ?? [],
      refused: config.refused ?? null,
    })),
  };
}

function encodeSecrets(cache: SecretsCache): string {
  return `${JSON.stringify({
    version: cache.version,
    fetchedAt: cache.fetchedAt,
    storedAt: cache.storedAt,
    manifest: cache.manifest,
    reason: cache.reason,
    policy: cache.policy,
    configs: cache.configs.map((config) => ({
      project: config.project,
      config: config.config,
      values: Object.fromEntries(config.values),
      withheld: config.withheld,
      missing: config.missing,
      refused: config.refused,
    })),
  })}\n`;
}

export function secretsCachePath(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME || '/home/user', '.runpane-cloud', 'doppler', 'secrets.json');
}

async function readCache(deps: AgentDeps): Promise<SecretsCache | null> {
  const file = secretsCachePath(deps.env);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  await keepPrivate(deps, file);
  try {
    return decodeSecrets(JSON.parse(text), '');
  } catch {
    deps.stderr('doppler: the stored secrets file is unreadable; run doppler refresh.');
    return null;
  }
}

/**
 * Puts the store and its directory back to 0600/0700 when something (a restore, a copy, a chmod) widened
 * them. Any process running as the Session user can still read it: that is the design, the same as a
 * real Doppler CLI token in ~/.doppler, and the reason values never go to output by default.
 */
async function keepPrivate(deps: AgentDeps, file: string): Promise<void> {
  const targets: Array<{ target: string; mode: number }> = [{ target: file, mode: 0o600 }, { target: path.dirname(file), mode: 0o700 }];
  for (const { target, mode } of targets) {
    try {
      const current = (await fs.stat(target)).mode & 0o777;
      if ((current & 0o077) === 0) continue;
      await fs.chmod(target, mode);
      deps.stderr(`doppler: ${target} was ${modeText(current)}; set it back to ${modeText(mode)}.`);
    } catch {
      // Gone or not ours: the read or the next write reports it.
    }
  }
}

function modeText(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

/** The store's path and mode for `doppler status` (never its contents). */
async function storeInfo(deps: AgentDeps): Promise<{ path: string; mode: string | null }> {
  const file = secretsCachePath(deps.env);
  try {
    return { path: file, mode: modeText((await fs.stat(file)).mode & 0o777) };
  } catch {
    return { path: file, mode: null };
  }
}

/**
 * Written in place with mode 0600 in a 0700 directory, never renamed into place: a boat restore can
 * truncate a file that was renamed shortly before the snapshot.
 */
async function writeCache(deps: AgentDeps, cache: SecretsCache): Promise<void> {
  const file = secretsCachePath(deps.env);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const handle = await fs.open(file, 'w', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(encodeSecrets(cache));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------- refresh

interface RefreshOutcome {
  cache: SecretsCache;
  previous: SecretsCache | null;
}

/**
 * Coordinator answers that are decisions, not outages: the Session drops what it had (the user turned
 * the service off, the manifest is broken or on a branch the Session can write, the Session was removed).
 * Anything else (unreachable, Doppler or GitHub down, rate limited) keeps the stored copy.
 */
const CLEARING_CODES = new Set(['secrets-disabled', 'manifest-invalid', 'manifest-ref-writable', 'forbidden', 'auth-unknown-peer', 'auth-revoked']);

async function refresh(deps: AgentDeps, options: { retryForMs: number }): Promise<RefreshOutcome> {
  const previous = await readCache(deps);
  const broker = sessionBroker(deps);
  const until = Date.now() + options.retryForMs;
  for (;;) {
    try {
      const cache = decodeSecrets(await broker.fetchSecrets(FETCH_TIMEOUT_MS), new Date().toISOString());
      cache.storedAt = new Date().toISOString();
      await writeCache(deps, cache);
      return { cache, previous };
    } catch (error) {
      if (error instanceof BrokerError && CLEARING_CODES.has(error.code)) {
        const now = new Date().toISOString();
        await writeCache(deps, { fetchedAt: now, storedAt: now, manifest: previous?.manifest ?? null, reason: `${error.message} (${error.code})`, policy: null, version: null, configs: [] });
        throw error;
      }
      // At boot the tailnet may not be up yet: keep trying while the coordinator is unreachable.
      const transient = error instanceof BrokerError && (error.code === 'unreachable' || error.status >= 500);
      if (!transient || Date.now() >= until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

/**
 * The set for a command: stored, refreshed first when missing or older than an hour. A failed refresh
 * of an existing copy only warns; the coordinator being away must not stop the agent.
 */
async function currentSet(deps: AgentDeps): Promise<SecretsCache> {
  const cached = await readCache(deps);
  const age = cached ? Date.now() - Date.parse(cached.storedAt) : Number.POSITIVE_INFINITY;
  if (cached && Number.isFinite(age) && age >= 0 && age < REFRESH_AFTER_MS) return cached;
  try {
    return (await refresh(deps, { retryForMs: 0 })).cache;
  } catch (error) {
    if (!cached) throw error;
    deps.stderr(`doppler: using secrets stored ${cached.storedAt}; refreshing failed: ${describe(error)}`);
    return cached;
  }
}

// ---------------------------------------------------------------- choosing a config

const SCOPE_FLAGS: FlagSpec['values'] = [['--project', '-p'], ['--config', '-c']];

function chooseConfig(cache: SecretsCache, flags: ParsedFlags, deps: AgentDeps): CachedConfig {
  const project = lastValue(flags, '--project') ?? deps.env.DOPPLER_PROJECT;
  const config = lastValue(flags, '--config') ?? deps.env.DOPPLER_CONFIG;
  if (cache.configs.length === 0) {
    const noManifest = cache.manifest === null || cache.manifest.sha === null;
    throw new Error(`no Doppler secrets are delivered to this Session: ${cache.reason ?? 'the manifest lists none'}. `
      + (noManifest ? 'Add .runpane/secrets.json to the repository (see doppler --help), then doppler refresh.' : 'Run doppler refresh once that is fixed.'));
  }
  const first = cache.configs[0];
  const wantedProject = project ?? first.project;
  const wantedConfig = config ?? (wantedProject === first.project ? first.config : undefined);
  const found = cache.configs.find((candidate) => candidate.project === wantedProject && (wantedConfig === undefined || candidate.config === wantedConfig));
  const listed = cache.configs.map((candidate) => `${candidate.project}/${candidate.config}`).join(', ');
  if (!found) {
    throw new Error(`${wantedProject}/${wantedConfig ?? '?'} is not in this Session's manifest (${listed}). Add it to .runpane/secrets.json, then doppler refresh.`);
  }
  if (found.refused) throw new Error(`${found.project}/${found.config} is listed in the manifest but not delivered: ${found.refused}.`);
  return found;
}

/** The variables `doppler run` adds, like the real CLI's DOPPLER_PROJECT/CONFIG/ENVIRONMENT. */
function childEnvironment(config: CachedConfig, base: NodeJS.ProcessEnv, preserveEnv: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of config.values) {
    if (preserveEnv && env[name] !== undefined) continue;
    env[name] = value;
  }
  env.DOPPLER_PROJECT = config.project;
  env.DOPPLER_CONFIG = config.config;
  env.DOPPLER_ENVIRONMENT = config.config.split(/[_-]/u)[0];
  return env;
}

// ---------------------------------------------------------------- commands

export async function runDopplerStandIn(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        deps.stdout(DOPPLER_USAGE);
        return command === undefined ? 2 : 0;
      case '--version':
      case '-v':
      case 'version':
        deps.stdout('v0.0.0-runpane-cloud-stand-in (runpane cloud coordinator; not the Doppler CLI)');
        return 0;
      case 'run': return await run(rest, deps);
      case 'secrets': return await secrets(rest, deps);
      case 'refresh': return await refreshCommand(rest, deps);
      case 'status':
      case 'me':
      case 'configure':
        return await status(rest, deps);
      case 'setup':
      case 'login':
        deps.stderr(`doppler ${command}: not needed in a runpane cloud Session; the coordinator delivers this repository's manifest secrets (doppler status).`);
        return 0;
      case 'configs': return await configs(rest, deps);
      default:
        deps.stderr(`doppler ${command}: ${REFUSED}.\n\n${DOPPLER_USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UnsupportedFlagError) {
      deps.stderr(`doppler ${command ?? ''} ${error.flag}: ${REFUSED}.`);
      return 2;
    }
    deps.stderr(`doppler: ${describe(error)}`);
    return 1;
  }
}

async function run(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const flags = parseAgentFlags(argv, {
    values: [...SCOPE_FLAGS, ['--command']],
    // Accepted and ignored: this stand-in has no fallback file, and signals are always forwarded.
    booleans: [['--preserve-env'], ['--forward-signals'], ['--silent'], ['--no-fallback'], ['--fallback-readonly'], ['--fallback-only'], ['--no-check-version']],
  });
  const shellCommand = lastValue(flags, '--command');
  if (shellCommand !== undefined && flags.positionals.length > 0) throw new Error('give a command after -- or --command "...", not both.');
  if (shellCommand === undefined && flags.positionals.length === 0) throw new Error('doppler run needs a command: doppler run -- <command> [args...]');
  const config = chooseConfig(await currentSet(deps), flags, deps);
  const env = childEnvironment(config, deps.env, flags.booleans.has('--preserve-env'));
  const [program, ...args] = shellCommand === undefined ? flags.positionals : ['/bin/sh', '-c', shellCommand];
  return new Promise<number>((resolve) => {
    const child = spawn(program, args, { cwd: deps.cwd, env, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal);
    };
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
      const handler = forward(signal);
      process.on(signal, handler);
      return { signal, handler };
    });
    const done = (code: number) => {
      for (const { signal, handler } of handlers) process.off(signal, handler);
      resolve(code);
    };
    child.on('error', (error) => {
      deps.stderr(`doppler: could not start ${program}: ${error.message}`);
      done(127);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 + signalNumber(signal) : 1)));
  });
}

async function secrets(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === 'get') {
    const flags = parseAgentFlags(rest, { values: SCOPE_FLAGS, booleans: [['--plain'], ['--json'], ['--copy'], ['--no-copy'], ['--raw'], ['--no-exit-on-missing-secret']] });
    if (flags.positionals.length === 0) throw new Error('doppler secrets get needs a NAME.');
    if (flags.booleans.has('--copy')) throw new UnsupportedFlagError('--copy');
    const config = chooseConfig(await currentSet(deps), flags, deps);
    const absent = flags.positionals.filter((name) => !config.values.has(name));
    if (absent.length > 0 && !flags.booleans.has('--no-exit-on-missing-secret')) {
      const withheld = config.withheld.filter((item) => absent.includes(item.name));
      throw new Error(`Could not find requested secret${absent.length === 1 ? '' : 's'}: ${absent.join(', ')} in ${config.project}/${config.config}`
        + `${withheld.length > 0 ? ` (${withheld.map((item) => `${item.name}: ${item.reason}`).join('; ')})` : ' (not in the manifest\'s names, or not in Doppler)'}.`);
    }
    const present = flags.positionals.filter((name) => config.values.has(name));
    if (flags.booleans.has('--json')) {
      deps.stdout(JSON.stringify(Object.fromEntries(present.map((name) => {
        const value = config.values.get(name) ?? '';
        return [name, { computed: value, raw: value, note: '' }];
      }))));
    } else if (flags.booleans.has('--plain')) {
      for (const name of present) deps.stdout(config.values.get(name) ?? '');
    } else {
      for (const name of present) deps.stdout(`${name}  ${config.values.get(name) ?? ''}`);
    }
    return 0;
  }
  if (sub === 'download') {
    const flags = parseAgentFlags(rest, { values: [...SCOPE_FLAGS, ['--format']], booleans: [['--no-file'], ['--no-check-version']] });
    if (!flags.booleans.has('--no-file') || flags.positionals.length > 0) {
      throw new UnsupportedFlagError('download to a file (use --no-file and redirect stdout; the stand-in writes no fallback files)');
    }
    const format = lastValue(flags, '--format') ?? 'json';
    const config = chooseConfig(await currentSet(deps), flags, deps);
    const entries = [...childEnvironmentValues(config)];
    switch (format) {
      case 'json':
        deps.stdout(JSON.stringify(Object.fromEntries(entries)));
        return 0;
      case 'env':
        deps.stdout(entries.map(([name, value]) => `${name}="${value.replace(/(["\\$`])/gu, '\\$1').replace(/\n/gu, '\\n')}"`).join('\n'));
        return 0;
      case 'env-no-quotes':
      case 'docker':
        deps.stdout(entries.map(([name, value]) => `${name}=${value}`).join('\n'));
        return 0;
      default:
        throw new UnsupportedFlagError(`--format ${format}`);
    }
  }
  if (sub === undefined || sub.startsWith('-')) {
    const flags = parseAgentFlags(argv, { values: SCOPE_FLAGS, booleans: [['--only-names'], ['--json'], ['--raw']] });
    const config = chooseConfig(await currentSet(deps), flags, deps);
    const names = [...childEnvironmentValues(config).keys()];
    if (flags.booleans.has('--json')) deps.stdout(JSON.stringify(Object.fromEntries(names.map((name) => [name, {}]))));
    else deps.stdout(names.join('\n'));
    if (!flags.booleans.has('--only-names')) deps.stderr('doppler: names only in a runpane cloud Session; read a value with doppler secrets get NAME --plain.');
    return 0;
  }
  throw new UnsupportedFlagError(`secrets ${sub}`);
}

/** What `doppler run` would add, in name order (the DOPPLER_* metadata included, like the real CLI). */
function childEnvironmentValues(config: CachedConfig): Map<string, string> {
  const env = childEnvironment(config, {}, false);
  return new Map(Object.keys(env).sort().map((name) => [name, env[name] ?? '']));
}

async function refreshCommand(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const flags = parseAgentFlags(argv, { values: [], booleans: [['--json'], ['--boot'], ['--quiet']] });
  const { cache, previous } = await refresh(deps, { retryForMs: flags.booleans.has('--boot') ? BOOT_RETRY_FOR_MS : 0 });
  const summary = summarize(cache);
  const before = previous ? new Set(previous.configs.flatMap((config) => [...config.values.keys()].map((name) => `${config.project}/${config.config}:${name}`))) : new Set<string>();
  const after = new Set(cache.configs.flatMap((config) => [...config.values.keys()].map((name) => `${config.project}/${config.config}:${name}`)));
  const added = [...after].filter((name) => !before.has(name));
  const removed = [...before].filter((name) => !after.has(name));
  if (flags.booleans.has('--json')) {
    deps.stdout(JSON.stringify({ ok: true, ...summary, previousVersion: previous?.version ?? null, added, removed }, null, 2));
  } else if (!flags.booleans.has('--quiet')) {
    deps.stdout(`doppler: refreshed from the coordinator (${summary.source}); ${summary.configs.map((config) => `${config.config} ${config.names.length} names${config.refused ? ` (refused: ${config.refused})` : ''}`).join(', ') || 'no configs'}; version ${cache.version ?? 'none'}.`);
    if (previous) deps.stdout(`  changes since the last refresh: ${added.length} added, ${removed.length} removed${removed.length > 0 ? ` (${removed.join(', ')})` : ''}.`);
  }
  return 0;
}

function summarize(cache: SecretsCache) {
  return {
    source: cache.manifest ? `${cache.manifest.repo}${cache.manifest.ref ? `@${cache.manifest.ref}` : ''}:${cache.manifest.path}${cache.manifest.sha ? ` ${cache.manifest.sha.slice(0, 12)}` : ' (absent)'}` : 'no manifest',
    reason: cache.reason,
    policy: cache.policy,
    version: cache.version,
    fetchedAt: cache.fetchedAt,
    storedAt: cache.storedAt,
    configs: cache.configs.map((config) => ({
      config: `${config.project}/${config.config}`,
      names: [...config.values.keys()],
      withheld: config.withheld,
      missing: config.missing,
      refused: config.refused,
    })),
  };
}

async function status(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const flags = parseAgentFlags(argv, { values: [], booleans: [['--json']] });
  const cache = await readCache(deps);
  const store = await storeInfo(deps);
  if (flags.booleans.has('--json')) {
    deps.stdout(JSON.stringify(cache ? { ok: true, ...summarize(cache), store } : { ok: false, reason: 'nothing fetched yet (doppler refresh)', store }, null, 2));
    return cache ? 0 : 1;
  }
  if (!cache) {
    deps.stdout('doppler (runpane cloud stand-in): nothing fetched yet; run doppler refresh.');
    return 1;
  }
  const summary = summarize(cache);
  deps.stdout(`doppler (runpane cloud stand-in): secrets from ${summary.source}, fetched ${cache.fetchedAt}, version ${cache.version ?? 'none'}, policy ${cache.policy ?? '?'}.`);
  deps.stdout(`  stored in ${store.path} (${store.mode ?? 'missing'}; readable by this Session's user only; never print it, use doppler status or doppler secrets --only-names)`);
  if (cache.reason) deps.stdout(`  ${cache.reason}`);
  for (const config of summary.configs) {
    deps.stdout(`  ${config.config}: ${config.refused ? `refused: ${config.refused}` : `${config.names.length} names`}${config.withheld.length > 0 ? `; withheld ${config.withheld.map((item) => item.name).join(', ')}` : ''}${config.missing.length > 0 ? `; not in Doppler ${config.missing.join(', ')}` : ''}`);
  }
  return 0;
}

async function configs(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const flags = parseAgentFlags(argv, { values: SCOPE_FLAGS, booleans: [['--json']] });
  const cache = await currentSet(deps);
  const list = cache.configs.map((config) => ({ project: config.project, name: config.config, delivered: config.refused === null }));
  deps.stdout(flags.booleans.has('--json') ? JSON.stringify(list) : list.map((config) => `${config.project}/${config.name}${config.delivered ? '' : ' (refused)'}`).join('\n'));
  return 0;
}

function describe(cause: unknown): string {
  if (cause instanceof BrokerError) return `${cause.message} (${cause.code})`;
  return cause instanceof Error ? cause.message : String(cause);
}

function signalNumber(signal: NodeJS.Signals): number {
  return os.constants.signals[signal];
}
