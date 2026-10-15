import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { PaneError } from '../../../shared/paneError';

/** Generic-password items in the OS keychain, addressed by service and account. */
export interface Keychain {
  /** False where Pane has no keychain support; every call then throws `KEYCHAIN_UNSUPPORTED`. */
  readonly supported: boolean;
  read(service: string, account: string): Promise<string>;
  write(service: string, account: string, secret: string): Promise<void>;
  remove(service: string, account: string): Promise<void>;
}

interface SecurityResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `/usr/bin/security` with `args`, feeding `stdin`. Never rejects on a non-zero exit. */
export type SecurityRunner = (args: readonly string[], stdin?: string) => Promise<SecurityResult>;

// A keychain item another app owns makes macOS ask the user before Pane may read
// it; give them time to answer without holding a terminal open forever.
const SECURITY_TIMEOUT_MS = 60_000;

const runSecurity: SecurityRunner = (args, stdin) => new Promise(resolve => {
  const child = execFile('/usr/bin/security', [...args], { timeout: SECURITY_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = error ? Number(error.code) || 1 : 0;
    const timedOut = error?.killed ? 'Timed out waiting for the keychain.' : '';
    resolve({ code, stdout, stderr: timedOut || stderr });
  });
  child.stdin?.end(stdin ?? '');
});

/**
 * The password from `security find-generic-password -g` output, which prints it on
 * stderr as `password: "text"` or, for non-ASCII or escaped text, `password: 0xHEX  "…"`.
 */
export function parseSecurityPassword(stderr: string): string | null {
  const line = stderr.split('\n').find(candidate => candidate.startsWith('password:'));
  if (line === undefined) return null;
  const hex = /^password: 0x([0-9A-Fa-f]*)/.exec(line);
  if (hex) return Buffer.from(hex[1], 'hex').toString('utf8');
  const first = line.indexOf('"');
  const last = line.lastIndexOf('"');
  return first >= 0 && last > first ? line.slice(first + 1, last) : '';
}

/** Quote `value` as one argument for `security -i`, which reads shell-like command lines. */
function quoteSecurityArg(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('A keychain service or account cannot contain a line break.');
  return `"${value.replace(/["\\]/g, match => `\\${match}`)}"`;
}

/** The first line of a failed `security` call, which names the keychain error. Never contains a password. */
function securityFailure(result: SecurityResult): string {
  const message = result.stderr.split('\n').map(line => line.trim()).find(Boolean) ?? `security exited with code ${result.code}`;
  return message.replace(/^security: /, '').replace(/^SecKeychain\w+: /, '');
}

/** The macOS login keychain, through the `security` command-line tool. */
export function macKeychain(run: SecurityRunner = runSecurity): Keychain {
  return {
    supported: true,
    async read(service, account) {
      const result = await run(['find-generic-password', '-s', service, '-a', account, '-g']);
      const password = result.code === 0 ? parseSecurityPassword(result.stderr) : null;
      if (password === null) throw new Error(securityFailure(result));
      return password;
    },
    async write(service, account, secret) {
      // Through stdin and as hex, so the secret never appears in a process list
      // and needs no quoting.
      const hex = Buffer.from(secret, 'utf8').toString('hex');
      const result = await run(['-i'], `add-generic-password -U -s ${quoteSecurityArg(service)} -a ${quoteSecurityArg(account)} -X ${hex}\n`);
      if (result.code !== 0) throw new Error(securityFailure(result));
    },
    async remove(service, account) {
      const result = await run(['delete-generic-password', '-s', service, '-a', account]);
      if (result.code !== 0) throw new Error(securityFailure(result));
    },
  };
}

/** The refusal for keychain use on a host without keychain support. */
export function keychainUnsupportedError(platform: string = process.platform): PaneError {
  return new PaneError(
    'KEYCHAIN_UNSUPPORTED',
    `Pane can use keychain-backed environment variables only on macOS, and this host runs ${platform}.`,
    'Give the variable a plain value in Project Settings → Environment Variables on this host.',
  );
}

function unsupportedKeychain(platform: string): Keychain {
  const refuse = async (): Promise<never> => {
    throw keychainUnsupportedError(platform);
  };
  return { supported: false, read: refuse, write: refuse, remove: refuse };
}

/** The keychain of the host Pane runs on. */
export function systemKeychain(platform: string = process.platform): Keychain {
  return platform === 'darwin' ? macKeychain() : unsupportedKeychain(platform);
}

/**
 * Service of the keychain items Pane creates for typed secrets. A data directory
 * other than the default (a dev build's `PANE_DIR`, say) gets its own service, so
 * two Pane instances never share or delete each other's items.
 */
export function paneKeychainService(appDirectory: string, homeDirectory: string = os.homedir()): string {
  return path.resolve(appDirectory) === path.join(homeDirectory, '.pane') ? 'Pane' : `Pane (${path.resolve(appDirectory)})`;
}

/** Account of the keychain item Pane creates for `key` in project `projectId`. */
export function paneKeychainAccount(projectId: number, key: string): string {
  return `${projectId}:${key}`;
}
