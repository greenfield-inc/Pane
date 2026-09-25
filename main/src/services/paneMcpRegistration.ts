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
import { escapeForBash, linuxToUNCPath, windowsPathToWSLMount } from '../utils/wslUtils';
import { parse as parseToml } from 'smol-toml';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../shared/validation/boundaryDecoder';

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
): Promise<Omit<RegistrationOutcome, 'client'>> {
  const current = await readClaudeEntry(claude.configPath);
  // Pane owns only an entry that runs its own copy of runpane; anything else was added by hand.
  if (current && current.args?.[0] !== server.args[0]) {
    return { action: 'skipped', detail: `${claude.configPath} has a "pane" MCP server that Pane did not add; left it unchanged` };
  }
  const remove = ['mcp', 'remove', PANE_MCP_SERVER_NAME, '--scope', 'user'];
  if (!enabled) {
    if (!current) return { action: 'unchanged' };
    await claude.run(remove);
    return { action: 'removed' };
  }
  if (current && sameClaudeEntry(current, server)) return { action: 'unchanged' };
  // `claude mcp add` refuses to overwrite, so an update is remove + add, with the old entry restored on failure.
  if (current) await claude.run(remove);
  try {
    await claude.run(claudeAddArgs(server));
  } catch (error) {
    const previous = current && claudeEntryAsServer(current);
    if (previous) await claude.run(claudeAddArgs(previous)).catch(() => undefined);
    throw error;
  }
  return { action: current ? 'updated' : 'added' };
}

function claudeAddArgs(server: PaneMcpServerEntry): string[] {
  return [
    'mcp', 'add', PANE_MCP_SERVER_NAME, '--scope', 'user',
    ...Object.entries(server.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '--', server.command, ...server.args,
  ];
}

const claudeEntrySchema = boundary.object({
  type: boundary.optional(boundary.string),
  command: boundary.optional(boundary.string),
  args: boundary.optional(boundary.array(boundary.string)),
  env: boundary.optional(boundary.jsonObject),
});
type ClaudeEntry = ReturnType<typeof claudeEntrySchema.decode>;

function claudeEntryAsServer(entry: ClaudeEntry): PaneMcpServerEntry | undefined {
  if (!entry.command) return undefined;
  return {
    command: entry.command,
    args: entry.args ?? [],
    env: Object.fromEntries(Object.entries(entry.env ?? {}).map(([key, value]) => [key, String(value)])),
  };
}

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

const CODEX_MANAGED_MARKER = '# Managed by Pane (Settings > AI & Agents). Pane rewrites this table on launch.';

async function syncCodex(configPath: string, server: PaneMcpServerEntry, enabled: boolean): Promise<Omit<RegistrationOutcome, 'client'>> {
  const current = await readIfExists(configPath) ?? '';
  const before = parseTomlConfig(current);
  if (!before) return { action: 'skipped', detail: `${configPath} is not valid TOML; left it unchanged` };
  const table = findManagedCodexTable(current);
  if (!table && before.paneEntry !== undefined) {
    return { action: 'skipped', detail: `${configPath} has a "pane" MCP server that Pane did not write; left it unchanged` };
  }
  const next = enabled ? upsertCodexServer(current, server, table) : removeCodexServer(current, table);
  if (next === current) return { action: 'unchanged' };
  const after = parseTomlConfig(next);
  const expected = enabled ? JSON.stringify(codexEntry(server)) : undefined;
  // Text edits keep the user's comments and formatting; parsing the result proves they changed nothing else.
  if (!after || after.rest !== before.rest || (after.paneEntry && JSON.stringify(after.paneEntry)) !== expected) {
    return { action: 'skipped', detail: `editing ${configPath} would have changed more than Pane's entry; left it unchanged` };
  }
  await writeFileAtomic(configPath, next);
  if (!enabled) return { action: 'removed' };
  return { action: table ? 'updated' : 'added' };
}

function codexEntry(server: PaneMcpServerEntry) {
  return { command: server.command, args: server.args, env: server.env, tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC };
}

/** The `pane` MCP entry and a JSON fingerprint of everything else, or undefined when the text is not valid TOML. */
function parseTomlConfig(text: string): { paneEntry: JsonValue | undefined; rest: string } | undefined {
  let config: JsonObject;
  try {
    config = decodeBoundary(JSON.parse(JSON.stringify(parseToml(text))), boundary.jsonObject);
  } catch {
    return undefined;
  }
  const servers = decodeOptionalBoundary(config.mcp_servers, boundary.jsonObject);
  const paneEntry = servers?.[PANE_MCP_SERVER_NAME];
  if (servers) {
    const others = { ...servers };
    delete others[PANE_MCP_SERVER_NAME];
    if (Object.keys(others).length > 0) config.mcp_servers = others;
    else delete config.mcp_servers;
  }
  return { paneEntry, rest: JSON.stringify(config) };
}

/** Returns config.toml with Pane's table written in place, or appended when there is none. */
function upsertCodexServer(toml: string, server: PaneMcpServerEntry, table: LineRange | undefined): string {
  const block = renderCodexTable(server);
  if (table) {
    const lines = toml.split('\n');
    return [...lines.slice(0, table.start), ...block, ...lines.slice(table.end)].join('\n');
  }
  if (toml.trim().length === 0) return `${block.join('\n')}\n`;
  const separator = toml.endsWith('\n') ? '\n' : '\n\n';
  return `${toml}${separator}${block.join('\n')}\n`;
}

/** Returns config.toml without Pane's table, collapsing only the blank lines left where it was. */
function removeCodexServer(toml: string, table: LineRange | undefined): string {
  if (!table) return toml;
  const lines = toml.split('\n');
  lines.splice(table.start, table.end - table.start);
  const junction = table.start;
  const blankAt = (index: number) => index < lines.length && lines[index].trim() === '';
  // Drop the separator blank lines Pane's table leaves behind: doubled ones mid-file, leading ones at the top.
  while (blankAt(junction) && (junction === 0 ? lines.length > 1 : blankAt(junction - 1))) {
    lines.splice(junction, 1);
  }
  return lines.join('\n');
}

function renderCodexTable(server: PaneMcpServerEntry): string[] {
  const entry = codexEntry(server);
  const env = Object.entries(entry.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ');
  return [
    `[mcp_servers.${PANE_MCP_SERVER_NAME}]`,
    CODEX_MANAGED_MARKER,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    `env = { ${env} }`,
    `tool_timeout_sec = ${entry.tool_timeout_sec}`,
  ];
}

interface LineRange { start: number; end: number }

const PANE_TABLE_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*pane\s*\]\s*$/;
const ANY_TABLE_HEADER = /^\s*\[/;

/**
 * Line range [start, end) of the `[mcp_servers.pane]` table Pane wrote (header followed by its marker),
 * ending at the table's last key so comments that introduce the next table stay put.
 */
function findManagedCodexTable(toml: string): LineRange | undefined {
  const lines = toml.split('\n');
  const start = lines.findIndex((line, index) => PANE_TABLE_HEADER.test(line) && lines[index + 1]?.trim() === CODEX_MANAGED_MARKER);
  if (start === -1) return undefined;
  let end = start + 2;
  while (end < lines.length && !ANY_TABLE_HEADER.test(lines[end])) end++;
  while (end > start + 2 && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
  return { start, end };
}

/** Replaces the file in one rename so a crash or a concurrent reader never sees half a config. Follows symlinks. */
async function writeFileAtomic(filePath: string, content: string | Buffer): Promise<void> {
  const target = await fs.realpath(filePath).catch(() => filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const mode = (await fs.stat(target).catch(() => undefined))?.mode;
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, content, mode === undefined ? undefined : { mode });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
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
  /** `runpane mcp --toolsets`; the server's default (core) when absent. */
  toolsets?: string[];
  claudeExecutablePath?: string;
}

function serverArgs(host: PaneMcpHost): string[] {
  const args = [host.scriptPath, 'mcp'];
  if (host.toolsets && host.toolsets.length > 0) args.push('--toolsets', host.toolsets.join(','));
  return args;
}

/** The host's own Claude Code and Codex configs. */
async function buildHostTarget(host: PaneMcpHost): Promise<McpRegistrationTarget> {
  const target: McpRegistrationTarget = {
    label: 'this machine',
    server: { command: host.executable, args: serverArgs(host), env: serverEnv(host.paneDir, false) },
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
    `echo "exe=$(wslpath -u ${escapeForBash(host.executable)})"`,
  ].join('; ')).catch(() => undefined);
  if (probe === undefined) return undefined;
  const values = Object.fromEntries(probe.split('\n').map((line) => line.trim().split('=')).filter((pair) => pair.length >= 2)
    .map(([key, ...rest]) => [key, rest.join('=')]));

  const target: McpRegistrationTarget = {
    label: `WSL (${distro})`,
    // wslpath honors a custom automount root; /mnt/<drive> is the default if it is unavailable.
    server: { command: values.exe?.startsWith('/') ? values.exe : windowsPathToWSLMount(host.executable), args: serverArgs(host), env: serverEnv(host.paneDir, true) },
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

/**
 * Runs the Pane binary as Node; WSLENV carries the variables across WSL interop to Pane.exe.
 * This relies on Electron's RunAsNode fuse staying enabled: flipping it off breaks every registration.
 */
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

let syncQueue: Promise<void> = Promise.resolve();

/**
 * Applies the "Register Pane tools" setting to every installed Claude Code and Codex on this
 * machine, one sync at a time so a settings toggle cannot interleave with the launch sync.
 * Only packaged builds register: a dev build would point every agent at a worktree.
 */
export function syncPaneMcpForApp(options: {
  isPackaged: boolean;
  config: Pick<AppConfig, 'agentContext' | 'claudeExecutablePath'>;
  /** Saved repositories; their WSL distros get registrations on Windows. */
  getProjects: () => Pick<Project, 'wsl_enabled' | 'wsl_distribution'>[];
}): void {
  if (!options.isPackaged) return;
  syncQueue = syncQueue
    .then(() => syncRegistrations(options.config.agentContext?.registerMcp !== false, options))
    .catch((error) => console.warn('[PaneMcp] Registration sync failed:', error));
}

async function syncRegistrations(
  enabled: boolean,
  options: Pick<Parameters<typeof syncPaneMcpForApp>[0], 'config' | 'getProjects'>,
): Promise<void> {
  const paneDir = getAppDirectory();
  // A stable copy outside the app bundle survives app updates and AppImage remounts.
  const scriptPath = path.join(paneDir, 'mcp', 'runpane', 'dist', 'cli.js');
  if (enabled) await installRunpaneCopy(path.join(paneDir, 'mcp', 'runpane'));
  const host: PaneMcpHost = {
    // An AppImage's execPath is a per-launch mount; APPIMAGE is the stable file.
    executable: process.env.APPIMAGE || process.execPath,
    scriptPath,
    paneDir,
    toolsets: options.config.agentContext?.mcpToolsets,
    claudeExecutablePath: options.config.claudeExecutablePath,
  };
  // Remember which distros were registered so turning the setting off also cleans a distro whose repos are gone.
  const distroRecord = path.join(paneDir, 'mcp', 'wsl-distros.json');
  const wslDistros = new Set<string>();
  if (process.platform === 'win32') {
    for (const project of options.getProjects()) {
      if (project.wsl_enabled && project.wsl_distribution) wslDistros.add(project.wsl_distribution);
    }
    if (!enabled) for (const distro of await readDistroRecord(distroRecord)) wslDistros.add(distro);
  }
  const wslTargets = await Promise.all([...wslDistros].map((distro) => buildWslTarget(host, distro)));
  const targets = [await buildHostTarget(host), ...wslTargets];
  if (process.platform === 'win32') {
    const registered = enabled ? [...wslDistros].filter((_, index) => wslTargets[index]) : [];
    await writeFileAtomic(distroRecord, `${JSON.stringify(registered)}\n`);
  }
  await Promise.all(targets.map(async (target) => {
    if (!target) return;
    for (const outcome of await syncMcpRegistration(target, enabled)) {
      if (outcome.action === 'unchanged') continue;
      const detail = outcome.detail ? `: ${outcome.detail}` : '';
      console.log(`[PaneMcp] ${outcome.client} on ${target.label}: ${outcome.action} the "${PANE_MCP_SERVER_NAME}" MCP server${detail}`);
    }
  }));
}

async function installRunpaneCopy(destination: string): Promise<void> {
  for (const file of ['package.json', path.join('dist', 'cli.js'), path.join('dist', 'docs-index.json')]) {
    const source = await fs.readFile(path.join(BUNDLED_RUNPANE_DIR, file));
    const target = path.join(destination, file);
    const current = await fs.readFile(target).catch(() => undefined);
    if (current && current.equals(source)) continue;
    // Atomic, so an agent starting the MCP server mid-update never loads half a file.
    await writeFileAtomic(target, source);
  }
}

async function readDistroRecord(recordPath: string): Promise<string[]> {
  const text = await readIfExists(recordPath).catch(() => undefined);
  if (!text) return [];
  try {
    return decodeBoundary(JSON.parse(text), boundary.array(boundary.string));
  } catch {
    return [];
  }
}
