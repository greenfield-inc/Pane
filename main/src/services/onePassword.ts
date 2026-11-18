import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { PaneError } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { findExecutableInPath, getShellPath } from '../utils/shellPath';

/** What one run of `op` gave back. stdout can hold values: callers never log it or put it in an error. */
interface OpOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type OpRunner = (args: readonly string[], stdin: string) => Promise<OpOutput>;

/** 1Password may wait on Touch ID or Windows Hello: give the person time to answer. */
const OP_TIMEOUT_MS = 3 * 60 * 1000;
const OP_INSTALL_NEXT = 'Install the 1Password CLI (op), and in the 1Password app turn on Settings › Developer › Integrate with 1Password CLI. Then try again.';

function opMissing(): PaneError {
  return new PaneError('ONEPASSWORD_CLI_MISSING', 'Pane could not find the 1Password CLI (op) on this computer. Nothing was read.', OP_INSTALL_NEXT);
}

/** `op` from the login shell's PATH, run without a terminal. */
function systemOpRunner(): OpRunner {
  return (args, stdin) => new Promise((resolve, reject) => {
    const executable = findExecutableInPath(process.platform === 'win32' ? 'op.exe' : 'op');
    if (!executable) {
      reject(opMissing());
      return;
    }
    const child = execFile(executable, [...args], {
      timeout: OP_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PATH: getShellPath() },
    }, (error, stdout, stderr) => {
      // A non-zero exit carries its exit code; anything else (op missing, a timeout) never ran to the end.
      if (error && !Number.isInteger(error.code)) {
        reject(error.code === 'ENOENT' ? opMissing() : new PaneError('ONEPASSWORD_FAILED', `The 1Password CLI did not finish: ${error.killed ? 'it timed out waiting for approval' : error.message}. Nothing was read.`, 'Unlock 1Password and approve the prompt, then try again.'));
        return;
      }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
    child.stdin?.end(stdin);
  });
}

/** op's own message, for an error. op never prints a value on stderr. */
function opReason(output: OpOutput): string {
  const line = output.stderr.split('\n').map(text => text.replace(/^\[ERROR\]\s*\S+\s+\S+\s*/, '').trim()).find(Boolean);
  return line ?? `op exited with code ${output.code}`;
}

function opFailed(action: string, output: OpOutput): PaneError {
  const reason = opReason(output);
  if (/not currently signed in|no accounts configured|authorization prompt dismissed|not authorized|denied/i.test(reason)) {
    return new PaneError('ONEPASSWORD_NOT_APPROVED', `1Password did not allow Pane to ${action}: ${reason}. Nothing was read.`, 'Unlock 1Password and approve its prompt (Touch ID or Windows Hello), then try again.');
  }
  return new PaneError('ONEPASSWORD_FAILED', `The 1Password CLI could not ${action}: ${reason}. Nothing was read.`, `Check the reference in 1Password (Copy Secret Reference), and that ${OP_INSTALL_NEXT.charAt(0).toLowerCase()}${OP_INSTALL_NEXT.slice(1)}`);
}

const createdItemSchema = boundary.object({
  id: boundary.nonEmptyString,
  vault: boundary.object({ id: boundary.nonEmptyString }),
});
const vaultListSchema = boundary.array(boundary.object({ id: boundary.nonEmptyString, name: boundary.string }));

/**
 * 1Password through its CLI, from Pane's main process. Reads go through one `op inject` call, so
 * 1Password asks once for all of them. Nothing here logs or returns a value except `read`'s result.
 */
export class OnePassword {
  constructor(private readonly run: OpRunner = systemOpRunner()) {}

  /** The values of `references`, in one call. Throws without a value in the message. */
  async read(references: readonly string[]): Promise<string[]> {
    if (references.length === 0) return [];
    // Each value sits between two random markers no value can contain, so line breaks in values survive.
    const marker = `pane-${randomBytes(12).toString('hex')}`;
    const template = references.map((reference, index) => `${marker}:${index}:{{ ${reference} }}:${marker}`).join('\n');
    const output = await this.run(['inject'], template);
    if (output.code !== 0) throw opFailed(`read ${references.length === 1 ? references[0] : `${references.length} references`}`, output);
    const values: string[] = [];
    const pattern = new RegExp(`${marker}:(\\d+):([\\s\\S]*?):${marker}`, 'g');
    for (const match of output.stdout.matchAll(pattern)) values[Number(match[1])] = match[2];
    if (values.length !== references.length || values.some(value => value === undefined)) {
      throw new PaneError('ONEPASSWORD_FAILED', 'The 1Password CLI answered in a form Pane does not recognize. Nothing was leased.', 'Update the 1Password CLI, then try again.');
    }
    return values;
  }

  /** Vault names Pane can write to. 1Password may ask for approval. */
  async vaults(): Promise<string[]> {
    const output = await this.run(['vault', 'list', '--format', 'json'], '');
    if (output.code !== 0) throw opFailed('list your vaults', output);
    return decodeBoundary(JSON.parse(output.stdout), vaultListSchema).map(vault => vault.name).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Creates an API Credential item holding `value` in `vault` and returns its reference. The value
   * goes to op on stdin inside the item template, never on the command line.
   */
  async createItem(vault: string, title: string, value: string): Promise<string> {
    const template = JSON.stringify({
      title,
      category: 'API_CREDENTIAL',
      fields: [{ id: 'credential', type: 'CONCEALED', label: 'credential', value }],
    });
    const output = await this.run(['item', 'create', '--vault', vault, '--format', 'json', '-'], template);
    if (output.code !== 0) throw opFailed(`create an item in ${vault}`, output);
    let created: { id: string; vault: { id: string } };
    try {
      created = decodeBoundary(JSON.parse(output.stdout), createdItemSchema);
    } catch {
      throw new PaneError('ONEPASSWORD_FAILED', `1Password created an item in ${vault}, but Pane could not read its id. The typed secret was kept.`, `Find "${title}" in ${vault}, choose Copy Secret Reference on its credential, and add it in Settings → Secrets.`);
    }
    return `op://${created.vault.id}/${created.id}/credential`;
  }
}

let shared: OnePassword | null = null;

export function onePassword(): OnePassword {
  shared ??= new OnePassword();
  return shared;
}
