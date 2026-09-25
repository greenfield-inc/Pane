import { execFile } from 'child_process';
import { constants } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { Project } from '../database/models';
import type { AppConfig } from '../types/config';
import { getAppDirectory } from '../utils/appDirectory';
import { getShellPath } from '../utils/shellPath';
import { escapeForBash, linuxToUNCPath } from '../utils/wslUtils';
import { boundary, decodeOptionalBoundary, type JsonObject } from '../../../shared/validation/boundaryDecoder';

const execFileAsync = promisify(execFile);

const PANE_MCP_SERVER_NAME = 'pane';
// Codex stops waiting for a tool after 60 s by default; `watch` and `panels wait` block longer.
const CODEX_TOOL_TIMEOUT_SEC = 600;
const CLI_TIMEOUT_MS = 30_000;

export interface PaneMcpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** One machine environment whose user-level agent configs Pane manages (the host, or a WSL distro). */
export interface McpRegistrationTarget {
  label: string;
  server: PaneMcpServerEntry;
  /** Present when Claude Code is installed. Writes go through its CLI, which owns ~/.claude.json. */
  claude?: { configPath: string; run: (args: string[]) => Promise<void> };
  /** Present when Codex is installed. */
  codex?: { configPath: string };
}

type RegistrationAction = 'added' | 'updated' | 'removed' | 'unchanged' | 'skipped';

export interface RegistrationOutcome {
  client: 'Claude Code' | 'Codex';
  action: RegistrationAction;
  detail?: string;
}

/** Adds, repairs, or removes the `pane` MCP server in every agent config the target has. */
export async function syncMcpRegistration(target: McpRegistrationTarget, enabled: boolean): Promise<RegistrationOutcome[]> {
  const outcomes: RegistrationOutcome[] = [];
  const { claude, codex } = target;
  if (claude) {
    outcomes.push(await settle('Claude Code', () => syncClaude(claude, target.server, enabled)));
  }
  if (codex) {
    outcomes.push(await settle('Codex', () => syncCodex(codex.configPath, target.server, enabled)));
  }
  return outcomes;
}

async function settle(
  client: RegistrationOutcome['client'],
  sync: () => Promise<Omit<RegistrationOutcome, 'client'>>,
): Promise<RegistrationOutcome> {
  try {
    return { client, ...await sync() };
  } catch (error) {
    return { client, action: 'skipped', detail: error instanceof Error ? error.message : String(error) };
  }
}

async function syncClaude(
  claude: NonNullable<McpRegistrationTarget['claude']>,
  server: PaneMcpServerEntry,
  enabled: boolean,
): Promise<{ action: RegistrationAction }> {
  const current = await readClaudeEntry(claude.configPath);
  const remove = ['mcp', 'remove', PANE_MCP_SERVER_NAME, '--scope', 'user'];
  if (!enabled) {
    if (!current) return { action: 'unchanged' };
    await claude.run(remove);
    return { action: 'removed' };
  }
  if (current && sameClaudeEntry(current, server)) return { action: 'unchanged' };
  if (current) await claude.run(remove);
  await claude.run([
    'mcp', 'add', PANE_MCP_SERVER_NAME, '--scope', 'user',
    ...Object.entries(server.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '--', server.command, ...server.args,
  ]);
  return { action: current ? 'updated' : 'added' };
}

const claudeEntrySchema = boundary.object({
  type: boundary.optional(boundary.string),
  command: boundary.optional(boundary.string),
  args: boundary.optional(boundary.array(boundary.string)),
  env: boundary.optional(boundary.jsonObject),
});
type ClaudeEntry = ReturnType<typeof claudeEntrySchema.decode>;

async function readClaudeEntry(configPath: string): Promise<ClaudeEntry | undefined> {
  const text = await readIfExists(configPath);
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const servers = decodeOptionalBoundary(parsed, boundary.object({ mcpServers: boundary.optional(boundary.jsonObject) }))?.mcpServers;
  return servers && decodeOptionalBoundary(servers[PANE_MCP_SERVER_NAME], claudeEntrySchema);
}

function sameClaudeEntry(entry: ClaudeEntry, server: PaneMcpServerEntry): boolean {
  const sortedEnv = (env: JsonObject) => JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  return (entry.type === undefined || entry.type === 'stdio')
    && entry.command === server.command
    && JSON.stringify(entry.args ?? []) === JSON.stringify(server.args)
    && sortedEnv(entry.env ?? {}) === sortedEnv(server.env);
}

async function syncCodex(configPath: string, server: PaneMcpServerEntry, enabled: boolean): Promise<Omit<RegistrationOutcome, 'client'>> {
  const current = await readIfExists(configPath) ?? '';
  if (hasUnmanagedCodexEntry(current)) {
    return { action: 'skipped', detail: `${configPath} already defines mcp_servers.pane in a form Pane does not manage` };
  }
  const next = enabled ? upsertCodexServer(current, server) : removeCodexServer(current);
  if (next === current) return { action: 'unchanged' };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  // writeFile follows a symlinked config (dotfile managers) instead of replacing it.
  await fs.writeFile(configPath, next, 'utf8');
  if (!enabled) return { action: 'removed' };
  return { action: findCodexTable(current) ? 'updated' : 'added' };
}

/** Returns config.toml with exactly one `[mcp_servers.pane]` table matching `server`. */
function upsertCodexServer(toml: string, server: PaneMcpServerEntry): string {
  const block = renderCodexTable(server);
  const table = findCodexTable(toml);
  if (table) {
    const lines = toml.split('\n');
    return [...lines.slice(0, table.start), ...block, ...lines.slice(table.end)].join('\n');
  }
  if (toml.trim().length === 0) return `${block.join('\n')}`;
  const separator = toml.endsWith('\n') ? '\n' : '\n\n';
  return `${toml}${separator}${block.join('\n')}`;
}

/** Returns config.toml without Pane's `[mcp_servers.pane]` table and its subtables. */
function removeCodexServer(toml: string): string {
  const table = findCodexTable(toml);
  if (!table) return toml;
  const lines = toml.split('\n');
  return [...lines.slice(0, table.start), ...lines.slice(table.end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderCodexTable(server: PaneMcpServerEntry): string[] {
  const env = Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ');
  return [
    `[mcp_servers.${PANE_MCP_SERVER_NAME}]`,
    '# Managed by Pane (Settings > AI & Agents). Pane rewrites this table on launch.',
    `command = ${JSON.stringify(server.command)}`,
    `args = [${server.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    `env = { ${env} }`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    '',
  ];
}

const PANE_TABLE_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:pane|"pane")\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const ANY_TABLE_HEADER = /^\s*\[/;

/** Line range [start, end) of the `[mcp_servers.pane]` table plus its `[mcp_servers.pane.*]` subtables. */
function findCodexTable(toml: string): { start: number; end: number } | undefined {
  const lines = toml.split('\n');
  const start = lines.findIndex((line) => PANE_TABLE_HEADER.test(line));
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && !(ANY_TABLE_HEADER.test(lines[end]) && !PANE_TABLE_HEADER.test(lines[end]))) {
    end++;
  }
  return { start, end };
}

/** A `pane` server written as a dotted key or inline table: rewriting it could duplicate the key and break the file. */
function hasUnmanagedCodexEntry(toml: string): boolean {
  let table = '';
  for (const line of toml.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      table = header[1].replace(/\s+/g, '');
      continue;
    }
    if (table === '' && /^\s*mcp_servers\s*\.\s*"?pane"?\s*[.=]/.test(line)) return true;
    if (table === 'mcp_servers' && /^\s*"?pane"?\s*[.=]/.test(line)) return true;
  }
  return false;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (decodeOptionalBoundary(error, boundary.object({ code: boundary.literal('ENOENT') }))) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Targets for this machine

interface PaneMcpHost {
  /** Executable that runs the MCP script as Node (the Pane binary with ELECTRON_RUN_AS_NODE). */
  executable: string;
  /** Stable path of the runpane entrypoint Pane copied out of the app bundle. */
  scriptPath: string;
  /** Pane data directory; passed as PANE_DIR when it is not the default. */
  paneDir: string;
  claudeExecutablePath?: string;
}

/** The host's own Claude Code and Codex configs. */
async function buildHostTarget(host: PaneMcpHost): Promise<McpRegistrationTarget> {
  const target: McpRegistrationTarget = {
    label: 'this machine',
    server: { command: host.executable, args: [host.scriptPath, 'mcp'], env: serverEnv(host.paneDir, false) },
  };

  const claude = host.claudeExecutablePath || await findExecutable('claude');
  if (claude) {
    target.claude = {
      configPath: path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json'),
      run: (args) => runHostCli(claude, args),
    };
  }
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (await exists(codexHome) || await findExecutable('codex')) {
    target.codex = { configPath: path.join(codexHome, 'config.toml') };
  }
  return target;
}

/**
 * A WSL distro's configs. Agents there run the Windows Pane binary through WSL
 * interop, so the MCP server talks to the Windows Pane daemon.
 */
async function buildWslTarget(host: PaneMcpHost, distro: string): Promise<McpRegistrationTarget | undefined> {
  const probe = await runWsl(distro, [
    'command -v claude >/dev/null && echo claude=1',
    '{ [ -d "${CODEX_HOME:-$HOME/.codex}" ] || command -v codex >/dev/null; } && echo codex=1',
    'echo "codexHome=${CODEX_HOME:-$HOME/.codex}"',
    'echo "claudeHome=${CLAUDE_CONFIG_DIR:-$HOME}"',
  ].join('; ')).catch(() => undefined);
  if (probe === undefined) return undefined;
  const values = Object.fromEntries(probe.split('\n').map((line) => line.trim().split('=')).filter((pair) => pair.length >= 2)
    .map(([key, ...rest]) => [key, rest.join('=')]));

  const target: McpRegistrationTarget = {
    label: `WSL (${distro})`,
    server: { command: windowsToWslPath(host.executable), args: [host.scriptPath, 'mcp'], env: serverEnv(host.paneDir, true) },
  };
  if (values.claude === '1' && values.claudeHome?.startsWith('/')) {
    target.claude = {
      configPath: linuxToUNCPath(`${values.claudeHome}/.claude.json`, distro),
      run: async (args) => { await runWsl(distro, ['claude', ...args].map(escapeForBash).join(' ')); },
    };
  }
  if (values.codex === '1' && values.codexHome?.startsWith('/')) {
    target.codex = { configPath: linuxToUNCPath(`${values.codexHome}/config.toml`, distro) };
  }
  return target;
}

/** `C:\Program Files\Pane\Pane.exe` → `/mnt/c/Program Files/Pane/Pane.exe` (default WSL automount root). */
export function windowsToWslPath(windowsPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!match) return windowsPath;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

/** Runs the Pane binary as Node; WSLENV carries the variables across WSL interop to Pane.exe. */
function serverEnv(paneDir: string, forWsl: boolean): PaneMcpServerEntry['env'] {
  const entries: [string, string][] = [['ELECTRON_RUN_AS_NODE', '1']];
  if (!isDefaultPaneDir(paneDir)) entries.push(['PANE_DIR', paneDir]);
  if (forWsl) entries.push(['WSLENV', entries.map(([name]) => name).join(':')]);
  return Object.fromEntries(entries);
}

function isDefaultPaneDir(paneDir: string): boolean {
  return path.resolve(paneDir) === path.resolve(os.homedir(), '.pane');
}

async function runHostCli(executable: string, args: string[]): Promise<void> {
  const env = { ...process.env, PATH: getShellPath() };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    // npm installs claude as a .cmd shim, which only cmd.exe can run. Arguments are paths and
    // KEY=value pairs without quotes, so wrapping each in double quotes is enough.
    const line = [executable, ...args].map((arg) => `"${arg}"`).join(' ');
    await execFileAsync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, timeout: CLI_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: true });
    return;
  }
  await execFileAsync(executable, args, { env, timeout: CLI_TIMEOUT_MS, windowsHide: true });
}

async function runWsl(distro: string, command: string): Promise<string> {
  // A login shell loads the PATH where claude and codex usually live (~/.local/bin, nvm).
  const { stdout } = await execFileAsync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', command], {
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf8',
  });
  return stdout;
}

async function findExecutable(name: string): Promise<string | undefined> {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const dir of getShellPath().split(path.delimiter).filter(Boolean)) {
    for (const candidate of names) {
      const fullPath = path.join(dir, candidate);
      try {
        await fs.access(fullPath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return fullPath;
      } catch {
        // keep searching
      }
    }
  }
  return undefined;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// App entry point

/** Where main's build puts the bundled runpane CLI (see main/build-runpane.js). */
const BUNDLED_RUNPANE_DIR = path.join(__dirname, '..', '..', '..', 'runpane');

interface PaneMcpSyncOptions {
  enabled: boolean;
  paneDir: string;
  /** Distros of saved WSL repositories; only used on Windows. */
  wslDistros: string[];
  claudeExecutablePath?: string;
}

/**
 * Registers (or unregisters) the bundled MCP server with every installed Claude Code
 * and Codex on this machine. Copies the runpane entrypoint to `<paneDir>/mcp/runpane`
 * so the registered path survives app updates and AppImage remounts.
 */
async function syncPaneMcpRegistrations(options: PaneMcpSyncOptions): Promise<void> {
  const scriptPath = options.enabled
    ? await installRunpaneCopy(options.paneDir)
    : path.join(options.paneDir, 'mcp', 'runpane', 'dist', 'cli.js');
  const host: PaneMcpHost = {
    // An AppImage's execPath is a per-launch mount; APPIMAGE is the stable file.
    executable: process.env.APPIMAGE || process.execPath,
    scriptPath,
    paneDir: options.paneDir,
    claudeExecutablePath: options.claudeExecutablePath,
  };
  const targets: McpRegistrationTarget[] = [await buildHostTarget(host)];
  if (process.platform === 'win32') {
    for (const distro of new Set(options.wslDistros)) {
      const target = await buildWslTarget(host, distro);
      if (target) targets.push(target);
    }
  }
  for (const target of targets) {
    for (const outcome of await syncMcpRegistration(target, options.enabled)) {
      if (outcome.action === 'unchanged') continue;
      const detail = outcome.detail ? `: ${outcome.detail}` : '';
      console.log(`[PaneMcp] ${outcome.client} on ${target.label}: ${outcome.action} the "${PANE_MCP_SERVER_NAME}" MCP server${detail}`);
    }
  }
}

async function installRunpaneCopy(paneDir: string): Promise<string> {
  const destination = path.join(paneDir, 'mcp', 'runpane');
  for (const file of ['package.json', path.join('dist', 'cli.js')]) {
    const source = await fs.readFile(path.join(BUNDLED_RUNPANE_DIR, file));
    const target = path.join(destination, file);
    const current = await fs.readFile(target).catch(() => undefined);
    if (current && current.equals(source)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, source);
  }
  return path.join(destination, 'dist', 'cli.js');
}

let syncQueue: Promise<void> = Promise.resolve();

/**
 * Applies the "Register Pane tools" setting. Runs one sync at a time so a settings toggle
 * cannot interleave with the launch sync. Only packaged builds register: a dev build would
 * point every agent at a worktree.
 */
export function syncPaneMcpForApp(options: {
  isPackaged: boolean;
  config: Pick<AppConfig, 'agentContext' | 'claudeExecutablePath'>;
  projects: Pick<Project, 'wsl_enabled' | 'wsl_distribution'>[];
}): Promise<void> {
  if (!options.isPackaged) return Promise.resolve();
  const run = syncQueue.then(() => syncPaneMcpRegistrations({
    enabled: options.config.agentContext?.registerMcp !== false,
    paneDir: getAppDirectory(),
    wslDistros: options.projects.flatMap((project) => project.wsl_enabled && project.wsl_distribution ? [project.wsl_distribution] : []),
    claudeExecutablePath: options.config.claudeExecutablePath,
  }));
  syncQueue = run.catch(() => undefined);
  return run;
}
