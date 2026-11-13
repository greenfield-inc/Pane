import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getShellPath } from '../../utils/shellPath';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { hostCommand } from './hostCommand';
import { agentConfig } from '../../../../shared/agents';

const execFileAsync = promisify(execFile);
const checked = new Set<string>();

/**
 * The bundled ACP adapter package's entry script, or undefined when this build is missing
 * it. The adapters ship inside Pane as exact dependencies in package.json, without the
 * native agent binaries their SDKs bundle; each runs the person's own installed CLI.
 * scripts/after-pack.js runs scripts/verify-chat-adapters.js, which fails a packaged
 * build unless each adapter in the agents config starts and answers ACP `initialize`.
 */
export function adapterEntry(packageName: string): string | undefined {
  let root;
  try { root = path.dirname(require.resolve(`${packageName}/package.json`)); }
  catch { return; }
  const entry = path.join(root, 'dist', 'index.js');
  return existsSync(entry) ? entry : undefined;
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
 * Checks that the person's installed CLI is new enough for chat (the agents config's
 * `chat.minimumVersion`). Nothing is downloaded or installed. The version is read in
 * `context`, the folder and environment the agent will run in, because a
 * project-selected wrapper may answer only there.
 */
export async function checkAgentCli(agentId: string, executable: string | null, context: LaunchContext = {}): Promise<void> {
  const agent = agentConfig(agentId);
  const chat = agent?.chat;
  if (!agent || !chat) throw new PaneError('CHAT_AGENT_UNKNOWN', `Pane has no chat settings for the agent "${agentId}".`, 'Open a chat tab for an agent listed in the + menu.');
  if (chat.adapter && !adapterEntry(chat.adapter.package)) throw new PaneError('CHAT_ADAPTER_MISSING', `This Pane build is missing its bundled ${agent.title} chat adapter.`, 'Reinstall Pane from runpane.com. Terminal agent tabs are not affected.');
  if (!executable) throw new PaneError('CHAT_AGENT_NOT_INSTALLED', `${agent.title} is not installed on this machine, or not on its PATH.`, `Install it with \`${agent.install.command}\`, then start Chat again. Terminal agent tabs are not affected.`);
  const key = `${executable}\0${context.cwd ?? ''}`;
  if (checked.has(key)) return;
  const version = await installedVersion(agent.title, executable, context);
  if (compareVersions(version, chat.minimumVersion) < 0) {
    throw new PaneError('CHAT_AGENT_OUTDATED', `${agent.title} ${version} at ${executable} is older than ${chat.minimumVersion}, the oldest version chat supports.`, `Update it with \`${agent.install.command}\`, then start Chat again. Terminal agent tabs are not affected.`);
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
