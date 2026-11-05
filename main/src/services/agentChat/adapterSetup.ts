import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findExecutableInPath, getShellPath } from '../../utils/shellPath';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { PaneError, reasonOf } from '../../../../shared/paneError';
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
 * Change a pin only with its `minimum`, its `minimumReleaseAgeExclude` entries
 * in pnpm-workspace.yaml, and a packaged build: scripts/after-pack.js runs
 * scripts/verify-chat-adapters.js, which fails the build unless each packaged
 * adapter starts and answers ACP `initialize`.
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

/**
 * The adapter as a file another program's plain Node can run, for Agent Farm profiles. In a
 * packaged Pane the entry is inside app.asar, which only Electron can read, so Agent Farm refuses
 * it. Outside app.asar this is the entry itself; inside, it is a small launcher in `directory`
 * that runs the entry with Pane's own Electron, the way plain chat tabs and the release check do.
 */
export function adapterFileForPlainNode(entry: string, directory: string, electron: string = process.execPath): string {
  if (!/\.asar[\\/]/.test(entry)) return entry;
  const file = path.join(directory, `${path.basename(path.dirname(path.dirname(entry)))}-launcher.cjs`);
  const content = `// Written by Pane: runs its bundled chat adapter with Pane's Electron, because plain Node cannot read app.asar.
const { spawn } = require('child_process');
const child = spawn(${JSON.stringify(electron)}, [${JSON.stringify(entry)}, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error('Pane could not start its chat adapter: ' + error.message); process.exit(1); });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
`;
  mkdirSync(directory, { recursive: true });
  if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content, { mode: 0o755 });
  return file;
}

/** Where the adapter will run the CLI: the tab's project folder and launch environment. */
export interface LaunchContext { cwd?: string; env?: NodeJS.ProcessEnv }

/**
 * Checks that the person's installed CLI can run under the bundled adapter.
 * Nothing is downloaded or installed. `executable` defaults to the same PATH
 * lookup terminal agent tabs use. The version is read in `context`, the folder
 * and environment the adapter will run the CLI in, because a project-selected
 * wrapper may answer only there.
 */
export async function installAdapter(provider: Provider, executable: string | null = findExecutableInPath(provider), context: LaunchContext = {}): Promise<void> {
  const { name, minimum, upgrade } = adapters[provider];
  if (!adapterEntry(provider)) throw new PaneError('CHAT_ADAPTER_MISSING', `This Pane build is missing its bundled ${name} chat adapter.`, 'Reinstall Pane from runpane.com. Terminal agent tabs are not affected.');
  if (!executable) throw new PaneError('CHAT_AGENT_NOT_INSTALLED', `${name} is not installed on this machine, or not on its PATH.`, `Install it with \`${upgrade}\`, then start Chat again. Terminal agent tabs are not affected.`);
  const key = `${executable}\0${context.cwd ?? ''}`;
  if (checked.has(key)) return;
  const version = await installedVersion(name, executable, context);
  if (compareVersions(version, minimum) < 0) {
    throw new PaneError('CHAT_AGENT_OUTDATED', `${name} ${version} at ${executable} is older than ${minimum}, the oldest version chat supports.`, `Update it with \`${upgrade}\`, then start Chat again. Terminal agent tabs are not affected.`);
  }
  checked.add(key);
}

/** The CLI's `--version`, or a PaneError keeping why it could not be read. */
async function installedVersion(name: string, executable: string, { cwd, env }: LaunchContext): Promise<string> {
  const command = hostCommand(executable, ['--version']);
  const next = `Check that \`${executable} --version\` runs in a terminal in this project, then start Chat again. Terminal agent tabs are not affected.`;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command.executable, command.args, { cwd, env: env ?? { ...process.env, PATH: getShellPath() }, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments }));
  } catch (error) {
    throw new PaneError('CHAT_AGENT_VERSION_UNREADABLE', `Pane could not run ${name} at ${executable} to read its version: ${reasonOf(error)}. Chat did not start.`, next);
  }
  const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
  if (!version) throw new PaneError('CHAT_AGENT_VERSION_UNREADABLE', `${name} at ${executable} printed no version number for \`--version\` (it printed "${stdout.trim().slice(0, 200)}"). Chat did not start.`, next);
  return version;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}
