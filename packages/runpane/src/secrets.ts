import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary, type BoundarySchema, type JsonObject } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { confirmMutation } from './daemonActions';
import { invokeDaemon, PaneDaemonClientError } from './daemonClient';
import { RunpaneError } from './errors';
import { describeNotifyResult, notifyCallerFields, notifyResultSchema, type NotifyRequest, type NotifyResult } from './notify';

// `runpane secrets`: Pane secrets are values only `secrets exec` hands out, to a child process's
// environment. Nothing here prints, logs or puts a value in an error message.

interface SecretSummary {
  project: string;
  name: string;
  updatedAt: string;
  machine: string;
}

const secretSummarySchema: BoundarySchema<SecretSummary> = boundary.object({
  project: boundary.string,
  name: boundary.string,
  updatedAt: boundary.string,
  machine: boundary.string,
});
const listResultSchema = boundary.object({
  ok: boundary.literal(true),
  secrets: boundary.array(secretSummarySchema),
  storage: boundary.object({ kind: boundary.enumeration('keychain', 'file'), encrypted: boundary.boolean }),
});
const setResultSchema = boundary.object({ ok: boundary.literal(true), replaced: boundary.boolean, secret: secretSummarySchema });
const deleteResultSchema = boundary.object({
  ok: boundary.literal(true),
  deleted: boundary.object({ project: boundary.string, name: boundary.string }),
});
const resolveResultSchema = boundary.object({ ok: boundary.literal(true), values: boundary.jsonObject });

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NOT_FOUND_NEXT = 'Run `runpane secrets request`, or open Pane on a desktop connected to this machine so it syncs.';
const UNAVAILABLE_NEXT = 'Ask the person to save it in Pane under Settings > Secrets, then run your command with `runpane secrets exec`. Do not ask them to paste it into the chat.';

function invalid(message: string, next: string): RunpaneError {
  return new RunpaneError('SECRET_INVALID', message, next);
}

function requireFlag(parsed: ParsedArgs, value: string | undefined, flag: string, outcome: string): string {
  if (value?.trim()) return value;
  throw invalid(`runpane ${parsed.command} requires ${flag}. ${outcome}`, `See the options with \`runpane help ${parsed.command}\`.`);
}

export async function runSecretsList(parsed: ParsedArgs): Promise<number> {
  const request = parsed.project === undefined ? {} : { project: parsed.project };
  const result = await invokeDaemon('runpane:secrets:list', [request], listResultSchema, { paneDir: parsed.paneDir });
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.secrets.length === 0) {
    console.log(`No Pane secrets${parsed.project === undefined ? '' : ` in project ${parsed.project}`} on this machine yet.`);
  }
  for (const secret of result.secrets) {
    console.log(`${secret.project}/${secret.name}  set ${secret.updatedAt} on ${secret.machine}`);
  }
  if (result.storage.kind === 'file' && !result.storage.encrypted) {
    console.log('This machine has no OS keyring, so its secret values are stored unencrypted in a file only you can read.');
  }
  return 0;
}

export async function runSecretsSet(parsed: ParsedArgs): Promise<number> {
  const project = requireFlag(parsed, parsed.project, '--project', 'Nothing was saved.');
  const name = requireFlag(parsed, parsed.name, '--name', 'Nothing was saved.');
  if (process.stdin.isTTY) {
    throw new RunpaneError(
      'SECRET_STDIN_REQUIRED',
      'runpane secrets set reads the value from stdin, and stdin is a terminal. Nothing was saved.',
      `Pipe the value in, such as \`printf %s "$VALUE" | runpane secrets set --project ${project} --name ${name} --yes\`. To have the person enter it, use Settings > Secrets in Pane or \`runpane secrets request\`.`,
    );
  }
  await confirmMutation(parsed);
  const value = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (!value) throw invalid('The value on stdin is empty. Nothing was saved.', 'Pipe the secret\'s value to `runpane secrets set`.');
  const result = await invokeDaemon('runpane:secrets:set', [{ project, name, value }], setResultSchema, { paneDir: parsed.paneDir });
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.replaced ? 'Replaced' : 'Saved'} ${result.secret.project}/${result.secret.name}`);
  return 0;
}

export async function runSecretsDelete(parsed: ParsedArgs): Promise<number> {
  const project = requireFlag(parsed, parsed.project, '--project', 'Nothing was deleted.');
  const name = requireFlag(parsed, parsed.name, '--name', 'Nothing was deleted.');
  await confirmMutation(parsed);
  const result = await invokeDaemon('runpane:secrets:delete', [{ project, name }], deleteResultSchema, { paneDir: parsed.paneDir });
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Deleted ${result.deleted.project}/${result.deleted.name}`);
  return 0;
}

/** One variable the child gets: `target` set to secret `secret`'s value, or to the path of a file holding it. */
interface Injection {
  target: string;
  secret: string;
  file: boolean;
}

/** Every case counts: secrets sync across platforms, and Windows reads Path as PATH. */
function isReservedTarget(name: string): boolean {
  const key = name.toUpperCase();
  return key === 'PATH' || key === 'WORKTREE_PATH' || key.startsWith('PANE_');
}

function checkTargets(injections: readonly Injection[]): void {
  const seen = new Set<string>();
  for (const { target, secret } of injections) {
    if (!ENV_NAME.test(target)) {
      throw invalid(`"${target}" is not a valid variable name: use letters, digits and underscores, not starting with a digit. Nothing was run.`, 'See the naming rules with `runpane help secrets`.');
    }
    if (isReservedTarget(target)) {
      throw new RunpaneError(
        'SECRET_RESERVED_NAME',
        `${target} is set by Pane itself (PATH, WORKTREE_PATH and PANE_* are reserved), so runpane secrets exec does not set it. Nothing was run.`,
        `Inject it under another name, such as --env MY_${target.replace(/^PANE_/i, '')}=${secret}.`,
      );
    }
    const key = process.platform === 'win32' ? target.toUpperCase() : target;
    if (seen.has(key)) throw invalid(`${target} is set twice; give each variable one source. Nothing was run.`, 'Name each variable once across --only, --env and --file.');
    seen.add(key);
  }
}

/** What --only, --env and --file ask for; empty means every secret in the project. */
function requestedInjections(parsed: ParsedArgs): Injection[] {
  const injections = (parsed.only ?? []).map((name) => ({ target: name, secret: name, file: false }));
  for (const mapping of parsed.envArgs ?? []) {
    const match = /^([^=]+)=(.+)$/.exec(mapping);
    if (!match) {
      throw invalid(`--env must be VAR=NAME, such as --env STRIPE_API_KEY=STRIPE_SECRET_KEY; got "${mapping}". Nothing was run.`, 'Pass --env VAR=NAME to inject secret NAME as VAR.');
    }
    injections.push({ target: match[1], secret: match[2], file: false });
  }
  for (const name of parsed.secretFiles ?? []) injections.push({ target: name, secret: name, file: true });
  return injections;
}

async function resolveSecrets(parsed: ParsedArgs, project: string, names: string[] | undefined): Promise<Map<string, string>> {
  const request = names ? { project, names } : { project };
  const result = await invokeDaemon('runpane:secrets:resolve', [request], resolveResultSchema, { paneDir: parsed.paneDir });
  return readValues(result.values);
}

function readValues(values: JsonObject): Map<string, string> {
  const read = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    try {
      read.set(name, decodeBoundary(value, boundary.string));
    } catch {
      throw new RunpaneError('SECRET_UNREADABLE', `Pane returned secret ${name} in a form this runpane cannot read. Nothing was run.`, 'Compare the versions with `runpane doctor` and update the older one.');
    }
  }
  return read;
}

/**
 * `runpane secrets exec`: starts the command with the secrets in its environment, passes stdio
 * through, removes any --file files when it exits, and returns its exit code.
 */
export async function runSecretsExec(parsed: ParsedArgs): Promise<number> {
  const project = requireFlag(parsed, parsed.project, '--project', 'Nothing was run.');
  const command = parsed.execCommand ?? [];
  if (command.length === 0) {
    throw invalid('runpane secrets exec needs a command after --. Nothing was run.', `Run \`runpane secrets exec --project ${project} -- <command>\`.`);
  }
  const requested = requestedInjections(parsed);
  checkTargets(requested);
  const values = await resolveSecrets(parsed, project, requested.length > 0 ? [...new Set(requested.map((item) => item.secret))] : undefined);
  const injections = requested.length > 0 ? requested : [...values.keys()].map((name) => ({ target: name, secret: name, file: false }));
  if (injections.length === 0) {
    throw new RunpaneError('SECRET_NOT_FOUND', `No secrets in project ${project} on this machine yet. Nothing was run.`, NOT_FOUND_NEXT);
  }
  checkTargets(injections);
  for (const { secret } of injections) {
    if (!values.has(secret)) throw new RunpaneError('SECRET_NOT_FOUND', `No secret ${project}/${secret} on this machine yet. Nothing was run.`, NOT_FOUND_NEXT);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  let tempDir: string | undefined;
  let ended: ChildEnd;
  try {
    for (const { target, secret, file } of injections) {
      if (process.platform === 'win32') {
        for (const key of Object.keys(env)) if (key.toUpperCase() === target.toUpperCase()) delete env[key];
      }
      if (!file) {
        env[target] = values.get(secret);
        continue;
      }
      tempDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-secrets-'));
      const filePath = path.join(tempDir, secret);
      fs.writeFileSync(filePath, values.get(secret) ?? '', { mode: 0o600, flag: 'wx' });
      env[target] = filePath;
    }
    ended = await runChild(command, env);
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
  // Re-raise a signal that ended the child only after its files are gone.
  if (ended.signal) process.kill(process.pid, ended.signal);
  return ended.status ?? 1;
}

interface ChildEnd {
  status: number | null;
  signal: NodeJS.Signals | null;
}

/** Runs the child with signals forwarded the way handOffToManagedCli does. */
async function runChild(command: string[], env: NodeJS.ProcessEnv): Promise<ChildEnd> {
  // From a terminal, Ctrl-C and Ctrl-\ reach the child through the process group it shares with
  // this CLI, so forwarding them would deliver them twice. Without a terminal the child gets its
  // own group and every signal is forwarded once.
  const ownGroup = process.platform !== 'win32' && !process.stdin.isTTY;
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env, detached: ownGroup });
  const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
  const interrupt = (signal: NodeJS.Signals) => () => { if (ownGroup) forward(signal); };
  const handlers: Array<[NodeJS.Signals, () => void]> = [
    ['SIGINT', interrupt('SIGINT')],
    ['SIGQUIT', interrupt('SIGQUIT')],
    ['SIGTERM', () => forward('SIGTERM')],
    ['SIGHUP', () => forward('SIGHUP')],
  ];
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const result = await new Promise<ChildEnd | { error: string }>((resolve) => {
    child.once('error', (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? 'unknown error' }));
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if ('error' in result) {
    throw new RunpaneError(
      'ERR_SECRETS_EXEC_FAILED',
      `runpane secrets exec could not start ${command[0]} (${result.error}). Nothing was run.`,
      'Check that the command is installed and on PATH. For a shell command, run it through a shell: `-- sh -c \'...\'`, or `-- cmd /c ...` on Windows.',
    );
  }
  return result;
}

/** `runpane secrets request`: a secret Notify card. The answer is saved by Pane; only saved or declined comes back. */
export async function runSecretsRequest(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const outcome = 'Nothing was shown to the person.';
  const project = requireFlag(parsed, parsed.project, '--project', outcome);
  const name = requireFlag(parsed, parsed.name, '--name', outcome);
  const title = requireFlag(parsed, parsed.title, '--title', outcome);
  const reason = requireFlag(parsed, parsed.reason, '--reason', outcome);
  const { caller, timing } = notifyCallerFields(env, process.cwd());
  const request: NotifyRequest = { ui: 'secret', title, context: reason, secret: { project, name }, ...timing, caller };
  let result: NotifyResult;
  try {
    result = await invokeDaemon('runpane:notify', [request], notifyResultSchema, { paneDir: parsed.paneDir, timeoutMs: Infinity });
  } catch (error) {
    if (!(error instanceof PaneDaemonClientError)) throw error;
    if (error.connectionFailure) {
      result = { unavailable: 'Pane is not running.', next: UNAVAILABLE_NEXT };
    } else if (error.code === 'ERR_UNKNOWN_CHANNEL') {
      result = { unavailable: 'This Pane doesn\'t support notify yet.', next: UNAVAILABLE_NEXT };
    } else {
      throw error;
    }
  }
  console.log(parsed.json ? JSON.stringify(result, null, 2) : describeNotifyResult(result));
  return 0;
}
