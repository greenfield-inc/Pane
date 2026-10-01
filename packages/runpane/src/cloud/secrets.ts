import { randomBytes } from 'node:crypto';
import { boundary, decodeBoundary } from '../boundaryDecoder';
import type { CloudDeps } from './commands';
import { BUILT_IN_DENY_LIST, DENIED_DOPPLER_CONFIGS, isDeniedConfig, matchingPattern, reservedBy, SECRET_NAME_PATTERN } from './secretPolicy';
import type { SandboxHandle } from './provider';
import { coordinatorSecretsEnabled, describeSecretsOutcome, disableSessionSecrets, enableSessionSecrets } from './sessionSecrets';
import { runSecretsInspect } from './secretsInspect';
import { findHost, type CloudHostRecord } from './store';
import { hostProvider } from './wallet';

/**
 * `runpane cloud secrets set|list|rm`: environment variables for a cloud Session's agents (BYOK).
 *
 * Values are resolved on this machine (a local env var, a file, or the local `doppler` CLI) and
 * reach the sandbox only inside a staged file written through the provider's files API. A script
 * there merges them into `~/.runpane-cloud/secrets.json` and renders `secrets.env` (both 0600, in
 * the 0700 state dir) and shreds the staged file. Scripts carry names, never values, so nothing
 * lands in sandbox metadata, env, command lines or logs.
 *
 * A marked block at the top of `~/.bashrc` and `~/.zshenv` sources `secrets.env`, so every panel
 * shell the daemon starts after a change (and the Claude or Codex it launches) sees the current
 * set without restarting the daemon. Panels already open keep the environment they started with.
 */

const STATE_DIR = '/home/user/.runpane-cloud';
const SCRIPT_TIMEOUT_SECONDS = 60;
const DOPPLER_TIMEOUT_MS = 30_000;
const OK_MARKER = 'RP_SECRETS';


type SecretsSourceArg =
  | { kind: 'env'; variable?: string }
  | { kind: 'file'; path: string }
  | { kind: 'doppler'; project: string; config: string };

interface SecretsArgs {
  sub: 'set' | 'list' | 'rm' | 'inspect' | 'enable' | 'disable';
  host: string;
  names: string[];
  source: SecretsSourceArg;
  json: boolean;
}

const SECRETS_USAGE = `Usage:
  runpane cloud secrets set <host> NAME [NAME...] [--from-env VAR | --from-file PATH|- | --from-doppler <project>/<config>] [--json]
      Resolve each value on this machine and store it for the Session's agents. With no --from-*,
      each NAME is read from this machine's environment variable of the same name.
      --from-env VAR and --from-file take one NAME; --from-doppler reads every NAME from that config
      with the local doppler CLI (never prd/prod/stg/staging/production configs).
  runpane cloud secrets list <host> [--json]      names only; values are never shown
  runpane cloud secrets inspect <host> [--json]   names and counts in every secrets store of the Session (these, the
                                                   doppler stand-in's, agent sign-in) and their files' modes; never a value
  runpane cloud secrets rm <host> NAME [NAME...] [--json]
New agent panels load the change at once; panels already open keep their old environment.

Laptop-free (the coordinator holds read-only Doppler tokens: runpane cloud coordinator doppler set):
  runpane cloud secrets enable <host> [--json]     install the doppler stand-in in an existing Session and fetch
                                                   its repository's .runpane/secrets.json names (new Sessions get it)
  runpane cloud secrets disable <host> [--json]    remove the stand-in and shred the Session's copy`;

export function parseSecretsArgs(argv: readonly string[]): SecretsArgs {
  const [sub, ...rest] = argv;
  if (sub !== 'set' && sub !== 'list' && sub !== 'rm' && sub !== 'inspect' && sub !== 'enable' && sub !== 'disable') throw new Error(SECRETS_USAGE);
  let json = false;
  let source: SecretsSourceArg | undefined;
  const positionals: string[] = [];
  const setSource = (next: SecretsSourceArg, flag: string) => {
    if (sub !== 'set') throw new Error(`${flag} only applies to runpane cloud secrets set.`);
    if (source) throw new Error('Give one value source: --from-env, --from-file or --from-doppler.');
    source = next;
  };
  for (let index = 0; index < rest.length; index++) {
    const raw = rest[index];
    const separator = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = separator === -1 ? raw : raw.slice(0, separator);
    const takeValue = (): string => {
      const value = separator === -1 ? rest[++index] : raw.slice(separator + 1);
      if (!value || (value.startsWith('-') && value !== '-')) throw new Error(`${flag} requires a value.`);
      return value;
    };
    if (flag === '--json') json = true;
    else if (flag === '--from-env') setSource({ kind: 'env', variable: takeValue() }, flag);
    else if (flag === '--from-file') setSource({ kind: 'file', path: takeValue() }, flag);
    else if (flag === '--from-doppler') {
      const value = takeValue();
      const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(value);
      if (!match) throw new Error('--from-doppler takes <project>/<config>, e.g. my-app/dev.');
      setSource({ kind: 'doppler', project: match[1], config: match[2] }, flag);
    } else if (raw.startsWith('-')) throw new Error(`Unknown option for runpane cloud secrets ${sub}: ${raw}\n\n${SECRETS_USAGE}`);
    else positionals.push(raw);
  }
  const [host, ...names] = positionals;
  if (!host) throw new Error(SECRETS_USAGE);
  const takesNames = sub === 'set' || sub === 'rm';
  if (!takesNames && names.length > 0) throw new Error(SECRETS_USAGE);
  if (takesNames && names.length === 0) throw new Error(`runpane cloud secrets ${sub} needs at least one NAME.\n\n${SECRETS_USAGE}`);
  const resolved = source ?? { kind: 'env' };
  if ((resolved.kind === 'file' || (resolved.kind === 'env' && resolved.variable)) && names.length !== 1) {
    throw new Error(`--from-${resolved.kind} gives one value; set one NAME at a time with it.`);
  }
  return { sub, host, names: [...new Set(names)], source: resolved, json };
}

// ---------------------------------------------------------------- policy

/** The pattern that denies `name`, or null. Built-in patterns first, then the user's. */
export function deniedBy(name: string, userDenyList: readonly string[] = []): string | null {
  return matchingPattern(name, [...BUILT_IN_DENY_LIST, ...userDenyList]);
}

/** Refuses a bad or denied NAME (and, for --from-env/--from-doppler, the name read on this machine). */
export function checkSecretName(name: string, userDenyList: readonly string[] = []): void {
  if (!SECRET_NAME_PATTERN.test(name)) throw new Error(`${name} is not a valid environment variable name (letters, digits and _; not starting with a digit).`);
  const denied = deniedBy(name, userDenyList);
  if (denied) throw new Error(`Refusing ${name}: it matches the deny-list pattern ${denied}. Production, infrastructure and secret-manager credentials never enter a cloud Session.`);
  const reserved = reservedBy(name);
  if (reserved) throw new Error(`Refusing ${name}: the shell or Pane sets it (${reserved}); a secret must not override it.`);
}

export function checkDopplerConfig(config: string): void {
  if (isDeniedConfig(config, DENIED_DOPPLER_CONFIGS)) {
    throw new Error(`Refusing Doppler config ${config}: staging and production configs never feed a cloud Session. Use a dev config.`);
  }
}

// ---------------------------------------------------------------- sources (all resolved on this machine)

/** Where a secret's value comes from. Implementations run on the laptop; values never leave this process except in the staged file. */
interface SecretSource {
  /** For messages: says where values come from, never what they are. */
  readonly label: string;
  /** The name read on this machine for `name` (checked against the deny-list too). */
  sourceName(name: string): string | null;
  resolve(name: string): Promise<string>;
}

/** Removes the one trailing newline that files, stdin and `doppler --plain` usually end with. */
function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, '');
}

function envSource(env: NodeJS.ProcessEnv, variable?: string): SecretSource {
  return {
    label: variable ? `environment variable ${variable}` : 'environment variables of the same names',
    sourceName: (name) => variable ?? name,
    async resolve(name) {
      const from = variable ?? name;
      const value = env[from];
      if (value === undefined) throw new Error(`${from} is not set in this shell's environment.`);
      return value;
    },
  };
}

function fileSource(filePath: string, deps: CloudDeps): SecretSource {
  return {
    label: filePath === '-' ? 'stdin' : `file ${filePath}`,
    sourceName: () => null,
    resolve: async () => stripTrailingNewline(await deps.readSecretFile(filePath)),
  };
}

function dopplerSource(project: string, config: string, deps: CloudDeps): SecretSource {
  return {
    label: `Doppler ${project}/${config}`,
    sourceName: (name) => name,
    async resolve(name) {
      if (!deps.runLocal) throw new Error('--from-doppler is not available in this build.');
      let result: { exitCode: number | null; stdout: string; stderr: string };
      try {
        result = await deps.runLocal('doppler', ['secrets', 'get', name, '--plain', '--project', project, '--config', config], DOPPLER_TIMEOUT_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(/ENOENT/u.test(message) ? 'The doppler CLI is not installed on this machine.' : `doppler failed for ${name}: ${message}`);
      }
      if (result.exitCode !== 0) {
        // stderr is Doppler's error text; stdout (the value, if any) is never shown.
        const detail = result.stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';
        throw new Error(`doppler could not read ${name} from ${project}/${config} (exit ${String(result.exitCode)})${detail ? `: ${detail}` : ''}.`);
      }
      return stripTrailingNewline(result.stdout);
    },
  };
}

function createSource(source: SecretsSourceArg, deps: CloudDeps): SecretSource {
  switch (source.kind) {
    case 'env': return envSource(deps.env, source.variable);
    case 'file': return fileSource(source.path, deps);
    case 'doppler':
      checkDopplerConfig(source.config);
      return dopplerSource(source.project, source.config, deps);
  }
}

// ---------------------------------------------------------------- the sandbox side

const LOADER_BEGIN = '# >>> runpane cloud secrets >>>';
const LOADER_END = '# <<< runpane cloud secrets <<<';

/**
 * The script that applies a change inside the sandbox. It reads values only from the staged file,
 * writes both files in place (boat restores can truncate renamed files, so no mv), installs the
 * loader once, shreds the staged file and prints the stored names.
 */
function secretsScript(change: { stagedPath?: string; remove?: readonly string[] }): string {
  for (const name of change.remove ?? []) {
    if (!SECRET_NAME_PATTERN.test(name)) throw new Error(`invalid name ${name}`);
  }
  const staged = change.stagedPath ? JSON.stringify(change.stagedPath.replace(/^\/home\/user\//u, '')) : 'None';
  const loader = [
    LOADER_BEGIN,
    '# Environment for agents in this cloud Session; manage it with `runpane cloud secrets` (values are not in this file).',
    '[ -r "$HOME/.runpane-cloud/secrets.env" ] && . "$HOME/.runpane-cloud/secrets.env"',
    LOADER_END,
  ].join('\n');
  return `set -e
python3 - <<'PY'
import json, os, subprocess
home = os.path.expanduser('~')
state = os.path.join(home, '.runpane-cloud')
os.makedirs(state, mode=0o700, exist_ok=True)
os.chmod(state, 0o700)
os.umask(0o077)
store = os.path.join(state, 'secrets.json')
envfile = os.path.join(state, 'secrets.env')

def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())

def quote(value):
    return "'" + value.replace("'", "'\\\\''") + "'"

current = json.load(open(store)) if os.path.exists(store) else {}
staged = ${staged}
removed = []
if staged is not None:
    staged = os.path.join(home, staged)
    try:
        current.update(json.load(open(staged))['set'])
    finally:
        if subprocess.run(['shred', '-u', staged], capture_output=True).returncode != 0 and os.path.exists(staged):
            os.remove(staged)
for name in ${JSON.stringify(change.remove ?? [])}:
    if current.pop(name, None) is not None:
        removed.append(name)
if staged is not None or removed:
    write_private(store, json.dumps(current, sort_keys=True))
    write_private(envfile, '# Written by runpane cloud secrets; do not edit.\\n' + ''.join('export %s=%s\\n' % (name, quote(current[name])) for name in sorted(current)))

loader = ${JSON.stringify(loader)}
for rc in ('.bashrc', '.zshenv'):
    path = os.path.join(home, rc)
    text = open(path).read() if os.path.exists(path) else ''
    if ${JSON.stringify(LOADER_BEGIN)} in text:
        continue
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    with os.fdopen(fd, 'w') as f:
        f.write(loader + '\\n' + text)
print(${JSON.stringify(OK_MARKER)} + ' ' + json.dumps({'names': sorted(current), 'removed': removed}))
PY
`;
}

const sandboxOutcomeSchema = boundary.object({
  names: boundary.array(boundary.string),
  removed: boundary.array(boundary.string),
});

interface SandboxOutcome {
  names: string[];
  removed: string[];
}

async function runInSandbox(handle: SandboxHandle, script: string, what: string): Promise<SandboxOutcome> {
  const result = await handle.runScript(script, { timeoutSeconds: SCRIPT_TIMEOUT_SECONDS });
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith(`${OK_MARKER} `));
  if (result.exitCode !== 0 || !line) {
    // The script never prints values, so its stderr (a Python traceback, at worst) is safe to show.
    const detail = result.stderr.trim().split('\n').slice(-1)[0] ?? '';
    throw new Error(`${what} failed in the sandbox (exit ${String(result.exitCode)})${detail ? `: ${detail}` : ''}.`);
  }
  return decodeBoundary(JSON.parse(line.slice(OK_MARKER.length + 1)), sandboxOutcomeSchema);
}

// ---------------------------------------------------------------- the command

export async function runSecretsCommand(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const args = parseSecretsArgs(argv);
  const settings = await deps.store.readSettings();
  const userDenyList = settings.secretsDenyList ?? [];

  // Policy and values first, all on this machine: nothing reaches the sandbox if any NAME is refused.
  let values: Record<string, string> | undefined;
  if (args.sub === 'set') {
    const source = createSource(args.source, deps);
    for (const name of args.names) {
      checkSecretName(name, userDenyList);
      const from = source.sourceName(name);
      if (from && from !== name) checkSecretName(from, userDenyList);
    }
    values = {};
    for (const name of args.names) {
      const value = await source.resolve(name);
      if (value.length === 0) throw new Error(`${name} is empty in ${source.label}; nothing was stored.`);
      if (value.includes('\0')) throw new Error(`${name} contains a NUL byte, which an environment variable cannot hold.`);
      values[name] = value;
    }
  } else if (args.sub === 'rm') {
    for (const name of args.names) {
      if (!SECRET_NAME_PATTERN.test(name)) throw new Error(`${name} is not a valid environment variable name.`);
    }
  }

  const record = findHost(await deps.store.listHosts(), args.host);
  const handle = await runningSandbox(record, deps);
  const host = record.profile.cloud.hostname;

  if (args.sub === 'enable') {
    if (!(await coordinatorSecretsEnabled(deps))) {
      throw new Error('The coordinator has no Doppler secrets service yet: run runpane cloud coordinator doppler set --project <p> --config <c> first.');
    }
    if (!record.meta.brokerRepos?.length) {
      deps.stderr(`runpane cloud: ${host} has no GitHub broker repository, so the coordinator has no manifest to read for it (runpane cloud github connect ${host} --repo <owner/name> --broker).`);
    }
    const outcome = await enableSessionSecrets(handle, host);
    if (args.json) deps.stdout(JSON.stringify({ ok: outcome.ready && !outcome.fetchError, host, ...outcome }, null, 2));
    else {
      deps.stdout(`${host}: ${describeSecretsOutcome(outcome)}.`);
      if (outcome.warning) deps.stderr(`runpane cloud: ${outcome.warning}`);
    }
    return outcome.ready && !outcome.fetchError ? 0 : 1;
  }

  if (args.sub === 'disable') {
    await disableSessionSecrets(handle);
    if (args.json) deps.stdout(JSON.stringify({ ok: true, host, removed: true }, null, 2));
    else deps.stdout(`${host}: the doppler stand-in, its boot refresh and the Session's stored copy are removed.`);
    return 0;
  }

  if (args.sub === 'list') {
    const outcome = await runInSandbox(handle, secretsScript({}), 'Listing the secrets');
    const denied = outcome.names.filter((name) => deniedBy(name, userDenyList));
    if (args.json) {
      deps.stdout(JSON.stringify({ ok: true, host, names: outcome.names, denied }, null, 2));
    } else if (outcome.names.length === 0) {
      deps.stdout(`${host} has no agent secrets. Add one with runpane cloud secrets set ${host} NAME.`);
    } else {
      deps.stdout(`${host} agent secrets (names only):`);
      for (const name of outcome.names) deps.stdout(`  ${name}${denied.includes(name) ? '   (now on the deny-list: remove it with runpane cloud secrets rm)' : ''}`);
    }
    return 0;
  }

  if (args.sub === 'inspect') return runSecretsInspect(handle, host, { json: args.json, userDenyList }, deps);

  if (args.sub === 'rm') {
    const outcome = await runInSandbox(handle, secretsScript({ remove: args.names }), 'Removing the secrets');
    const missing = args.names.filter((name) => !outcome.removed.includes(name));
    if (args.json) {
      deps.stdout(JSON.stringify({ ok: true, host, removed: outcome.removed, notFound: missing, names: outcome.names }, null, 2));
    } else {
      if (outcome.removed.length > 0) deps.stdout(`Removed from ${host}: ${outcome.removed.join(', ')}. New agent panels no longer see them; open panels keep them until they restart.`);
      if (missing.length > 0) deps.stdout(`Not set on ${host}: ${missing.join(', ')}.`);
    }
    return 0;
  }

  const stagedPath = `${STATE_DIR}/secrets.stage-${randomBytes(6).toString('hex')}.json`;
  await handle.writeFile(stagedPath, `${JSON.stringify({ set: values })}\n`);
  let outcome: SandboxOutcome;
  try {
    outcome = await runInSandbox(handle, secretsScript({ stagedPath }), 'Storing the secrets');
  } catch (error) {
    // The script shreds the staged file itself; this covers a script that never ran.
    await handle.runScript(`shred -u ${stagedPath} 2>/dev/null || rm -f ${stagedPath}`, { timeoutSeconds: 30 }).catch(() => undefined);
    throw error;
  }
  const set = Object.keys(values ?? {});
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, host, set, names: outcome.names }, null, 2));
  } else {
    deps.stdout(`Stored on ${host}: ${set.join(', ')} (values not shown). New agent panels see them at once; panels already open keep their old environment.`);
  }
  return 0;
}

async function runningSandbox(record: CloudHostRecord, deps: CloudDeps): Promise<SandboxHandle> {
  const provider = await hostProvider(deps, await deps.store.readCredentials(), record);
  const sandboxId = record.profile.cloud.sandboxId;
  const sandbox = await provider.get(sandboxId);
  const host = record.profile.cloud.hostname;
  if (sandbox.state !== 'running') {
    throw new Error(`${host} is ${sandbox.providerState}; secrets live inside the Session, so wake it first: runpane cloud wake ${host}.`);
  }
  return provider.handle(sandboxId);
}
