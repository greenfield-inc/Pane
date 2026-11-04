import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findExecutableInPath, getShellPath } from '../../utils/shellPath';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../../shared/paneError';
import { hostCommand } from './hostCommand';

const execFileAsync = promisify(execFile);
const CLAUDE_ADAPTER_VERSION = '0.100.0';
export const CODEX_ADAPTER_VERSION = '2.5.0';
type Provider = 'claude' | 'codex';
/**
 * The adapters ship inside Pane as pinned dependencies, without the native
 * agent binaries their SDKs bundle. Each runs the person's own installed CLI,
 * which must be at least `minimum`: claude-agent-sdk 0.3.316 pairs with Claude
 * Code 2.1.316, and codex-acp 2.5.0 depends on @openai/codex ^0.165.0.
 */
const adapters = {
  claude: { packageName: '@agentclientprotocol/claude-agent-acp', version: CLAUDE_ADAPTER_VERSION, name: 'Claude Code', minimum: '2.1.316', upgrade: 'npm install -g @anthropic-ai/claude-code@latest' },
  codex: { packageName: '@agentclientprotocol/codex-acp', version: CODEX_ADAPTER_VERSION, name: 'Codex', minimum: '0.165.0', upgrade: 'npm install -g @openai/codex@latest' },
};
const checked = new Set<string>();

/** The bundled adapter's entry script, or undefined when this build is missing it. */
export function adapterEntry(provider: Provider): string | undefined {
  const { packageName, version } = adapters[provider];
  let root;
  try { root = path.dirname(require.resolve(`${packageName}/package.json`)); }
  catch { return; }
  let metadata;
  try { metadata = decodeOptionalBoundary(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')), boundary.object({ version: boundary.string })); }
  catch { return; }
  const entry = path.join(root, 'dist', 'index.js');
  return metadata?.version === version && existsSync(entry) ? entry : undefined;
}

export async function installClaudeAdapter(): Promise<void> { return installAdapter('claude'); }

/**
 * Checks that the person's installed CLI can run under the bundled adapter.
 * Nothing is downloaded or installed. `executable` defaults to the same PATH
 * lookup terminal agent tabs use.
 */
export async function installAdapter(provider: Provider, executable: string | null = findExecutableInPath(provider)): Promise<void> {
  const { name, minimum, upgrade } = adapters[provider];
  if (!adapterEntry(provider)) throw new PaneError('CHAT_ADAPTER_MISSING', `This Pane build is missing its bundled ${name} chat adapter.`, 'Reinstall Pane from runpane.com. Terminal agent tabs are not affected.');
  if (!executable) throw new PaneError('CHAT_AGENT_NOT_INSTALLED', `${name} is not installed on this machine, or not on its PATH.`, `Install it with \`${upgrade}\`, then press Retry. Terminal agent tabs are not affected.`);
  if (checked.has(executable)) return;
  const version = await installedVersion(executable);
  if (!version || compareVersions(version, minimum) < 0) {
    throw new PaneError('CHAT_AGENT_OUTDATED', `${name} ${version ?? '(unknown version)'} at ${executable} is older than ${minimum}, the oldest version chat supports.`, `Update it with \`${upgrade}\`, then press Retry. Terminal agent tabs are not affected.`);
  }
  checked.add(executable);
}

async function installedVersion(executable: string): Promise<string | undefined> {
  const command = hostCommand(executable, ['--version']);
  try {
    const { stdout } = await execFileAsync(command.executable, command.args, { env: { ...process.env, PATH: getShellPath() }, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments });
    return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
  } catch { return; }
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}
