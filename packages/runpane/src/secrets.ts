import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary, type BoundarySchema, type JsonObject } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { confirmMutation } from './daemonActions';
import { invokeDaemon, PaneDaemonClientError } from './daemonClient';
import { RunpaneError } from './errors';
import { runForwardingSignals, type ChildEnd } from './forwardedChild';
import { describeNotifyResult, notifyCallerFields, notifyResultSchema, type NotifyRequest, type NotifyResult } from './notify';

// `runpane secrets`: Pane secrets are values only `secrets exec` hands out, to a child process's
// environment. Nothing here prints, logs or puts a value in an error message.

interface SecretSummary {
  project: string;
  name: string;
  updatedAt: string;
  machine: string;
  /** Present on a login: where `browser fill` may fill it. */
  sites?: string[];
}

const secretSummarySchema: BoundarySchema<SecretSummary> = boundary.object({
  project: boundary.string,
  name: boundary.string,
  updatedAt: boundary.string,
  machine: boundary.string,
  sites: boundary.optional(boundary.array(boundary.string)),
});
const referenceSummarySchema = boundary.object({
  project: boundary.string,
  name: boundary.string,
  reference: boundary.string,
  updatedAt: boundary.string,
  machine: boundary.string,
  sites: boundary.optional(boundary.array(boundary.string)),
});
const leaseSummarySchema = boundary.object({
  id: boundary.string,
  project: boundary.string,
  names: boundary.array(boundary.string),
  grantedAt: boundary.string,
  expiresAt: boundary.string,
  requestedBy: boundary.string,
  grantedOn: boundary.string,
  memoryOnly: boundary.boolean,
});
// references and leases are optional so an older Pane, which has neither, still decodes.
const listResultSchema = boundary.object({
  ok: boundary.literal(true),
  secrets: boundary.array(secretSummarySchema),
  references: boundary.optional(boundary.array(referenceSummarySchema)),
  leases: boundary.optional(boundary.array(leaseSummarySchema)),
  storage: boundary.object({ kind: boundary.enumeration('keychain', 'file'), encrypted: boundary.boolean }),
});
const setResultSchema = boundary.object({ ok: boundary.literal(true), replaced: boundary.boolean, secret: secretSummarySchema });
const deleteResultSchema = boundary.object({
  ok: boundary.literal(true),
  deleted: boundary.object({ project: boundary.string, name: boundary.string }),
});
const resolveResultSchema = boundary.object({ ok: boundary.literal(true), values: boundary.jsonObject });
const leaseEndResultSchema = boundary.object({ ok: boundary.literal(true), ended: boundary.boolean });

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NOT_FOUND_NEXT = 'Run `runpane secrets request`, or open Pane on a desktop connected to this machine so it syncs.';
const UNAVAILABLE_NEXT = 'Ask the person to save it in Pane under Settings > Secrets, then run your command with `runpane secrets exec`. Do not ask them to paste it into the chat.';
const LEASE_UNAVAILABLE_NEXT = 'Ask the person to start the lease in Pane under Settings > Secrets, then run your command with `runpane secrets exec`.';
const LEASE_UNSUPPORTED = 'This Pane doesn\'t support leases yet.';

function invalid(message: string, next: string): RunpaneError {
  return new RunpaneError('SECRET_INVALID', message, next);
}

/**
 * Pane secrets are the owner's. Pane sets PANE_TEAMMATE_LOGIN on a teammate's `workspace exec`, and
 * every secrets command refuses it before asking Pane for anything.
 */
export function refuseTeammate(action: string, env: NodeJS.ProcessEnv = process.env): void {
  const teammate = env.PANE_TEAMMATE_LOGIN;
  if (!teammate) return;
  throw new RunpaneError(
    'SECRET_OWNER_REQUIRED',
    `Only this computer's owner can use its Pane secrets, so ${teammate} cannot ${action}. Nothing was read or changed.`,
    'Ask the owner to do it on their own devices.',
  );
}

function requireFlag(parsed: ParsedArgs, value: string | undefined, flag: string, outcome: string): string {
  if (value?.trim()) return value;
  throw invalid(`runpane ${parsed.command} requires ${flag}. ${outcome}`, `See the options with \`runpane help ${parsed.command}\`.`);
}

function loginText(sites: readonly string[] | undefined): string {
  return sites ? `  login for ${sites.join(', ')}` : '';
}

export async function runSecretsList(parsed: ParsedArgs): Promise<number> {
  refuseTeammate('list them');
  const request = parsed.project === undefined ? {} : { project: parsed.project };
  const result = await invokeDaemon('runpane:secrets:list', [request], listResultSchema, { paneDir: parsed.paneDir });
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const references = result.references ?? [];
  if (result.secrets.length === 0 && references.length === 0) {
    console.log(`No Pane secrets${parsed.project === undefined ? '' : ` in project ${parsed.project}`} on this machine yet.`);
  }
  for (const secret of result.secrets) {
    console.log(`${secret.project}/${secret.name}  set ${secret.updatedAt} on ${secret.machine}${loginText(secret.sites)}`);
  }
  for (const reference of references) {
    const until = (result.leases ?? [])
      .filter((lease) => lease.project === reference.project && lease.names.includes(reference.name))
      .map((lease) => lease.expiresAt)
      .sort()
      .at(-1);
    console.log(`${reference.project}/${reference.name}  from 1Password (${reference.reference})  ${until ? `leased until ${until}` : 'no lease'}${loginText(reference.sites)}`);
  }
  if (result.storage.kind === 'file' && !result.storage.encrypted) {
    console.log('This machine has no OS keyring, so its secret values are stored unencrypted in a file only you can read.');
  }
  return 0;
}

export async function runSecretsSet(parsed: ParsedArgs): Promise<number> {
  refuseTeammate('save one');
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
  refuseTeammate('delete one');
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
  refuseTeammate('run secrets exec');
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

/** Runs the child with stdio passed through and signals forwarded. */
async function runChild(command: string[], env: NodeJS.ProcessEnv): Promise<ChildEnd> {
  const [file, args, windowsVerbatimArguments] = windowsBatchCommand(command, env) ?? [command[0], command.slice(1), false];
  const result = await runForwardingSignals(file, args, { env, windowsVerbatimArguments });
  if ('error' in result) {
    throw new RunpaneError(
      'ERR_SECRETS_EXEC_FAILED',
      `runpane secrets exec could not start ${command[0]} (${result.error}). Nothing was run.`,
      'Check that the command is installed and on PATH. For a shell command, run it through a shell: `-- sh -c \'...\'`, or `-- cmd /c ...` on Windows.',
    );
  }
  return result;
}

/**
 * On Windows, npm, pnpm and npx are .cmd shims, which only cmd.exe can run. Finds the command the
 * way cmd.exe does (the current directory, then PATH, with each PATHEXT extension) and, for a .cmd
 * or .bat file, returns a cmd.exe invocation that passes every argument literally. Keep the cmd quoting
 * rules aligned with `quoteShellWord(word, 'cmd')` in main/src/services/agentChat/hostCommand.ts.
 */
export function windowsBatchCommand(command: string[], env: NodeJS.ProcessEnv): [string, string[], boolean] | undefined {
  if (process.platform !== 'win32') return undefined;
  const read = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] ?? '';
  const extensions = (read('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const [name] = command;
  const names = extensions.some((extension) => name.toUpperCase().endsWith(extension.toUpperCase())) ? [name] : extensions.map((extension) => name + extension);
  const directories = /[\\/]/.test(name) ? [''] : [process.cwd(), ...read('PATH').split(';').filter(Boolean)];
  const found = directories.flatMap((directory) => names.map((candidate) => path.resolve(directory, candidate)))
    .find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
  if (!found || !/\.(cmd|bat)$/i.test(found)) return undefined;
  const words = [found, ...command.slice(1)];
  // oxlint-disable-next-line no-control-regex -- control characters cannot be passed through cmd literally.
  if (words.some((word) => /[%!"\x00-\x1f\x7f]/.test(word))) {
    throw invalid(
      `${name} is a Windows batch file, and cmd.exe cannot pass %, !, " or control characters in its arguments literally. Nothing was run.`,
      'Remove those characters from the arguments, or run the program the batch file starts directly.',
    );
  }
  return ['cmd.exe', ['/d', '/s', '/c', `"${words.map((word) => `"${word}"`).join(' ')}"`], true];
}

/** `runpane secrets request`: a secret Notify card. The answer is saved by Pane; only saved or declined comes back. */
export async function runSecretsRequest(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  refuseTeammate('ask for one', env);
  const outcome = 'Nothing was shown to the person.';
  const project = requireFlag(parsed, parsed.project, '--project', outcome);
  const name = requireFlag(parsed, parsed.name, '--name', outcome);
  const title = requireFlag(parsed, parsed.title, '--title', outcome);
  const reason = requireFlag(parsed, parsed.reason, '--reason', outcome);
  const { caller, timing } = notifyCallerFields(env, process.cwd());
  const request: NotifyRequest = { ui: 'secret', title, context: reason, secret: { project, name }, ...timing, caller };
  const result = await askOnCard(parsed, request, UNAVAILABLE_NEXT);
  console.log(parsed.json ? JSON.stringify(result, null, 2) : describeNotifyResult(result));
  return 0;
}

/** Asks Pane's runpane:notify channel and waits; Pane not running or too old reads as unavailable. */
async function askOnCard(parsed: ParsedArgs, request: NotifyRequest, unavailableNext: string): Promise<NotifyResult> {
  try {
    return await invokeDaemon('runpane:notify', [request], notifyResultSchema, { paneDir: parsed.paneDir, timeoutMs: Infinity });
  } catch (error) {
    if (!(error instanceof PaneDaemonClientError)) throw error;
    if (error.connectionFailure) return { unavailable: 'Pane is not running.', next: unavailableNext };
    if (error.code === 'ERR_UNKNOWN_CHANNEL') return { unavailable: 'This Pane doesn\'t support notify yet.', next: unavailableNext };
    throw error;
  }
}

/**
 * `runpane secrets lease`: a lease card for 1Password-backed secrets. The person starts the lease on
 * their computer; only the lease's id, end time and machines come back, never a value.
 */
export async function runSecretsLease(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  refuseTeammate('ask for a lease', env);
  const outcome = 'Nothing was shown to the person.';
  const project = requireFlag(parsed, parsed.project, '--project', outcome);
  const names = [...new Set(parsed.secretNames ?? [])];
  if (names.length === 0) {
    throw invalid(`runpane secrets lease needs the names of the secrets to lease. ${outcome}`, `Run \`runpane secrets lease --project ${project} <NAME>...\`.`);
  }
  for (const name of names) {
    if (!ENV_NAME.test(name)) {
      throw invalid(`"${name}" is not a valid secret name: use letters, digits and underscores, not starting with a digit. ${outcome}`, 'See the secret names with `runpane secrets list`.');
    }
  }
  const { caller, timing } = notifyCallerFields(env, process.cwd());
  const title = `Lease ${names.length} secret${names.length === 1 ? '' : 's'}`;
  const reason = parsed.reason?.trim() ? { context: parsed.reason } : {};
  const request: NotifyRequest = { ui: 'approve', title, ...reason, lease: { project, names }, ...timing, caller };
  const result = await askOnCard(parsed, request, LEASE_UNAVAILABLE_NEXT);
  console.log(parsed.json ? JSON.stringify(result, null, 2) : describeLeaseResult(result));
  return 0;
}

function describeLeaseResult(result: NotifyResult): string {
  if ('status' in result && result.status === 'leased') {
    return `Leased ${result.project}/${result.names.join(', ')} until ${result.expiresAt} on ${result.machines.join(', ')}. Lease ${result.leaseId}. `
      + `Use them with \`runpane secrets exec --project ${result.project} -- <command>\`, and logins with \`runpane browser fill\`.`;
  }
  if (('status' in result && result.status === 'declined') || ('approved' in result && !result.approved)) return 'The person declined the lease.';
  // A Pane from before leases shows a plain approve card and starts nothing.
  if ('approved' in result) return `${LEASE_UNSUPPORTED} Nothing was leased. Update Pane.`;
  return describeNotifyResult(result);
}

/** `runpane secrets lease end`: ends a lease on this machine. It only removes access, so an agent may do it. */
export async function runSecretsLeaseEnd(parsed: ParsedArgs): Promise<number> {
  refuseTeammate('end a lease');
  const leaseId = requireFlag(parsed, parsed.leaseId, '--id', 'Nothing was ended.');
  await confirmMutation(parsed);
  let result;
  try {
    result = await invokeDaemon('runpane:secrets:lease:end', [{ leaseId }], leaseEndResultSchema, { paneDir: parsed.paneDir });
  } catch (error) {
    if (error instanceof PaneDaemonClientError && error.code === 'ERR_UNKNOWN_CHANNEL') {
      throw new RunpaneError('SECRET_LEASE_UNSUPPORTED', `${LEASE_UNSUPPORTED} Nothing was ended.`, 'Update Pane.');
    }
    throw error;
  }
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.ended ? `Ended lease ${leaseId}.` : `No lease ${leaseId} here; it may have ended already.`);
  return 0;
}
